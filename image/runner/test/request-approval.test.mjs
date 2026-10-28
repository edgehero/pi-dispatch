import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { applyApprovalDecision, approvalDecisionFromEvent, approvalShadow, approvalTerminal, createRequestApproval, parseApprovalEnv } from "../src/request-approval.mjs";
import { decideExit } from "../src/outcome.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { trackPiRefreshes } from "./helpers/track-pi-refreshes.mjs";

const decision = { requestId: "r1", action: "deploy:staging", toolCallId: "call1", decision: "approved" };
function fixture() {
	const dir = tempDir("approval-");
	const manager = SessionManager.create("/workspace", dir);
	manager.appendMessage({ role: "user", content: "work", timestamp: 1 });
	const caller = manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "call1", name: "request_approval", arguments: { action: "deploy:staging", summary: "private summary" } }], stopReason: "toolUse", timestamp: 2 });
	const target = manager.appendMessage({ role: "toolResult", toolName: "request_approval", toolCallId: "call1", content: [{ type: "text", text: "pending" }], details: { approval: { action: "deploy:staging", toolCallId: "call1" } }, isError: false, timestamp: 3 });
	return { manager, dir, caller, target };
}

test("approval configuration is bounded and refuses malformed decisions and actions", () => {
	assert.deepEqual(parseApprovalEnv({}), { approvalGates: [], approvalDecision: null });
	assert.equal(parseApprovalEnv({ PI_APPROVAL_GATES: '["deploy:staging"]', PI_APPROVAL_DECISION: JSON.stringify(decision) }).approvalDecision.decision, "approved");
	for (const gates of ['{}', '["bad action"]', '["push","push"]', 'null']) assert.throws(() => parseApprovalEnv({ PI_APPROVAL_GATES: gates }), /invalid approval/);
	assert.throws(() => parseApprovalEnv({ PI_APPROVAL_DECISION: "null" }), /invalid approval/);
	for (const invalid of [{ ...decision, decision: "yes" }, { ...decision, action: "unknown" }, { ...decision, toolCallId: "\n" }, { ...decision, extra: 1 }]) assert.throws(() => parseApprovalEnv({ PI_APPROVAL_GATES: '["deploy:staging"]', PI_APPROVAL_DECISION: JSON.stringify(invalid) }), /invalid approval/);
});

test("declared tool terminates, unknown action refuses without parking, metadata excludes summary", async () => {
	const gate = createRequestApproval(["deploy:staging"]);
	let tool;
	let hook;
	const tools = [];
	gate.factories[0].factory({ registerTool(t) { tool = t; tools.push({ ...t, sourceInfo: { path: "<inline:job-request-approval>" } }); }, on(event, h) { hook = h; }, getAllTools: () => tools });
	assert.equal((await tool.execute("call1", { action: "unknown", summary: "secret" })).isError, true);
	assert.equal(gate.state.called, false);
	const result = await tool.execute("call1", { action: "deploy:staging", summary: "private" });
	assert.equal(result.terminate, true);
	const terminal = { role: "toolResult", toolName: "request_approval", toolCallId: "call1", ...result };
	assert.deepEqual(approvalTerminal(terminal, gate.state), { action: "deploy:staging", toolCallId: "call1" });
	assert.equal(JSON.stringify(result).includes("private"), false);
	assert.equal(approvalTerminal({ ...terminal, isError: true }, gate.state), null);
	assert.equal(approvalTerminal({ ...terminal, toolCallId: "other" }, gate.state), null);
	assert.equal(approvalTerminal({ role: "assistant" }, gate.state), null);
	assert.equal(approvalShadow(tools), null);
	tools[0].sourceInfo.path = "/workspace/.pi/extensions/evil.js";
	assert.equal(approvalShadow(tools), "request_approval");
	assert.equal(hook({ toolName: "request_approval" }).block, true);
});

for (const kind of ["approved", "declined", "question"]) test(`pinned pi restart replays ${kind} as the original tool result without rewriting history`, () => {
	const { manager, dir, target, caller } = fixture();
	const file = manager.getSessionFile();
	const resumed = SessionManager.open(file, dir, "/workspace");
	applyApprovalDecision(resumed, { ...decision, decision: kind, text: "human text" });
	const reopened = SessionManager.open(file, dir, "/workspace");
	const result = reopened.buildSessionContext().messages.at(-1);
	assert.equal(result.toolCallId, "call1");
	assert.equal(result.toolName, "request_approval");
	assert.equal(result.isError, false);
	assert.equal(JSON.parse(result.content[0].text).decision, kind);
	assert.equal(reopened.getEntry(target).message.content[0].text, "pending");
	assert.throws(() => applyApprovalDecision(reopened, decision), /does not match/);
	reopened.appendCompaction("retained tools", caller, 0);
	assert.equal(JSON.parse(reopened.buildSessionContext().messages.at(-1).content[0].text).decision, kind);
});

test("mismatched, superseded and compacted approval targets refuse before a provider is called", () => {
	for (const change of [{ action: "deploy:production" }, { toolCallId: "other" }]) {
		const { manager } = fixture();
		assert.throws(() => applyApprovalDecision(manager, { ...decision, ...change }), /does not match/);
	}
	const { manager } = fixture();
	manager.appendMessage({ role: "user", content: "later", timestamp: 4 });
	assert.throws(() => applyApprovalDecision(manager, decision), /does not match/);
	const compacted = fixture().manager;
	compacted.appendCompaction("all prior content", null, 0);
	assert.throws(() => applyApprovalDecision(compacted, decision), /does not match/);
});

test("approval parks only below budget and rejection outcomes", () => {
	assert.deepEqual(decideExit({ approval: true }), { code: 0, reason: "awaiting-approval" });
	assert.equal(decideExit({ approval: true, meterStop: "cost-cap" }).reason, "cost-cap");
	assert.equal(decideExit({ approval: true, rejected: { code: 2, reason: "refused" } }).reason, "refused");
});

for (const kind of ["approved", "declined", "question"]) test(`real pinned agent parks, reloads, and sends ${kind} to the scripted model`, async () => {
	const pi = await import("@earendil-works/pi-coding-agent");
	trackPiRefreshes(pi.ModelRuntime);
	const ai = await import("@earendil-works/pi-ai");
	const { mkdirSync, writeFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { buildLoadedResourceLoader } = await import("../src/loader.mjs");
	const { createJobModelRuntime } = await import("../src/model-runtime.mjs");
	const root = tempDir("approval-agent-");
	const agentDir = join(root, "agent");
	const jobPiDir = join(root, "pi");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(jobPiDir, "skills"), { recursive: true });
	const guardrailsPath = join(root, "rules.md");
	const outboxProtocolPath = join(root, "outbox.md");
	writeFileSync(guardrailsPath, "## Rules\n");
	writeFileSync(outboxProtocolPath, "## Outbox\n");
	const provider = `approval-${kind}`;
	const api = `approval-api-${kind}`;
	const modelsPath = join(agentDir, "models.json");
	writeFileSync(modelsPath, JSON.stringify({ providers: { [provider]: { api, apiKey: "fake-key", baseUrl: "http://127.0.0.1:1", models: [{ id: "fake", name: "fake", api, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 }] } } }));
	const runtime = await createJobModelRuntime({ ModelRuntime: pi.ModelRuntime, agentDir, modelsPath });
	const contexts = [];
	runtime.registerProvider(provider, { api, streamSimple(model, context) {
		contexts.push(context.messages);
		const content = contexts.length === 1 ? [{ type: "toolCall", id: "call1", name: "request_approval", arguments: { action: "deploy:staging", summary: "private summary" } }] : [{ type: "text", text: "decision received" }];
		const reason = contexts.length === 1 ? "toolUse" : "stop";
		const stream = ai.createAssistantMessageEventStream();
		queueMicrotask(() => stream.push({ type: "done", reason, message: { role: "assistant", content, api, provider, model: "fake", stopReason: reason, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }));
		return stream;
	} });
	await runtime.refresh({ allowNetwork: false });
	const gate = createRequestApproval(["deploy:staging"]);
	const loader = await buildLoadedResourceLoader({ cwd: root, jobPiDir, guardrailsPath, outboxProtocolPath, packagePaths: [], extensionFactories: gate.factories });
	const manager = pi.SessionManager.create(root, join(root, "sessions"));
	const options = { cwd: root, agentDir, modelRuntime: runtime, model: runtime.getModel(provider, "fake"), settingsManager: pi.SettingsManager.inMemory({ telemetry: false }), resourceLoader: loader, noTools: "builtin" };
	const first = (await pi.createAgentSession({ ...options, sessionManager: manager })).session;
	try {
		await first.prompt("ask permission");
		assert.equal(contexts.length, 1, "terminate prevents a second model call while awaiting approval");
		assert.deepEqual(approvalTerminal(manager.buildSessionContext().messages.at(-1), gate.state), { action: "deploy:staging", toolCallId: "call1" });
	} finally { first.dispose(); }
	const reopened = pi.SessionManager.open(manager.getSessionFile(), join(root, "sessions"), root);
	writeFileSync(join(root, "event.json"), JSON.stringify({ comment: { body: "private human explanation" } }));
	applyApprovalDecision(reopened, approvalDecisionFromEvent({ ...decision, decision: kind }, { jobDir: root }));
	const second = (await pi.createAgentSession({ ...options, sessionManager: reopened })).session;
	try {
		await second.prompt("Continue from the approval decision.");
		assert.equal(contexts.length, 2);
		const result = contexts[1].find((message) => message.role === "toolResult" && message.toolCallId === "call1");
		assert.equal(JSON.parse(result.content[0].text).decision, kind);
		assert.equal(JSON.parse(result.content[0].text).text, "private human explanation");
		assert.equal(result.isError, false);
	} finally { second.dispose(); }
});


test("private decision text comes only from one bounded event-file read before replay", () => {
	let reads = 0;
	const readFile = (path, encoding) => { reads++; assert.equal(path, "/job/event.json"); assert.equal(encoding, "utf8"); return JSON.stringify({ comment: { body: "the person's actual explanation" } }); };
	assert.equal(approvalDecisionFromEvent(null, { readFile }), null);
	assert.equal(reads, 0, "unarmed jobs do not read an event");
	assert.deepEqual(approvalDecisionFromEvent({ ...decision, text: "env text must not win" }, { jobDir: "/job", readFile }), { ...decision, text: "the person's actual explanation" });
	assert.equal(reads, 1);
	for (const body of [null, {}, { comment: {} }, { comment: { body: 7 } }, { comment: { body: "x".repeat(8193) } }, { comment: { body: "é".repeat(4097) } }]) assert.throws(() => approvalDecisionFromEvent(decision, { jobDir: "/job", readFile: () => JSON.stringify(body) }), (error) => error.piDispatchReason === "approval-decision-invalid" && !error.message.includes("é"));
	assert.equal(approvalDecisionFromEvent(decision, { jobDir: "/sandbox/job", readFile: (path) => { assert.equal(path, "/sandbox/job/event.json"); return '{"comment":{"body":""}}'; } }).text, "");
	assert.throws(() => approvalDecisionFromEvent(decision, { jobDir: "/job", readFile: () => { throw new Error("private human text"); } }), (error) => error.piDispatchReason === "approval-decision-invalid" && !error.message.includes("private human text"));
});
