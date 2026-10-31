import assert from "node:assert/strict";
import { randomBytes, createHmac } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Queue } from "bullmq";
import { tempDir } from "./helpers/temp-dir.mjs";
import { makeRedisClient } from "../src/connection.mjs";
import { enqueueAnswerDraftJob } from "../src/queue.mjs";
import { makeAnswerDraftStore, answerConfigDigest, answerStandingSource } from "../src/answerer.mjs";
import { makeAnswerDraftRuntime, readAnswerPending } from "../src/answerer-runtime.mjs";
import { makePrepareWorkspace } from "../src/prepare.mjs";
import { makeProcessor } from "../src/index.mjs";
import { checkDraftAnswerSource, runJob, InfraRetry } from "../src/processor.mjs";
import { makeLateForge } from "../src/inbox-settle.mjs";
import { inboxKeys, preseedInbox, readInbox, registerLive, steerOpenKey, steerTargetKey } from "../src/steer-inbox.mjs";
import { buildRecord, makeLogSink } from "../src/run-history.mjs";
import { readAnswerDraft, createAnswerDraftTools } from "../../image/runner/src/answerer.mjs";

const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("answerer pipeline requires VALKEY_TEST_URL");
const skip = url ? false : "VALKEY_TEST_URL not set";
const CLOCK = Date.UTC(2026, 9, 31, 12);
const SHA = "b".repeat(40);
const PRIVATE = "PRIVATE question: which test command?";
const rule = { id: "help", projects: ["web"], categories: ["how-to"], confidence: 0.9, mode: "draft", flow: "answer", model: "test/chat", decisionModel: "test/classifier", maxCostUsd: "0.10" };
const standing = { id: "tests", title: "Test command", text: "Run npm test.", projects: ["web"], repo: "github:acme/web" };

function isolatedLedger(redis, prefix, events) {
	const one = method => async (key, ...args) => { if (method === "incr") events.push("reserve"); return redis[method](`${prefix}${key}`, ...args); };
	return { ...Object.fromEntries(["get", "incr", "decr", "expire", "incrby", "set", "hgetall", "exists", "pexpire", "hget", "del"].map(m => [m, one(m)])), eval: (script, count, ...args) => redis.eval(script, count, ...args.slice(0, count).map(k => `${prefix}${k}`), ...args.slice(count)) };
}
async function fixture(t, { kind = "github" } = {}) {
	const root = tempDir("answerer-pipeline-"), parentSession = join(root, "parent"), jobsDir = join(root, "jobs"); mkdirSync(parentSession); mkdirSync(jobsDir);
	writeFileSync(join(parentSession, "current.jsonl"), "PARENT TRANSCRIPT MUST NOT CHANGE\n");
	writeFileSync(join(parentSession, "question-ref.json"), JSON.stringify({ version: 1, commentId: "123" }));
	const prefix = `answer-test-${randomBytes(8).toString("hex")}:`, redis = makeRedisClient(url), queue = new Queue(prefix.slice(0, -1), { connection: redis });
	const cleanups = [];
	t.after(async () => { for (const cleanup of cleanups) await cleanup(); await queue.obliterate({ force: true }); await queue.close(); const keys = await redis.keys(`${prefix}*`); if (keys.length) await redis.del(...keys); redis.disconnect(); });
	const store = makeAnswerDraftStore({ redis, prefix, now: () => CLOCK });
	const triggersPath = join(root, "triggers.json"), doc = { triggers: [], answerRules: [rule], standingAnswers: [standing] }; writeFileSync(triggersPath, JSON.stringify(doc));
	const parent = { kind, repo: "acme/web", target: { type: "issue", number: 7 }, awaitInput: true };
	const current = { park: { runId: "parent-run", at: CLOCK }, approval: { ok: true, request: null }, identity: { selfId: 99, apiUrl: kind === "gitlab" ? "https://gitlab.example/sub" : "https://api.github.com" } };
	const runtime = makeAnswerDraftRuntime({ store, triggersPath, now: () => CLOCK, readParkedInfo: () => current.park, readApproval: () => current.approval, readPendingAnswer: source => readAnswerPending({ queues: [queue], source, runId: source.runId }), identity: async () => { if (current.identityError) throw new Error("connection"); return current.identity; }, enqueue: fields => enqueueAnswerDraftJob(queue, fields) });
	const meta = await runtime.afterPark({ job: parent, prepared: { session: { hostDir: parentSession }, questionRefDigest: answerConfigDigest({ version: 1, commentId: "123" }) }, runId: "parent-run", project: "web", startedAt: CLOCK - 60000 });
	return { root, jobsDir, parentSession, prefix, redis, queue, store, runtime, triggersPath, doc, parent, meta, current, cleanups };
}

test("real durable park intent becomes an ordinary reserved forge job, then a private cited draft without changing its park", { skip }, async t => {
	const f = await fixture(t), events = [], records = [], credentials = [];
	const before = readFileSync(join(f.parentSession, "current.jsonl"), "utf8");
	const job = await f.queue.getJob(f.meta.draftRunId);
	assert.doesNotMatch(JSON.stringify(job.data), /PRIVATE|npm test|123/);
	const prepare = makePrepareWorkspace({ jobsDir: f.jobsDir, forgeFor: () => ({ host: {} }), preparers: { github: async (_job, _token, { jobDir }) => { events.push("clone"); const workspace = join(jobDir, "workspace"); mkdirSync(workspace); writeFileSync(join(workspace, "README.md"), "Run npm test."); mkdirSync(join(workspace, ".pi/skills/answer"), { recursive: true }); writeFileSync(join(workspace, ".pi/skills/answer/SKILL.md"), "Cite the command and explain when it runs."); return { jobDir, workspace, sha: SHA, materialised: [] }; } } });
	const process = makeProcessor({ redis: isolatedLedger(f.redis, `${f.prefix}ledger:`, events), now: () => CLOCK, projects: () => [{ id: "web", members: ["github:acme/web"] }], getSettings: () => ({ provider: "test", model: "chat", maxTurns: 10, concurrency: 1, dailyCap: 10, dailyCostUsd: "1", maxCostUsd: "0.20" }), cancelJob() {}, stopContainer() {}, cancelPollMs: 60000, recordRun: args => records.push(buildRecord(args)), deps: {
		answerDraftRuntime: f.runtime,
		imagePreflight: async () => ({ ok: true, piVersion: "1.4.0", capabilities: ["answerDraft", "exitAuth", "costCap", "modelPolicy", "modelFailover"] }),
		checkProviderCredential: async job => { credentials.push(job.provider); return { ok: true }; }, checkModelsKnown: () => ({ ok: true }),
		mintToken: async () => { events.push("mint"); return "scoped"; }, isDefaultBranchProtected: async () => true, prepareWorkspace: prepare,
		async runContainer({ job, prepared }) {
			events.push("container"); assert.ok(events.includes("reserve")); assert.equal(prepared.workspaceReadOnly, true); assert.equal(job.resume, false); assert.equal(job.packages, false); assert.equal(job.mcp, undefined); assert.equal(job.secrets, undefined);
			const input = readAnswerDraft({ path: join(prepared.jobDir, "answer-draft.json") });
			assert.equal(input.flow.revision, SHA); assert.equal(input.flow.text, "Cite the command and explain when it runs."); assert.ok(readFileSync(join(prepared.jobDir, "prompt.md"), "utf8").includes(input.flow.text), "the configured reviewed flow actually reaches the model prompt");
			assert.equal(input.standing.length, 1); assert.equal(input.standing[0].text, standing.text);
			const sources = new Map(), evidence = { ...answerStandingSource(standing), text: standing.text };
			const tools = createAnswerDraftTools({ input, outbox: prepared.outboxDir, reader: { sources, question: async () => PRIVATE, standing: id => { assert.equal(id, "tests"); sources.set(evidence.id, evidence); return evidence; } }, runtime: { getModelsOfType: () => [{ id: "classifier", cost: { input: 1, output: 0 } }], classify: async (_m, c) => { events.push("classify"); const category = Object.hasOwn(c.questions, "category"), name = category ? "category" : "coverage", selected = category ? "how-to" : "covered"; return { stopReason: "stop", answers: { [name]: { type: "choice", choice: selected, confidence: 1, probabilities: Object.fromEntries(Object.keys(c.questions[name].criteria).map(k => [k, Number(k === selected)])) } } }; } } });
			assert.equal(await tools.initialize(), true); await tools.tools.find(t => t.name === "read_standing_answer").execute("read", { id: "tests" }); const submission = await tools.tools.find(t => t.name === "submit_answer_draft").execute("submit", { draft: "Run npm test.", sources: [evidence.id] }); assert.equal(submission.terminate, true);
			prepared.answerDraftDigest = tools.state.receipt;
			return { code: 0, aborted: false, turns: 1, tokens: { input: 10, output: 3, total: 13, cost: 0.01, metered: true }, exitLineCode: 0, exitAuth: "verified" };
		},
		collectChain: async () => assert.fail("a draft result is not a chain channel"), collectPlan: async () => assert.fail("a draft cannot change allocations"), comment: async () => assert.fail("no draft status/refusal comment may post"), cleanup: async () => {},
	} });
	const result = await process(job, "token", new AbortController().signal);
	assert.equal(result.outcome, "completed", JSON.stringify({ result, events })); assert.equal(events.filter(e => e === "classify").length, 2); assert.ok(events.indexOf("mint") < events.indexOf("clone")); assert.ok(events.indexOf("reserve") < events.indexOf("classify"));
	const got = await f.store.privateDraft("parent-run"); assert.equal(got.draft, "Run npm test."); assert.equal(got.question, PRIVATE); assert.equal(got.meta.status, "drafted"); assert.equal(got.meta.costUsd, 0.01);
	assert.equal(records.at(-1).purpose, "answer-draft"); assert.deepEqual(records.at(-1).answerDraft, { sourceRunId: "parent-run", ruleId: "help" }); assert.equal(readFileSync(join(f.parentSession, "current.jsonl"), "utf8"), before);
	assert.doesNotMatch(JSON.stringify(await f.store.publicSnapshot()), /PRIVATE|Run npm test/);
});

test("scope/config changes and legacy missing question references never buy a draft; lost enqueue acknowledgement is idempotent", { skip }, async t => {
	const f = await fixture(t);
	await f.runtime.afterPark({ job: f.parent, prepared: { session: { hostDir: f.parentSession } }, runId: "parent-run", project: "web", startedAt: CLOCK - 60000 });
	assert.equal(await f.queue.getJobCountByTypes("waiting"), 1);
	const job = await f.queue.getJob(f.meta.draftRunId), resolved = (await f.runtime.resolve(job.data, job.id)).data;
	const deferred = JSON.parse(JSON.stringify(resolved)); deferred.provider = "attacker"; deferred.mcp = ["post"]; deferred.resume = true;
	const rebuilt = (await f.runtime.resolve(deferred, job.id)).data;
	assert.equal(rebuilt.provider, "test"); assert.equal(rebuilt.resume, false); assert.equal(rebuilt.mcp, undefined); assert.equal(rebuilt.answerDraft.input.standing[0].text, standing.text);
	f.doc.answerRules[0] = { ...rule, categories: ["decided"] }; writeFileSync(f.triggersPath, JSON.stringify(f.doc));
	assert.equal((await f.runtime.resolve(deferred, job.id)).result.reason, "answer-draft-config-changed");
	const legacy = await f.runtime.afterPark({ job: f.parent, prepared: {}, runId: "legacy", project: "web", startedAt: CLOCK - 60000 }); assert.equal(legacy.passReason, "source-unavailable"); assert.equal(await f.queue.getJobCountByTypes("waiting"), 1);
	assert.equal(await f.runtime.afterPark({ job: f.parent, prepared: {}, runId: "outside", project: "another", startedAt: CLOCK - 60000 }), null);
});

test("a missing reviewed draft flow refuses without leaving its disposable clone or buying a container", { skip }, async t => {
	const f = await fixture(t), queued = await f.queue.getJob(f.meta.draftRunId), job = (await f.runtime.resolve(queued.data, queued.id)).data;
	const prepare = makePrepareWorkspace({ jobsDir: f.jobsDir, forgeFor: () => ({ host: {} }), preparers: { github: async (_job, _token, { jobDir }) => { const workspace = join(jobDir, "workspace"); mkdirSync(workspace); return { jobDir, workspace, sha: SHA }; } } });
	const result = await prepare(job, "scoped"); assert.equal(result.reason, "answer-draft-refused"); assert.deepEqual(readdirSync(f.jobsDir), []);
});

test("a substituted valid bot comment id cannot replace the exact question reference signed by the parked attempt", { skip }, async t => {
	const f = await fixture(t), signed = answerConfigDigest({ version: 1, commentId: "123" });
	writeFileSync(join(f.parentSession, "question-ref.json"), JSON.stringify({ version: 1, commentId: "124" }));
	const rejected = await f.runtime.afterPark({ job: f.parent, prepared: { session: { hostDir: f.parentSession }, questionRefDigest: signed }, runId: "substituted", project: "web", startedAt: CLOCK - 60000 });
	assert.equal(rejected.passReason, "source-unavailable"); assert.equal(await f.queue.getJobCountByTypes("waiting"), 1, "only the original correctly bound draft is queued");
	const unverified = await f.runtime.afterPark({ job: f.parent, prepared: { session: { hostDir: f.parentSession } }, runId: "unsigned", project: "web", startedAt: CLOCK - 60000 }); assert.equal(unverified.passReason, "source-unavailable");
});

test("a queued draft rechecks the exact current park, pending answers and approvals before any paid admission", { skip }, async t => {
	for (const change of ["answered", "new-park", "approval", "pending"]) {
		const f = await fixture(t), queued = await f.queue.getJob(f.meta.draftRunId);
		if (change === "answered") f.current.park = null;
		if (change === "new-park") f.current.park = { runId: "new-question", at: CLOCK + 1 };
		if (change === "approval") f.current.approval = { ok: true, request: { runId: "parent-run" } };
		if (change === "pending") await f.queue.add("github", { ...f.parent, console: { by: "rob" } }, { jobId: "human-answer" });
		const resolved = await f.runtime.resolve(queued.data, queued.id);
		assert.equal(resolved.data, undefined, change); assert.equal(resolved.result.reason, "answer-draft-unavailable", change); assert.equal(resolved.result.budgetReserved, false);
		assert.equal((await f.store.readMeta("parent-run")).status, "passed");
		assert.equal((await f.store.readMeta("parent-run")).passReason, change === "approval" ? "approval" : "source-unavailable");
	}
	const f = await fixture(t), queued = await f.queue.getJob(f.meta.draftRunId); f.current.approval = { error: "connection" };
	await assert.rejects(f.runtime.resolve(queued.data, queued.id), /current source could not be read/);
	assert.equal((await f.store.readMeta("parent-run")).status, "queued", "an infrastructure read failure preserves the retryable intent");
});

test("forge account or API-root rotation cannot send a fresh job credential to a captured old origin", { skip }, async t => {
	for (const changed of [{ apiUrl: "https://new-forge.example/sub" }, { apiUrl: "https://gitlab.example/another-scope" }, { selfId: 100 }]) {
		const f = await fixture(t, { kind: "gitlab" }), queued = await f.queue.getJob(f.meta.draftRunId); f.current.identity = { ...f.current.identity, ...changed };
		let minted = 0;
		const process = makeProcessor({ now: () => CLOCK, recordRun: () => {}, deps: { answerDraftRuntime: f.runtime, mintToken: async () => { minted++; throw new Error("must not mint after identity rotation"); } } });
		const result = await process(queued, "token", new AbortController().signal);
		assert.equal(result.reason, "answer-draft-config-changed"); assert.equal(result.budgetReserved, false); assert.equal(minted, 0); assert.equal((await f.store.readMeta("parent-run")).passReason, "config-changed");
	}
	const canonical = await fixture(t, { kind: "gitlab" }), queued = await canonical.queue.getJob(canonical.meta.draftRunId); canonical.current.identity = { selfId: "99", apiUrl: "https://GITLAB.example/sub/" };
	assert.ok((await canonical.runtime.resolve(queued.data, queued.id)).data, "URL host case/trailing slash and numeric id spelling do not manufacture drift");
	canonical.current.identityError = true;
	await assert.rejects(canonical.runtime.resolve(queued.data, queued.id), /current forge identity could not be read/);
	assert.equal((await canonical.store.readMeta("parent-run")).status, "running", "a current identity read outage remains infrastructure-retryable");
});

test("a completed draft answer refuses before every token, comment or approval path and settles held state after forge rotation", { skip }, async t => {
	for (const status of ["drafted", "sent"]) for (const changed of [{ apiUrl: "https://new-forge.example/sub" }, { apiUrl: "https://gitlab.example/another-scope" }, { selfId: 100 }]) {
		const f = await fixture(t, { kind: "gitlab" }), value = { question: PRIVATE, draft: "Run npm test.", sources: [answerStandingSource(standing)] }, digest = answerConfigDigest(value);
		assert.equal(await f.store.saveDraft("parent-run", { ...value, digest }), true);
		if (status === "sent") assert.equal(await f.store.markSent("parent-run", { by: "rob", at: CLOCK, draftRunId: f.meta.draftRunId, draftDigest: digest, disposition: "as-drafted" }), true);
		const data = { ...f.parent, parkedReply: true, resume: true, console: { by: "rob", draftRunId: f.meta.draftRunId, draftDigest: digest, draftSourceRunId: "parent-run" }, trigger: { deliveryId: "console-reply", comment: { body: value.draft } } };
		const calls = [], records = [], settled = [], forbidden = label => async () => { calls.push(label); throw new Error(`must not reach ${label} on another forge`); };
		const deps = { answerDraftRuntime: f.runtime, answerDraftStore: f.store, mintToken: forbidden("mint"), comment: forbidden("comment"), statusPost: forbidden("status"), settleHeld: async args => { settled.push(args); return { resumed: 0 }; }, approvalRuntime: { before: forbidden("approval") } };
		assert.equal(await checkDraftAnswerSource(data, deps), null, "the completed draft can continue under its original source identity");
		f.current.identity = { ...f.current.identity, ...changed };
		const process = makeProcessor({ now: () => CLOCK, recordRun: args => records.push(args), deps });
		const result = await process({ id: "console-reply", data }, "token", new AbortController().signal);
		assert.equal(result.reason, "answer-draft-config-changed"); assert.equal(result.budgetReserved, false); assert.deepEqual(calls, []); assert.equal(records.length, 1); assert.equal(settled.length, 1); assert.equal(settled[0].result, result); assert.equal(records[0].project, null);
		assert.equal((await runJob(data, deps)).reason, "answer-draft-config-changed", "standalone runJob also checks before approval policy can post"); assert.deepEqual(calls, []);
	}
	const f = await fixture(t), value = { question: PRIVATE, draft: "Run npm test.", sources: [answerStandingSource(standing)] }, digest = answerConfigDigest(value); await f.store.saveDraft("parent-run", { ...value, digest });
	f.current.identityError = true;
	const data = { ...f.parent, parkedReply: true, console: { by: "rob", draftRunId: f.meta.draftRunId, draftDigest: digest, draftSourceRunId: "parent-run" } };
	await assert.rejects(runJob(data, { answerDraftRuntime: f.runtime, answerDraftStore: f.store }), e => e instanceof InfraRetry && e.reason === "container-never-started" && e.budgetReserved === false);
});

test("source refusal closes and counts the old inbox without carrying private late messages, preserving its pre-settle project snapshot", { skip }, async t => {
	const f = await fixture(t, { kind: "gitlab" }), value = { question: PRIVATE, draft: "Run npm test.", sources: [answerStandingSource(standing)] }, digest = answerConfigDigest(value); await f.store.saveDraft("parent-run", { ...value, digest });
	const id = `private-reply-${randomBytes(8).toString("hex")}`, targetKey = steerTargetKey({ kind: "gitlab", repo: "acme/web", targetType: "issue", number: 7 });
	f.cleanups.push(async () => { await f.redis.del(...Object.values(inboxKeys(id)), steerOpenKey(id)); await f.redis.zrem(targetKey, id); });
	assert.deepEqual(await registerLive({ redis: f.redis, runId: id, targetKey, host: "worker", now: () => CLOCK }), { ok: true });
	assert.deepEqual(await preseedInbox({ redis: f.redis, runId: id, entries: [{ v: 1, id: "a".repeat(32), mode: "steer", source: "forge", author: { kind: "forge", id: 88, association: "MEMBER" }, text: "PRIVATE late message", at: CLOCK, deliveryId: "late-private", hop: 1 }], now: () => CLOCK }), { seeded: 1 });
	const data = { ...f.parent, parkedReply: true, steer: true, console: { by: "rob", draftRunId: f.meta.draftRunId, draftDigest: digest, draftSourceRunId: "parent-run" } };
	f.current.identity = { ...f.current.identity, apiUrl: "https://another-forge.example" };
	let projects = [{ id: "web", members: ["gitlab:acme/web"] }], reads = 0, released = 0; const records = [], posts = [], logs = [];
	const onLateForge = makeLateForge({ redis: f.redis, queues: { shared: () => f.queue }, now: () => CLOCK, release: async () => { released++; }, comment: async () => posts.push("comment"), enqueue: async () => posts.push("enqueue"), canPublish: async () => f.runtime.checkSource((await f.store.privateInput("parent-run")).source), log: (...args) => logs.push(args) });
	const process = makeProcessor({ redis: f.redis, now: () => CLOCK, projects: () => { reads++; return projects; }, recordRun: args => records.push(args), deps: { answerDraftRuntime: f.runtime, answerDraftStore: f.store, onLateForge, settleHeld: async () => { projects = [{ id: "moved", members: ["gitlab:acme/web"] }]; return { resumed: 0 }; } } });
	const result = await process({ id, data }, "token", new AbortController().signal);
	assert.equal(result.reason, "answer-draft-config-changed"); assert.equal(reads, 1); assert.equal(records[0].project, "web", "the free-boundary project is captured before settlement awaits a live edit");
	assert.deepEqual(result.steered, { delivered: 0, late: 1, withdrawn: 0 }); assert.equal((await readInbox({ redis: f.redis, runId: id })).closed, true);
	assert.equal(await f.redis.get(steerOpenKey(id)), null); assert.equal(await f.redis.zscore(targetKey, id), null); assert.equal(released, 1); assert.deepEqual(posts, [], "no private fallback or reply is sent to the new forge"); assert.ok(!JSON.stringify(logs).includes("PRIVATE late message"));
});

test("store binding rejects stale drops, preserves actor accounting, and no late worker can resurrect sent or dropped text", { skip }, async t => {
	const f = await fixture(t), source = answerStandingSource(standing), value = { question: PRIVATE, draft: "Run npm test.", sources: [source] }, digest = answerConfigDigest(value);
	assert.equal(await f.store.saveDraft("parent-run", { ...value, digest }), true);
	assert.equal(await f.store.drop("parent-run", { draftRunId: f.meta.draftRunId, draftDigest: "0".repeat(64) }), false);
	assert.equal(await f.store.markSent("parent-run", { by: "rob", draftRunId: f.meta.draftRunId, at: CLOCK, disposition: "as-drafted" }), false);
	assert.equal(await f.store.markSent("parent-run", { by: "rob", draftRunId: f.meta.draftRunId, draftDigest: "0".repeat(64), at: CLOCK, disposition: "as-drafted" }), false);
	assert.equal(await f.store.markSent("parent-run", { by: "rob", draftRunId: f.meta.draftRunId, draftDigest: digest, at: CLOCK, disposition: "as-drafted" }), true);
	assert.equal(await f.store.privateDraft("parent-run"), null); const meta = await f.store.readMeta("parent-run"); assert.equal(meta.by, "rob"); assert.equal(meta.disposition, "as-drafted");
	assert.equal(await f.store.saveDraft("parent-run", { ...value, digest }), false); assert.equal(await f.store.update("parent-run", { status: "running" }), false);
	const keys = await f.redis.keys(`${f.prefix}*`); for (const key of keys) assert.ok(await f.redis.pttl(key) > 0, "every answerer key has bounded retention");
});

test("a terminal pass or offered draft cannot be overwritten by a late overlapping attempt", { skip }, async t => {
	for (const status of ["passed", "drafted"]) {
		const f = await fixture(t), value = { question: PRIVATE, draft: "Run npm test.", sources: [answerStandingSource(standing)] }, digest = answerConfigDigest(value);
		if (status === "passed") await f.store.update("parent-run", { status, passReason: "uncovered" });
		else assert.equal(await f.store.saveDraft("parent-run", { ...value, digest }), true);
		const changed = { ...value, draft: "Replace the reviewed words" }, changedDigest = answerConfigDigest(changed);
		assert.equal(await f.store.saveDraft("parent-run", { ...changed, digest: changedDigest }), false);
		assert.equal(await f.store.update("parent-run", { status: "running" }), false);
		assert.equal((await f.store.readMeta("parent-run")).status, status);
		assert.equal((await f.store.privateDraft("parent-run"))?.draft ?? null, status === "drafted" ? value.draft : null);
	}
});

test("valid individual citations cannot create an unreadable oversized metadata or private draft row", { skip }, async t => {
	const f = await fixture(t), sources = Array.from({ length: 32 }, (_, n) => ({ id: n.toString(16).padStart(64, "0"), kind: "repository", name: `docs/${n}.md`, revision: SHA, url: `https://sources.example/${"x".repeat(1900)}/${n}` }));
	const oversized = { question: "Which procedure?", draft: "A sourced procedure", sources };
	assert.equal(await f.store.saveDraft("parent-run", { ...oversized, digest: answerConfigDigest(oversized) }), false);
	assert.equal((await f.store.readMeta("parent-run")).status, "queued"); assert.equal(await f.store.privateDraft("parent-run"), null);
	assert.equal(await f.store.update("parent-run", { sources }), false); assert.deepEqual((await f.store.readMeta("parent-run")).sources, []);
	const admitted = { ...oversized, sources: sources.slice(0, 5) };
	assert.equal(await f.store.saveDraft("parent-run", { ...admitted, digest: answerConfigDigest(admitted) }), true);
	assert.deepEqual((await f.store.privateDraft("parent-run")).sources, admitted.sources, "an admitted row round trips with every source byte intact");
	const meta = { ...(await f.store.readMeta("parent-run")), runId: "large-capture", sources };
	assert.equal(await f.store.capture({ runId: "large-capture" }, meta), false); assert.equal(await f.store.readMeta("large-capture"), null);
});

test("collector requires the runner's authenticated receipt and refuses swapped output and source-free drafts", { skip }, async t => {
	const f = await fixture(t), queued = await f.queue.getJob(f.meta.draftRunId), job = (await f.runtime.resolve(queued.data, queued.id)).data;
	const outboxDir = join(f.root, "result"); mkdirSync(outboxDir);
	const out = { version: 1, verdict: "drafted", question: PRIVATE, draft: "Do it", category: "how-to", confidence: 1, answerableConfidence: 1, probabilities: Object.fromEntries(["convention", "how-to", "decided", "product", "security", "money", "scope", "approval", "uncovered"].map(c => [c, Number(c === "how-to")])), sources: [] };
	writeFileSync(join(outboxDir, "answer-draft.json"), JSON.stringify(out));
	await f.runtime.collect({ job, prepared: { outboxDir, sha: SHA, answerDraftDigest: answerConfigDigest(out) }, completed: true });
	assert.equal((await f.store.readMeta("parent-run")).passReason, "output-invalid"); assert.equal(await f.store.privateDraft("parent-run"), null);
	const logsDir = join(f.root, "logs"), key = "a".repeat(64), receipt = "b".repeat(64);
	const sink = makeLogSink({ logsDir, enabled: false })("draft", { exitKey: key });
	const unsigned = JSON.stringify({ event: "exit", code: 0, reason: "stop", answerDraftDigest: receipt });
	const mac = createHmac("sha256", key).update(unsigned).digest("hex"); sink.write(`${unsigned.slice(0, -1)},"auth":"${mac}"}\n`);
	const parsed = await sink.close(); assert.equal(parsed.answerDraftDigest, receipt);
	const keyless = makeLogSink({ logsDir, enabled: false })("keyless"); keyless.write(unsigned); assert.equal((await keyless.close()).answerDraftDigest, undefined);
});
