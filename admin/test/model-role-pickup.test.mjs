import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeProcessor } from "@edgehero/pi-dispatch";
import { parseTriggersDocument } from "@edgehero/pi-dispatch/triggers";
import { createModelRoleActions } from "../src/model-role-plans.mjs";
import { ACTIONS, previewAction, confirmAction } from "../src/console/actions.mjs";
import { makeConfirmTickets } from "../src/console/confirm.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const session = { id: "person", name: "operator", role: "operator" };
function setup() {
  const dir = tempDir("models-next-pickup-");
  const paths = { triggersPath: join(dir, "triggers.json") };
  const doc = { modelRoles: { default: { editor: "openai/old", checkpoint: "openai/old" } }, triggers: [{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix", model: "role:editor" } }] };
  writeFileSync(paths.triggersPath, JSON.stringify(doc));
  const modelRoles = createModelRoleActions({ paths, now: () => NOW, checkModelsKnown: () => ({ ok: true }) });
  const action = ACTIONS.find(action => action.name === "model-role-edit");
  const audit = [];
  const deps = { now: () => NOW, log() {}, actionDeps: { modelRoles }, tickets: makeConfirmTickets({ now: () => NOW }), audit: { append(row) { audit.push(row); return { ...row, seq: audit.length }; } }, sessions: { setFlash() {} } };
  const context = body => ({ body, deps, session, actor: () => session, route: { path: "/api/act/model-role-edit/confirm" }, record(row) { audit.push(row); }, json: (status, body) => ({ status, body }) });
  const edit = async () => {
    const p = await previewAction(context({ scope: "default", role: "editor", model: "anthropic/new" }), action);
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(JSON.parse(readFileSync(paths.triggersPath)).modelRoles.default.editor, "openai/old");
    const c = await confirmAction(context({ ticket: p.body.ticket }), action);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(audit.length, 1); assert.equal(audit[0].kind, "model-role-edit");
  };
  const events = [], records = [], data = new Map();
  const redis = { get: async key => data.get(key) ?? null, set: async (key, value) => (data.set(key, value), "OK"), incr: async key => { events.push("reserve"); const value = Number(data.get(key) ?? 0) + 1; data.set(key, value); return value; }, decr: async key => { const value = Number(data.get(key) ?? 0) - 1; data.set(key, value); return value; }, expire: async () => 1 };
  const reader = () => parseTriggersDocument(readFileSync(paths.triggersPath, "utf8")).modelRoles;
  const processor = extra => makeProcessor({ redis, now: () => NOW, cancelJob() {}, stopContainer() {}, readModelRoles: reader,
    getSettings: () => ({ provider: "openai", model: "default", maxTurns: 5, dailyCap: 10, concurrency: 3, softHoldPct: null }), recordRun: row => records.push(row),
    deps: { now: new Date(NOW), imagePreflight: async () => ({ ok: true, capabilities: ["exitAuth", "modelPolicy", "modelRoles"] }), mintToken: async () => (events.push("mint"), "token"), isDefaultBranchProtected: async () => true,
      prepareWorkspace: async () => (events.push("clone"), { workspace: "/w", jobDir: "/j" }), stageModelRoleInputs: async () => {}, cleanup: async () => {}, comment: async () => {}, log() {},
      runContainer: async ({ job }) => (events.push({ run: job }), { code: 0, aborted: false }), ...extra },
  });
  let seq = 0;
  const run = (subject, data = {}) => subject({ id: `delivery-${++seq}`, name: "github", attemptsMade: 0, data: { kind: "github", repo: "org/repo", model: "role:editor", ...data } }, "lock", new AbortController().signal);
  return { paths, edit, events, records, processor, run };
}

test("a person's preview and audited confirm change the physical model of the next actual processor delivery", async () => {
  const f = setup();
  const processor = f.processor();
  assert.equal((await f.run(processor)).outcome, "completed");
  const before = f.events.length;
  await f.edit();
  assert.equal(f.events.length, before, "editing neither enqueues nor starts a container or reservation");
  assert.equal((await f.run(processor)).outcome, "completed");
  assert.deepEqual(f.events.filter(event => event.run).map(({ run }) => [run.modelRole, run.provider, run.model]), [["editor", "openai", "old"], ["editor", "anthropic", "new"]]);
  assert.deepEqual(f.records.map(row => [row.result.modelRole, row.result.provider, row.result.model]), [["editor", "openai", "old"], ["editor", "anthropic", "new"]]);
});

test("a recovery after the console edit keeps the checkpoint's physical model at the actual pickup gate", async () => {
  const f = setup();
  await f.edit();
  const checked = [];
  const recovering = f.processor({ workspaceCheckpointer: { readManifest: async () => ({ ok: true, manifest: { provider: "openai", model: "old" } }) }, imagePreflight: async job => { checked.push(job); return { missing: "stopped-before-container" }; } });
  assert.equal((await f.run(recovering, { recover: true, recoveryOf: "previous" })).reason, "job-image-missing");
  assert.deepEqual(checked.map(job => [job.modelRole, job.provider, job.model]), [["editor", "openai", "old"]]);
  assert.deepEqual(f.events, [], "checkpoint selection is verified before mint, clone or reservation");
});
