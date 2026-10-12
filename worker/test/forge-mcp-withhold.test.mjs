import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * image/forge-mcp/withhold.mjs, the gate between a job and the forge's own MCP server (DES-FORGE-MCP,
 * CONST-MERGE-NEVER-AUTOMATIC), run against a stub server that lists every tool and runs any call it receives, which is
 * what mcp-gitlab 2.1.67 does with a tool its own settings hide (measured). So whatever the stub answers for a withheld
 * or unlisted name is a call the gate let through.
 */
const GATE = fileURLToPath(new URL("../../image/forge-mcp/withhold.mjs", import.meta.url));
const STUB = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
rl.on("line", (line) => {
	const m = JSON.parse(line);
	if (m.method === "initialize") return send({ id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1" } } });
	if (m.method === "tools/list") {
		const page = m.params && m.params.cursor ? [{ name: "late" }] : [{ name: "read_it" }, { name: "merge_it" }, { name: "approve_it" }];
		return send({ id: m.id, result: { tools: page, ...(m.params && m.params.cursor ? {} : { nextCursor: "2" }) } });
	}
	if (m.method === "tools/call") return send({ id: m.id, result: { ran: m.params.name, raw: line } });
	// A server that answers a request it was not asked for a list with a list anyway (an id it reuses, a ping).
	if (m.method === "ping") return send({ id: m.id, result: { tools: [{ name: "merge_it" }, { name: "pinged" }] } });
	// Closes its end of the pipe first and exits a little later, so the gate's next writes meet a closed pipe.
	if (m.method === "die") {
		process.stdin.destroy();
		setTimeout(() => process.exit(3), 300);
	}
	if (m.id !== undefined) send({ id: m.id, result: {} });
});
rl.on("close", () => process.exit(0));
`;

/**
 * Runs the gate over the stub, writes `lines` in order (a `{ wait: id }` item holds the rest until that answer came, so
 * a call is never raced against the list it depends on), and returns every answer by id once `expect` have come.
 */
function session(lines, { withheld = "merge_it,approve_it", expect } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [GATE, withheld, "--", process.execPath, "-e", STUB], { stdio: ["pipe", "pipe", "inherit"] });
		const answers = new Map();
		let buffer = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`timed out with ${[...answers.keys()]}`));
		}, 10_000);
		child.stdout.on("data", (chunk) => {
			buffer += chunk;
			let at;
			while ((at = buffer.indexOf("\n")) >= 0) {
				const message = JSON.parse(buffer.slice(0, at));
				buffer = buffer.slice(at + 1);
				answers.set(message.id, message);
				if (answers.size === expect) {
					clearTimeout(timer);
					child.stdin.end();
				}
			}
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ answers, code });
		});
		const queue = [...lines];
		const next = () => {
			if (queue.length === 0) return;
			if (typeof queue[0] === "object") {
				if (answers.has(queue[0].wait)) queue.shift();
				setTimeout(next, 10);
				return;
			}
			child.stdin.write(`${queue.shift()}\n`);
			setTimeout(next, 10);
		};
		next();
	});
}
const rpc = (m) => JSON.stringify({ jsonrpc: "2.0", ...m });
const call = (id, name) => rpc({ id, method: "tools/call", params: { name, arguments: {} } });

test("withhold.mjs: a listed tool passes; a withheld one is dropped from the list and its call refused; a call to a tool never listed is refused", async () => {
	const { answers, code } = await session(
		[
			rpc({ id: 1, method: "initialize", params: {} }),
			{ wait: 1 },
			call(2, "read_it"),
			{ wait: 2 },
			rpc({ id: 3, method: "tools/list" }),
			{ wait: 3 },
			rpc({ id: 4, method: "tools/list", params: { cursor: "2" } }),
			{ wait: 4 },
			call(5, "read_it"),
			call(6, "merge_it"),
			call(7, "approve_it"),
			call(8, "never_listed"),
			call(9, "late"),
		],
		{ expect: 9 },
	);
	assert.equal(code, 0, "the gate exits as the server does");
	assert.equal(answers.get(1).result.serverInfo.name, "stub");
	assert.match(answers.get(2).error.message, /did not list/, "no call before the server listed its tools");
	assert.deepEqual(answers.get(3).result.tools.map((t) => t.name), ["read_it"]);
	assert.equal(answers.get(3).result.nextCursor, "2", "the rest of the answer is the server's");
	assert.deepEqual(answers.get(4).result.tools.map((t) => t.name), ["late"]);
	assert.equal(answers.get(5).result.ran, "read_it");
	for (const id of [6, 7, 8]) {
		assert.equal(answers.get(id).result, undefined, `call ${id} never reached the server`);
		assert.equal(answers.get(id).error.code, -32602);
	}
	// A withheld name and a name the server never listed are refused alike, each saying which it is.
	assert.match(answers.get(6).error.message, /withheld/);
	assert.match(answers.get(7).error.message, /withheld/);
	assert.match(answers.get(8).error.message, /did not list/);
	assert.equal(answers.get(9).result.ran, "late", "a later page adds to the first");
});

test("withhold.mjs: the server reads the call as the gate judged it; a batch, a line that does not parse and a nameless call never reach it", async () => {
	const { answers } = await session(
		[
			rpc({ id: 1, method: "tools/list" }),
			{ wait: 1 },
			// A duplicate key: JSON.parse keeps the last, and so must the server, so the line is forwarded re-serialized.
			'{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"merge_it","name":"read_it","arguments":{}}}',
			'{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read_it","name":"merge_it","arguments":{}}}',
			// Two objects on one line, which a streaming decoder would read as two messages.
			`${call(4, "read_it")}${call(5, "merge_it")}`,
			JSON.stringify([JSON.parse(call(6, "merge_it")), JSON.parse(call(7, "read_it"))]),
			rpc({ id: 8, method: "tools/call", params: { arguments: {} } }),
			call(9, "read_it"),
		],
		{ expect: 7 },
	);
	assert.equal(answers.get(2).result.ran, "read_it");
	assert.equal(answers.get(2).result.raw, '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_it","arguments":{}}}');
	assert.match(answers.get(3).error.message, /withheld/);
	assert.equal(answers.has(4), false, "a line that does not parse is not forwarded");
	assert.equal(answers.has(5), false);
	assert.match(answers.get(6).error.message, /batch/);
	assert.match(answers.get(7).error.message, /batch/, "a batch is refused whole");
	assert.match(answers.get(8).error.message, /did not list/);
	assert.equal(answers.get(9).result.ran, "read_it");
});

test("withhold.mjs: refuses to start without its list and separator", async () => {
	const code = await new Promise((resolve) => spawn(process.execPath, [GATE, "merge_it", process.execPath], { stdio: "ignore" }).on("close", resolve));
	assert.equal(code, 2);
});

test("withhold.mjs: a tool list in ANY answer is filtered, whatever request it answers, and calls are judged against what it let through", async () => {
	const { answers } = await session(
		[
			rpc({ id: 1, method: "tools/list" }),
			{ wait: 1 },
			rpc({ id: 2, method: "ping" }),
			{ wait: 2 },
			call(3, "pinged"),
			call(4, "merge_it"),
			call(5, "read_it"),
		],
		{ expect: 5 },
	);
	assert.deepEqual(answers.get(2).result.tools.map((t) => t.name), ["pinged"], "the withheld name never reaches the client");
	assert.equal(answers.get(3).result.ran, "pinged");
	assert.match(answers.get(4).error.message, /withheld/);
	assert.match(answers.get(5).error.message, /did not list/, "the newer list replaced the older one");
});

test("withhold.mjs: a server that exits with lines still arriving ends the gate with the server's code, and no error of the gate's own", async () => {
	const child = spawn(process.execPath, [GATE, "merge_it", "--", process.execPath, "-e", STUB], { stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const closed = new Promise((resolve) => child.on("close", resolve));
	child.stdin.on("error", () => {});
	child.stdin.write(`${rpc({ id: 1, method: "die" })}\n`);
	const flood = setInterval(() => {
		if (child.stdin.writable) child.stdin.write(`${rpc({ id: 2, method: "tools/list" })}\n`);
	}, 1);
	const code = await closed;
	clearInterval(flood);
	assert.equal(code, 3);
	assert.doesNotMatch(stderr, /EPIPE|Unhandled|Error/);
});

test("withhold.mjs: a client that goes away ends the server and the gate, with no error of the gate's own", async () => {
	const child = spawn(process.execPath, [GATE, "merge_it", "--", process.execPath, "-e", STUB], { stdio: ["pipe", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
	child.stdin.on("error", () => {});
	// The reader of the gate's answers is gone; the client's side stays open, so only the EPIPE can end the gate.
	child.stdout.destroy();
	const flood = setInterval(() => {
		if (child.stdin.writable) child.stdin.write(`${rpc({ id: 2, method: "tools/list" })}\n`);
	}, 1);
	const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
	const { signal } = await closed;
	clearInterval(flood);
	clearTimeout(timer);
	assert.notEqual(signal, "SIGKILL", "the gate ended on its own");
	assert.doesNotMatch(stderr, /EPIPE|Unhandled|Error/);
});
