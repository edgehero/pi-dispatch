import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { tempDir } from "./helpers/temp-dir.mjs";
import { planZeroTouchName, planZeroTouchGroup, planZeroTouchInstruction, planZeroTouchInstructionUndo, applyZeroTouchFilePlan, GROUP_PENDING_LINE } from "../src/zero-touch-actions.mjs";
import { checkTriggerFixSource } from "../src/job-actions.mjs";
import { GROUP_STATUS_UNANSWERED, makeZeroTouchService } from "../src/zero-touch-data.mjs";
const config = { capture: true, model: "test/classifier", maxCostUsd: "0.05", names: {} };
const groupId = "a".repeat(32), scopeId = "b".repeat(64);
function fixture() {
  const paths = { triggersPath: join(tempDir("zt-action-"), "triggers.json") };
  const doc = { triggers: [{ on: { type: "label", any: ["fix"] }, run: { kind: "github", flow: "fix" } }], zeroTouch: config, untouched: { key: true } };
  writeFileSync(paths.triggersPath, JSON.stringify(doc));
  const sourceRecord = { jobId: "source", touchScopeId: scopeId, kind: "github", triggerIndex: 0, outcome: "completed", reason: "awaiting-input" };
  const group = { id: groupId, scopeId, runIds: ["source"] };
  const binding = { ok: true, runId: "source", index: 0, triggerDigest: createHash("sha256").update(JSON.stringify(doc.triggers[0])).digest("hex") };
  return { paths, doc, sourceRecord, group, binding };
}
test("operator group name write preserves all unrelated fields and is refused after a concurrent edit", () => {
  const { paths } = fixture();
  const built = planZeroTouchName({ params: { groupId, name: "Package manager" }, paths });
  assert.ok(built.plan);
  assert.equal(applyZeroTouchFilePlan({ plan: built.plan, paths }).ok, true);
  const written = JSON.parse(readFileSync(paths.triggersPath));
  assert.equal(written.zeroTouch.names[groupId], "Package manager");
  assert.deepEqual(written.untouched, { key: true });
  const stale = planZeroTouchName({ params: { groupId, name: "Changed" }, paths });
  writeFileSync(paths.triggersPath, JSON.stringify({ ...written, unrelated: 1 }));
  assert.match(applyZeroTouchFilePlan({ plan: stale.plan, paths }).invalid, /changed/);
  assert.equal(JSON.parse(readFileSync(paths.triggersPath)).zeroTouch.names[groupId], "Package manager");
});
test("instruction preview writes the exact sentence and safe Undo restores absence", () => {
  const { paths, sourceRecord, group, binding } = fixture();
  const params = { runId: "source", groupId, index: 0, sentence: "Use pnpm in this repository." };
  const { plan } = planZeroTouchInstruction({ params, paths, sourceRecord, group, binding });
  assert.ok(plan);
  assert.equal(JSON.parse(plan.afterText).triggers[0].run.instructions, params.sentence);
  assert.equal(applyZeroTouchFilePlan({ plan, paths }).ok, true);
  const fix = { id: groupId, kind: "instructions", undo: plan.privateUndo };
  const undo = planZeroTouchInstructionUndo({ params: { fixId: groupId }, paths, fix });
  assert.ok(undo.plan);
  assert.equal(applyZeroTouchFilePlan({ plan: undo.plan, paths }).ok, true);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(paths.triggersPath)).triggers[0].run, "instructions"), false);
});
test("the instruction, Undo and name previews are the bytes the writer writes: stamped, without a dropped version 1, and today's with no rule", () => {
  // A sentence naming pnpm and a named group stand in for a run value and a zeroTouch value a later release widens.
  const versions = { runValueTable: Object.freeze({ instructions: text => (String(text).includes("pnpm") ? 2 : 1) }), blockValueTable: Object.freeze({ zeroTouch: block => (Object.keys(block?.names ?? {}).length ? 2 : 1) }), supported: 2 };
  const { paths, doc, sourceRecord, group, binding } = fixture();
  const text = () => readFileSync(paths.triggersPath, "utf8");
  const params = { runId: "source", groupId, index: 0, sentence: "Use pnpm in this repository." };
  const { plan } = planZeroTouchInstruction({ params, paths, sourceRecord, group, binding, versions });
  assert.ok(plan);
  assert.ok(plan.afterText.startsWith('{\n  "version": 2,\n  "triggers": ['), plan.afterText);
  assert.equal(applyZeroTouchFilePlan({ plan, paths, versions }).ok, true);
  assert.equal(text(), plan.afterText, "the applied file is the preview");
  // The stamped file is read by the same rules; removing the sentence removes the stamp, in the preview as on disk.
  const undo = planZeroTouchInstructionUndo({ params: { fixId: groupId }, paths, fix: { id: groupId, kind: "instructions", undo: plan.privateUndo }, versions });
  assert.ok(undo.plan);
  assert.doesNotMatch(undo.plan.afterText, /"version"/);
  assert.equal(applyZeroTouchFilePlan({ plan: undo.plan, paths, versions }).ok, true);
  assert.equal(text(), undo.plan.afterText);
  const named = planZeroTouchName({ params: { groupId, name: "Package manager" }, paths, versions });
  assert.ok(named.plan?.afterText.startsWith('{\n  "version": 2,\n  "triggers": ['), JSON.stringify(named));
  assert.equal(applyZeroTouchFilePlan({ plan: named.plan, paths, versions }).ok, true);
  assert.equal(text(), named.plan.afterText);
  // With the group named, the file stays at version 2 after an Undo, so the Undo's preview is stamped by the same rules.
  const again = planZeroTouchInstruction({ params, paths, sourceRecord, group, binding, versions }).plan;
  assert.equal(applyZeroTouchFilePlan({ plan: again, paths, versions }).ok, true);
  const kept = planZeroTouchInstructionUndo({ params: { fixId: groupId }, paths, fix: { id: groupId, kind: "instructions", undo: again.privateUndo }, versions });
  assert.ok(kept.plan?.afterText.startsWith('{\n  "version": 2,\n  "triggers": ['), JSON.stringify(kept));
  assert.equal(applyZeroTouchFilePlan({ plan: kept.plan, paths, versions }).ok, true);
  assert.equal(text(), kept.plan.afterText);

  // A hand-written "version": 1 is dropped by the writer, so every preview drops it too.
  for (const build of [
    () => planZeroTouchInstruction({ params, paths, sourceRecord, group, binding }),
    () => planZeroTouchName({ params: { groupId, name: "Package manager" }, paths }),
  ]) {
    writeFileSync(paths.triggersPath, JSON.stringify({ version: 1, ...doc }));
    const built = build().plan;
    assert.doesNotMatch(built.afterText, /"version"/);
    assert.equal(applyZeroTouchFilePlan({ plan: built, paths }).ok, true);
    assert.equal(text(), built.afterText);
  }
  writeFileSync(paths.triggersPath, JSON.stringify({ version: 1, ...doc, triggers: [{ ...doc.triggers[0], run: { ...doc.triggers[0].run, instructions: params.sentence } }] }));
  const undone = planZeroTouchInstructionUndo({ params: { fixId: groupId }, paths, fix: { id: groupId, kind: "instructions", undo: plan.privateUndo } }).plan;
  assert.doesNotMatch(undone.afterText, /"version"/);
  assert.equal(applyZeroTouchFilePlan({ plan: undone, paths }).ok, true);
  assert.equal(text(), undone.afterText);

  // With every table empty: unstamped, in today's exact bytes.
  writeFileSync(paths.triggersPath, JSON.stringify(doc));
  const plain = planZeroTouchInstruction({ params, paths, sourceRecord, group, binding }).plan;
  assert.equal(plain.afterText, `${JSON.stringify({ ...doc, triggers: [{ ...doc.triggers[0], run: { ...doc.triggers[0].run, instructions: params.sentence } }] }, null, 2)}\n`);
  assert.equal(applyZeroTouchFilePlan({ plan: plain, paths }).ok, true);
  assert.equal(text(), plain.afterText);
});
test("a replacement trigger with the same instruction sentence is not an Undo target", () => {
  const { paths, sourceRecord, group, binding } = fixture();
  const { plan } = planZeroTouchInstruction({ params: { runId: "source", groupId, index: 0, sentence: "Use pnpm." }, paths, sourceRecord, group, binding });
  applyZeroTouchFilePlan({ plan, paths });
  const doc = JSON.parse(readFileSync(paths.triggersPath)); doc.triggers[0].on.any = ["different"];
  writeFileSync(paths.triggersPath, JSON.stringify(doc));
  assert.match(planZeroTouchInstructionUndo({ params: { fixId: groupId }, paths, fix: { id: groupId, kind: "instructions", undo: plan.privateUndo } }).refusal, /changed/);
});
test("instructions are console-only, bounded and require matching source lineage", () => {
  const { paths, sourceRecord, group, binding } = fixture();
  const args = { params: { runId: "source", groupId, index: 0, sentence: "Use pnpm." }, paths, sourceRecord, group, binding };
  assert.match(planZeroTouchInstruction({ ...args, surface: "tool" }).refusal, /only.*console/);
  assert.match(planZeroTouchInstruction({ ...args, params: { ...args.params, sentence: "x".repeat(2001) } }).refusal, /2,000/);
  assert.match(planZeroTouchInstruction({ ...args, sourceRecord: { ...sourceRecord, triggerIndex: 1 } }).refusal, /does not identify/);
  assert.match(planZeroTouchInstruction({ ...args, group: { ...group, scopeId: "c".repeat(64) } }).refusal, /explicit source/);
  assert.equal(JSON.parse(readFileSync(paths.triggersPath)).triggers[0].run.instructions, undefined);
  assert.match(planZeroTouchInstruction({ ...args, binding: null }).refusal, /identity is unavailable/);
});
test("a cron cause does not gain an ignored instructions field", () => {
  const { paths, sourceRecord } = fixture();
  const doc = { triggers: [{ on: { type: "cron", id: "daily", pattern: "0 0 * * *" }, run: { kind: "local", folder: "/repo", flow: "fix", task: "Check" } }] };
  writeFileSync(paths.triggersPath, JSON.stringify(doc));
  const out = planZeroTouchInstruction({ params: { runId: "source", index: 0, sentence: "Use pnpm." }, paths, sourceRecord: { ...sourceRecord, kind: "local", outcome: "policy", reason: "secret-unresolved" } });
  assert.match(out.refusal, /cron instructions belong in its task/);
});
test("grouping plan refuses absent capture, invalid source and tool calls; preview names actual model and cap", () => {
  const args = { params: { runId: "source" }, config, meta: { runId: "source", status: "unassigned", digest: "a".repeat(64) } };
  assert.match(planZeroTouchGroup({ ...args, surface: "tool" }).refusal, /only/);
  assert.match(planZeroTouchGroup({ ...args, config: { ...config, capture: false } }).refusal, /not enabled/);
  assert.match(planZeroTouchGroup({ ...args, meta: { ...args.meta, status: "source-expired" } }).refusal, /no available/);
  const { plan } = planZeroTouchGroup(args);
  assert.equal(plan.model, "test/classifier"); assert.equal(plan.maxCostUsd, "0.05");
  for (const status of ["failed", "stale", "refused"]) assert.ok(planZeroTouchGroup({ ...args, meta: { ...args.meta, status } }).plan, status);
  assert.match(planZeroTouchGroup({ ...args, meta: { ...args.meta, status: "pending" } }).plan.summary.join(" "), /pay for another classification/);
  // What a pending status means and how long it stays (issue #987): the last line of that preview and of no other, and
  // the confirm's sentence for a status write that was not answered, which ends the same way. It said "a previous
  // grouping is pending or its result could not be confirmed", and nothing of when that ends.
  assert.equal(GROUP_PENDING_LINE, "A grouping of this question is marked pending: one is queued or running, an earlier request or its status write was not confirmed, or an earlier grouping ended without recording a result. The mark stays until a grouping records a result or the question's record expires. Confirming this request can pay for another classification.");
  assert.equal(planZeroTouchGroup({ ...args, meta: { ...args.meta, status: "pending" } }).plan.summary.at(-1), GROUP_PENDING_LINE);
  for (const status of ["unassigned", "failed", "stale", "refused"]) assert.ok(!planZeroTouchGroup({ ...args, meta: { ...args.meta, status } }).plan.summary.includes(GROUP_PENDING_LINE), status);
  assert.equal(GROUP_STATUS_UNANSWERED, "Nothing was queued: the question's grouping status write was not answered, so it may read as pending until a grouping records a result or its record expires.");
  assert.ok([...GROUP_STATUS_UNANSWERED].length <= 200, "an audit row keeps the whole sentence");
});

test("source identity checks retained trigger type, label and flow before accepting a same-kind array position", async () => {
  const { paths, doc, sourceRecord, group } = fixture();
  const data = { kind: "github", flow: "fix", target: { type: "issue", number: 1 }, trigger: { matched: { index: 0, type: "label", label: "fix" } } };
  const args = { jobId: "source", index: 0, triggersPath: paths.triggersPath, readRetainedJob: async () => data };
  const good = await checkTriggerFixSource(args);
  assert.equal(good.ok, true);
  const params = { runId: "source", groupId, index: 0, sentence: "Use pnpm." };
  assert.ok(planZeroTouchInstruction({ params, paths, sourceRecord, group, binding: good }).plan);
  for (const replacement of [
    { ...doc.triggers[0], on: { type: "label", any: ["another-label"] } },
    { ...doc.triggers[0], run: { kind: "github", flow: "another-flow" } },
    { ...doc.triggers[0], on: { type: "comment", phrase: "@pi" } },
  ]) {
    writeFileSync(paths.triggersPath, JSON.stringify({ ...doc, triggers: [replacement] }));
    assert.match((await checkTriggerFixSource(args)).refusal, /changed or moved/);
    assert.match(planZeroTouchInstruction({ params, paths, sourceRecord, group, binding: good }).refusal, /identity is unavailable or changed/);
  }
  assert.match((await checkTriggerFixSource({ ...args, readRetainedJob: async () => null })).refusal, /no longer holds/);
});

test("the service's client carries an error listener, so an outage outlasting a call is not a stack trace per reconnect attempt", async () => {
  const dir = tempDir("zero-touch-listener-");
  const heard = [];
  const service = makeZeroTouchService({ paths: { valkeyUrl: "redis://example.invalid", logsDir: dir, triggersPath: join(dir, "triggers.json") }, redisFn: () => ({ on(event) { heard.push(event); }, disconnect() {} }) });
  await service.withWriters(async () => null);
  assert.deepEqual(heard, ["error"]);
  const seam = makeZeroTouchService({ paths: { valkeyUrl: "redis://example.invalid", logsDir: dir, triggersPath: join(dir, "triggers.json") }, redisFn: () => ({ disconnect() {} }) });
  assert.equal(await seam.withWriters(async () => "ran"), "ran");
});

test("a source lookup that could not ask every queue says it could not be checked, never that the queue no longer holds the run", async () => {
  const { paths } = fixture();
  const data = { kind: "github", flow: "fix", target: { type: "issue", number: 1 }, trigger: { matched: { index: 0, type: "label", label: "fix" } } };
  const base = { url: "redis://unused", jobId: "source", index: 0, triggersPath: paths.triggersPath, parseConnectionFn: () => ({}), timeoutMs: 40 };
  const queueOf = (getJob) => (_connection, { name }) => ({ name, getJob, close: async () => {} });
  // Longer than the bound, and a real timer: the bound's own is unref'd, so a promise that never settles would end the test's loop.
  const late = () => new Promise((resolve) => setTimeout(resolve, 400, null));
  const answers = { on() {}, smembers: async () => [], scan: async () => ["0", []], disconnect() {} };
  const UNCHECKED = /could not be checked\. Reload and try again; nothing was changed\.$/;
  // The control: every queue asked and none holds it.
  assert.match((await checkTriggerFixSource({ ...base, redisFn: () => answers, queueFn: queueOf(async () => null) })).refusal, /no longer holds/);
  // The registry unread (the client refused): the one queue asked proves nothing about the others.
  const blind = () => { throw new Error("no client"); };
  assert.match((await checkTriggerFixSource({ ...base, redisFn: blind, queueFn: queueOf(async () => null) })).refusal, UNCHECKED);
  // The keyspace scan unread: a host out of the registry may still hold it.
  const noScan = { ...answers, scan: async () => { throw new Error("scan failed"); } };
  assert.match((await checkTriggerFixSource({ ...base, redisFn: () => noScan, queueFn: queueOf(async () => null) })).refusal, UNCHECKED);
  // A job found is found, however the list was read.
  assert.equal((await checkTriggerFixSource({ ...base, redisFn: blind, queueFn: queueOf(async () => ({ data })) })).ok, true);
  // The bound: a queue that does not answer in time.
  assert.match((await checkTriggerFixSource({ ...base, redisFn: () => answers, queueFn: queueOf(late) })).refusal, UNCHECKED);
  assert.match((await checkTriggerFixSource({ ...base, readRetainedJob: late })).refusal, UNCHECKED);
});

test("a source lookup that outlives its bound still closes every queue it opens afterwards", async () => {
  const { paths } = fixture();
  const made = [];
  // The first queue answers after the bound (a real timer: the bound's own is unref'd).
  const held = new Promise((resolve) => setTimeout(resolve, 150, null));
  const queueFn = (_connection, { name }) => {
    const queue = { name, closed: false, getJob: () => (made.length === 1 ? held : Promise.resolve(null)), close: async () => { queue.closed = true; } };
    made.push(queue);
    return queue;
  };
  // Three queues exist; the first does not answer until after the bound, and the lookup then walks on to the other two.
  const redisFn = () => ({ on() {}, smembers: async () => [], scan: async () => ["0", ["bull:pi-jobs@a:meta", "bull:pi-jobs@b:meta"]], disconnect() {} });
  const got = await checkTriggerFixSource({ url: "redis://unused", jobId: "source", index: 0, triggersPath: paths.triggersPath, redisFn, queueFn, parseConnectionFn: () => ({}), timeoutMs: 40 });
  assert.match(got.refusal, /could not be checked/);
  assert.equal(made.length, 1);
  await held;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(made.map((q) => q.name), ["pi-jobs", "pi-jobs@a", "pi-jobs@b"]);
  assert.deepEqual(made.map((q) => q.closed), [true, true, true]);
});

test("an instruction preview over a run record or a group list that could not be read says so, not that the run names another trigger", async () => {
  const { paths, binding } = fixture();
  const logsDir = tempDir("zt-unread-logs-");
  const AT = Date.UTC(2026, 9, 8, 15, 0, 0);
  const params = { runId: "source", groupId, index: 0, sentence: "Use pnpm." };
  const down = new Proxy({}, { get: (_, key) => (key === "on" || key === "disconnect" ? () => {} : key === "then" ? undefined : async () => { throw new Error("Valkey does not answer"); }) });
  const service = (redis) => makeZeroTouchService({ paths: { ...paths, valkeyUrl: "redis://unused", logsDir }, redisFn: () => redis, triggerBindingFn: async () => binding, now: () => AT });
  // No local record and a mirror that does not answer: the record was not read.
  const unread = await service(down).preview("zero-touch-instruction", params);
  assert.equal(unread.refusal, "The source trigger identity could not be checked. Reload and try again; nothing was changed.");
  // The group list read (and empty), the record still unread: not "the source run does not identify that trigger".
  const groupsOnly = new Proxy({}, { get: (_, key) => (key === "on" || key === "disconnect" ? () => {} : key === "then" ? undefined : key === "zrevrangebyscore" ? async () => [] : async () => { throw new Error("Valkey does not answer"); }) });
  const noRecord = await service(groupsOnly).preview("zero-touch-instruction", params);
  assert.equal(noRecord.refusal, "The source trigger identity could not be checked. Reload and try again; nothing was changed.");
  // A file here that is not a record will not read on a reload: said as that, with no "try again".
  writeFileSync(join(logsDir, "source.json"), "{ not a record");
  const corrupt = await service(groupsOnly).preview("zero-touch-instruction", params);
  assert.equal(corrupt.refusal, "This host's record of the source run cannot be read as a record, so its trigger cannot be checked. Nothing was changed.");
  // The record read from this host's file, the group list not: the group is not "no longer retained".
  const { sourceRecord } = fixture();
  writeFileSync(join(logsDir, "source.json"), JSON.stringify({ ...sourceRecord, startedAt: new Date(AT - 120_000).toISOString(), endedAt: new Date(AT - 60_000).toISOString() }));
  const noGroups = await service(down).preview("zero-touch-instruction", params);
  assert.equal(noGroups.refusal, "The source trigger identity could not be checked. Reload and try again; nothing was changed.");
});
