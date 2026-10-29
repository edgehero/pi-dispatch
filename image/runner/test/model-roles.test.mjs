import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { createRoleSubagents, readRoleInputs, resolveAgentModel, roleSubagentShadow, runRoleChild, validateRoleInputs } from "../src/model-roles.mjs";

const document = { version: 1, roles: { explorer: "test/small" }, parent: "test/main", models: ["test/main", "test/small"] };
const agent = { name: "scout", description: "Find code", model: "explorer", content: "Find things", tools: ["read"] };
const inputs = () => validateRoleInputs(document, { version: 1, agents: [agent] });
function toolFor(options) {
	const tools = [];
	const handlers = {};
	const extension = createRoleSubagents(inputs(), options);
	extension.factories[0].factory({ registerTool: (tool) => tools.push({ ...tool, sourceInfo: { path: "<inline:job-role-subagent>" } }), on: (event, fn) => { handlers[event] = fn; }, getAllTools: () => tools });
	return { tool: tools[0], extension, handlers, tools };
}
const context = { cwd: "/workspace", model: { provider: "test", id: "main" }, thinkingLevel: "low" };

test("role resolver supports roles, explicit roles, inherit, omitted and reviewed literal models", () => {
	for (const value of [undefined, "inherit", "test/main"]) assert.deepEqual(resolveAgentModel(value, document), { model: "test/main" });
	for (const value of ["explorer", "role:explorer", "test/small"]) assert.deepEqual(resolveAgentModel(value, document), { model: "test/small" });
	assert.deepEqual(resolveAgentModel("missing", document), { reason: "unknown-role" });
	assert.deepEqual(resolveAgentModel("test/other", document), { reason: "model-not-allowed" });
	assert.deepEqual(resolveAgentModel("explorer", { ...document, models: ["test/main"] }), { reason: "model-not-allowed" }, "failover singleton cannot be widened by a role");
	assert.deepEqual(resolveAgentModel("inherit", document, "test/other"), { reason: "model-not-allowed" });
});

test("role input reader is optional, closed to job paths and refuses malformed or missing documents", () => {
	assert.equal(readRoleInputs({}), null);
	assert.throws(() => readRoleInputs({ PI_MODEL_ROLES_FILE: "/workspace/map.json" }), /paths are invalid/);
	const env = { PI_MODEL_ROLES_FILE: "/job/model-roles.json", PI_AGENTS_FILE: "/job/agents.json" };
	assert.equal(readRoleInputs(env, (path) => JSON.stringify(path.endsWith("model-roles.json") ? document : { version: 1, agents: [agent] })).agents[0].name, "scout");
	for (const read of [() => { throw new Error("private path"); }, () => "{}", () => "{" ]) assert.throws(() => readRoleInputs(env, read), /inputs cannot be read/);
	for (const bad of [{ ...document, version: 2 }, { ...document, roles: { inherit: "test/main" } }, { ...document, models: ["bad"] }]) assert.throws(() => validateRoleInputs(bad, { version: 1, agents: [] }));
	assert.throws(() => validateRoleInputs(document, { version: 1, agents: [agent, agent] }), /entry is invalid/);
});

test("tool resolves from immutable snapshot and starts only a reviewed child", async () => {
	const calls = [];
	const { tool } = toolFor({ runChild: async (call) => { calls.push(call); return { text: "found", exitCode: 0 }; } });
	const result = await tool.execute("id", { agent: "scout", task: "find it" }, undefined, undefined, context);
	assert.equal(result.content[0].text, "found");
	assert.equal(calls[0].model, "test/small");
	assert.equal(calls[0].thinkingLevel, undefined, "explicit role does not inherit thinking");
	assert.deepEqual(calls[0].agent.tools, ["read"]);
});

test("unknown agents, roles and off-list models refuse before spawning and record hashes only", async () => {
	for (const model of ["missing", "test/off-list"]) {
		const data = inputs();
		data.agents[0].model = model;
		let calls = 0;
		const extension = createRoleSubagents(data, { runChild: async () => { calls++; } });
		let tool;
		extension.factories[0].factory({ registerTool: (value) => { tool = value; }, on() {} });
		const result = await tool.execute("id", { agent: "scout", task: "find" }, undefined, undefined, context);
		assert.equal(result.isError, true);
		assert.equal(calls, 0);
		assert.match(extension.snapshot().refusals[0].agentHash, /^[a-f0-9]{64}$/);
		assert.equal(JSON.stringify(extension.snapshot()).includes("scout"), false);
	}
	const { tool, extension } = toolFor({ runChild: () => assert.fail("refused child started") });
	for (let index = 0; index < 70; index++) await tool.execute("id", { agent: "unknown", task: "find" }, undefined, undefined, context);
	assert.equal(extension.snapshot().refusals.length, 8);
	const abort = new AbortController(); abort.abort();
	assert.equal((await tool.execute("id", { agent: "scout", task: "find" }, abort.signal, undefined, context)).isError, true);
});

test("reserved subagent name blocks shadowed tools", () => {
	const { tools, handlers } = toolFor();
	assert.equal(roleSubagentShadow(tools), null);
	tools[0].sourceInfo.path = "/workspace/.pi/extensions/other.js";
	assert.equal(roleSubagentShadow(tools), "subagent");
	assert.equal(handlers.tool_call({ toolName: "subagent" }).block, true);
	assert.equal(handlers.tool_call({ toolName: "read" }), undefined);
});

test("child uses nested runner argv, keeps meter environment and removes prompt after close", async () => {
	let prompt;
	const result = await runRoleChild({ agent, task: "--a task", model: "test/small", cwd: "/workspace" }, { spawnChild: (command, args, options) => {
		assert.equal(command, process.execPath);
		assert.match(args[0], /run-job.mjs$/);
		assert.deepEqual(args.slice(-2), ["--", "Task: --a task"]);
		assert.equal(args[args.indexOf("--model") + 1], "test/small");
		assert.equal(options.env, undefined, "inherits the child preload and ledger");
		prompt = args[args.indexOf("--append-system-prompt") + 1];
		assert.equal(readFileSync(prompt, "utf8"), agent.content);
		const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
		queueMicrotask(() => { child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } }) + "\n")); child.emit("close", 0); });
		return child;
	} });
	assert.deepEqual(result, { exitCode: 0, text: "answer" });
	assert.equal(existsSync(prompt), false);
});

test("parallel validates every member before spawn; chain passes previous and stops on error", async () => {
	const calls = [];
	const { tool } = toolFor({ runChild: async (call) => { calls.push(call.task); return { text: `answer ${calls.length}`, exitCode: call.task === "stop" ? 1 : 0 }; } });
	assert.equal((await tool.execute("id", { tasks: [{ agent: "scout", task: "one" }, { agent: "missing", task: "two" }] }, undefined, undefined, context)).isError, true);
	assert.deepEqual(calls, []);
	await tool.execute("id", { tasks: [{ agent: "scout", task: "one" }, { agent: "scout", task: "two" }] }, undefined, undefined, context);
	assert.deepEqual(calls, ["one", "two"]);
	calls.length = 0;
	await tool.execute("id", { chain: [{ agent: "scout", task: "one" }, { agent: "scout", task: "use {previous}" }, { agent: "scout", task: "stop" }, { agent: "scout", task: "never" }] }, undefined, undefined, context);
	assert.deepEqual(calls, ["one", "use answer 1", "stop"]);
});

test("runner physical references and role names accept the worker's exact grammar", async () => {
	const { splitModelEntry } = await import("../../../worker/src/model-ref.mjs");
	const { MODEL_ROLE_RE } = await import("../../../worker/src/model-roles.mjs");
	const { roleModelPair } = await import("../src/model-roles.mjs");
	for (const value of ["cloudflare-workers-ai/@cf/vendor/model", "openrouter/~vendor/model", "ollama/Qwen2.5:0.5b_Q4_K_M", "Provider/MODEL", "test/" + "a".repeat(64), "test/" + "a".repeat(65), "test/x+y", "test/K", "test/../x", "test/@x", "test/~x", "test/no space"]) assert.equal(roleModelPair(value), splitModelEntry(value) !== null, value);
	for (const name of ["a", "a".repeat(32), "a".repeat(33), "A", "has-space", "with_under"]) {
		const candidate = { ...document, roles: { [name]: "test/main" } };
		if (MODEL_ROLE_RE.test(name)) assert.doesNotThrow(() => validateRoleInputs(candidate, { version: 1, agents: [] }));
		else assert.throws(() => validateRoleInputs(candidate, { version: 1, agents: [] }));
	}
});


test("pinned pi session offers the role tool from the protected inline factory", async (t) => {
	let pi;
	try { pi = await import("@earendil-works/pi-coding-agent"); }
	catch (error) { if (process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") throw error; t.skip(`pi cannot load: ${error.code ?? "import failed"}`); return; }
	const { buildLoadedResourceLoader } = await import("../src/loader.mjs");
	const { createJobModelRuntime, loadPiAuthStorage } = await import("../src/model-runtime.mjs");
	const { trackPiRefreshes } = await import("./helpers/track-pi-refreshes.mjs");
	trackPiRefreshes(pi.ModelRuntime);
	const root = tempDir("pi-dispatch-roles-loader-");
	const cwd = join(root, "workspace");
	const jobPiDir = join(root, "job", "pi");
	const agentDir = join(root, "agent");
	for (const path of [cwd, jobPiDir, agentDir]) mkdirSync(path, { recursive: true });
	const guardrailsPath = join(root, "rules.md");
	const outboxProtocolPath = join(root, "outbox.md");
	writeFileSync(guardrailsPath, "Rules"); writeFileSync(outboxProtocolPath, "Outbox");
	const roles = createRoleSubagents(inputs(), { runChild: () => assert.fail("loader started a child") });
	const loader = await buildLoadedResourceLoader({ cwd, jobPiDir, guardrailsPath, outboxProtocolPath, packagePaths: [], extensionFactories: roles.factories });
	const modelRuntime = await createJobModelRuntime({ ModelRuntime: pi.ModelRuntime, AuthStorage: await loadPiAuthStorage(), agentDir, modelsPath: join(agentDir, "models.json") });
	const model = modelRuntime.getModel("anthropic", "claude-sonnet-4-5-20250929");
	const { session } = await pi.createAgentSession({ cwd, agentDir, modelRuntime, model, settingsManager: pi.SettingsManager.inMemory({}), sessionManager: pi.SessionManager.inMemory(cwd), resourceLoader: loader, noTools: "builtin" });
	try {
		assert.equal(roleSubagentShadow(session.getAllTools()), null);
		assert.ok(session.getActiveToolNames().includes("subagent"));
		assert.equal(session.getAllTools().find((tool) => tool.name === "subagent").sourceInfo.path, "<inline:job-role-subagent>");
	} finally { session.dispose(); }
});

test("child failure and excessive stdout return errors and clean the temporary prompt", async () => {
	for (const mode of ["error", "overflow"]) {
		let prompt;
		let killed = false;
		const result = await runRoleChild({ agent, task: "find", model: "test/small" }, { spawnChild: (_command, args) => {
			prompt = args[args.indexOf("--append-system-prompt") + 1];
			const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => { killed = true; queueMicrotask(() => child.emit("close", 0)); };
			queueMicrotask(() => mode === "error" ? child.emit("error", new Error("private provider detail")) : child.stdout.emit("data", Buffer.alloc(1048577)));
			return child;
		} });
		assert.equal(result.exitCode, 1);
		assert.equal(existsSync(prompt), false);
		assert.equal(result.text.includes("private"), false);
		assert.equal(killed, mode === "overflow");
	}
});


test("the pinned CLI keeps leading @ task text literal instead of reading an attached file", async () => {
	const { parseArgs } = await import(new URL("./cli/args.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
	let captured;
	await runRoleChild({ agent, task: "@/tmp/private-file", model: "test/small", cwd: "/workspace" }, { spawnChild: (_command, args) => {
		captured = args.slice(1);
		const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
		queueMicrotask(() => child.emit("close", 0));
		return child;
	} });
	const parsed = parseArgs(captured);
	assert.deepEqual(parsed.messages, ["Task: @/tmp/private-file"]);
	assert.deepEqual(parsed.fileArgs, []);
	assert.deepEqual(parsed.diagnostics, []);
});
