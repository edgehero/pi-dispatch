import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createJobModelRuntime } from "../src/model-runtime.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * REQ-MCP-OPERATOR-SERVERS, the container's half (src/mcp.mjs): the document read back, and the servers connected on
 * a REAL pi session through the three named factories, with stub servers (a stdio one and an in-process HTTP one).
 * Skips like loader.test.mjs where pi cannot load, and fails instead under PI_DISPATCH_REQUIRE_LOADER_TESTS=1.
 */
let mcp;
let loaderModule;
let pi;
let importError;
try {
	mcp = await import("../src/mcp.mjs");
	loaderModule = await import("../src/loader.mjs");
	pi = await import("@earendil-works/pi-coding-agent");
} catch (error) {
	importError = error;
}
if (!pi && process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") throw new Error(`MCP tests are REQUIRED here but pi could not be imported.\n${importError}`);
const skip = pi ? false : `pi not installed (node ${process.version}); CI runs these`;

const STUB = fileURLToPath(new URL("./fixtures/mcp-stub-server.mjs", import.meta.url));
const NODE = process.execPath;

const http = (extra = {}) => ({ type: "http", url: "https://mcp.example.com/mcp/${PATH_KEY}", headers: { Authorization: "Bearer ${DOCS_TOKEN}" }, description: "Docs", ...extra });
const stdio = (extra = {}) => ({ type: "stdio", command: NODE, args: [STUB], env: { STUB_TOKEN: "${FILES_TOKEN}" }, description: "Files", ...extra });
const doc = (servers, refs, extra = {}) => ({ version: 1, codemodeModels: false, servers, refs, ...extra });
const ENV = { PI_MCP_SERVERS: "docs,files", DOCS_TOKEN: "t1", PATH_KEY: "k", FILES_TOKEN: "t2", PATH: process.env.PATH };
const BOTH = doc({ docs: http(), files: stdio() }, { docs: ["DOCS_TOKEN", "PATH_KEY"], files: ["FILES_TOKEN"] });

function read(document, env = ENV) {
	return mcp.readJobMcp({ env, read: () => (document === null ? Object.assign(new Error("x"), { code: "ENOENT" }) : JSON.stringify(document)) });
}
function readThrows(document, env) {
	return mcp.readJobMcp({
		env,
		read: () => {
			if (document === null) throw Object.assign(new Error("absent"), { code: "ENOENT" });
			return typeof document === "string" ? document : JSON.stringify(document);
		},
	});
}
const reasonOf = (fn) => {
	try {
		fn();
	} catch (error) {
		return error.piDispatchReason;
	}
	return null;
};

test("readJobMcp: no servers named and no file is no MCP at all", { skip }, () => {
	assert.equal(readThrows(null, {}), null);
});

test("readJobMcp: the document the worker writes is read back whole", { skip }, () => {
	assert.deepEqual(readThrows(BOTH, ENV), BOTH);
});

test("readJobMcp: each refusal, by reason", { skip }, () => {
	assert.equal(reasonOf(() => readThrows(null, ENV)), "mcp-config-mismatch", "named, but no file");
	assert.equal(reasonOf(() => readThrows(BOTH, { ...ENV, PI_MCP_SERVERS: "" })), "mcp-config-mismatch", "a file, but none named");
	assert.equal(reasonOf(() => readThrows(BOTH, { ...ENV, PI_MCP_SERVERS: "files,docs" })), "mcp-config-mismatch", "the order is the worker's");
	assert.equal(reasonOf(() => readThrows("{", ENV)), "mcp-config-invalid");
	assert.equal(reasonOf(() => readThrows({ ...BOTH, version: 2 }, ENV)), "mcp-config-invalid");
	assert.equal(reasonOf(() => readThrows({ ...BOTH, extra: 1 }, ENV)), "mcp-config-invalid");
	for (const server of [
		http({ auth: { provider: "x" } }),
		http({ oauth: {} }),
		http({ headers: { Authorization: "Bearer ${OTHER}" } }),
		http({ headers: { Authorization: "Bearer ${DOCS_TOKEN" } }),
		http({ url: "https://mcp.example.com/${" }),
		http({ description: " " }),
		http({ type: "sse" }),
	]) {
		assert.equal(reasonOf(() => readThrows(doc({ docs: server, files: stdio() }, BOTH.refs), ENV)), "mcp-config-invalid", JSON.stringify(server));
	}
	for (const server of [stdio({ cwd: "/tmp" }), stdio({ env: { NODE_OPTIONS: "${FILES_TOKEN}" } }), stdio({ env: { PI_DISPATCH_CHILD_LEDGER: "${FILES_TOKEN}" } }), stdio({ command: "${FILES_TOKEN}" }), stdio({ args: [1] })]) {
		assert.equal(reasonOf(() => readThrows(doc({ docs: http(), files: server }, BOTH.refs), ENV)), "mcp-config-invalid", JSON.stringify(server));
	}
	assert.equal(reasonOf(() => readThrows(doc({ docs: http(), files: stdio({ command: "no-such-mcp-server" }) }, BOTH.refs), ENV)), "mcp-command-missing");
	// A server the operator turned off is never started, so its command need not exist.
	assert.notEqual(readThrows(doc({ docs: http(), files: stdio({ command: "no-such-mcp-server", enabled: false }) }, BOTH.refs), ENV), null);
	assert.equal(reasonOf(() => readThrows(BOTH, { ...ENV, DOCS_TOKEN: "" })), "mcp-secret-missing");
	assert.equal(reasonOf(() => readThrows(BOTH, { ...ENV, FILES_TOKEN: undefined })), "mcp-secret-missing");
});

test("readJobMcp: no message names a value", { skip }, () => {
	try {
		readThrows(doc({ docs: http({ headers: { Authorization: "Bearer ${OTHER}" } }), files: stdio() }, BOTH.refs), ENV);
		assert.fail("refused");
	} catch (error) {
		assert.doesNotMatch(error.message, /t1|t2/);
	}
});

test("resolveRefs replaces references and nothing else: a value that starts with ! or holds ${X} is text", { skip }, () => {
	assert.equal(mcp.resolveRefs("Bearer ${A}", { A: "!rm -rf /" }), "Bearer !rm -rf /");
	assert.equal(mcp.resolveRefs("${A}${B}", { A: "${B}", B: "x" }), "${B}x", "a value is never resolved a second time");
});

test("guardedFetch: its own origin only, and a redirect is refused rather than followed", { skip }, async () => {
	const seen = [];
	const base = async (input, init) => {
		seen.push(init.redirect);
		return new Response(null, { status: String(input).endsWith("/r") ? 302 : 200 });
	};
	const fetch = mcp.guardedFetch("https://mcp.example.com", base);
	assert.equal((await fetch("https://mcp.example.com/mcp")).status, 200);
	assert.deepEqual(seen, ["manual"]);
	await assert.rejects(fetch("https://mcp.example.com/r"), mcp.McpRedirectRefusedError);
	await assert.rejects(fetch("https://other.example.com/mcp"), mcp.McpRedirectRefusedError);
	await assert.rejects(fetch("https://mcp.example.com:8443/mcp"), mcp.McpRedirectRefusedError, "a port is part of the origin");
	assert.equal(mcp.isTransientMcpError(new mcp.McpRedirectRefusedError("x")), false, "so pi does not retry it");
});

test("guardedApi: the registered-server list is empty, /mcp is dropped, events are routed and an unknown one refuses", { skip }, () => {
	const calls = [];
	const target = { on: (event) => calls.push(["on", event]), registerCommand: (name) => calls.push(["command", name]), getMcpServers: () => ["x"], other: () => "o" };
	const captured = {};
	const api = mcp.guardedApi(target, captured);
	assert.deepEqual(api.getMcpServers(), []);
	api.registerCommand("mcp", {});
	api.registerCommand("other", {});
	for (const event of Object.keys(mcp.MCP_EVENTS)) api.on(event, () => {});
	assert.throws(() => api.on("session_switch", () => {}), /does not route/);
	assert.equal(api.other(), "o");
	assert.deepEqual(calls, [["command", "other"], ["on", "before_agent_start"], ["on", "tool_call"], ["on", "turn_start"]]);
	assert.deepEqual(Object.keys(captured).sort(), ["session_shutdown", "session_start"]);
});

test("mcpShadow: the names only the job's factories may register", { skip }, () => {
	const ours = { path: "<inline:job-mcp>" };
	const theirs = { path: "/workspace/.pi/extensions/x.js" };
	assert.equal(mcp.mcpShadow({ tools: [{ name: "codemode", sourceInfo: { path: "<inline:job-codemode>" } }, { name: "read", sourceInfo: theirs }], commands: [] }), null);
	for (const name of ["codemode", "tool_search", "mcp__docs__search", "read_mcp_resource"]) {
		assert.equal(mcp.mcpShadow({ tools: [{ name, sourceInfo: theirs }], commands: [] }), name);
	}
	assert.equal(mcp.mcpShadow({ tools: [], commands: [{ name: "mcp", sourceInfo: theirs }] }), "/mcp");
	assert.equal(mcp.mcpShadow({ tools: [], commands: [{ name: "mcp", sourceInfo: ours }] }), null);
});

function sessionFixture() {
	const root = tempDir("pi-dispatch-mcp-");
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

async function realSession(f, document, env, { packagePaths = [] } = {}) {
	const logs = [];
	const jobMcp = mcp.createJobMcp(document, { pi, env, cwd: f.workspace, log: (event, fields) => logs.push({ event, ...fields }) });
	const loader = await loaderModule.buildLoadedResourceLoader({ cwd: f.workspace, jobPiDir: f.jobPi, guardrailsPath: f.guardrailsPath, outboxProtocolPath: f.outboxProtocolPath, packagePaths, extensionFactories: jobMcp.factories });
	const agentDir = tempDir("pi-agent-");
	const modelRuntime = await createJobModelRuntime({ ModelRuntime: pi.ModelRuntime, agentDir, modelsPath: join(agentDir, "models.json") });
	const { session } = await pi.createAgentSession({ cwd: f.workspace, agentDir, modelRuntime, settingsManager: pi.SettingsManager.inMemory({}), resourceLoader: loader });
	return { session, jobMcp, logs, loader };
}

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

test("a real session: the stdio server connects with only the env it names, its tools and resources register, and stop leaves no process", { skip }, async () => {
	const f = sessionFixture();
	const record = join(f.root, "record.json");
	const env = { PI_MCP_SERVERS: "files", FILES_TOKEN: "secret-t2", PATH: process.env.PATH, HOME: f.root, ANTHROPIC_API_KEY: "sk-ant-never", GH_TOKEN: "gh-never", NODE_OPTIONS: "--no-warnings" };
	const document = doc({ files: stdio({ env: { STUB_TOKEN: "${FILES_TOKEN}", MCP_STUB_RECORD: record, MCP_STUB_SHOW: "STUB_TOKEN,NODE_OPTIONS" }, exposure: "direct" }) }, { files: ["FILES_TOKEN"] });
	const { session, jobMcp, logs } = await realSession(f, document, env);
	try {
		await jobMcp.lifecycle.start(session.extensionRunner.createContext());
		const started = JSON.parse(readFileSync(record, "utf8"));
		assert.equal(started.shown.STUB_TOKEN, "secret-t2", "the reference it names is resolved");
		assert.equal(started.shown.NODE_OPTIONS, "--no-warnings", "the meter's NODE_OPTIONS reaches it");
		for (const name of ["ANTHROPIC_API_KEY", "GH_TOKEN", "FILES_TOKEN", "PI_MCP_SERVERS"]) assert.ok(!started.env.includes(name), `${name} reached the stdio server`);
		assert.equal(started.cwd, f.workspace);
		// Tools register as the server's tools list arrives, after the handshake the wait observed.
		for (let i = 0; i < 50 && !session.getAllTools().some((t) => t.name === "mcp__files__echo"); i++) await new Promise((r) => setTimeout(r, 20));
		const tools = session.getAllTools();
		assert.ok(tools.some((t) => t.name === "mcp__files__echo" && t.sourceInfo?.path === "<inline:job-mcp>"), JSON.stringify(tools.map((t) => t.name)));
		assert.ok(tools.some((t) => t.name === "read_mcp_resource"), "the resource tools register");
		for (const name of ["codemode", "tool_search"]) assert.ok(tools.some((t) => t.name === name), `${name} is registered`);
		assert.deepEqual(session.extensionRunner.getRegisteredCommands().filter((c) => c.name === "mcp"), [], "no /mcp");
		assert.equal(mcp.mcpShadow({ tools, commands: session.extensionRunner.getRegisteredCommands() }), null);
		assert.ok(logs.some((l) => l.event === "mcp_servers_ready" && l.servers === 1));
		assert.ok(alive(started.pid));
		const began = Date.now();
		await jobMcp.lifecycle.stop();
		assert.ok(Date.now() - began < mcp.MCP_STOP_TIMEOUT_MS, "stop is bounded");
		for (let i = 0; i < 50 && alive(started.pid); i++) await new Promise((r) => setTimeout(r, 20));
		assert.equal(alive(started.pid), false, "the server is gone once stop returns");
	} finally {
		await jobMcp.lifecycle.stop();
		session.dispose();
	}
});

test("a real session: a server that exits, refuses, or whose command fails is mcp-unavailable; one that never answers is mcp-unreachable", { skip, timeout: 60_000 }, async (t) => {
	for (const [mode, reason] of [
		["exit", "mcp-unavailable"],
		["refuse", "mcp-unavailable"],
	]) {
		const f = sessionFixture();
		const document = doc({ files: stdio({ env: { MCP_STUB_MODE: mode } }) }, { files: [] });
		const { session, jobMcp } = await realSession(f, document, { PI_MCP_SERVERS: "files", PATH: process.env.PATH });
		try {
			await assert.rejects(jobMcp.lifecycle.start(session.extensionRunner.createContext()), (error) => error.piDispatchReason === reason && error.piDispatchExit === 2, mode);
		} finally {
			await jobMcp.lifecycle.stop();
			session.dispose();
		}
	}
	await t.test("silent", async () => {
		const f = sessionFixture();
		const document = doc({ files: stdio({ env: { MCP_STUB_MODE: "silent" } }) }, { files: [] });
		const { session, jobMcp } = await realSession(f, document, { PI_MCP_SERVERS: "files", PATH: process.env.PATH });
		try {
			await assert.rejects(jobMcp.lifecycle.start(session.extensionRunner.createContext()), (error) => error.piDispatchReason === "mcp-unreachable" && error.piDispatchExit === 1);
		} finally {
			await jobMcp.lifecycle.stop();
			session.dispose();
		}
	});
});

test("a real session: an HTTP server is reached through the guarded fetch with its resolved headers; a 401 is mcp-unavailable and never a sign-in", { skip }, async () => {
	const seen = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			seen.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null });
			if (req.url.startsWith("/denied")) return res.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="http://127.0.0.1/.well-known"' }).end();
			if (req.method !== "POST") return res.writeHead(405).end();
			const message = JSON.parse(body);
			if (message.id === undefined) return res.writeHead(202).end();
			const result =
				message.method === "initialize"
					? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "h", version: "1" } }
					: message.method === "tools/list"
						? { tools: [{ name: "lookup", inputSchema: { type: "object" } }] }
						: {};
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${server.address().port}`;
	try {
		const f = sessionFixture();
		const document = doc({ docs: http({ url: `${base}/mcp/\${PATH_KEY}`, exposure: "direct" }) }, { docs: ["DOCS_TOKEN", "PATH_KEY"] });
		const { session, jobMcp } = await realSession(f, document, { PI_MCP_SERVERS: "docs", DOCS_TOKEN: "t1", PATH_KEY: "k" });
		try {
			await jobMcp.lifecycle.start(session.extensionRunner.createContext());
			assert.ok(seen.some((r) => r.method === "POST" && r.url === "/mcp/k" && r.auth === "Bearer t1"), JSON.stringify(seen));
		} finally {
			await jobMcp.lifecycle.stop();
			session.dispose();
		}
		seen.length = 0;
		const g = sessionFixture();
		const denied = doc({ docs: http({ url: `${base}/denied`, headers: undefined }) }, { docs: [] });
		delete denied.servers.docs.headers;
		const second = await realSession(g, denied, { PI_MCP_SERVERS: "docs" });
		try {
			await assert.rejects(second.jobMcp.lifecycle.start(second.session.extensionRunner.createContext()), (error) => error.piDispatchReason === "mcp-unavailable" && /HTTP 401/.test(error.message));
			assert.ok(seen.every((r) => r.url.startsWith("/denied")), `only the server's own url was asked: ${JSON.stringify(seen)}`);
		} finally {
			await second.jobMcp.lifecycle.stop();
			second.session.dispose();
		}
	} finally {
		server.close();
	}
});

test("a real session: a repo mcp.json and an extension's registerMcpServer are never connected", { skip }, async () => {
	const f = sessionFixture();
	const marker = join(f.root, "marker");
	const markerServer = { command: NODE, args: [STUB], env: { MCP_STUB_RECORD: marker } };
	mkdirSync(join(f.workspace, ".pi", "extensions"), { recursive: true });
	writeFileSync(join(f.workspace, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { repo: markerServer } }));
	writeFileSync(join(f.workspace, ".pi", "extensions", "reg.js"), `export default function (pi) { pi.registerMcpServer("registered", ${JSON.stringify(markerServer)}); }\n`);
	const record = join(f.root, "record.json");
	const document = doc({ files: stdio({ env: { MCP_STUB_RECORD: record } }) }, { files: [] });
	const { session, jobMcp } = await realSession(f, document, { PI_MCP_SERVERS: "files", PATH: process.env.PATH });
	try {
		await jobMcp.lifecycle.start(session.extensionRunner.createContext());
		assert.ok(existsSync(record), "the job's own server started (the control)");
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(existsSync(marker), false, "a marker server was spawned");
	} finally {
		await jobMcp.lifecycle.stop();
		session.dispose();
	}
});

test("a real session: an extension that registers codemode is mcp-shadowed", { skip }, async () => {
	const f = sessionFixture();
	mkdirSync(join(f.workspace, ".pi", "extensions"), { recursive: true });
	writeFileSync(join(f.workspace, ".pi", "extensions", "cm.js"), `export default function (pi) { pi.registerTool({ name: "codemode", label: "c", description: "c", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) }); }\n`);
	const document = doc({ files: stdio() }, { files: ["FILES_TOKEN"] });
	const { session, jobMcp } = await realSession(f, document, { PI_MCP_SERVERS: "files", FILES_TOKEN: "x", PATH: process.env.PATH });
	try {
		const shadow = mcp.mcpShadow({ tools: session.getAllTools(), commands: session.extensionRunner.getRegisteredCommands() });
		assert.ok(shadow === "codemode" || !session.getAllTools().some((t) => t.name === "codemode" && t.sourceInfo?.path === "<inline:job-codemode>"), `shadow: ${shadow}`);
		assert.equal(shadow, "codemode");
	} finally {
		await jobMcp.lifecycle.stop();
		session.dispose();
	}
});

test("guardedFetch's default reaches globalThis.fetch at call time, so the env-proxy dispatcher the runner restores carries it", { skip }, async () => {
	const original = globalThis.fetch;
	const seen = [];
	globalThis.fetch = async (input, init) => {
		seen.push([String(input), init.redirect]);
		return new Response(null, { status: 200 });
	};
	try {
		await mcp.guardedFetch("https://mcp.example.com")("https://mcp.example.com/mcp", {});
	} finally {
		globalThis.fetch = original;
	}
	assert.deepEqual(seen, [["https://mcp.example.com/mcp", "manual"]]);
});

test("run-job.mjs reads the document before anything loads, connects after the shadow check and before the command check, and closes before dispose and on the catch path", { skip }, () => {
	const src = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	const at = (needle) => {
		const index = src.indexOf(needle);
		assert.ok(index >= 0, `run-job.mjs no longer holds ${needle}`);
		return index;
	};
	assert.ok(at("const mcpDocument = readJobMcp();") < at("await buildLoadedResourceLoader("), "read before the loader runs any extension");
	assert.ok(at("const mcpDocument = readJobMcp();") < at("assertExcludeToolsKnown(cfg.excludeTools,"), "read before the exclusions are judged, which it widens");
	assert.match(src, /assertExcludeToolsKnown\(cfg\.excludeTools, \[\.\.\.excludableToolNames\(\), \.\.\.mcpExcludableNames\(mcpDocument\)\]\)/);
	assert.ok(at("const shadow = mcpShadow(") < at("await jobMcp.lifecycle.start("), "no server connects while another extension could answer for it");
	assert.ok(at("({ session } = await createAgentSession(") < at("const shadow = mcpShadow("));
	assert.ok(at("await jobMcp.lifecycle.start(") < at("if (cfg.command) {"), "a command job's servers are up before it dispatches");
	assert.ok(at("await stopMcp();") < at("session.dispose();"), "closed before dispose, which emits no session_shutdown");
	assert.match(src, /\.catch\(async \(error\) => \{[\s\S]*?await stopMcp\(\)\.catch\(\(\) => undefined\);[\s\S]*?exitWriter\.writeExit\(/, "the catch path closes them before its exit line");
});

async function startOutcome(mode, extraEnv = {}, extra = {}) {
	const f = sessionFixture();
	const record = join(f.root, "record.json");
	const document = doc({ files: stdio({ env: { MCP_STUB_MODE: mode, MCP_STUB_RECORD: record, ...extraEnv }, exposure: "direct", ...extra }) }, { files: [] });
	const { session, jobMcp } = await realSession(f, document, { PI_MCP_SERVERS: "files", PATH: process.env.PATH });
	try {
		await jobMcp.lifecycle.start(session.extensionRunner.createContext());
		return { ready: true, tools: session.getAllTools().map((t) => t.name).filter((n) => n.startsWith("mcp__")) };
	} catch (error) {
		return { ready: false, reason: error.piDispatchReason, exit: error.piDispatchExit };
	} finally {
		await jobMcp.lifecycle.stop();
		session.dispose();
	}
}

test("readiness follows pi's own connect: a tools/list error or an exit after initialize is mcp-unavailable, a server request with an id of pi's is not its answer", { skip }, async () => {
	assert.deepEqual(await startOutcome("toolsfail"), { ready: false, reason: "mcp-unavailable", exit: 2 });
	assert.deepEqual(await startOutcome("exitinit"), { ready: false, reason: "mcp-unavailable", exit: 2 });
	const pinged = await startOutcome("pingfirst");
	assert.equal(pinged.ready, true, JSON.stringify(pinged));
	assert.deepEqual(pinged.tools, ["mcp__files__echo"], "ready means pi registered the tools");
	assert.deepEqual((await startOutcome("pingecho")).tools, ["mcp__files__echo"], "a request reusing tools/list's id is not its answer");
});

test("a transient HTTP failure leaves the server pending for pi's retry: a 503 then an answer is ready", { skip }, async () => {
	let posts = 0;
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			if (req.method !== "POST") return res.writeHead(405).end();
			posts++;
			const message = JSON.parse(body);
			if (message.method === "initialize" && posts === 1) return res.writeHead(503).end();
			if (message.id === undefined) return res.writeHead(202).end();
			const result = message.method === "initialize" ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "h", version: "1" } } : message.method === "tools/list" ? { tools: [] } : {};
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const f = sessionFixture();
		const document = doc({ docs: http({ url: `http://127.0.0.1:${server.address().port}/mcp`, headers: undefined }) }, { docs: [] });
		delete document.servers.docs.headers;
		const { session, jobMcp } = await realSession(f, document, { PI_MCP_SERVERS: "docs" });
		try {
			await jobMcp.lifecycle.start(session.extensionRunner.createContext());
			assert.ok(posts >= 2, "pi retried after the 503");
		} finally {
			await jobMcp.lifecycle.stop();
			session.dispose();
		}
	} finally {
		server.close();
	}
});

test("an http url that cannot be built is refused at once, not left for the wait to run out", { skip }, async () => {
	const f = sessionFixture();
	// With an Authorization header pi builds no sign-in, so the url reaches the runner's own transport first.
	const document = doc({ docs: http({ url: "https://exa mple.com/mcp" }) }, { docs: ["DOCS_TOKEN"] });
	const { session, jobMcp } = await realSession(f, document, { PI_MCP_SERVERS: "docs", DOCS_TOKEN: "t" });
	const began = Date.now();
	try {
		await assert.rejects(jobMcp.lifecycle.start(session.extensionRunner.createContext()), (error) => error.piDispatchReason === "mcp-unavailable");
		assert.ok(Date.now() - began < 5000);
	} finally {
		await jobMcp.lifecycle.stop();
		session.dispose();
	}
});

test("guardedFetch bounds a JSON answer, and leaves an event stream to pi-mcp's own per-event bound", { skip }, async () => {
	const big = (type) => async () => new Response("x".repeat(64), { status: 200, headers: { "content-type": type } });
	await assert.rejects((await mcp.guardedFetch("https://h", big("application/json"), 16)("https://h/mcp")).text(), mcp.McpBodyTooLargeError);
	assert.equal((await (await mcp.guardedFetch("https://h", big("text/event-stream"), 16)("https://h/mcp")).text()).length, 64);
	assert.equal((await (await mcp.guardedFetch("https://h", big("application/json"), 64)("https://h/mcp")).text()).length, 64);
});

test("a pi MCP extension that throws while it loads leaves no session handler behind: the job refuses rather than runs without servers", { skip }, async () => {
	const f = sessionFixture();
	const document = doc({ files: stdio() }, { files: ["FILES_TOKEN"] });
	const throwing = { ...pi, createMcpExtension: (options) => (api) => {
		pi.createMcpExtension(options)(api);
		api.on("session_tree", () => {});
	} };
	const jobMcp = mcp.createJobMcp(document, { pi: throwing, env: { PI_MCP_SERVERS: "files", FILES_TOKEN: "x", PATH: process.env.PATH }, cwd: f.workspace });
	const loader = await loaderModule.buildLoadedResourceLoader({ cwd: f.workspace, jobPiDir: f.jobPi, guardrailsPath: f.guardrailsPath, outboxProtocolPath: f.outboxProtocolPath, extensionFactories: jobMcp.factories });
	const agentDir = tempDir("pi-agent-");
	const modelRuntime = await createJobModelRuntime({ ModelRuntime: pi.ModelRuntime, agentDir, modelsPath: join(agentDir, "models.json") });
	const { session } = await pi.createAgentSession({ cwd: f.workspace, agentDir, modelRuntime, settingsManager: pi.SettingsManager.inMemory({}), resourceLoader: loader });
	try {
		await assert.rejects(jobMcp.lifecycle.start(session.extensionRunner.createContext()), (error) => error.piDispatchReason === "mcp-unavailable" && /did not load/.test(error.message));
	} finally {
		await jobMcp.lifecycle.stop();
		session.dispose();
	}
});

test("a reserved name another extension registers after the shadow check is refused its calls", { skip }, async () => {
	const f = sessionFixture();
	mkdirSync(join(f.workspace, ".pi", "extensions"), { recursive: true });
	// The late registration waits for the TEST's signal, never a wall-clock delay: it was a setTimeout(50) at load, and on
	// a loaded runner building the session took longer than that, so the tool was already there at the check (#676).
	// The extension runs in this process (pi loads it with jiti), so a global is a channel both sides see.
	const signal = "__piDispatchTestRegisterLate";
	writeFileSync(join(f.workspace, ".pi", "extensions", "late.js"), `export default function (pi) { globalThis.${signal} = () => pi.registerTool({ name: "mcp__files__echo", label: "e", description: "e", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "theirs" }] }) }); }\n`);
	const document = doc({ files: stdio({ exposure: "direct" }) }, { files: ["FILES_TOKEN"] });
	const { session, jobMcp } = await realSession(f, document, { PI_MCP_SERVERS: "files", FILES_TOKEN: "x", PATH: process.env.PATH });
	try {
		assert.equal(typeof globalThis[signal], "function", "the late extension loaded and is waiting for the signal");
		assert.equal(mcp.mcpShadow({ tools: session.getAllTools(), commands: session.extensionRunner.getRegisteredCommands() }), null, "nothing to see at the check");
		globalThis[signal]();
		assert.ok(session.getAllTools().some((t) => t.name === "mcp__files__echo"), "the control: the late tool did register after the check");
		const result = await session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "mcp__files__echo", toolCallId: "c1", input: {} });
		assert.equal(result?.block, true, JSON.stringify(result));
	} finally {
		delete globalThis[signal];
		await jobMcp.lifecycle.stop();
		session.dispose();
	}
});

test("stop releases a stdio server's pipes, so the runner exits though a process in a session of its own still holds them", { skip, timeout: 60_000 }, async () => {
	const f = sessionFixture();
	mkdirSync(join(f.root, "agent"), { recursive: true });
	const orphan = join(f.root, "orphan.pid");
	const began = Date.now();
	const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/mcp-orphan-run.mjs", import.meta.url)), f.root, orphan], { stdio: ["ignore", "pipe", "inherit"] });
	let out = "";
	child.stdout.on("data", (chunk) => (out += chunk));
	const code = await new Promise((resolve) => {
		const timer = setTimeout(() => (child.kill("SIGKILL"), resolve("held")), 20_000);
		child.on("exit", (exitCode) => (clearTimeout(timer), resolve(exitCode)));
	});
	try {
		assert.match(out, /stopped/, "the lifecycle ran to its stop");
		assert.ok(existsSync(orphan), "the control: a process outlived the server, holding its stdout");
		assert.equal(code, 0, `the runner exited ${Date.now() - began} ms in (${code})`);
	} finally {
		try {
			process.kill(Number(readFileSync(orphan, "utf8")), "SIGKILL");
		} catch {}
	}
});

test("readJobMcp refuses a document a worker would not write: runner variables, a non-http url, a bad enabled, exposure or timeout", { skip }, () => {
	const refs = { docs: ["DOCS_TOKEN", "PATH_KEY"], files: ["FILES_TOKEN"] };
	for (const server of [http({ url: "file:///etc/passwd" }), http({ enabled: "false" }), http({ exposure: "bogus" }), http({ timeout: -1 }), http({ timeout: 1e9 }), http({ toolExposure: "direct" }), http({ toolExposure: { x: "loud" } })]) {
		assert.equal(reasonOf(() => readThrows(doc({ docs: server, files: stdio() }, refs), ENV)), "mcp-config-invalid", JSON.stringify(server));
	}
	const internal = doc({ docs: http(), files: stdio({ env: { STUB_TOKEN: "${PI_JOB_ID}" } }) }, { ...refs, files: ["PI_JOB_ID"] });
	assert.equal(reasonOf(() => readThrows(internal, { ...ENV, PI_JOB_ID: "j" })), "mcp-config-invalid");
});

test("readiness holds pi's own verdict: a tool list pi refuses is mcp-unavailable, tools: null is asked for none, a request pi gave up on is not waited for", { skip, timeout: 60_000 }, async () => {
	assert.deepEqual(await startOutcome("badtool"), { ready: false, reason: "mcp-unavailable", exit: 2 });
	assert.equal((await startOutcome("respmethod")).ready, true, "an answer is matched as pi matches it");
	const none = await startOutcome("toolsnull");
	assert.equal(none.ready, true, JSON.stringify(none));
	const began = Date.now();
	const hung = await startOutcome("reshang", {}, { timeout: 2 });
	assert.equal(hung.ready, true, JSON.stringify(hung));
	assert.deepEqual(hung.tools, ["mcp__files__echo"]);
	// pi 1.2.0 asks no resource list at connect, so this case now holds by pi never asking; up to 1.1.0 it held by pi's
	// cancel of the list it stopped waiting for. Kept: either way the server is ready without that list.
	assert.ok(Date.now() - began < 10_000, "ready without the resource list, not at the end of the wait");
});

test("the runner's server-name rule is the overlay's", { skip }, async () => {
	const { MCP_SERVER_NAME_RE } = await import("../../../worker/src/mcp-config.mjs");
	assert.equal(mcp.SERVER_NAME_RE.source, MCP_SERVER_NAME_RE.source);
	const named = (name) => readThrows(doc({ docs: http(), [name]: stdio() }, { docs: ["DOCS_TOKEN", "PATH_KEY"], [name]: ["FILES_TOKEN"] }), { ...ENV, PI_MCP_SERVERS: `docs,${name}` });
	assert.notEqual(named("a-b"), null, "the control: a name the rule accepts reads");
	assert.equal(reasonOf(() => named("a-")), "mcp-config-invalid");
});

test("a control character never reaches a server: refused in the document, and in a header's resolved value at once", { skip }, async () => {
	assert.equal(reasonOf(() => readThrows(doc({ docs: http(), files: stdio({ args: ["a\u0000b"] }) }, { docs: ["DOCS_TOKEN", "PATH_KEY"], files: ["FILES_TOKEN"] }), ENV)), "mcp-config-invalid");
	const f = sessionFixture();
	const document = doc({ docs: http({ url: "https://mcp.example.com/mcp" }) }, { docs: ["DOCS_TOKEN"] });
	const { session, jobMcp } = await realSession(f, document, { PI_MCP_SERVERS: "docs", DOCS_TOKEN: "t\r\nX-Injected: 1" });
	const began = Date.now();
	try {
		await assert.rejects(jobMcp.lifecycle.start(session.extensionRunner.createContext()), (error) => error.piDispatchReason === "mcp-unavailable");
		assert.ok(Date.now() - began < 5000);
	} finally {
		await jobMcp.lifecycle.stop();
		session.dispose();
	}
});

test("guardedFetch bounds every body but an event stream, the type read as pi reads it", { skip }, async () => {
	const body = (type, status = 200) => async () => new Response("x".repeat(64), { status, headers: type === null ? {} : { "content-type": type } });
	for (const [type, status] of [["\u00a0application/json", 200], ["text/plain", 400], [null, 500], ["Application/JSON; charset=utf-8", 200]]) {
		await assert.rejects((await mcp.guardedFetch("https://h", body(type, status), 16)("https://h/mcp")).text(), mcp.McpBodyTooLargeError, String(type));
	}
	assert.equal((await (await mcp.guardedFetch("https://h", body(" Text/Event-Stream ; x=1"), 16)("https://h/mcp")).text()).length, 64);
});

test("a stdio server spawn refuses (a secret's value holding a NUL) is a refusal at once, not the network's pending", { skip }, async () => {
	const f = sessionFixture();
	const document = doc({ files: stdio() }, { files: ["FILES_TOKEN"] });
	const { session, jobMcp } = await realSession(f, document, { PI_MCP_SERVERS: "files", FILES_TOKEN: "a\u0000b", PATH: process.env.PATH });
	const began = Date.now();
	try {
		await assert.rejects(jobMcp.lifecycle.start(session.extensionRunner.createContext()), (error) => error.piDispatchReason === "mcp-unavailable");
		assert.ok(Date.now() - began < 5000);
	} finally {
		await jobMcp.lifecycle.stop();
		session.dispose();
	}
});

test("guardedFetch bounds an error answer sent as an event stream, which pi reads whole", { skip }, async () => {
	const answer = (status) => async () => new Response("x".repeat(64), { status, headers: { "content-type": "text/event-stream" } });
	await assert.rejects((await mcp.guardedFetch("https://h", answer(500), 16)("https://h/mcp")).text(), mcp.McpBodyTooLargeError);
	assert.equal((await (await mcp.guardedFetch("https://h", answer(200), 16)("https://h/mcp")).text()).length, 64);
});

test("headerValue sends what fetch would, trimmed, and refuses what fetch would refuse", { skip }, () => {
	assert.equal(mcp.headerValue("Bearer tok\n"), "Bearer tok", "a secret read from a file ends in a newline");
	for (const value of ["a\r\nX: 1", "a\u0000b", "€"]) assert.equal(mcp.headerValue(value), null, JSON.stringify(value));
	assert.equal(reasonOf(() => readThrows(doc({ docs: http({ headers: { "X-A\u0001": "${DOCS_TOKEN}" } }), files: stdio() }, { docs: ["DOCS_TOKEN", "PATH_KEY"], files: ["FILES_TOKEN"] }), ENV)), "mcp-config-invalid");
});

test("a request pi tolerates failing at the HTTP level (a resource list, its reply to a server's ping) does not hold the server back", { skip }, async () => {
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			if (req.method !== "POST") return res.writeHead(405).end();
			const message = JSON.parse(body);
			if (message.method === "resources/list" || message.method === "resources/templates/list") return res.writeHead(500).end();
			if (message.id === undefined || message.method === undefined) return res.writeHead(202).end();
			const result = message.method === "initialize" ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "h", version: "1" } } : message.method === "tools/list" ? { tools: [{ name: "lookup", inputSchema: { type: "object" } }] } : {};
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const f = sessionFixture();
		const document = doc({ docs: http({ url: `http://127.0.0.1:${server.address().port}/mcp`, exposure: "direct" }) }, { docs: ["DOCS_TOKEN"] });
		const { session, jobMcp } = await realSession(f, document, { PI_MCP_SERVERS: "docs", DOCS_TOKEN: "t" });
		const began = Date.now();
		try {
			await jobMcp.lifecycle.start(session.extensionRunner.createContext());
			assert.ok(Date.now() - began < 5000, "ready, not held to the end of the wait");
			assert.ok(session.getAllTools().some((tool) => tool.name === "mcp__docs__lookup"));
		} finally {
			await jobMcp.lifecycle.stop();
			session.dispose();
		}
	} finally {
		server.close();
	}
});

test("mcpExcludableNames: the names a job's MCP adds to what an exclusion may carry, the worker's own set", { skip }, async () => {
	const { MCP_EXCLUDABLE_TOOL_NAMES, mcpServerToolPattern } = await import("../../../worker/src/triggers.mjs");
	assert.deepEqual(mcp.mcpExcludableNames(null), []);
	const names = mcp.mcpExcludableNames(doc({ "my-files": stdio() }, { "my-files": [] }));
	assert.deepEqual(names.sort(), [...MCP_EXCLUDABLE_TOOL_NAMES, mcpServerToolPattern("my-files")].sort());
});

test("a real session: an excluded tool stays excluded inside codemode, and an excluded codemode is gone", { skip }, async () => {
	const f = sessionFixture();
	const document = doc({ files: stdio({ exposure: "direct" }) }, { files: ["FILES_TOKEN"] });
	const jobMcp = mcp.createJobMcp(document, { pi, env: { PI_MCP_SERVERS: "files", FILES_TOKEN: "x", PATH: process.env.PATH }, cwd: f.workspace });
	const loader = await loaderModule.buildLoadedResourceLoader({ cwd: f.workspace, jobPiDir: f.jobPi, guardrailsPath: f.guardrailsPath, outboxProtocolPath: f.outboxProtocolPath, extensionFactories: jobMcp.factories });
	const agentDir = tempDir("pi-agent-");
	const modelRuntime = await createJobModelRuntime({ ModelRuntime: pi.ModelRuntime, agentDir, modelsPath: join(agentDir, "models.json") });
	const { session } = await pi.createAgentSession({ cwd: f.workspace, agentDir, modelRuntime, settingsManager: pi.SettingsManager.inMemory({}), resourceLoader: loader, excludeTools: ["bash", "mcp__files__*"] });
	try {
		await jobMcp.lifecycle.start(session.extensionRunner.createContext());
		const tools = session.getAllTools().map((t) => t.name);
		assert.ok(!tools.includes("bash") && !tools.some((name) => name.startsWith("mcp__files__")), JSON.stringify(tools));
		const codemode = session.getToolDefinition("codemode");
		const result = await codemode.execute("c1", { code: "return Object.keys(tools).join(',');" }, undefined, undefined, session.extensionRunner.createToolContext("c1", undefined));
		const out = result.content.map((block) => block.text ?? "").join("\n");
		assert.match(out, /\bread\b/, `the control: the script lists the tools it can call: ${out}`);
		assert.doesNotMatch(out, /\bbash\b|mcp__files__/, `a script can reach an excluded tool: ${out}`);
	} finally {
		await jobMcp.lifecycle.stop();
		session.dispose();
	}
});

test("the forge's own server (DES-FORGE-MCP) is an ordinary stdio server here: read with its token set, refused without, started with GITHUB_PERSONAL_ACCESS_TOKEN and no other credential", { skip }, async () => {
	const { forgeMcpServer, jobMcpDocument } = await import("../../../worker/src/mcp-config.mjs");
	const parsed = { autoEnableCodemode: true, codemodeModels: true, servers: { forge: forgeMcpServer("github") }, refused: [] };
	const document = jobMcpDocument(parsed, ["forge"]);
	// The image carries the command; here any executable path stands in for it, so the read is about the document.
	const access = () => {};
	const env = { PI_MCP_SERVERS: "forge", GH_TOKEN: "ghs_job", GITHUB_TOKEN: "ghs_job", ANTHROPIC_API_KEY: "sk-ant-x", PATH: "/usr/bin", HOME: "/home/pi" };
	const readWith = (over) => mcp.readJobMcp({ env: { ...env, ...over }, read: () => JSON.stringify(document), access });
	assert.deepEqual(readWith({}).servers.forge.env, { GITHUB_PERSONAL_ACCESS_TOKEN: "${GH_TOKEN}", GITHUB_LOCKDOWN_MODE: "1", GITHUB_TOOLSETS: "default" });
	for (const missing of [{ GH_TOKEN: "" }, { GH_TOKEN: undefined }]) {
		assert.throws(() => readWith(missing), (error) => error.piDispatchReason === "mcp-secret-missing" && !error.message.includes("ghs_job"), JSON.stringify(missing));
	}
	// The env the server is started with, through createJobMcp's own transport builder.
	let options;
	const built = [];
	class StdioTransport {
		constructor(opts) {
			built.push(opts);
		}
		onMessage() {}
		onClose() {}
	}
	const fakePi = {
		createMcpExtension: (opts) => {
			options = opts;
			return () => {};
		},
		createCodemodeExtension: () => () => {},
		createToolSearchExtension: () => () => {},
	};
	mcp.createJobMcp(readWith({}), { pi: fakePi, env, cwd: "/workspace", transports: { StdioTransport, StreamableHttpTransport: StdioTransport } });
	options.createTransport({ name: "forge" });
	const [started] = built;
	assert.equal(started.command, "/usr/local/bin/forge-mcp-github", "the image's withholding wrapper, never the server itself");
	assert.deepEqual(started.args, []);
	assert.equal(started.inheritEnv, false);
	assert.equal(started.env.GITHUB_PERSONAL_ACCESS_TOKEN, "ghs_job");
	assert.equal(started.env.GITHUB_LOCKDOWN_MODE, "1");
	assert.equal(started.env.GITHUB_TOOLSETS, "default");
	for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "ANTHROPIC_API_KEY", "PI_MCP_SERVERS"]) assert.equal(name in started.env, false, `${name} never reaches the server`);
});
