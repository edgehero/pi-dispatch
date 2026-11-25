import assert from "node:assert/strict";
import { test } from "node:test";
import { FORGE_KINDS } from "../src/forges.mjs";
import { parseTriggersDocument, triggersFileVersionFor } from "../src/triggers.mjs";
import { ANSWER_CLASSIFICATIONS, validateAnswerRules, validateStandingAnswers, answerStandingSource, answerConfigDigest, answerRuleConfigDigest, makeAnswerDraftStore } from "../src/answerer.mjs";
import { consoleDraftOf, answerTrailComment } from "../src/console-answer.mjs";
import { enqueueAnswerDraftJob, enqueueForgeJob } from "../src/queue.mjs";
import { makeAnswerDraftRuntime, readAnswerPending, stageAnswerDraft } from "../src/answerer-runtime.mjs";
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

// Issue #1013: an answer rule declares its models' provider keys as a trigger declares its main model's, in `secrets`.
const keyed = { ...rule, model: "openai/gpt-5-mini", decisionModel: "anthropic/claude-haiku-4-5", secrets: { OPENAI_API_KEY: "op://ci/openai", ANTHROPIC_API_KEY: "op://ci/anthropic" }, secretsProfile: "vault" };
const loadRules = (rules, version = 12) => parseTriggersDocument(JSON.stringify({ version, triggers: [], answerRules: rules }), "/config");

test("issue #1013: an answer rule's declared provider keys load by run.secrets' own rules, OAuth and bearer variables refuse, and each refusal names the rule and the variable", () => {
	assert.deepEqual(loadRules([keyed]).answerRules, [keyed]);
	assert.deepEqual(validateAnswerRules([keyed]), [keyed], "the rule validator admits both fields");
	for (const [changed, message] of [
		[{ secrets: { ANTHROPIC_OAUTH_TOKEN: "op://ci/oauth" } }, 'answer rule "help": secrets key "ANTHROPIC_OAUTH_TOKEN" is a subscription login (an OAuth token variable), not a provider\'s API key'],
		[{ secrets: { EXAMPLE_AUTH_TOKEN: "op://ci/bearer" } }, 'answer rule "help": secrets key "EXAMPLE_AUTH_TOKEN" is a bearer token variable, not a provider\'s API key'],
		// No key any model could take: the jobs would run on this host's key while the file reads as though they did not.
		[{ secrets: { OPENAI_APIKEY: "op://ci/openai" } }, 'answer rule "help": secrets key "OPENAI_APIKEY" is no provider\'s API-key variable (did you mean "OPENAI_API_KEY"?) --'],
		[{ secrets: { DATABASE_URL: "op://ci/db" } }, 'answer rule "help": secrets key "DATABASE_URL" is no provider\'s API-key variable --'],
		[{ secrets: { COPILOT_GITHUB_TOKEN: "op://ci/copilot" } }, 'answer rule "help": secrets key "COPILOT_GITHUB_TOKEN" is the key variable of github-copilot, which needs host authentication, so it is never a declared key'],
		[{ secrets: { QWEN_TOKEN_PLAN_API_KEY: "op://ci/qwen" } }, 'answer rule "help": secrets key "QWEN_TOKEN_PLAN_API_KEY" is a variable pi reads for qwen-token-plan and qwen-token-plan-individual, not the one their API keys are written under (QWEN_TOKEN_PLAN_TEAM_API_KEY and QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY)'],
		[{ secrets: { GITHUB_TOKEN: "op://ci/forge" } }, 'answer rule "help": secrets key "GITHUB_TOKEN" is reserved'],
		[{ secrets: { ANTHROPIC_AUTH_TOKEN: "op://ci/bearer" } }, 'answer rule "help": secrets key "ANTHROPIC_AUTH_TOKEN" is reserved'],
		[{ secrets: ["OPENAI_API_KEY"] }, 'answer rule "help": secrets must be an object'],
		[{ secrets: {} }, 'answer rule "help": secrets is empty'],
		[{ secrets: { OPENAI_API_KEY: "" } }, 'answer rule "help": secrets.OPENAI_API_KEY must be a non-empty string reference'],
		[{ secrets: { OPENAI_API_KEY: "-op" } }, 'answer rule "help": secrets.OPENAI_API_KEY must not start with "-"'],
		[{ secrets: { "OPENAI-KEY": "op://ci/openai" } }, 'answer rule "help": secrets key "OPENAI-KEY" is not an environment variable name'],
		[{ secretsProfile: "vault,two" }, 'answer rule "help": secretsProfile "vault,two" may use letters, digits, dot, dash and underscore only'],
		[{ secretsProfile: 7 }, 'answer rule "help": secretsProfile must be a non-empty string'],
		[{ secrets: undefined }, 'answer rule "help": secretsProfile is set but secrets names nothing --'],
	]) {
		assert.throws(() => loadRules([{ ...keyed, ...changed }]), (error) => error.piDispatchConfig === true && error.message.startsWith(message) && error.message.endsWith(": /config") && !error.message.includes("run."), `${JSON.stringify(changed)} -> ${message}`);
	}
	// A provider-key name is the rule's to declare only through the two fields: anything else is still an unknown field.
	assert.throws(() => validateAnswerRules([{ ...rule, secretFiles: { OPENAI_API_KEY: "op://ci/openai" } }]));
});

test("issue #1013: a rule declaring a key needs triggers file version 12, so an older loader keeps the file it had, and the writer stamps it", () => {
	assert.throws(() => loadRules([keyed], 11), (error) => error.message === 'triggers file: top-level "answerRules" holds a value that needs triggers file version 12, and the file declares 11: /config');
	assert.throws(() => parseTriggersDocument(JSON.stringify({ triggers: [], answerRules: [{ ...keyed, secretsProfile: undefined }] }), "/config"), /"answerRules" holds a value that needs triggers file version 12, and the file declares 1:/);
	assert.equal(triggersFileVersionFor({ triggers: [], answerRules: [rule, keyed] }), 12);
	assert.equal(triggersFileVersionFor({ triggers: [], answerRules: [rule] }), 1, "a rule without either field keeps the file's version");
	assert.throws(() => loadRules([keyed], 13), (error) => error.newer === true, "a file a newer build wrote defers");
});

test("issue #1013: an answer draft job carries its rule's declared keys of its main and decision providers, and withholds the rest by name", async () => {
	const keyNames = (provider) => ({ openai: ["OPENAI_API_KEY"], anthropic: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] })[provider] ?? [];
	const draft = (secrets) => {
		const doc = { version: 12, triggers: [], answerRules: [{ ...keyed, secrets }], standingAnswers: [] };
		const parsed = parseTriggersDocument(JSON.stringify(doc), "/t.json"), at = 1_900_000_000_000;
		const source = { kind: "github", repo: "acme/web", target: { type: "issue", number: 7 }, selfId: 99, apiUrl: "https://api.github.com", questionCommentId: "123", startedAt: at - 1000, parkedAt: at };
		const input = { version: 1, runId: "parent", ruleId: "help", configDigest: answerRuleConfigDigest(parsed, parsed.answerRules[0]), project: "web", source };
		const logs = [];
		const runtime = makeAnswerDraftRuntime({ triggersPath: "/t.json", readFile: () => JSON.stringify(doc), providerKeyNames: keyNames, log: (event, fields) => logs.push({ event, fields }),
			store: { privateInput: async () => input, readMeta: async () => ({ draftRunId: "draft-1", status: "queued" }), update: async () => true },
			identity: async () => ({ selfId: 99, apiUrl: "https://api.github.com" }), readParkedInfo: async () => ({ runId: "parent", at }), readApproval: async () => ({ ok: true, request: null }), readPendingAnswer: async () => ({ jobId: null }) });
		return runtime.resolve({ kind: "answer-draft", answerDraft: { runId: "parent", ruleId: "help" } }, "draft-1").then((got) => ({ got, logs }));
	};
	const both = await draft({ OPENAI_API_KEY: "op://ci/openai", ANTHROPIC_API_KEY: "op://ci/anthropic", GROQ_API_KEY: "op://ci/groq" });
	assert.equal(both.got.data.provider, "openai");
	assert.deepEqual(both.got.data.answerDecisionModel, { provider: "anthropic", id: "claude-haiku-4-5" });
	assert.deepEqual(both.got.data.secrets, { OPENAI_API_KEY: "op://ci/openai", ANTHROPIC_API_KEY: "op://ci/anthropic" });
	assert.equal(both.got.data.secretsProfile, "vault");
	assert.equal(both.got.data.secretBundle, false, "a project bundle still never reaches a draft");
	assert.deepEqual(both.logs, [{ event: "declared_key_withheld", fields: { rule: "help", names: ["GROQ_API_KEY"] } }], "names only, never a reference");
	// A rule naming no key either provider reads gives the job neither field, so it keeps the host's credentials.
	const none = await draft({ GROQ_API_KEY: "op://ci/groq" });
	assert.equal("secrets" in none.got.data || "secretsProfile" in none.got.data, false);
});

test("a standing answer's forge prefix is FORGE_KINDS itself: every forge loads, anything else refuses, and no copy of the list is written out", () => {
	for (const kind of FORGE_KINDS) assert.deepEqual(validateStandingAnswers([{ ...standing, repo: `${kind}:acme/web` }]), [{ ...standing, repo: `${kind}:acme/web` }], kind);
	for (const repo of ["local:acme/web", "bitbucket:acme/web", "GitHub:acme/web", "constructor:acme/web", ":acme/web", "github:acme", "github:acme/web:x", "github:gitlab:acme/web"]) {
		assert.throws(() => validateStandingAnswers([{ ...standing, repo }]), /a forge-qualified repository$/, repo);
	}
	// Two forge names side by side are a copy of the list: a forge added to FORGES would not reach it, and every
	// standing answer of that forge would refuse the whole triggers file.
	const names = FORGE_KINDS.join("|");
	assert.doesNotMatch(readFileSync(new URL("../src/answerer.mjs", import.meta.url), "utf8"), new RegExp(`\\b(?:${names})\\b\\W+\\b(?:${names})\\b`));
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

test("a draft job the provider refused is a failed draft, not a cap refusal (issue #950)", async () => {
	// The draft's pass reason is read off the stop's token by pattern; a provider's refusal names no cap or budget, so it must
	// not read as one, while a real cap stop still does.
	const updates = [];
	const runtime = makeAnswerDraftRuntime({ store: { update: async (runId, fields) => updates.push([runId, fields]) } });
	for (const reason of ["provider-stop-refusal", "cost-cap", "token_budget"]) await runtime.refused({ answerDraft: { runId: `draft-${reason}` } }, { outcome: "policy", reason });
	assert.deepEqual(updates, [
		["draft-provider-stop-refusal", { status: "failed", passReason: "failed" }],
		["draft-cost-cap", { status: "failed", passReason: "cap-refused" }],
		["draft-token_budget", { status: "failed", passReason: "cap-refused" }],
	]);
});
