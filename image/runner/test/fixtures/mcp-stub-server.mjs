// A minimal MCP server over stdio for the runner's MCP tests: newline-delimited JSON-RPC, one tool (`echo`), one
// resource, and a record of what it was started with. MCP_STUB_RECORD names a file the server writes once at start:
// its pid, its process group, its cwd and every environment variable NAME it holds (values only for the names in
// MCP_STUB_SHOW). MCP_STUB_MODE changes its behaviour: "exit" exits before answering, "silent" never answers,
// "refuse" answers initialize with an error, "toolsfail" answers tools/list with an error, "exitinit" exits once told
// it is initialized, "pingfirst" sends a request of its own with id 1 before answering, and "orphan" starts a process
// in a session of its own that holds its stdout open for a minute, and "pingecho" sends a request of its own with the
// id of pi's tools/list before answering it, "badtool" lists a tool with no input schema (pi refuses the list),
// "toolsnull" declares `tools: null`, "reshang" never answers resources/list, and "respmethod" answers initialize with a
// stray `method` member (pi still reads it as the answer).
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.env.MCP_STUB_MODE ?? "ok";
if (process.env.MCP_STUB_RECORD) {
	const show = new Set((process.env.MCP_STUB_SHOW ?? "").split(",").filter(Boolean));
	writeFileSync(
		process.env.MCP_STUB_RECORD,
		JSON.stringify({ pid: process.pid, cwd: process.cwd(), argv: process.argv.slice(2), env: Object.keys(process.env).sort(), shown: Object.fromEntries([...show].map((name) => [name, process.env[name] ?? null])) }),
	);
}
if (mode === "exit") process.exit(3);
if (mode === "orphan") {
	const script = "require('fs').writeFileSync(process.env.MCP_STUB_ORPHAN, String(process.pid)); setTimeout(() => {}, 60000)";
	spawn(process.execPath, ["-e", script], { detached: true, stdio: ["ignore", "inherit", "ignore"] }).unref();
}
if (mode === "pingfirst") process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (message.method === "notifications/initialized" && mode === "exitinit") process.exit(4);
	if (message.id === undefined || mode === "silent" || message.method === undefined) return;
	if (message.method === "initialize") {
		if (mode === "refuse") return send({ id: message.id, error: { code: -32603, message: "not today" } });
		const capabilities = { tools: mode === "toolsnull" ? null : {}, resources: {} };
		return send({ id: message.id, ...(mode === "respmethod" && { method: "x" }), result: { protocolVersion: message.params.protocolVersion, capabilities, serverInfo: { name: "stub", version: "1.0.0" }, instructions: "A stub." } });
	}
	if (message.method === "tools/list" && mode === "pingecho") {
		send({ id: message.id, method: "ping" });
		return setTimeout(() => send({ id: message.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } }), 200);
	}
	if (message.method === "tools/list" && mode === "badtool") return send({ id: message.id, result: { tools: [{ name: "x" }] } });
	if (message.method === "resources/list" && mode === "reshang") return;
	if (message.method === "tools/list" && mode === "toolsfail") return send({ id: message.id, error: { code: -32603, message: "no tools today" } });
	if (message.method === "tools/list") return send({ id: message.id, result: { tools: [{ name: "echo", description: "Echo the text back.", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } });
	if (message.method === "tools/call") return send({ id: message.id, result: { content: [{ type: "text", text: `echo:${message.params.arguments?.text ?? ""}` }] } });
	if (message.method === "resources/list") return send({ id: message.id, result: { resources: [{ uri: "stub://readme", name: "readme" }] } });
	if (message.method === "resources/templates/list") return send({ id: message.id, result: { resourceTemplates: [] } });
	if (message.method === "resources/read") return send({ id: message.id, result: { contents: [{ uri: "stub://readme", text: "hello" }] } });
	return send({ id: message.id, error: { code: -32601, message: "method not found" } });
});
