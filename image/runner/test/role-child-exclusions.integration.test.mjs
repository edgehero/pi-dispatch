import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runRoleChild } from "../src/model-roles.mjs";
import { openChildLedger } from "../src/usage-meter.mjs";
import { JOB_MODEL, JOB_PROVIDER, jobTree, put, runRealJob } from "./helpers/real-job.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * A role child runs pi's own CLI, so it reads none of the runner's environment and PI_EXCLUDE_TOOLS never reached it: a trigger
 * that took `bash` away got a child with `bash`, an agent's `tools: [read, bash]` included. The real `runRoleChild` starts a real
 * child of the pinned pi here, on an offline provider, and the child's own session says what it holds.
 *
 * Gated like loader.test.mjs: a skip is NOT a pass, and CI sets PI_DISPATCH_REQUIRE_LOADER_TESTS=1.
 */
let pi;
let importError;
try {
	pi = await import("@earendil-works/pi-coding-agent");
} catch (error) {
	importError = error;
}
if (!pi && process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") throw new Error(`a role child's exclusions are REQUIRED here but pi could not be imported.\n${importError}`);
const skip = pi ? false : `pi not installed (node ${process.version}); CI runs these`;

const PRELOAD = new URL("../src/child-preload.mjs", import.meta.url).href;
const USAGE = "{ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }";

/** In the agent dir, where a child's CLI finds it: the provider that dials nothing, and what the session holds once it starts. */
const CHILD_PROBE = `import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { writeFileSync } from "node:fs";
export default function (pi) {
	const api = "role-child-fake";
	pi.registerProvider("fake", {
		baseUrl: "http://127.0.0.1:1", apiKey: "role-child-key", api,
		models: [{ id: "m1", name: "m1", api, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096, compat: { maxTokensField: "max_tokens" } }],
		streamSimple(model) {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "ok" }], api: model.api, provider: model.provider, model: model.id, usage: ${USAGE}, stopReason: "stop", timestamp: Date.now() } }));
			return stream;
		},
	});
	pi.on("session_start", () => writeFileSync(process.env.ROLE_CHILD_PROBE, JSON.stringify({ all: pi.getAllTools().map((tool) => tool.name), active: [...pi.getActiveTools()] })));
}
`;

const home = tempDir("role-child-home-");
const probeFile = join(home, "probe.json");
if (pi) {
	mkdirSync(join(home, ".pi", "agent", "extensions"), { recursive: true });
	writeFileSync(join(home, ".pi", "agent", "extensions", "probe.ts"), CHILD_PROBE);
	// What the child inherits from a job's runner (`openChildLedger`), which is what makes it a nested runner and pi's CLI.
	Object.assign(process.env, { HOME: home, PI_OFFLINE: "1", PI_TELEMETRY: "0", ROLE_CHILD_PROBE: probeFile });
	delete process.env.PI_CODING_AGENT_DIR;
	const ledger = openChildLedger({ env: process.env, pid: process.pid, preloadUrl: PRELOAD });
	assert.equal(ledger.error ?? null, null);
	// Made by the runner's own function, under the temp directory, and not the helper's: this one must be 0700 where the runner makes it.
	process.on("exit", () => rmSync(ledger.dir, { recursive: true, force: true }));
}

async function child({ tools, excludeTools }) {
	rmSync(probeFile, { force: true });
	const agent = { name: "scout", description: "probe", content: "Probe.", ...(tools ? { tools } : {}) };
	const result = await runRoleChild({ agent, task: "say ok", model: "fake/m1", cwd: home, ...(excludeTools ? { excludeTools } : {}) });
	assert.equal(result.exitCode, 0, JSON.stringify(result));
	return JSON.parse(readFileSync(probeFile, "utf8"));
}

test("a role child loses what its job's trigger removes, beside one that keeps it", { skip }, async () => {
	const plain = await child({});
	for (const name of ["bash", "edit", "write"]) assert.ok(plain.all.includes(name), `the premise: a child holds ${name} when nothing removes it`);
	const narrowed = await child({ excludeTools: ["bash", "edit", "write"] });
	for (const name of ["bash", "edit", "write"]) {
		assert.ok(!narrowed.all.includes(name), `${name} left the child's registry`);
		assert.ok(!narrowed.active.includes(name), `${name} is not active`);
	}
	assert.ok(narrowed.all.includes("read"), "and what the trigger did not name stays");
});

test("the exclusion beats an agent's own tools: `tools: [read, bash]` with bash removed is read", { skip }, async () => {
	const kept = await child({ tools: ["read", "bash"] });
	assert.deepEqual([...kept.active].sort(), ["bash", "read"], "the premise: the agent's list alone keeps bash");
	const removed = await child({ tools: ["read", "bash"], excludeTools: ["bash"] });
	assert.deepEqual(removed.active, ["read"]);
	assert.ok(!removed.all.includes("bash"));
});

/** The real job's model: its first call asks for the subagent, a child's call and the call after the child answer in words. Every request's tools are kept. */
async function scriptedServer() {
	const offered = [];
	const server = createServer((req, res) => {
		let text = "";
		req.on("data", (chunk) => (text += chunk));
		req.on("end", () => {
			const body = JSON.parse(text);
			const names = (body.tools ?? []).map((tool) => tool.function?.name);
			offered.push(names);
			const chunk = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
			res.writeHead(200, { "content-type": "text/event-stream" });
			const calling = names.includes("subagent") && !body.messages.some((message) => message.role === "tool");
			const base = { id: "r", object: "chat.completion.chunk", created: 0, model: JOB_MODEL };
			chunk({ ...base, choices: [{ index: 0, delta: calling ? { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "subagent", arguments: JSON.stringify({ agent: "scout", task: "look" }) } }] } : { role: "assistant", content: "done" }, finish_reason: null }] });
			chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: calling ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { base: `http://127.0.0.1:${server.address().port}/v1`, offered, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}

test("a whole job: the real runner hands PI_EXCLUDE_TOOLS to its role child, and the model is never offered the tool there", { skip }, async () => {
	const server = await scriptedServer();
	try {
		const root = jobTree({ base: server.base });
		const ref = `${JOB_PROVIDER}/${JOB_MODEL}`;
		put(root, "/job/model-roles.json", JSON.stringify({ version: 1, roles: {}, parent: ref, models: [ref] }));
		put(root, "/job/agents.json", JSON.stringify({ version: 1, agents: [{ name: "scout", description: "probe", content: "Probe.", tools: ["read", "bash"] }] }));
		// The child reads no overlay: pi's CLI finds its provider in its own agent dir.
		mkdirSync(join(root, "home", ".pi", "agent"), { recursive: true });
		writeFileSync(join(root, "home", ".pi", "agent", "models.json"), readFileSync(join(root, "opt", "pi-global", "models.json")));
		const { exit, stderr } = await runRealJob(root, { PI_MODEL_ROLES_FILE: "/job/model-roles.json", PI_AGENTS_FILE: "/job/agents.json", PI_EXCLUDE_TOOLS: "bash", PI_ALLOWED_MODELS: ref, PI_OFFLINE: "1" });
		assert.equal(exit?.code, 0, `${JSON.stringify(exit)}\n${stderr}`);
		const [parentFirst, childCall] = server.offered;
		assert.ok(parentFirst.includes("subagent") && !parentFirst.includes("bash"), JSON.stringify(parentFirst));
		assert.ok(childCall, "the child reached the model");
		assert.ok(!childCall.includes("subagent"), "this is the child's call, not the parent's");
		assert.deepEqual(childCall, ["read"], "the agent's list less what the trigger removed");
	} finally {
		await server.close();
	}
});

test("the boundary the docs state: exclusion stops what a job loads on its own, and an agent that writes pi's settings brings an excluded extension back in a child", { skip }, async () => {
	const server = await scriptedServer();
	try {
		const root = jobTree({ base: server.base });
		const ref = `${JOB_PROVIDER}/${JOB_MODEL}`;
		put(root, "/job/model-roles.json", JSON.stringify({ version: 1, roles: {}, parent: ref, models: [ref] }));
		put(root, "/job/agents.json", JSON.stringify({ version: 1, agents: [{ name: "scout", description: "probe", content: "Probe." }] }));
		mkdirSync(join(root, "home", ".pi", "agent"), { recursive: true });
		writeFileSync(join(root, "home", ".pi", "agent", "models.json"), readFileSync(join(root, "opt", "pi-global", "models.json")));
		const overlayFile = join(root, "opt", "pi-global", "extensions", "gone.js");
		put(root, "/opt/pi-global/extensions/gone.js", `export default function (pi) { pi.registerTool({ name: "gone_tool", label: "t", description: "t", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) }); }\n`);
		// As an agent with a shell could, before it asks for a child: the file is writable in the image (0777, image/Dockerfile).
		writeFileSync(join(root, "home", ".pi", "agent", "settings.json"), JSON.stringify({ extensions: [overlayFile] }));
		const { exit, stderr } = await runRealJob(root, { PI_MODEL_ROLES_FILE: "/job/model-roles.json", PI_AGENTS_FILE: "/job/agents.json", PI_EXCLUDE_EXTENSIONS: "gone", PI_ALLOWED_MODELS: ref, PI_OFFLINE: "1" });
		assert.equal(exit?.code, 0, `${JSON.stringify(exit)}\n${stderr}`);
		const parentCall = server.offered.find((names) => names.includes("subagent"));
		assert.ok(!parentCall.includes("gone_tool"), "the job itself did not load it");
		const childCall = server.offered.find((names) => !names.includes("subagent"));
		assert.ok(childCall.includes("gone_tool"), `the residual this test pins, which the docs say out loud: ${JSON.stringify(childCall)}`);
	} finally {
		await server.close();
	}
});

test("a whole job: an extension tool the trigger names is out of the child too, and a child is no strict job", { skip }, async () => {
	const server = await scriptedServer();
	try {
		const root = jobTree({ base: server.base });
		const ref = `${JOB_PROVIDER}/${JOB_MODEL}`;
		put(root, "/job/model-roles.json", JSON.stringify({ version: 1, roles: {}, parent: ref, models: [ref] }));
		put(root, "/job/agents.json", JSON.stringify({ version: 1, agents: [{ name: "scout", description: "probe", content: "Probe." }] }));
		mkdirSync(join(root, "home", ".pi", "agent", "extensions"), { recursive: true });
		writeFileSync(join(root, "home", ".pi", "agent", "models.json"), readFileSync(join(root, "opt", "pi-global", "models.json")));
		// In the child's own agent dir, as an agent with a shell could leave one: what its CLI loads, and a tool the trigger names.
		const tool = (name) => `pi.registerTool({ name: ${JSON.stringify(name)}, label: "t", description: "t", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) });`;
		writeFileSync(join(root, "home", ".pi", "agent", "extensions", "child-tools.js"), `export default function (pi) { ${tool("child_keep")} ${tool("child_gone")} }\n`);
		const { exit, stderr } = await runRealJob(root, { PI_MODEL_ROLES_FILE: "/job/model-roles.json", PI_AGENTS_FILE: "/job/agents.json", PI_EXCLUDE_EXTENSION_TOOLS: "child_gone", PI_ALLOWED_MODELS: ref, PI_OFFLINE: "1" });
		assert.equal(exit?.code, 0, `${JSON.stringify(exit)}\n${stderr}`);
		const childCall = server.offered.find((names) => !names.includes("subagent"));
		assert.ok(childCall, "the child reached the model");
		assert.ok(childCall.includes("child_keep"), "the premise: the child loads that extension");
		assert.ok(!childCall.includes("child_gone"), JSON.stringify(childCall));
	} finally {
		await server.close();
	}
});
