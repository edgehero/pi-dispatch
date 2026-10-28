import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseRunnerEnv } from "../src/config.mjs";
import { createJobModelRuntime } from "../src/model-runtime.mjs";
import { EXIT_POLICY } from "../src/outcome.mjs";
import { NOTE_MAX, PHASE_MAX, progressArgsError, REPORT_PROGRESS_TOOL, createReportProgress, reportProgressShadow } from "../src/report-progress.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { trackPiRefreshes } from "./helpers/track-pi-refreshes.mjs";

/**
 * Issue #644, the container's half: the report_progress tool a job armed with run.progress is offered, its reserved
 * name, and the env that arms it. The real-session tests drive a scripted offline model that calls the tool and read
 * the call back out of the transcript the worker's reducer tails. They skip like await-input.test.mjs where pi cannot
 * load, and fail instead under PI_DISPATCH_REQUIRE_LOADER_TESTS=1.
 */
let loaderModule;
let pi;
let piAi;
let importError;
try {
	loaderModule = await import("../src/loader.mjs");
	pi = await import("@earendil-works/pi-coding-agent");
	// registerProvider starts a refresh without awaiting it; settle its auth writes before temp-dir cleanup.
	trackPiRefreshes(pi.ModelRuntime);
	piAi = await import("@earendil-works/pi-ai");
} catch (error) {
	importError = error;
}
if (!pi && process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") throw new Error(`report-progress tests are REQUIRED here but pi could not be imported.\n${importError}`);
const skip = pi ? false : `pi not installed (node ${process.version}); CI runs these`;

const BASE = { PI_PROVIDER: "anthropic", PI_MODEL: "claude-sonnet-4-5-20250929", PI_MAX_TURNS: "10" };
const OURS = { path: "<inline:job-report-progress>" };
const THEIRS = { path: "/workspace/.pi/extensions/x.js" };

function fakeApi() {
	const tools = [];
	const handlers = {};
	return {
		tools,
		handlers,
		registerTool: (tool) => tools.push({ ...tool, sourceInfo: OURS }),
		on: (event, handler) => {
			handlers[event] = handler;
		},
		getAllTools: () => tools,
	};
}

test("PI_REPORT_PROGRESS: absent or empty is off, \"1\" is on, anything else is a config error", () => {
	assert.equal(parseRunnerEnv(BASE).reportProgress, false);
	assert.equal(parseRunnerEnv({ ...BASE, PI_REPORT_PROGRESS: "" }).reportProgress, false);
	assert.equal(parseRunnerEnv({ ...BASE, PI_REPORT_PROGRESS: "1" }).reportProgress, true);
	for (const bad of ["0", "true", "yes", " 1"]) {
		assert.throws(() => parseRunnerEnv({ ...BASE, PI_REPORT_PROGRESS: bad }), (error) => error.piDispatchExit === EXIT_POLICY, bad);
	}
});

test("progressArgsError: the contract's bounds, counted in code points, done never past total", () => {
	assert.equal(progressArgsError({ phase: "plan" }), null);
	assert.equal(progressArgsError({ phase: "x".repeat(PHASE_MAX), done: 0, total: 1, note: "n".repeat(NOTE_MAX) }), null);
	assert.equal(progressArgsError({ phase: "\u{1F600}".repeat(PHASE_MAX) }), null, "64 emoji are 128 UTF-16 units but 64 code points");
	assert.equal(progressArgsError({ phase: "p", done: 3, total: 3 }), null);
	assert.equal(progressArgsError({ phase: "p", done: 7 }), null, "done alone is fine");
	for (const bad of [
		null,
		[],
		"plan",
		{},
		{ phase: "" },
		{ phase: "   " },
		{ phase: 3 },
		{ phase: "x".repeat(PHASE_MAX + 1) },
		{ phase: "p", done: -1 },
		{ phase: "p", done: 1.5 },
		{ phase: "p", done: "1" },
		{ phase: "p", done: Number.MAX_SAFE_INTEGER + 1 },
		{ phase: "p", total: 0 },
		{ phase: "p", done: 4, total: 3 },
		{ phase: "p", note: 5 },
		{ phase: "p", note: "n".repeat(NOTE_MAX + 1) },
		{ phase: "p", extra: true },
	]) {
		assert.equal(typeof progressArgsError(bad), "string", JSON.stringify(bad));
	}
});

test("the tool records and goes on: \"recorded\" on valid input, an error result on invalid input, never terminate", async () => {
	const { factories } = createReportProgress();
	const api = fakeApi();
	factories[0].factory(api);
	assert.equal(api.tools.length, 1);
	const tool = api.tools[0];
	assert.equal(tool.name, REPORT_PROGRESS_TOOL);
	assert.deepEqual(tool.parameters.required, ["phase"]);
	assert.deepEqual(Object.keys(tool.parameters.properties), ["phase", "done", "total", "note"]);
	assert.equal(tool.parameters.additionalProperties, false);
	assert.equal(typeof tool.promptSnippet, "string", "the one system-prompt line pi lists the tool with");
	const ok = await tool.execute("t1", { phase: "tests", done: 2, total: 5, note: "half way" });
	assert.deepEqual(ok.content, [{ type: "text", text: "recorded" }]);
	assert.equal(ok.isError, undefined);
	assert.equal(ok.terminate, undefined);
	const bad = await tool.execute("t2", { phase: "tests", done: 6, total: 5 });
	assert.equal(bad.isError, true);
	assert.equal(bad.terminate, undefined);
	assert.match(bad.content[0].text, /^not recorded: /);
});

test("the tool_call hook refuses the name when another extension answers for it, and leaves every other call alone", () => {
	const { factories } = createReportProgress();
	const api = fakeApi();
	factories[0].factory(api);
	assert.equal(api.handlers.tool_call({ toolName: REPORT_PROGRESS_TOOL }), undefined, "ours: allowed");
	assert.equal(api.handlers.tool_call({ toolName: "read" }), undefined);
	api.tools[0] = { ...api.tools[0], sourceInfo: THEIRS };
	assert.equal(api.handlers.tool_call({ toolName: REPORT_PROGRESS_TOOL }).block, true);
});

test("reportProgressShadow names the tool only when another extension registered it", () => {
	assert.equal(reportProgressShadow([{ name: REPORT_PROGRESS_TOOL, sourceInfo: OURS }, { name: "read", sourceInfo: THEIRS }]), null);
	assert.equal(reportProgressShadow([{ name: REPORT_PROGRESS_TOOL, sourceInfo: THEIRS }]), REPORT_PROGRESS_TOOL);
	assert.equal(reportProgressShadow([]), null);
});

function sessionFixture() {
	const root = tempDir("pi-dispatch-progress-");
	const workspace = join(root, "workspace");
	const jobPi = join(root, "job", "pi");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(join(jobPi, "skills"), { recursive: true });
	const guardrailsPath = join(root, "HARD_RULES.md");
	writeFileSync(guardrailsPath, "## Operating rules\n");
	const outboxProtocolPath = join(root, "OUTBOX_PROTOCOL.md");
	writeFileSync(outboxProtocolPath, "## Outbox\n");
	return { root, workspace, jobPi, guardrailsPath, outboxProtocolPath };
}

const PROVIDER = "pi-dispatch-progress-fake";
const MODEL_ID = "fake-1";
const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/**
 * An offline model that answers from a script, one assistant message per call, and counts the calls.
 * Declared in a models.json of its own (a literal key, baseUrl on the unbound port 1) and served by a streamSimple
 * registered on the runtime, as usage-meter.integration.test.mjs does, so nothing is dialled.
 */
async function scriptedRuntime(root, api, script) {
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const modelsPath = join(agentDir, "models.json");
	const definition = { id: MODEL_ID, name: "fake", api, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 };
	writeFileSync(modelsPath, `${JSON.stringify({ providers: { [PROVIDER]: { apiKey: "pi-dispatch-progress-fake-key", baseUrl: "http://127.0.0.1:1", api, models: [definition] } } })}\n`);
	const modelRuntime = await createJobModelRuntime({ ModelRuntime: pi.ModelRuntime, agentDir, modelsPath });
	const calls = [];
	modelRuntime.registerProvider(PROVIDER, {
		api,
		streamSimple(model, context) {
			calls.push(context.messages.length);
			const content = script[Math.min(calls.length - 1, script.length - 1)];
			const stopReason = content.some((part) => part.type === "toolCall") ? "toolUse" : "stop";
			const stream = piAi.createAssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: stopReason, message: { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: USAGE, stopReason, timestamp: Date.now() } }));
			return stream;
		},
	});
	await modelRuntime.refresh({ allowNetwork: false });
	return { agentDir, modelRuntime, model: modelRuntime.getModel(PROVIDER, MODEL_ID), calls };
}

async function scriptedSession(f, { api, script, armed, extensionFactories = [] }) {
	const reportProgress = armed ? createReportProgress() : null;
	const factories = [...extensionFactories, ...(reportProgress?.factories ?? [])];
	const loader = await loaderModule.buildLoadedResourceLoader({ cwd: f.workspace, jobPiDir: f.jobPi, guardrailsPath: f.guardrailsPath, outboxProtocolPath: f.outboxProtocolPath, packagePaths: [], ...(factories.length > 0 && { extensionFactories: factories }) });
	const runtime = await scriptedRuntime(f.root, api, script);
	const sessionManager = pi.SessionManager.create(f.workspace, join(f.root, "sessions"));
	const { session } = await pi.createAgentSession({ cwd: f.workspace, agentDir: runtime.agentDir, modelRuntime: runtime.modelRuntime, model: runtime.model, settingsManager: pi.SettingsManager.inMemory({}), sessionManager, resourceLoader: loader, noTools: "builtin" });
	return { session, sessionManager, calls: runtime.calls };
}

const call = (id, args) => ({ type: "toolCall", id, name: REPORT_PROGRESS_TOOL, arguments: args });

test("a real session: the scripted model calls report_progress, the transcript holds the call and its result, and the run goes on", { skip }, async () => {
	const f = sessionFixture();
	const script = [
		[call("c1", { phase: "read the code", done: 1, total: 3, note: "starting" })],
		[call("c2", { phase: "read the code", done: 5, total: 3 })],
		[{ type: "text", text: "finished" }],
	];
	const { session, sessionManager, calls: modelCalls } = await scriptedSession(f, { api: "pi-dispatch-progress-api-1", script, armed: true });
	try {
		const tool = session.getAllTools().find((candidate) => candidate.name === REPORT_PROGRESS_TOOL);
		assert.ok(tool, "the inline factory's tool is not in the session");
		assert.equal(tool.sourceInfo?.path, "<inline:job-report-progress>", "run-job's shadow check reads this path");
		assert.ok(session.getActiveToolNames().includes(REPORT_PROGRESS_TOOL), "registered but not offered to the model");
		assert.equal(reportProgressShadow(session.getAllTools()), null);

		// pi lists each active tool's promptSnippet as one line of the system prompt (agent-session.js _rebuildSystemPrompt).
		assert.match(session.systemPrompt, /report_progress.*report the phase of your plan/, "the system prompt lists the tool when it is armed");
		await session.prompt("do the work");
		assert.equal(modelCalls.length, 3, "no terminate: the loop asked the model again after each call");

		const lines = readFileSync(sessionManager.getSessionFile(), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
		const messages = lines.filter((entry) => entry.type === "message").map((entry) => entry.message);
		const calls = messages.filter((m) => m.role === "assistant").flatMap((m) => m.content.filter((part) => part.type === "toolCall"));
		assert.deepEqual(calls.map((c) => [c.name, c.arguments]), [
			[REPORT_PROGRESS_TOOL, { phase: "read the code", done: 1, total: 3, note: "starting" }],
			[REPORT_PROGRESS_TOOL, { phase: "read the code", done: 5, total: 3 }],
		]);
		const results = messages.filter((m) => m.role === "toolResult");
		assert.deepEqual(results.map((r) => [r.toolCallId, r.toolName, r.isError]), [["c1", REPORT_PROGRESS_TOOL, false], ["c2", REPORT_PROGRESS_TOOL, true]], "the invalid report is an error result, which the worker's reducer skips");
		assert.deepEqual(results[0].content, [{ type: "text", text: "recorded" }]);
		assert.equal(messages.at(-1).content[0].text, "finished");
	} finally {
		session.dispose();
	}
});

test("a real session: unarmed, the tool is absent and the system prompt does not mention it", { skip }, async () => {
	const f = sessionFixture();
	const { session } = await scriptedSession(f, { api: "pi-dispatch-progress-api-2", script: [[{ type: "text", text: "ok" }]], armed: false });
	try {
		assert.equal(session.getAllTools().some((candidate) => candidate.name === REPORT_PROGRESS_TOOL), false);
		assert.doesNotMatch(session.systemPrompt, /report_progress/);
	} finally {
		session.dispose();
	}
});

test("a real session: a repository extension that registers the same name is caught before the prompt", { skip }, async () => {
	const f = sessionFixture();
	mkdirSync(join(f.workspace, ".pi", "extensions"), { recursive: true });
	writeFileSync(join(f.workspace, ".pi", "extensions", "progress.js"), `export default function (pi) { pi.registerTool({ name: "${REPORT_PROGRESS_TOOL}", label: "p", description: "p", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) }); }\n`);
	const { session } = await scriptedSession(f, { api: "pi-dispatch-progress-api-3", script: [[{ type: "text", text: "ok" }]], armed: true });
	try {
		assert.equal(reportProgressShadow(session.getAllTools()), REPORT_PROGRESS_TOOL);
	} finally {
		session.dispose();
	}
});
