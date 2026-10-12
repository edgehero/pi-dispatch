/**
 * The forge MCP servers' gate (DES-FORGE-MCP, CONST-MERGE-NEVER-AUTOMATIC): a stdio pass-through between the job's
 * MCP client and the forge's own server that WITHHOLDS the tools named on its command line, so the job is not handed a
 * forge's dedicated merge or approval tool. It is not a boundary: a quick action in a note, the job's own CLI, or the
 * server run from the job's shell act with the token's role, which with branch protection is the boundary. Run by the
 * two wrappers beside it, never by the worker directly:
 *
 *   node withhold.mjs <name,name,...> -- <server command> [args...]
 *
 * Two rules, both on every message, so neither depends on the server honouring its own settings:
 *   - every answer of the server's that carries a tool list (`result.tools`, whatever request it answers) loses every
 *     withheld name before the client sees it;
 *   - a `tools/call` is answered here with an error, never forwarded, when its name is withheld OR is not in the tool
 *     list the server last answered (minus the withheld). The second rule is the one that holds: mcp-gitlab 2.1.67
 *     hides a tool from its list (GITLAB_TOOL_POLICY_HIDDEN, GITLAB_DENIED_TOOLS_REGEX) yet still runs a direct call
 *     to it, and runs a call to a tool no toolset lists (`execute_graphql`, whose mutations include a merge). A call
 *     before any list is refused for the same reason.
 *
 * A client line is judged as parsed and forwarded as re-serialized, so the server reads exactly what was judged (no
 * second reading of a duplicate key or of two objects on one line, which a streaming decoder would take). A line that
 * does not parse, and a batch, are not forwarded at all. The server's lines pass as written but for the list answers.
 * Plain node and nothing else: it runs before anything of the job is trusted, and the image ships no package for it.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [list, separator, command, ...args] = process.argv.slice(2);
if (typeof list !== "string" || separator !== "--" || typeof command !== "string") {
	process.stderr.write("usage: withhold.mjs <name,name,...> -- <command> [args...]\n");
	process.exit(2);
}
const withheld = new Set(list.split(",").filter((name) => name !== ""));

const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
// A pipe that closes under a write (the server exited with a line in flight, or the client went away) is an EPIPE on
// the stream, never an unhandled error: the server's own exit decides ours.
child.stdin.on("error", () => {});
process.stdout.on("error", () => child.kill("SIGTERM"));
child.on("error", (error) => {
	process.stderr.write(`withhold.mjs: the server did not start (${error.code ?? "error"})\n`);
	process.exit(127);
});
// On "close", after the server's output has ended, and once ours has drained: an exit on "exit" could drop its
// last lines.
child.on("close", (code, signal) => {
	const status = code ?? (signal ? 1 : 0);
	if (process.stdout.destroyed || !process.stdout.writable) process.exit(status);
	process.stdout.write("", () => process.exit(status));
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => child.kill(signal));

/** The tools the server last listed, less the withheld; null before its first list. Pages add to the first page. */
let listed = null;
/** The ids of the client's `tools/list` requests, and whether each asked for a later page. */
const listRequests = new Map();

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const answer = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const refuse = (id, text) => answer({ id, error: { code: -32602, message: text } });

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
	if (line.trim() === "") return;
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	if (!isRecord(message)) {
		if (Array.isArray(message)) for (const item of message) if (isRecord(item) && item.id !== undefined) refuse(item.id, "a batch is not accepted here");
		return;
	}
	if (message.method === "tools/call") {
		const name = isRecord(message.params) ? message.params.name : undefined;
		if (typeof name !== "string" || withheld.has(name) || listed === null || !listed.has(name)) {
			const why = withheld.has(name) ? "it is withheld from this job" : "the server did not list it";
			if (message.id !== undefined) refuse(message.id, `unknown tool ${JSON.stringify(String(name))}: ${why}`);
			return;
		}
	}
	if (message.method === "tools/list" && message.id !== undefined) {
		listRequests.set(message.id, isRecord(message.params) && message.params.cursor !== undefined);
	}
	if (child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
}).on("close", () => child.stdin.end());

createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		process.stdout.write(`${line}\n`);
		return;
	}
	// Every message that carries a tool list is filtered, not only the answers to ids the gate saw asked: an id a
	// server reuses (its own ping, say) must not carry an unfiltered list past it. An answer to a later page adds to
	// the list; any other list replaces it.
	if (isRecord(message) && isRecord(message.result) && Array.isArray(message.result.tools)) {
		const page = message.id !== undefined && listRequests.get(message.id) === true;
		if (message.id !== undefined) listRequests.delete(message.id);
		const tools = message.result.tools.filter((tool) => isRecord(tool) && typeof tool.name === "string" && !withheld.has(tool.name));
		if (!page || listed === null) listed = new Set();
		for (const tool of tools) listed.add(tool.name);
		process.stdout.write(`${JSON.stringify({ ...message, result: { ...message.result, tools } })}\n`);
		return;
	}
	if (isRecord(message) && message.id !== undefined && message.method === undefined) listRequests.delete(message.id);
	process.stdout.write(`${line}\n`);
});
