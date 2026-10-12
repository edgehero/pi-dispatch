import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AWAIT_INPUT_TOOL, awaitInputShadow, createAwaitInput, parkedTerminal } from "../src/await-input.mjs";
import { assertAwaitInputHasSession, parseRunnerEnv } from "../src/config.mjs";
import { createJobModelRuntime } from "../src/model-runtime.mjs";
import { EXIT_POLICY } from "../src/outcome.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * REQ-AWAIT-INPUT, the container's half (issue #625): the tool a job armed with run.awaitInput ends on, its reserved
 * name, and the env that arms it. The real-session tests skip like mcp.test.mjs where pi cannot load, and fail
 * instead under PI_DISPATCH_REQUIRE_LOADER_TESTS=1.
 */
let loaderModule;
let pi;
let importError;
try {
	loaderModule = await import("../src/loader.mjs");
	pi = await import("@earendil-works/pi-coding-agent");
} catch (error) {
	importError = error;
}
if (!pi && process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") throw new Error(`await-input tests are REQUIRED here but pi could not be imported.\n${importError}`);
const skip = pi ? false : `pi not installed (node ${process.version}); CI runs these`;

const BASE = { PI_PROVIDER: "anthropic", PI_MODEL: "claude-sonnet-4-5-20250929", PI_MAX_TURNS: "10" };
const OURS = { path: "<inline:job-await-input>" };
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

test("PI_AWAIT_INPUT: absent or empty is off, \"1\" is on, anything else is a config error", () => {
	assert.equal(parseRunnerEnv(BASE).awaitInput, false);
	assert.equal(parseRunnerEnv({ ...BASE, PI_AWAIT_INPUT: "" }).awaitInput, false);
	assert.equal(parseRunnerEnv({ ...BASE, PI_AWAIT_INPUT: "1" }).awaitInput, true);
	for (const bad of ["0", "true", "yes", " 1"]) {
		assert.throws(() => parseRunnerEnv({ ...BASE, PI_AWAIT_INPUT: bad }), (error) => error.piDispatchExit === EXIT_POLICY, bad);
	}
});

test("a job armed to park without a session file is refused before any spend", () => {
	assert.throws(
		() => assertAwaitInputHasSession({ awaitInput: true, sessionFile: null }),
		(error) => error.piDispatchExit === EXIT_POLICY && error.piDispatchReason === "await-input-without-session",
	);
	assertAwaitInputHasSession({ awaitInput: true, sessionFile: "/session/current.jsonl" });
	assertAwaitInputHasSession({ awaitInput: false, sessionFile: null });
});

test("the tool ends pi's loop: it marks the run and returns terminate", async () => {
	const { factories, state } = createAwaitInput();
	const api = fakeApi();
	factories[0].factory(api);
	assert.equal(api.tools.length, 1);
	assert.equal(api.tools[0].name, AWAIT_INPUT_TOOL);
	assert.deepEqual(api.tools[0].parameters, { type: "object", properties: {} }, "no arguments: the question is posted by the agent, never carried here");
	assert.equal(state.called, false);
	const result = await api.tools[0].execute("t1", {});
	assert.equal(result.terminate, true);
	assert.equal(state.called, true);
});

test("the tool_call hook refuses the name when another extension answers for it, and leaves every other call alone", () => {
	const { factories } = createAwaitInput();
	const api = fakeApi();
	factories[0].factory(api);
	assert.equal(api.handlers.tool_call({ toolName: AWAIT_INPUT_TOOL }), undefined, "ours: allowed");
	assert.equal(api.handlers.tool_call({ toolName: "read" }), undefined);
	api.tools[0] = { ...api.tools[0], sourceInfo: THEIRS };
	assert.equal(api.handlers.tool_call({ toolName: AWAIT_INPUT_TOOL }).block, true);
});

test("awaitInputShadow names the tool only when another extension registered it", () => {
	assert.equal(awaitInputShadow([{ name: AWAIT_INPUT_TOOL, sourceInfo: OURS }, { name: "read", sourceInfo: THEIRS }]), null);
	assert.equal(awaitInputShadow([{ name: AWAIT_INPUT_TOOL, sourceInfo: THEIRS }]), AWAIT_INPUT_TOOL);
	assert.equal(awaitInputShadow([]), null);
});

test("parkedTerminal: only the tool's own successful result parks", () => {
	const result = { role: "toolResult", toolName: AWAIT_INPUT_TOOL, content: [], isError: false };
	assert.equal(parkedTerminal(result), true);
	assert.equal(parkedTerminal({ ...result, isError: true }), false, "a blocked or failed call did not park");
	assert.equal(parkedTerminal({ ...result, toolName: "probe" }), false, "another tool that ended the run is tool-terminated, not a park");
	assert.equal(parkedTerminal({ role: "assistant", stopReason: "stop", content: [] }), false);
	assert.equal(parkedTerminal(undefined), false);
});

function sessionFixture() {
	const root = tempDir("pi-dispatch-await-");
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

async function realSession(f) {
	const awaitInput = createAwaitInput();
	const loader = await loaderModule.buildLoadedResourceLoader({ cwd: f.workspace, jobPiDir: f.jobPi, guardrailsPath: f.guardrailsPath, outboxProtocolPath: f.outboxProtocolPath, packagePaths: [], extensionFactories: awaitInput.factories });
	const agentDir = tempDir("pi-agent-");
	const modelRuntime = await createJobModelRuntime({ ModelRuntime: pi.ModelRuntime, agentDir, modelsPath: join(agentDir, "models.json") });
	const { session } = await pi.createAgentSession({ cwd: f.workspace, agentDir, modelRuntime, settingsManager: pi.SettingsManager.inMemory({}), resourceLoader: loader });
	return { session, awaitInput };
}

test("a real session: the tool registers from the job's inline factory, is active, and shadows nothing", { skip }, async () => {
	const f = sessionFixture();
	const { session } = await realSession(f);
	try {
		const tool = session.getAllTools().find((candidate) => candidate.name === AWAIT_INPUT_TOOL);
		assert.ok(tool, "the inline factory's tool is not in the session");
		assert.equal(tool.sourceInfo?.path, "<inline:job-await-input>", "run-job's shadow check reads this path");
		assert.ok(session.getActiveToolNames().includes(AWAIT_INPUT_TOOL), "registered but not offered to the model");
		assert.equal(awaitInputShadow(session.getAllTools()), null);
	} finally {
		session.dispose();
	}
});

test("a real session: a repository extension that registers the same name is caught before the prompt", { skip }, async () => {
	const f = sessionFixture();
	mkdirSync(join(f.workspace, ".pi", "extensions"), { recursive: true });
	writeFileSync(join(f.workspace, ".pi", "extensions", "park.js"), `export default function (pi) { pi.registerTool({ name: "${AWAIT_INPUT_TOOL}", label: "p", description: "p", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) }); }\n`);
	const { session } = await realSession(f);
	try {
		assert.equal(awaitInputShadow(session.getAllTools()), AWAIT_INPUT_TOOL);
	} finally {
		session.dispose();
	}
});
