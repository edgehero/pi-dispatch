/**
 * A preload (`node --import`) that answers every model request of the process it runs in, and lets nothing leave the
 * machine. For the tests and image proofs that run a REAL runner or a REAL pi child on a subscription: no provider, no
 * credential and no network, ever.
 *
 * TWO LOCKS, because one is not enough: the pi CLI replaces `globalThis.fetch` with undici's at startup
 * (pi-coding-agent core/http-dispatcher.js `configureHttpDispatcher`), so a fake that is only assigned is gone by the
 * first call of a pi child, and that call goes out (measured once, issue #1098's gate, with a fake token: refused by the
 * provider). So (1) `fetch` is pinned to the fake below, a later assignment ignored; and (2) every outbound socket to an
 * address that is not loopback is refused before any lookup or connect, whatever opens it.
 *
 * Answers the OpenAI Responses and the Anthropic Messages routes, as a stream. Driven by the environment, which a child
 * inherits:
 *   OFFLINE_FETCH_LOG     a file each request is appended to, one JSON line: `who`, `answered`, `tools`, `model`,
 *                         `token` (the bearer is the subscription's access token) and one boolean per probe;
 *   OFFLINE_FETCH_TOOL    the parent's tool: a request offering it is the parent's (`who: "root"`), and its first call is
 *                         answered with a call of that tool, with OFFLINE_FETCH_ARGS (JSON) as its arguments;
 *   OFFLINE_FETCH_PROBES  a JSON object, name to text: whether the request's body holds that text (in its JSON form);
 *   OFFLINE_FETCH_ANSWER  the text a request that is not the parent's first one is answered with.
 */
import { appendFileSync } from "node:fs";
import net from "node:net";

// Only a literal loopback address or "localhost": a name that merely starts with "127." (127.example.com) is a name
// to look up, and so is anything else.
const loopback = (host) => host === "localhost" || host === "::1" || host === "[::1]" || (typeof host === "string" && /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host));
const record = (line) => {
	try {
		if (process.env.OFFLINE_FETCH_LOG) appendFileSync(process.env.OFFLINE_FETCH_LOG, `${JSON.stringify(line)}\n`);
	} catch {
		// A test reads what was written; a write that failed only shows there as a missing line.
	}
};

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
	let options = Array.isArray(args[0]) ? args[0][0] : args[0];
	if (typeof options !== "object" || options === null) options = typeof args[0] === "string" && !/^\d+$/.test(args[0]) ? { path: args[0] } : { port: args[0], host: args[1] };
	// A Unix socket is a string path with no host and no port (node:http's agent passes `path: null` beside its host, so a
	// path that is not a string is no socket). Anything else must name a loopback address; a missing host is
	// "localhost" only when no path was given at all, as net.connect reads it.
	const socketPath = typeof options.path === "string" && options.host == null && options.port == null;
	const host = options.host ?? (options.path == null ? "localhost" : null);
	if (!socketPath && !loopback(host)) {
		record({ blocked: String(host) });
		const error = new Error("offline: an outbound connection was refused");
		process.nextTick(() => this.destroy(error));
		return this;
	}
	return connect.apply(this, args);
};

const stream = (chunks) => new Response(chunks.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

async function answer(input, init) {
	const request = new Request(input, init);
	const url = new URL(request.url);
	const route = url.origin + url.pathname;
	const openai = route === "https://api.openai.com/v1/responses";
	if (!openai && route !== "https://api.anthropic.com/v1/messages") {
		record({ refusedRoute: route });
		throw new Error("offline: no such route");
	}
	const body = JSON.parse(await request.text());
	const text = JSON.stringify(body);
	const tools = (body.tools ?? []).map((tool) => tool.name);
	const tool = process.env.OFFLINE_FETCH_TOOL ?? "";
	const answered = openai ? (body.input ?? []).some((item) => item.type === "function_call_output") : (body.messages ?? []).some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "tool_result"));
	const who = tool !== "" && tools.includes(tool) ? "root" : "child";
	const access = openai ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_OAUTH_TOKEN;
	let probes = {};
	try {
		probes = JSON.parse(process.env.OFFLINE_FETCH_PROBES ?? "{}");
	} catch {
		probes = {};
	}
	record({ who, answered, tools, model: body.model, token: request.headers.get("authorization") === `Bearer ${access}`, ...Object.fromEntries(Object.entries(probes).map(([name, needle]) => [name, text.includes(needle)])) });
	const calls = who === "root" && !answered;
	const reply = who === "root" ? "parent done" : (process.env.OFFLINE_FETCH_ANSWER ?? "child ok");
	const args = process.env.OFFLINE_FETCH_ARGS ?? "{}";
	if (openai) {
		const item = calls
			? { type: "function_call", id: "fc_1", call_id: "call_1", name: tool, arguments: args }
			: { type: "message", id: `msg_${who}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: reply, annotations: [] }] };
		const opening = item.type === "function_call" ? { ...item, arguments: "" } : { ...item, content: [] };
		return stream([
			event("response.created", { response: { id: `resp_${who}` } }),
			event("response.output_item.added", { output_index: 0, item: opening }),
			event("response.output_item.done", { output_index: 0, item }),
			event("response.completed", { response: { id: `resp_${who}`, status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } }),
		]);
	}
	const block = calls ? { type: "tool_use", id: "toolu_1", name: tool, input: {} } : { type: "text", text: "" };
	const delta = calls ? { type: "input_json_delta", partial_json: args } : { type: "text_delta", text: reply };
	return stream([
		event("message_start", { message: { id: `msg_${who}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }),
		event("content_block_start", { index: 0, content_block: block }),
		event("content_block_delta", { index: 0, delta }),
		event("content_block_stop", { index: 0 }),
		event("message_delta", { delta: { stop_reason: calls ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }),
		event("message_stop", {}),
	]);
}

Object.defineProperty(globalThis, "fetch", { configurable: false, enumerable: true, get: () => answer, set: () => {} });
