/** Actual HTTP/session/confirmation application over isolated live Valkey and real reply planners. No worker runs. */
import assert from "node:assert/strict";
import { Worker } from "bullmq";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRedisClient, parseConnection } from "@edgehero/pi-dispatch/connection";
import { makeQueue, enqueueForgeJob } from "@edgehero/pi-dispatch/queue";
import { makeAnswerDraftStore, answerRuleConfigDigest } from "@edgehero/pi-dispatch/answerer";
import { sanitizeJobId } from "@edgehero/pi-dispatch/run-history";
import { findToken } from "@edgehero/pi-dispatch/console-tokens";
import { makeConsoleAudit, readConsoleAudit, verifyConsoleAudit } from "@edgehero/pi-dispatch/console-audit";
import * as cookies from "../../src/console/sessions.mjs";
import { makeConfirmTickets } from "../../src/console/confirm.mjs";
import { makeLoginLimiter } from "../../src/console/guards.mjs";
import { makeLiveHub } from "../../src/console/live.mjs";
import * as pages from "../../src/console/pages.mjs";
import { createConsoleServer } from "../../src/console/server.mjs";
import { makeAnswererService } from "../../src/answerer-data.mjs";
import * as RM from "../../src/read-model.mjs";
import { parkedAnswerRefusalOf } from "../../src/job-actions.mjs";
import { readAgentWritesToday } from "../../src/agent-write-count.mjs";
import { NOW } from "../../../launch/fixture-deployment.mjs";
import { answererFixture } from "./answerer-goldens.mjs";

export const ANSWERER_BROWSER_TOKENS = Object.freeze({ operator: `pdc_${"o".repeat(43)}`, viewer: `pdc_${"v".repeat(43)}`, agent: `pdc_${"a".repeat(43)}` });

export async function startAnswererBrowserFixture(dir, { url = process.env.VALKEY_TEST_URL, readOnly = false } = {}) {
  if (!url) throw new Error("The answerer browser requires VALKEY_TEST_URL.");
  const base = new URL(url); base.pathname = "/15"; const valkeyUrl = base.href;
  const redis = makeRedisClient(valkeyUrl); redis.on("error", () => {});
  if ((await redis.keys("*")).some(key => key !== "bull:pi-jobs:meta")) { redis.disconnect(); throw new Error("Answerer browser requires empty database 15; no keys were changed."); }
  const queue = makeQueue(parseConnection(valkeyUrl, { failFast: true }));
  let seedWorker = null, hub = null, server = null;
  try {
  let clock = NOW, ticks = true;
  const now = () => clock;
  const paths = { valkeyUrl, triggersPath: join(dir, "triggers.json"), projectsPath: join(dir, "projects.json"), scopedLimitsPath: join(dir, "limits.json"), logsDir: join(dir, "logs") };
  mkdirSync(paths.logsDir, { recursive: true });
  const model = answererFixture(NOW);
  const doc = { triggers: [{ on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "fix", resume: true, awaitInput: true } }, { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix", resume: true, awaitInput: true, maxCostUsd: "0.05" } }], answerRules: model.rules, standingAnswers: model.standing.map(({ used, ...answer }) => answer) };
  const saveDoc = value => writeFileSync(paths.triggersPath, JSON.stringify(value, null, 2), { mode: 0o600 });
  saveDoc(doc);
  writeFileSync(paths.projectsPath, JSON.stringify({ version: 1, projects: [{ id: "web", members: ["github:acme/web"] }, { id: "api", members: ["github:acme/api"] }] }), { mode: 0o600 });
  writeFileSync(paths.scopedLimitsPath, JSON.stringify({ version: 1, limits: [] }), { mode: 0o600 });
  const store = makeAnswerDraftStore({ redis, now });
  const records = new Map(), parks = [];
  // The pinned BullMQ manual API only claims and completes fixture jobs. No processor, flow, model or container runs.
  // A retained completed job and a real pending-reply scan let the shipped read model judge every browser state.
  seedWorker = new Worker(queue.name, null, { connection: parseConnection(valkeyUrl, { failFast: true }), autorun: false });
  seedWorker.on("error", () => {});
  for (const [index, repo, number, project] of [[0, "acme/web", 512, "web"], [1, "acme/api", 131, "api"]]) {
    const job = { repo, target: { type: "issue", number, title: "Synthetic question", body: "Synthetic issue data" }, flow: "fix", resume: true, awaitInput: true, trigger: { event: "issues", action: "labeled", deliveryId: `browser-answer-${index}`, sender: { id: 5 }, matched: { index: 0, type: "label", label: "pi" } } };
    const { jobId } = await enqueueForgeJob(queue, "github", job);
    const seedToken = `browser-fixture-${index}`;
    const claimed = await seedWorker.getNextJob(seedToken, { block: false });
    assert.equal(claimed?.id, jobId);
    await claimed.moveToCompleted({ outcome: "completed", reason: "awaiting-input" }, seedToken, false);
    assert.equal(await claimed.getState(), "completed");
    await queue.removeDeduplicationKey(`${repo}#${number}:fix`);
    const record = { jobId, kind: "github", project, target: `${repo}#${number}`, flow: "fix", host: "mini1", backend: "local", outcome: "completed", reason: "awaiting-input", startedAt: new Date(NOW - 600000).toISOString(), endedAt: new Date(NOW - 240000).toISOString() };
    records.set(jobId, record); writeFileSync(join(paths.logsDir, `${sanitizeJobId(jobId)}.json`), JSON.stringify(record));
    parks.push({ ...record, ageMs: 240000, pendingScan: { jobId: null } });
    const meta = { ...model.rows[index], runId: jobId, status: index === 0 ? "running" : "passed", draftExists: false, draftRunId: `answer-draft-browser-${index}` };
    delete meta.sentBy;
    assert.equal(await store.capture({ version: 1, runId: jobId, ruleId: doc.answerRules[0].id, configDigest: answerRuleConfigDigest(doc, doc.answerRules[0]), project, source: { kind: "github", repo, target: { type: "issue", number }, selfId: "1", apiUrl: "https://api.github.com", questionCommentId: "123", startedAt: NOW - 600000, parkedAt: NOW - 240000 } }, meta), true, "The production store accepts the synthetic retained metadata");
    if (index === 0) assert.equal(await store.saveDraft(jobId, model.privateDraft), true, "The production store retains the draft before browser checks start");
    await queue.add("answer-draft", { kind: "answer-draft", purpose: "answer-draft", answerDraft: { runId: jobId, ruleId: meta.ruleId } }, { jobId: meta.draftRunId });
    const draftToken = `browser-fixture-draft-${index}`, draftJob = await seedWorker.getNextJob(draftToken, { block: false });
    assert.equal(draftJob?.id, meta.draftRunId); await draftJob.moveToCompleted({ outcome: "completed" }, draftToken, false);
    const draftRecord = { ...record, jobId: meta.draftRunId, purpose: "answer-draft", answerDraft: { sourceRunId: jobId, ruleId: meta.ruleId }, reason: "completed", startedAt: new Date(NOW - 180000).toISOString(), endedAt: new Date(NOW - 120000).toISOString() };
    records.set(meta.draftRunId, draftRecord); writeFileSync(join(paths.logsDir, `${sanitizeJobId(meta.draftRunId)}.json`), JSON.stringify(draftRecord));
  }
  await seedWorker.close(); seedWorker = null;
  const sourceRunId = parks[0].jobId;
  const service = makeAnswererService({ paths, now });
  const state = { unavailable: false, partial: false };
  const answerer = { ...service, async read(request) { if (state.unavailable) throw new Error("synthetic unavailable"); const got = await service.read(request); return { ...got, partial: got.partial || state.partial }; } };
  const fleet = {
    snapshot: async () => ({ at: clock, parked: await Promise.all(parks.map(async park => ({ ...park, pendingScan: await RM.readPendingAnswer({ queues: [queue], kind: park.kind, target: park.target, runId: park.jobId }) }))), parkedUnreachable: null, queue: { counts: await queue.getJobCounts(), pausedState: await queue.isPaused() }, hostBudgets: [], queueCounts: [{ queue: queue.name, counts: await queue.getJobCounts(), paused: await queue.isPaused() }], failed: { rows: [], more: 0 } }),
    pause: () => RM.killSwitchSet({ paused: true, plan: { urls: [valkeyUrl], disagreement: null } }),
    resume: () => RM.killSwitchSet({ paused: false, plan: { urls: [valkeyUrl], disagreement: null } }),
    parkedCount: async () => parks.length,
    runById: async id => records.has(id) ? { source: "local", record: records.get(id) } : { missing: true },
    runsPage: async () => ({ runs: [...records.values()], next: null, mirror: "off" }),
    jobStatus: async jobId => RM.readJobStatus({ queues: [queue], jobId }),
    pendingAnswer: async args => RM.readPendingAnswer({ queues: [queue], ...args }),
    parkedAnswerCheck: async jobId => { const job = await queue.getJob(jobId); const result = parkedAnswerRefusalOf({ jobId, data: job?.data ?? null, triggersPath: paths.triggersPath, approval: Array.isArray(job?.data?.gates) }); return result.refusal ? result : { ok: true }; },
    rerunCheck: async () => ({ refusal: "Synthetic fixture keeps re-runs off." }), sandboxCheck: async () => ({ refusal: "No workspace in this fixture." }),
    transcriptMeta: async () => ({ exists: false, ended: true }),
  };
  const tokens = { version: 1, generation: 0, tokens: Object.entries(ANSWERER_BROWSER_TOKENS).map(([role, token]) => ({ name: role === "operator" ? "ops" : role, role, sha256: createHash("sha256").update(token).digest("hex"), createdAt: new Date(NOW).toISOString() })) };
  const config = { dir, allowedHosts: [], readOnly, maxMs: 43200000, idleMs: 3600000, maxStreams: 4, logsDir: paths.logsDir };
  const sessions = cookies.makeSessionStore({ now });
  const audit = makeConsoleAudit({ logsDir: paths.logsDir, now });
  const pageDeps = { now, fleet, answerer, audit: opts => readConsoleAudit({ logsDir: paths.logsDir, ...opts, positions: true }), auditVerify: () => verifyConsoleAudit({ logsDir: paths.logsDir, withLast: true }), agentWrites: () => readAgentWritesToday({ now, host: "mini1", read: opts => readConsoleAudit({ logsDir: paths.logsDir, ...opts, positions: true }), verify: () => verifyConsoleAudit({ logsDir: paths.logsDir, withLast: true }) }) };
  const timers = { setInterval: (fn, ms) => setInterval(() => { if (ticks) fn(); }, ms), clearInterval };
  hub = makeLiveHub({ timers, loadPageData: (page, query, who) => pages.loadPageData(page, query, pageDeps, who), pagePanels: pages.pagePanels, queryKeyOf: pages.pageQueryString, dataQueryOf: pages.dataQueryOf, peekSession: (id, file) => sessions.peek(id, file), endedReason: (id, file) => sessions.verdict(id, file).ended ?? null, readTokens: () => ({ file: tokens }), readOnly, now });
  const logs = [];
  server = createConsoleServer({ config, now, sessions, cookies, tickets: makeConfirmTickets({ now }), limiter: makeLoginLimiter({ now }), audit, readTokens: () => ({ file: tokens }), findToken, hub, pageDeps, actionDeps: { answerer, rm: RM, paths, fleet, env: {} }, log: line => logs.push(line) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, paths, service, store, queue, redis, sourceRunId, model, tokens, logs, state, agentWrites: pageDeps.agentWrites,
    document: () => JSON.parse(readFileSync(paths.triggersPath, "utf8")), saveDocument: saveDoc,
    async refresh(ms = 6000) { clock += ms; await hub.tick(); },
    async pauseTicks() { ticks = false; await hub.tick(); },
    async close() { hub.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await queue.obliterate({ force: true }); await queue.close(); const keys = await redis.keys("answerer:*"); if (keys.length) await redis.del(...keys); redis.disconnect(); },
  };
  } catch (error) {
    hub?.close();
    server?.closeAllConnections();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await seedWorker?.close().catch(() => {});
    await queue.obliterate({ force: true }).catch(() => {}); await queue.close().catch(() => {});
    const keys = await redis.keys("answerer:*").catch(() => []); if (keys.length) await redis.del(...keys);
    redis.disconnect(); throw error;
  }
}
