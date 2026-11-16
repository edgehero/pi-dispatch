import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTriggerForDisplay, readLocalEventStatuses, triggerDetailOf, joinRunsToTriggers, attributeRunsToTriggers } from "../src/read-model.mjs";
import { parseRunFilter, runMatches, triggerValueOf } from "../src/run-filter.mjs";
import { recordMatchesTrigger, triggerListOf } from "../src/trigger-list.mjs";
import { triggerGetsOf } from "../src/trigger-gets-view.mjs";
import { agentReadProjection } from "../src/agent-read.mjs";
import { triggerSandboxHosts } from "../src/console/trigger-sandbox.mjs";
import { triggerOn, triggerRuns } from "../src/console/panels/trigger.mjs";
import { parseTriggers, TRIGGERS_FILE_VERSION } from "@edgehero/pi-dispatch/triggers";
import { buildLocalEventJob } from "@edgehero/pi-dispatch/local-event";

const NOW = Date.UTC(2026, 10, 16, 12);
const entry = () => ({ on: { type: "pull_request", forge: "github", id: "maintenance", action: ["review_submitted"], reviewAuthors: ["reviewer-app[bot]"] }, run: { kind: "local", worker: "build1", folder: "/srv/maintenance", command: "maintain-prs" } });
const display = () => ({ ...normalizeTriggerForDisplay(entry()), index: 2 });
const job = () => buildLocalEventJob(parseTriggers(JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [entry()] }), "test")[0], "a".repeat(32));

test("local event display keeps source and execution separate and hashes the actual normalized job definition", () => {
  const t = display();
  const data = job();
  assert.equal(t.forge, "github");
  assert.equal(t.runKind, "local");
  assert.equal(t.worker, "build1");
  assert.equal(t.folder, "/srv/maintenance");
  assert.equal(t.debounceSeconds, 10);
  assert.equal(t.localEventDigest, data.localEvent.digest, "omitted authored defaults still identify the queued normalized definition");
  assert.equal(triggerGetsOf({ trigger: t, hostLoads: null, liveHosts: [] }).mcp.items.some((i) => i.name === "forge"), false);
  assert.deepEqual(triggerSandboxHosts(t, { hostBudgets: [{ name: "elsewhere" }, { name: "build1" }] }).map((h) => h.name), ["build1"]);
  const projected = agentReadProjection(t);
  assert.equal(projected.command, undefined);
  assert.equal(projected.reviewAuthors, undefined);
  assert.equal(projected.worker, "build1");
  assert.equal(projected.runKind, "local");
});

test("event-local history follows id, source, type and definition, never a reused raw index or a cron command", () => {
  const t = display();
  const { id, forge, type, digest } = job().localEvent;
  const record = { kind: "local", jobId: "event-local-test", localEvent: { id, forge, type, digest }, triggerIndex: 99, startedAt: new Date(NOW - 1000).toISOString(), endedAt: new Date(NOW).toISOString(), outcome: "completed", tokens: { metered: true, cost: 0 } };
  assert.equal(recordMatchesTrigger(record, t), true);
  for (const over of [{ kind: "github" }, { localEvent: undefined }, { localEvent: { id, forge, type, digest: "b".repeat(64) } }, { localEvent: { id: "other", forge, type, digest } }]) assert.equal(recordMatchesTrigger({ ...record, ...over }, t), false);
  const snapshot = { readAt: NOW, triggers: { triggers: [t] }, runs: [record, { ...record, jobId: "old-definition", localEvent: { id, forge, type, digest: "b".repeat(64) } }], waiting: { rows: [{ trigger: 2, jobId: "unrelated" }] }, localEventStatuses: { 2: { status: null } } };
  const detail = triggerDetailOf(snapshot, 2, { now: NOW });
  assert.deepEqual(detail.lastRuns.map((r) => r.jobId), [record.jobId]);
  assert.equal(detail.queued, null, "raw queue indices cannot attribute local event generations");
  assert.deepEqual(detail.localEvent, { status: null });
  const list = triggerListOf({ snapshot, records: snapshot.runs, now: NOW, coverage: { complete: true } });
  assert.equal(list.rows[0].stats.runs30d, 1);
  assert.equal(list.rows[0].trigger.worker, "build1");
  assert.equal(joinRunsToTriggers({ records: snapshot.runs, triggers: [t], triggerCount: 3, triggerTypes: { 2: t.type } }).byIndex[2].runs, 1);
  assert.equal(joinRunsToTriggers({ records: snapshot.runs, triggers: [t], triggerCount: 3 }).unattributed, 1);
  assert.equal(attributeRunsToTriggers({ records: snapshot.runs, triggers: [t] }).byJobId[record.jobId].key, "trigger:2");
  assert.equal(attributeRunsToTriggers({ records: snapshot.runs, triggers: [t] }).byJobId["old-definition"].key, "unattributed");
  const value = triggerValueOf(record);
  assert.equal(value, "event:github:maintenance");
  const { filter } = parseRunFilter({ trigger: value });
  assert.ok(filter);
  assert.equal(runMatches(record, filter), true);
  assert.equal(runMatches({ ...record, localEvent: { ...record.localEvent, forge: "gitlab" } }, filter), false);
  assert.equal(runMatches({ kind: "local", jobId: "repeat:maintenance:1234" }, filter), false);
  for (const trigger of ["event:github:a:b", "event:unknown:a", "event:github:", `event:github:${"a".repeat(65)}`]) assert.ok(parseRunFilter({ trigger }).refusal);
});

test("local status reads are scoped to declared listeners and distinguish idle from unavailable", async () => {
  const t = display();
  const calls = [];
  const readStatus = async (_redis, key) => { calls.push(key); return null; };
  assert.deepEqual(await readLocalEventStatuses({}, [t, { type: "cron", id: "nightly" }, { type: "label", forge: "github", index: 7 }], { readStatus }), { 2: { status: null } });
  assert.deepEqual(calls, [{ id: t.id, forge: t.forge }]);
  assert.deepEqual(await readLocalEventStatuses({}, [t], { readStatus: async () => { throw new Error("private connection detail"); } }), { 2: { unreadable: true } });
});

test("local detail states debounce, authority and current/follow-up state, with a named unreadable fallback", () => {
  const t = display();
  const view = { role: "operator", query: { index: 2 }, data: { snapshot: { triggers: { triggers: [t] } }, triggerDetail: { trigger: t, count24h: 0, cost24hMicros: 0, lastRuns: [], localEvent: { status: { current: { jobId: "event-current", phase: "running", count: 3, dueAt: NOW }, next: { jobId: "event-next", phase: "pending", count: 2, dueAt: NOW + 10000 } } } } } };
  const on = String(triggerOn(view));
  assert.match(on, /10s quiet; at most one pending follow-up/);
  assert.match(on, /reviewer-app\[bot\]/);
  assert.match(on, /No event text is passed/);
  const runs = String(triggerRuns(view));
  assert.match(runs, /Pending follow-up/);
  assert.match(runs, /3 matching events/);
  view.data.triggerDetail.localEvent.status.current.blocked = "queue-job-missing";
  assert.match(String(triggerRuns(view)), /Queue job missing; reconcile runtime before clearing signal state/);
  const agentData = agentReadProjection(view.data);
  assert.equal(agentData.triggerDetail.localEvent.status.current.phase, undefined);
  assert.equal(agentData.triggerDetail.localEvent.status.current.blocked, undefined);
  const agentRuns = String(triggerRuns({ ...view, role: "agent", data: agentData }));
  assert.match(agentRuns, /not in an agent’s read, 3 matching events/);
  assert.doesNotMatch(agentRuns, /Queue job missing|: ,|undefined/);
  view.data.triggerDetail.localEvent = { unreadable: true };
  assert.match(String(triggerRuns(view)), /Local command state is unavailable/);
});


test("finished local event generations refuse manual retry at single and bulk previews and applies, while removal stays available", async () => {
  const { planFailedBulk, retryFailedJob, retryFailedJobs, removeFailedJob, LOCAL_EVENT_RETRY_REFUSAL } = await import("../src/job-actions.mjs");
  const { ACTIONS } = await import("../src/console/actions.mjs");
  let retried = 0, removed = 0;
  const failed = { id: "event-failed", data: job(), attemptsMade: 3, finishedOn: NOW, getState: async () => "failed", retry: async () => { retried++; }, remove: async () => { removed++; } };
  const deps = { url: "redis://test", now: () => NOW, parseConnectionFn: () => ({}), redisFn: () => ({ on() {}, smembers: async () => [], scan: async () => ["0", []], disconnect() {} }), queueFn: (_c, { name }) => ({ name, client: {}, getJob: async () => failed, getFailed: async () => [failed], getFailedCount: async () => 1, close: async () => {} }), localEventStoreFn: () => ({ finish: async () => ({ stale: true }) }) };
  const planned = await planFailedBulk(deps);
  assert.equal(planned.jobs[0].retryRefusal, LOCAL_EVENT_RETRY_REFUSAL);
  const expect = { attemptsMade: 3, finishedOn: NOW };
  assert.equal((await retryFailedJob({ ...deps, jobId: failed.id, expect })).invalid, LOCAL_EVENT_RETRY_REFUSAL);
  assert.equal((await retryFailedJobs({ ...deps, jobs: [{ jobId: failed.id, ...expect }] })).results[0].invalid, LOCAL_EVENT_RETRY_REFUSAL);
  const ctx = { a: { paths: { valkeyUrl: "redis://test" }, rm: { planFailedBulk: async () => planned } } };
  assert.deepEqual(await ACTIONS.find((a) => a.name === "retry-failed").preview({ jobId: failed.id }, ctx), { refusal: LOCAL_EVENT_RETRY_REFUSAL });
  assert.deepEqual(await ACTIONS.find((a) => a.name === "retry-all-failed").preview({}, ctx), { refusal: LOCAL_EVENT_RETRY_REFUSAL });
  const ordinary = { jobId: "gh-failed", queue: "pi-jobs", ...expect };
  ctx.a.rm.planFailedBulk = async () => ({ ...planned, jobs: [...planned.jobs, ordinary] });
  const mixed = await ACTIONS.find((a) => a.name === "retry-all-failed").preview({}, ctx);
  assert.deepEqual(mixed.targets.map((j) => j.jobId), [ordinary.jobId]);
  assert.ok(mixed.summary.includes(`1 local event generation left out. ${LOCAL_EVENT_RETRY_REFUSAL}`));
  ctx.a.fleet = { supersededOf: async () => new Map([[ordinary.jobId, {}]]) };
  const allExcluded = await ACTIONS.find((a) => a.name === "retry-all-failed").preview({}, ctx);
  assert.match(allExcluded.refusal, /local event generation left out.*Every other failed job.*ran again later/);
  assert.equal(retried, 0);
  assert.equal((await removeFailedJob({ ...deps, jobId: failed.id, expect })).ok, true);
  assert.equal(removed, 1);
});

test("failed local event removal settles only the revalidated generation before deleting, preserving once and partial outcomes", async () => {
  const { removeFailedJob, removeFailedJobs } = await import("../src/job-actions.mjs");
  const { ACTIONS } = await import("../src/console/actions.mjs");
  const calls = [];
  const data = job();
  data.localEvent.once = true;
  let state = "failed", finishReply = { ok: true }, removeFailure = false;
  const failed = { id: "event-failed", data, attemptsMade: 3, finishedOn: NOW, getState: async () => state, remove: async () => { calls.push("remove"); if (removeFailure) throw Error("private connection details"); } };
  const queueRedis = {};
  const deps = {
    url: "redis://test", timeoutMs: 5, parseConnectionFn: () => ({}),
    redisFn: () => ({ on() {}, smembers: async () => [], scan: async () => ["0", []], disconnect() {} }),
    queueFn: (_c, { name }) => ({ name, client: queueRedis, getJob: async () => failed, close: async () => {} }),
    localEventStoreFn: ({ redis }) => {
      assert.equal(redis, queueRedis);
      return { finish: async (meta, opts) => { calls.push("finish"); assert.equal(meta, data.localEvent); assert.deepEqual(opts, { discard: true }); if (finishReply instanceof Error) throw finishReply; return finishReply === "late" ? new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 25)) : finishReply; } };
    },
  };
  const expect = { attemptsMade: 3, finishedOn: NOW };
  const remove = () => removeFailedJob({ ...deps, jobId: failed.id, expect });
  state = "waiting";
  assert.match((await remove()).invalid, /not failed/);
  state = "failed";
  assert.match((await removeFailedJob({ ...deps, jobId: failed.id, expect: { ...expect, attemptsMade: 2 } })).invalid, /failed again/);
  assert.deepEqual(calls, [], "no signal change before state and fingerprint checks");
  assert.equal((await remove()).ok, true);
  assert.deepEqual(calls.splice(0), ["finish", "remove"]);
  finishReply = { stale: true };
  assert.equal((await removeFailedJobs({ ...deps, jobs: [{ jobId: failed.id, ...expect }] })).results[0].ok, true);
  assert.deepEqual(calls.splice(0), ["finish", "remove"], "already-settled generation is safe to remove again");
  for (const reply of [new Error("private connection details"), {}, "late"]) {
    finishReply = reply;
    const result = await remove();
    assert.equal(result.partial, true);
    assert.match(result.invalid, /settlement is unconfirmed; failed job kept; its successor may be ready/);
    assert.ok(!result.invalid.includes("private"));
    assert.deepEqual(calls.splice(0), ["finish"]);
  }
  finishReply = { ok: true };
  removeFailure = true;
  const result = await remove();
  assert.equal(result.partial, true);
  assert.match(result.invalid, /signal settled; queue removal is unconfirmed/);
  assert.deepEqual(calls.splice(0), ["finish", "remove"]);
  finishReply = new Error("unanswered");
  const bulk = await removeFailedJobs({ ...deps, jobs: [{ jobId: failed.id, ...expect }] });
  assert.equal(bulk.results[0].partial, true);
  assert.deepEqual(calls.splice(0), ["finish"]);
  const ctx = { a: { paths: { valkeyUrl: "redis://test" }, rm: { removeFailedJob: async () => result, removeFailedJobs: async () => bulk } } };
  const oneUi = await ACTIONS.find((a) => a.name === "remove-failed").apply({ target: failed.id, payload: { jobId: failed.id }, expect }, ctx);
  assert.equal(oneUi.partial, true);
  const bulkUi = await ACTIONS.find((a) => a.name === "remove-all-failed").apply({ targets: [{ jobId: failed.id, ...expect }] }, ctx);
  assert.equal(bulkUi.results[0].partial, true, "the console must not call an uncertain settlement unchanged");
});
