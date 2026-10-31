import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTriggersDocument } from "../src/triggers.mjs";
import { ANSWER_CLASSIFICATIONS, validateAnswerRules, validateStandingAnswers, answerStandingSource, answerConfigDigest, makeAnswerDraftStore } from "../src/answerer.mjs";
import { consoleDraftOf, answerTrailComment } from "../src/console-answer.mjs";
import { enqueueAnswerDraftJob, enqueueForgeJob } from "../src/queue.mjs";
import { readAnswerPending, stageAnswerDraft } from "../src/answerer-runtime.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { mkdirSync, writeFileSync, symlinkSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const rule = { id: "help", projects: ["web"], categories: ["convention", "how-to", "decided"], confidence: 0.9, mode: "draft", flow: "answer", model: "test/chat", decisionModel: "test/classifier", maxCostUsd: "0.10" };
const standing = { id: "tests", title: "Test command", text: "Run npm test.", projects: ["web"], repo: "github:acme/web" };

test("reviewed answer rules and standing answers have strict scope and execution bounds", () => {
	assert.deepEqual(validateAnswerRules([rule]), [rule]); assert.deepEqual(validateStandingAnswers([standing]), [standing]);
	assert.deepEqual(parseTriggersDocument(JSON.stringify({ triggers: [], answerRules: [rule], standingAnswers: [standing] }), "/config").answerRules, [rule]);
	for (const changed of [{ categories: ["approval"] }, { categories: [] }, { confidence: 0.5 }, { confidence: Number.NaN }, { projects: [] }, { maxCostUsd: "unlimited" }, { mode: "send" }, { model: "role:chat" }, { mcp: ["forge"] }, { command: "post" }, { instructions: "widen" }]) assert.throws(() => validateAnswerRules([{ ...rule, ...changed }]));
	assert.throws(() => validateAnswerRules([rule, { ...rule, id: "overlap" }]));
	for (const changed of [{ repo: "acme/web" }, { repo: undefined }, { text: "x".repeat(8193) }, { projects: [] }, { script: "/bin/evil" }]) assert.throws(() => validateStandingAnswers([{ ...standing, ...changed }]));
	assert.equal(validateStandingAnswers([{ ...standing, adoptedAt: "2026-10-31T12:00:00.000Z" }])[0].adoptedAt, "2026-10-31T12:00:00.000Z");
	for (const adoptedAt of ["yesterday", "2026-10-31", "2026-10-31T12:00:00Z", "2026-02-30T12:00:00.000Z"]) assert.throws(() => validateStandingAnswers([{ ...standing, adoptedAt }]));
	for (const key of ["answer_rules", "AnswerRules", "standing_answers"]) assert.throws(() => parseTriggersDocument(JSON.stringify({ triggers: [], [key]: [] }), "/config"));
	const source = answerStandingSource(standing); assert.equal(source.id, answerConfigDigest({ kind: "standing", name: standing.title, revision: answerConfigDigest(standing) }));
});

test("only exact same-target real jobs answer a parent, and a partial pending scan cannot authorize a paid draft", async () => {
	const source = { kind: "github", repo: "acme/web", target: { type: "issue", number: 7 } }, parent = { id: "parent", data: source };
	const rows = [parent, { id: "helper", data: { ...source, purpose: "answer-draft" } }, { id: "different-repo", data: { ...source, repo: "other/web" } }];
	const queue = { getJobs: async ([state], start, end) => state === "wait" ? rows.slice(start, end + 1) : [] };
	assert.deepEqual(await readAnswerPending({ queues: [queue], source, runId: "parent" }), { jobId: null });
	rows.push({ id: "human-answer", data: source }); assert.deepEqual(await readAnswerPending({ queues: [queue], source, runId: "parent" }), { jobId: "human-answer" });
	assert.deepEqual(await readAnswerPending({ queues: [queue], source, runId: "parent", budget: 2 }), { unknown: true });
	assert.deepEqual(await readAnswerPending({ queues: [{}], source, runId: "parent" }), { unknown: true });
	assert.deepEqual(await readAnswerPending({ queues: [{ getJobs: async () => { throw new Error("connection"); } }], source, runId: "parent" }), { unreachable: true });
});

test("an unread pending intent index reports an outage instead of silently appearing empty", async () => {
	const store = makeAnswerDraftStore({ redis: { zrevrangebyscore: async () => { throw new Error("connection"); } } });
	assert.deepEqual(await store.publicSnapshot(), { state: "unavailable", rows: [], partial: true });
	await assert.rejects(store.pending(), /answer-store-unavailable/);
});

test("retained classifier evidence must agree with its selected category and confidence", async () => {
	const at = 1000, base = { v: 1, runId: "parent", ruleId: "help", draftRunId: "draft", status: "passed", passReason: "classify-only", at, draftExists: false, sources: [], category: "how-to", confidence: 1, probabilities: Object.fromEntries(ANSWER_CLASSIFICATIONS.map(c => [c, Number(c === "how-to")])) };
	let value = base;
	const store = makeAnswerDraftStore({ redis: { get: async () => JSON.stringify(value) }, now: () => at });
	assert.equal((await store.readMeta("parent")).category, "how-to");
	for (const changed of [{ category: "convention" }, { confidence: 0.9 }, { category: undefined }, { confidence: undefined }, { probabilities: { ...base.probabilities, money: 0.1 } }]) { value = { ...base, ...changed }; assert.equal(await store.readMeta("parent"), null); }
	value = { ...base }; delete value.probabilities; assert.equal((await store.readMeta("parent")).category, "how-to", "older rows can truthfully omit distribution evidence");
});

test("the configured flow is bounded reviewed text at the fresh base, never a symlink, host file or executable import", () => {
	const root = tempDir("answer-flow-"), workspace = join(root, "workspace"), flow = join(workspace, ".pi/skills/answer"); mkdirSync(flow, { recursive: true });
	const job = { answerDraft: { input: { version: 1, standing: [] } }, flow: "answer", maxCostUsd: "1" }, prepared = { jobDir: root, workspace, sha: "a".repeat(40) };
	assert.equal(stageAnswerDraft(job, prepared).reason, "answer-draft-refused", "a missing configured flow is loud");
	writeFileSync(join(flow, "SKILL.md"), "Cite the exact procedure. Never run scripts."); assert.equal(stageAnswerDraft(job, prepared).workspaceReadOnly, true);
	const input = JSON.parse(readFileSync(join(root, "answer-draft.json"))); assert.equal(input.flow.revision, prepared.sha); assert.ok(readFileSync(join(root, "prompt.md"), "utf8").includes(input.flow.text));
	writeFileSync(join(flow, "SKILL.md"), "x".repeat(16385)); assert.equal(stageAnswerDraft(job, prepared).reason, "answer-draft-refused");
	rmSync(join(flow, "SKILL.md")); writeFileSync(join(root, "host-secret"), "HOST"); symlinkSync(join(root, "host-secret"), join(flow, "SKILL.md")); assert.equal(stageAnswerDraft(job, prepared).reason, "answer-draft-refused");
	rmSync(flow, { recursive: true }); symlinkSync(root, flow); assert.equal(stageAnswerDraft(job, prepared).reason, "answer-draft-refused");
	assert.equal(stageAnswerDraft({ ...job, flow: "../../host-secret" }, prepared).reason, "answer-draft-refused");
});

test("draft queue jobs are deterministic, references only and do not use the answer semantic window", async () => {
	const added = []; const queue = { add: async (...args) => added.push(args) };
	const fields = { runId: "parent", ruleId: "help", draftRunId: `answer-draft-${"a".repeat(40)}` };
	assert.equal(await enqueueAnswerDraftJob(queue, fields), fields.draftRunId);
	assert.deepEqual(added[0][1], { kind: "answer-draft", purpose: "answer-draft", answerDraft: { runId: "parent", ruleId: "help" } });
	assert.equal(added[0][2].deduplication, undefined); assert.equal(added[0][2].attempts, 2);
	await assert.rejects(enqueueAnswerDraftJob(queue, { ...fields, draftRunId: "attacker" }));
});

test("console provenance is all-or-none and the queue preserves only validated draft fields", async () => {
	const meta = { by: "rob", draftRunId: "draft-1", draftDigest: "a".repeat(64), draftSourceRunId: "parent" };
	assert.equal(consoleDraftOf({ by: "rob" }), null); assert.equal(consoleDraftOf({ ...meta, draftDigest: "bad" }).invalid, true);
	const added = []; const queue = { add: async (name, data, opts) => { added.push(data); return { id: opts.jobId }; } };
	const job = { repo: "acme/web", target: { type: "issue", number: 7 }, flow: "work", console: { ...meta, text: "PRIVATE" }, trigger: { deliveryId: "console-12345678" } };
	await enqueueForgeJob(queue, "github", job); assert.deepEqual(added[0].console, meta);
	assert.ok(answerTrailComment("rob", "npm test", "draft-1").includes("Drafted in run draft-1."));
	assert.ok(!answerTrailComment("rob", "npm test", "bad @mention").includes("Drafted"));
});
