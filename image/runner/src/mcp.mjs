import { LAYOUT } from "./layout.mjs";
import { accessSync, constants, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { isJsonRpcResponse, McpHttpError, StdioTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { CHILD_LEDGER_ENV, RUNNER_PID_ENV } from "./usage-meter.mjs";
import { configError, EXIT_INFRA } from "./outcome.mjs";

/**
 * The job's MCP servers (REQ-MCP-OPERATOR-SERVERS, DES-MCP-TARGETED-LIFECYCLE, DES-MCP-TRANSPORTS-OWNED).
 *
 * The worker writes `/job/mcp.json` for a job whose trigger names servers (`run.mcp`), after its pickup check passed
 * them, and passes their names in PI_MCP_SERVERS. Everything here is the container's half: read the document back
 * and check it again, hand pi its MCP, codemode and tool_search extensions as three named inline factories, and own
 * what pi would otherwise decide for itself. pi's defaults read `mcp.json` from the agent directory and from a
 * trusted project (a repository's own file, in a job), connect servers any loaded extension registers, resolve
 * `!command` config values, give a stdio server the runner's whole environment (the provider's key included), follow
 * an HTTP redirect anywhere, and write OAuth state and a log into the agent directory. None of that runs here:
 *   - the config is the document and nothing else (`loadConfig`);
 *   - the transports are built here, from values this module resolves (`createTransport`);
 *   - pi's extension sees an API whose registered-server list is empty and whose session events are this module's to
 *     fire (`guardedApi`), so the servers connect when the runner says so and close before it exits.
 */

/** Where the worker writes the job's document (INT-CONTAINER-JOB-INPUTS). */
export const JOB_MCP_PATH = `${LAYOUT.job}/mcp.json`;
/** The document version this runner reads; the worker's `JOB_MCP_VERSION`. */
export const JOB_MCP_VERSION = 1;
/** The env var naming the servers, in the document's order, comma separated. */
export const MCP_SERVERS_ENV = "PI_MCP_SERVERS";
/** How long the runner waits for every server to answer before the prompt is sent. */
export const MCP_READY_TIMEOUT_MS = 15_000;
/** The largest JSON answer an HTTP server may send, pi-mcp's own bound on a stdio message and an event. */
export const MCP_HTTP_MAX_BYTES = 16 * 1024 * 1024;
/** The longest the runner waits for servers whose own `timeout` is longer than MCP_READY_TIMEOUT_MS. */
export const MCP_READY_TIMEOUT_MAX_MS = 120_000;
/** How long the runner waits for the servers to close before it disposes the session and exits. */
export const MCP_STOP_TIMEOUT_MS = 5_000;
/** The three inline factories' names: an extension path of `<inline:job-mcp>`, never a `builtin:` one. */
export const MCP_FACTORY_NAMES = Object.freeze(["job-mcp", "job-codemode", "job-tool-search"]);
/** The tools pi's resource support registers: with `mcp__*` and the discovery tools, names only these factories may own. */
export const MCP_RESOURCE_TOOLS = Object.freeze(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
/**
 * The excludeTools entries a job with this document may carry beyond pi's builtins (the worker's loader accepts the
 * same, worker/src/triggers.mjs MCP_EXCLUDABLE_TOOL_NAMES and mcpServerToolPattern): the discovery and resource tools,
 * and each server's tools as a whole, in pi's namespace (`-` written as `_`).
 */
export function mcpExcludableNames(doc) {
	if (doc === null) return [];
	return [...MCP_DISCOVERY_TOOLS, ...MCP_RESOURCE_TOOLS, ...Object.keys(doc.servers).map((name) => `mcp__${name.replace(/-/g, "_")}__*`)];
}

/** The two discovery tools, codemode's and tool_search's. */
export const MCP_DISCOVERY_TOOLS = Object.freeze(["codemode", "tool_search"]);

/**
 * The session events pi 1.1.0's MCP extension subscribes to (extensions/mcp/index.js), and what `guardedApi` does
 * with each. A subscription outside this table refuses the extension (a pi bump that adds one is reviewed here, not
 * trusted): `capture` keeps the handler for `lifecycle`, `drop` never subscribes it, `pass` subscribes it as pi would.
 */
export const MCP_EVENTS = Object.freeze({
	session_start: "capture",
	session_shutdown: "capture",
	// Servers registered by extensions, which this job never connects.
	mcp_servers_change: "drop",
	before_agent_start: "pass",
	tool_call: "pass",
	turn_start: "pass",
});

/** pi-native keys a server may carry in the document: the overlay's accepted set (INT-OVERLAY-MCP-CONFIG), `allowPackageRunner` stripped. */
const SERVER_KEYS = Object.freeze({
	http: ["type", "description", "exposure", "toolExposure", "timeout", "enabled", "url", "headers"],
	stdio: ["type", "description", "exposure", "toolExposure", "timeout", "enabled", "command", "args", "env"],
});
const TOP_KEYS = ["version", "autoEnableCodemode", "codemodeModels", "servers", "refs"];
/** The overlay's server-name rule (worker/src/mcp-config.mjs MCP_SERVER_NAME_RE), held equal by mcp.test.mjs. */
export const SERVER_NAME_RE = /^(?=[a-z0-9-]{1,32}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** pi's exposures (core/mcp-servers.js MCP_EXPOSURES), the overlay's accepted set. */
const MCP_EXPOSURES = Object.freeze(["codemode", "deferred", "direct", "hidden"]);
const REF_NAME = "[A-Z_][A-Z0-9_]*";
const REF_RE = new RegExp(`\\$\\{(${REF_NAME})\\}`, "g");

/**
 * What a stdio server starts with besides its own `env`: enough to run (PATH, HOME, locale, zone, temp), the egress
 * proxy (so a server reaches what the job may reach and nothing else), and the child-meter trio, so a pi a server
 * starts is metered like one the agent starts. Never the provider's key, a minted forge token or a secret the server
 * did not name: pi's default passes the runner's whole environment.
 */
export const MCP_STDIO_BASE_ENV = Object.freeze([
	"PATH",
	"HOME",
	"LANG",
	"LC_ALL",
	"TZ",
	"TMPDIR",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"NODE_USE_ENV_PROXY",
	"NODE_OPTIONS",
	CHILD_LEDGER_ENV,
	RUNNER_PID_ENV,
]);
/** Base names a server's own `env` may not replace: the meter's three, whose loss would let a pi it starts spend unmetered. */
const PINNED_ENV = new Set(["NODE_OPTIONS", CHILD_LEDGER_ENV, RUNNER_PID_ENV]);

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = (why) => configError(`${JOB_MCP_PATH} cannot be used: ${why}`, "mcp-config-invalid");

/** The names in PI_MCP_SERVERS, or [] when it is unset or empty. */
export function mcpServerNames(env = process.env) {
	const raw = env[MCP_SERVERS_ENV];
	return typeof raw === "string" && raw !== "" ? raw.split(",") : [];
}

/**
 * Every `${NAME}` in `value`, or a problem: a `${` that does not open a whole reference. Literal text around a
 * reference is the operator's (a url path, a header scheme), and is sent as written.
 */
function refsIn(value) {
	const names = [...value.matchAll(REF_RE)].map((match) => match[1]);
	const rest = value.replace(REF_RE, "");
	return rest.includes("${") ? null : names;
}

/** `value` with each `${NAME}` replaced by env[NAME]. Resolved here, never by pi, so a value that starts with `!` is text. */
export function resolveRefs(value, env) {
	return value.replace(REF_RE, (_, name) => env[name]);
}

function checkStrings(where, values, allowed) {
	for (const value of values) {
		if (typeof value !== "string") throw invalid(`${where} holds a value that is not a string`);
		// A control character can never reach a header, an argument or an environment variable as written: spawn and
		// fetch refuse it, the latter with a TypeError pi would read as the network.
		if (/[\u0000-\u001f\u007f]/.test(value)) throw invalid(`${where} holds a control character`);
		const refs = refsIn(value);
		if (refs === null) throw invalid(`${where} holds a \`\${\` that opens no whole reference`);
		for (const ref of refs) if (!allowed.has(ref)) throw invalid(`${where} references ${ref}, which the document does not list for it`);
	}
}

/** A bare command found on PATH, or an absolute one, that the job user may execute; else null. */
export function findCommand(command, env = process.env, access = accessSync) {
	// env-internal PATH: the container's own search path, read to find a stdio server's command as a spawn would.
	const candidates = isAbsolute(command) ? [command] : command.includes("/") ? [] : String(env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, command));
	for (const candidate of candidates) {
		try {
			access(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
	return null;
}

/**
 * Read the job's document, or null when the job names no server. Refuses (exit 2, never retried) a document the worker
 * would not have written: a different set of servers than PI_MCP_SERVERS names (`mcp-config-mismatch`, a hand-run
 * container or a worker and image at different versions), a key or a reference outside the accepted set, a reference
 * the container does not hold (`mcp-secret-missing`), and a stdio command the image does not have
 * (`mcp-command-missing`). Never a value in a message: names, keys and reasons only.
 */
export function readJobMcp({ path = JOB_MCP_PATH, env = process.env, read = readFileSync, access = accessSync } = {}) {
	const names = mcpServerNames(env);
	let text;
	try {
		text = read(path, "utf8");
	} catch (error) {
		if (error?.code !== "ENOENT") throw invalid(`it cannot be read (${error?.code ?? "unreadable"})`);
		if (names.length === 0) return null;
		throw configError(`${MCP_SERVERS_ENV} names ${names.length} MCP server(s) but ${JOB_MCP_PATH} is absent`, "mcp-config-mismatch");
	}
	let doc;
	try {
		doc = JSON.parse(text);
	} catch {
		throw invalid("not valid JSON");
	}
	if (!isRecord(doc)) throw invalid("not an object");
	for (const key of Object.keys(doc)) if (!TOP_KEYS.includes(key)) throw invalid(`unknown key ${JSON.stringify(key)}`);
	if (doc.version !== JOB_MCP_VERSION) throw invalid(`version ${JSON.stringify(doc.version)} is not ${JOB_MCP_VERSION}`);
	if (doc.autoEnableCodemode !== undefined && typeof doc.autoEnableCodemode !== "boolean") throw invalid("autoEnableCodemode is not a boolean");
	if (typeof doc.codemodeModels !== "boolean") throw invalid("codemodeModels is not a boolean");
	if (!isRecord(doc.servers) || !isRecord(doc.refs)) throw invalid("servers and refs must be objects");
	const listed = Object.keys(doc.servers);
	if (listed.join(",") !== names.join(",") || Object.keys(doc.refs).join(",") !== names.join(",")) {
		throw configError(`${JOB_MCP_PATH} holds servers ${JSON.stringify(listed)} but ${MCP_SERVERS_ENV} names ${JSON.stringify(names)}`, "mcp-config-mismatch");
	}
	for (const name of names) {
		const server = doc.servers[name];
		const refs = doc.refs[name];
		const where = `server ${JSON.stringify(name)}`;
		if (!isRecord(server)) throw invalid(`${where} is not an object`);
		if (!SERVER_NAME_RE.test(name)) throw invalid(`${where} is not a server name the overlay accepts`);
		if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== "string" || !new RegExp(`^${REF_NAME}$`).test(ref))) throw invalid(`${where}'s refs are not variable names`);
		const kind = server.type === "http" ? "http" : server.type === "stdio" ? "stdio" : null;
		if (kind === null) throw invalid(`${where} has type ${JSON.stringify(server.type)}`);
		for (const key of Object.keys(server)) if (!SERVER_KEYS[kind].includes(key)) throw invalid(`${where} has the key ${JSON.stringify(key)}`);
		if (typeof server.description !== "string" || server.description.trim() === "") throw invalid(`${where} has no description`);
		const allowed = new Set(refs);
		// The runner's own variables are never a server's (the worker refuses these and the job's credentials; this is
		// the line a hand-run container or a worker at another version meets).
		for (const ref of refs) if (ref.startsWith("PI_") || PINNED_ENV.has(ref)) throw invalid(`${where} references ${ref}, which the runner keeps for itself`);
		if (server.enabled !== undefined && typeof server.enabled !== "boolean") throw invalid(`${where}'s enabled is not a boolean`);
		if (server.exposure !== undefined && !MCP_EXPOSURES.includes(server.exposure)) throw invalid(`${where}'s exposure is not one of ${MCP_EXPOSURES.join(", ")}`);
		if (server.timeout !== undefined && !(Number.isFinite(server.timeout) && server.timeout > 0 && server.timeout <= 600)) throw invalid(`${where}'s timeout is not a number of seconds from 1 to 600`);
		if (server.toolExposure !== undefined && (!isRecord(server.toolExposure) || Object.values(server.toolExposure).some((value) => !MCP_EXPOSURES.includes(value)))) {
			throw invalid(`${where}'s toolExposure is not a map of tools to exposures`);
		}
		if (kind === "http") {
			if (typeof server.url !== "string") throw invalid(`${where} has no url`);
			checkStrings(`${where}'s url`, [server.url], allowed);
			const probe = server.url.replace(REF_RE, "x");
			if (!URL.canParse(probe) || !["http:", "https:"].includes(new URL(probe).protocol)) throw invalid(`${where}'s url is not an http or https url`);
			if (server.headers !== undefined) {
				if (!isRecord(server.headers)) throw invalid(`${where}'s headers are not an object`);
				for (const key of Object.keys(server.headers)) if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) throw invalid(`${where} has a header name that is not an HTTP token`);
				checkStrings(`${where}'s headers`, Object.values(server.headers), allowed);
			}
		} else {
			if (typeof server.command !== "string" || server.command === "") throw invalid(`${where} has no command`);
			checkStrings(`${where}'s command`, [server.command], new Set());
			if (server.args !== undefined) {
				if (!Array.isArray(server.args)) throw invalid(`${where}'s args are not a list`);
				checkStrings(`${where}'s args`, server.args, allowed);
			}
			if (server.env !== undefined) {
				if (!isRecord(server.env)) throw invalid(`${where}'s env is not an object`);
				for (const key of Object.keys(server.env)) if (PINNED_ENV.has(key)) throw invalid(`${where}'s env sets ${key}, which the runner keeps for metering`);
				checkStrings(`${where}'s env`, Object.values(server.env), allowed);
			}
			if (server.enabled !== false && findCommand(server.command, env, access) === null) {
				throw configError(`MCP server ${JSON.stringify(name)}: its command is not in this image`, "mcp-command-missing");
			}
		}
		for (const ref of refs) {
			if (typeof env[ref] !== "string" || env[ref] === "") throw configError(`MCP server ${JSON.stringify(name)} references ${ref}, which this container does not hold`, "mcp-secret-missing");
		}
	}
	return doc;
}

/** A transport failure worth another attempt, pi's own rule (extensions/mcp/runtime.js `isTransientError`). */
export function isTransientMcpError(error) {
	if (error instanceof McpHttpError) return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status !== 501);
	return error instanceof TypeError;
}

/** A redirect, which pi's transport would follow to any host: refused, and not transient. */
export class McpRedirectRefusedError extends Error {}

/**
 * fetch for one server: only its own origin, and no redirect. pi's streamable HTTP transport sends every request of a
 * session to the url it was built with, so any other origin is a request this job never meant. `globalThis.fetch` at
 * call time, so the env-proxy dispatcher the runner restored carries it through the egress proxy.
 */
export function guardedFetch(origin, base = (...args) => globalThis.fetch(...args), maxBytes = MCP_HTTP_MAX_BYTES) {
	return async (input, init = {}) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.origin !== origin) throw new McpRedirectRefusedError(`a request to another origin was refused`);
		const response = await base(input, { ...init, redirect: "manual" });
		if (response.status >= 300 && response.status < 400) throw new McpRedirectRefusedError(`the server answered with a redirect (HTTP ${response.status}), which is not followed`);
		// pi-mcp reads a JSON answer and an error body whole (`response.json()`, `response.text()`), with no bound; an event
		// stream it bounds per event itself. So every body but an event stream is bounded, the type read as pi reads it
		// (streamable-http.js `contentType`: up to `;`, trimmed, lowercased).
		const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
		// An ERROR answer pi reads whole whatever its type (`checkResponse`, `response.text()`), so only an ok stream passes.
		if (response.body === null || (response.ok && type === "text/event-stream")) return response;
		let seen = 0;
		const bounded = response.body.pipeThrough(
			new TransformStream({
				transform(chunk, controller) {
					seen += chunk.byteLength;
					if (seen > maxBytes) controller.error(new McpBodyTooLargeError(`the server's answer passed ${maxBytes} bytes`));
					else controller.enqueue(chunk);
				},
			}),
		);
		return new Response(bounded, { status: response.status, statusText: response.statusText, headers: response.headers });
	};
}

/** An HTTP answer past MCP_HTTP_MAX_BYTES: refused, and not transient. */
export class McpBodyTooLargeError extends Error {}

/** Why a server did not become ready, as a fixed phrase: never its stderr, its body or a message it wrote. */
function failurePhrase(error) {
	if (error instanceof McpRedirectRefusedError || error instanceof McpBodyTooLargeError) return error.message;
	if (error instanceof McpHttpError) return `HTTP ${error.status}`;
	if (error?.code === "ENOENT" || error?.code === "EACCES") return `its command could not start (${error.code})`;
	if (error instanceof TypeError) return "the network request failed";
	return "it did not complete the MCP handshake";
}

/**
 * Per server: whether one of its transports finished the MCP handshake. pi retries a transient failure of an HTTP
 * server (twice, after 250 ms and 1 s) and nothing else, so a transient failure leaves the server pending (pi's next
 * attempt decides it, or the runner's wait runs out) and any other settles it failed.
 */
function readiness(names) {
	const servers = new Map(names.map((name) => [name, { state: "pending", why: null, transient: false }]));
	let wake = () => {};
	const changed = () => wake();
	return {
		servers,
		ready(name) {
			const server = servers.get(name);
			if (server && server.state !== "ready") {
				server.state = "ready";
				changed();
			}
		},
		failed(name, error) {
			const server = servers.get(name);
			if (!server || server.state === "ready") return;
			server.why = failurePhrase(error);
			server.transient = isTransientMcpError(error);
			if (!server.transient) server.state = "failed";
			changed();
		},
		/** True once every server answered or one failed; false when `ms` ran out first. */
		wait(ms) {
			return new Promise((resolve) => {
				// Not unref'd: a server pi fails before any transport exists (its own url parse, say) settles nothing here,
				// and the runner must reach mcp-unreachable rather than an event loop that empties mid-wait.
				const timer = setTimeout(() => resolve(false), ms);
				wake = () => {
					const states = [...servers.values()].map((server) => server.state);
					if (states.every((state) => state !== "pending") || states.includes("failed")) {
						clearTimeout(timer);
						resolve(true);
					}
				};
				wake();
			});
		},
	};
}

/**
 * Report a transport's connection to `track` as pi's own connect runs it (pi-mcp client.js `connect`, then the MCP
 * extension's runtime.js `connectOnce`): initialize, its answer checked, `notifications/initialized`, then `tools/list`
 * (when the server declares tools, every page), and only then the tools registered. Since pi 1.2.0 no resource list is
 * asked at connect (the resource tools list them on demand); one an older pi asked was an outstanding request like any. So the
 * server is READY once `notifications/initialized` has been sent, `tools/list` has answered when the server declares
 * tools, and no request of that connect is still unanswered, one turn of the event loop later (pi's own continuation
 * registers the tools in between, and a next page or list would be asked by then). An answer is matched to its request
 * by id AND by being a response (no `method`), since a server may send requests of its own with the same ids. FAILED on
 * an error answer to `initialize` or `tools/list` (pi gives up the connection on either; any other request that fails
 * pi tolerates), on a start or send that throws, or on a close before ready. A close that follows a transient failure on
 * the same transport is pi closing it before its next attempt, and leaves the server pending. A subclass, not a
 * wrapper, since pi treats a `StdioTransport` instance specially (its stderr tail, its close on exit).
 */
function observed(Base, name, track, live, { network = false } = {}) {
	return class extends Base {
		#requests = new Map();
		#tools = undefined;
		#toolsAnswered = false;
		#initialized = false;
		#ready = false;
		#transient = false;
		constructor(options) {
			super(options);
			live.add(this);
			this.onMessage((message) => {
				// A response by pi's own test (`isJsonRpcResponse`), since a server's request of its own may reuse an id.
				if (this.#ready || !isJsonRpcResponse(message)) return;
				const method = this.#requests.get(message.id);
				if (method === undefined) return;
				this.#requests.delete(message.id);
				if (message.error !== undefined && (method === "initialize" || method === "tools/list")) return this.#fail(new Error(`${method} refused`));
				// Truthy, as pi asks it (runtime.js connectOnce): a server declaring `tools: null` is asked for none.
				if (method === "initialize") this.#tools = Boolean(message.result?.capabilities?.tools);
				if (method === "tools/list") this.#toolsAnswered = true;
				this.#check();
			});
			this.onClose(() => {
				live.delete(this);
				if (!this.#ready && !this.#transient) track.failed(name, new Error("closed"));
			});
		}
		#check() {
			if (this.#ready || !this.#initialized) return;
			setImmediate(() => {
				// `closed` is pi-mcp's own flag, set at the start of close(): pi rejecting an answer (a tool with no schema,
				// a repeated page cursor) closes the transport within the same turn, before its close event arrives.
				if (this.#ready || this.closed || this.#requests.size > 0 || (this.#tools && !this.#toolsAnswered)) return;
				this.#ready = true;
				track.ready(name);
			});
		}
		#fail(error) {
			if (this.#ready) return;
			// pi retries a transient failure of an HTTP server only; a stdio start that throws (spawn refusing a NUL) is
			// followed by the transport's close, which settles it failed.
			if (network && isTransientMcpError(error)) this.#transient = true;
			track.failed(name, error);
		}
		async start() {
			try {
				return await super.start();
			} catch (error) {
				this.#fail(error);
				throw error;
			}
		}
		// pi-mcp 1.2.0 passes `{ signal }`, aborted once the sender stops waiting, so a transport does not dispatch a request
		// already given up on (streamable-http checks it before each try). Forwarded: a subclass that drops it sends anyway.
		async send(message, options) {
			const request = message?.id !== undefined && typeof message.method === "string";
			if (request) this.#requests.set(message.id, message.method);
			// A request pi gave up on (its timeout, or one it tolerates failing) is answered by nothing.
			if (message?.method === "notifications/cancelled" && this.#requests.delete(message.params?.requestId)) this.#check();
			try {
				const sent = await super.send(message, options);
				if (message?.method === "notifications/initialized") {
					this.#initialized = true;
					this.#check();
				}
				return sent;
			} catch (error) {
				// pi gives up the connection only when initialize, initialized or the tool list cannot be sent; any other
				// request, its reply to a server's request or a cancel notice that fails it tolerates (client.js
				// handleRequest), so those are dropped, not failed.
				if (CONNECT_SENDS.has(message?.method)) this.#fail(error);
				else if (request && this.#requests.delete(message.id)) this.#check();
				throw error;
			}
		}
	};
}

/** The sends whose failure pi's connect does not survive. */
const CONNECT_SENDS = new Set(["initialize", "notifications/initialized", "tools/list"]);

/**
 * A header value as fetch sends it, or null when fetch would refuse it: leading and trailing HTTP whitespace trimmed
 * (a secret read from a file ends in a newline), then no NUL, CR or LF inside and nothing past Latin-1. Refused here
 * rather than by fetch, whose TypeError pi would read as the network.
 */
export function headerValue(value) {
	const trimmed = value.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "");
	return /[\0\n\r]|[^\0-\xff]/.test(trimmed) ? null : trimmed;
}

/** OAuth state pi would keep in `mcp-auth.json`: nothing is loaded, and a save is refused. */
const INERT_CREDENTIALS = Object.freeze({
	forServer: () =>
		Object.freeze({
			load: () => undefined,
			save: () => {
				throw new Error("a job keeps no MCP sign-in");
			},
			withRefreshLock: (fn) => fn(),
		}),
	tokens: () => undefined,
	remove: () => false,
});

/**
 * pi's ExtensionAPI as the MCP extension sees it in a job: an empty registered-server list, no `/mcp` command, and
 * session events routed by MCP_EVENTS. An event outside the table throws, which refuses the extension at load and
 * then the job (lifecycle.start finds no handler).
 */
export function guardedApi(pi, captured) {
	return new Proxy(pi, {
		get(target, prop, receiver) {
			if (prop === "getMcpServers") return () => [];
			if (prop === "registerMcpServer" || prop === "unregisterMcpServer") return () => {};
			if (prop === "registerCommand") return (name, options) => (name === "mcp" ? undefined : target.registerCommand(name, options));
			if (prop === "on") {
				return (event, handler) => {
					const route = MCP_EVENTS[event];
					if (route === undefined) throw new Error(`pi's MCP extension subscribes to ${JSON.stringify(event)}, which the runner does not route`);
					if (route === "capture") {
						(captured[event] ??= []).push(handler);
						return () => {};
					}
					if (route === "drop") return () => {};
					return target.on(event, handler);
				};
			}
			return Reflect.get(target, prop, receiver);
		},
	});
}

/**
 * The three factories for `buildLoadedResourceLoader` and the lifecycle `run-job.mjs` drives, for a document
 * `readJobMcp` returned. `pi` is the pi-coding-agent module (its three create* factories); `env` resolves references.
 */
export function createJobMcp(doc, { pi, env = process.env, cwd = LAYOUT.workspace, log = () => {}, now = Date.now, transports = { StdioTransport, StreamableHttpTransport } } = {}) {
	const names = Object.keys(doc.servers);
	// A server the operator turned off is never connected by pi, so it is not waited for.
	const track = readiness(names.filter((name) => doc.servers[name].enabled !== false));
	const captured = {};
	const http = {};
	const stdio = {};
	// The transports still open, for the stop's last step.
	const live = new Set();
	for (const name of names) {
		http[name] = observed(transports.StreamableHttpTransport, name, track, live, { network: true });
		stdio[name] = observed(transports.StdioTransport, name, track, live);
	}

	const createTransport = (entry) => {
		try {
			return buildTransport(entry);
		} catch (error) {
			// A transport that cannot be built is refused, not left pending for the wait to run out; recorded as a plain
			// failure, since an invalid url throws a TypeError, which pi's transient rule reads as the network.
			track.failed(entry.name, new Error(`its transport could not be built (${error?.name ?? "error"})`));
			throw error;
		}
	};
	const buildTransport = (entry) => {
		const config = doc.servers[entry.name];
		if (!config) throw new Error(`MCP server ${JSON.stringify(entry.name)} is not this job's`);
		if (config.type === "http") {
			const url = resolveRefs(config.url, env);
			const headers = Object.fromEntries(Object.entries(config.headers ?? {}).map(([key, value]) => [key, headerValue(resolveRefs(value, env))]));
			// A secret's value is the container's, not the document's: one fetch would refuse is refused here.
			if (Object.values(headers).includes(null)) throw new Error("a header's resolved value is not one HTTP can send");
			// No authProvider: a server that answers 401 is refused, never signed in to.
			return new http[entry.name]({ url, headers, fetch: guardedFetch(new URL(url).origin) });
		}
		const base = Object.fromEntries(MCP_STDIO_BASE_ENV.filter((key) => typeof env[key] === "string").map((key) => [key, env[key]]));
		const own = Object.fromEntries(Object.entries(config.env ?? {}).map(([key, value]) => [key, resolveRefs(value, env)]));
		return new stdio[entry.name]({
			command: config.command,
			args: (config.args ?? []).map((arg) => resolveRefs(arg, env)),
			cwd,
			env: { ...base, ...own },
			inheritEnv: false,
			stderr: "pipe",
		});
	};

	const loadConfig = () => ({
		servers: names.map((name) => ({ name, config: doc.servers[name], source: JOB_MCP_PATH, scope: "global" })),
		...(doc.autoEnableCodemode !== undefined && { autoEnableCodemode: doc.autoEnableCodemode }),
		errors: [],
	});

	const mcpFactory = pi.createMcpExtension({
		loadConfig,
		createTransport,
		credentials: INERT_CREDENTIALS,
		// env-internal TMPDIR: the job's temp folder, where pi's MCP log goes instead of the read-only agent directory.
		logPath: join(env.TMPDIR || "/tmp", "pi-dispatch-mcp.log"),
		openUrl: () => {
			throw new Error("a job opens no browser");
		},
		updateConfig: () => {
			throw new Error("a job's MCP servers are not changed from inside it");
		},
	});

	const factories = [
		{
			name: "job-mcp",
			factory: (api) => {
				// Kept only once pi's factory returned: one that throws partway (an event the guarded API does not route) is
				// discarded by pi, and a session_start it captured first must not connect servers for an extension that
				// is not loaded.
				const loading = {};
				mcpFactory(guardedApi(api, loading));
				Object.assign(captured, loading);
				// The names only the job's MCP may own, held at every call: an extension that registers one after the
				// shadow check (from a timer, say) is refused its calls rather than answering for the job's servers.
				api.on("tool_call", (event) => {
					const tool = api.getAllTools().find((candidate) => candidate.name === event.toolName);
					if (tool && mcpShadow({ tools: [tool], commands: [] }) !== null) return { block: true, reason: `${event.toolName} is the job's MCP tool, and another extension registered it` };
				});
			},
		},
		{ name: "job-codemode", factory: pi.createCodemodeExtension({ models: doc.codemodeModels }) },
		{ name: "job-tool-search", factory: pi.createToolSearchExtension() },
	];

	// A server's own `timeout` (seconds, pi's per-request bound) lengthens the wait for a server known to start slowly.
	const timeouts = names.filter((name) => doc.servers[name].enabled !== false).map((name) => (doc.servers[name].timeout ?? 0) * 1000);
	const waitMs = Math.min(Math.max(MCP_READY_TIMEOUT_MS, ...timeouts), MCP_READY_TIMEOUT_MAX_MS);
	let started = false;
	const lifecycle = {
		/**
		 * Connect every server and wait for each to answer, before the prompt. A server that refused (its command, an
		 * HTTP error other than 408, 429 or a 5xx, a redirect, a handshake or tool list it failed) is `mcp-unavailable`,
		 * exit 2: the next attempt would find it the same. One still pending when the wait runs out is `mcp-unreachable`,
		 * exit 1, retried: a network or a server that may answer next time.
		 */
		async start(ctx) {
			const handlers = captured.session_start ?? [];
			if (handlers.length === 0) throw configError("pi's MCP extension did not load, so the servers this job names cannot connect", "mcp-unavailable");
			started = true;
			const began = now();
			for (const handler of handlers) await handler({ type: "session_start", reason: "startup" }, ctx);
			const settled = await track.wait(waitMs);
			const failed = [...track.servers].filter(([, server]) => server.state === "failed");
			if (failed.length > 0) {
				const [name, server] = failed[0];
				throw configError(`MCP server ${JSON.stringify(name)} cannot be used: ${server.why}`, "mcp-unavailable");
			}
			if (!settled) {
				const [name, server] = [...track.servers].find(([, s]) => s.state === "pending");
				const error = new Error(`MCP server ${JSON.stringify(name)} did not answer within ${waitMs / 1000}s${server.why ? ` (${server.why})` : ""}`);
				error.piDispatchExit = EXIT_INFRA;
				error.piDispatchReason = "mcp-unreachable";
				throw error;
			}
			log("mcp_servers_ready", { servers: track.servers.size, ms: now() - began });
		},
		/** Close every server, bounded: pi's own exit hook kills a stdio server's process group if this runs out. */
		async stop() {
			if (!started) return;
			started = false;
			const closing = Promise.all((captured.session_shutdown ?? []).map((handler) => Promise.resolve(handler({ type: "session_shutdown" })).catch(() => undefined)));
			let timer;
			const closed = await Promise.race([closing.then(() => true), new Promise((resolve) => (timer = setTimeout(() => resolve(false), MCP_STOP_TIMEOUT_MS)))]);
			clearTimeout(timer);
			// A stdio server's pipes stay open while anything holds them: a process it started in a session of its own
			// survives the group kill and keeps the runner alive past its exit line. The runner's ends are released here.
			for (const transport of live) {
				const child = transport.child;
				for (const stream of [child?.stdin, child?.stdout, child?.stderr]) stream?.destroy?.();
				child?.unref?.();
			}
			log("mcp_servers_closed", { servers: names.length, closed });
		},
	};
	return { factories, lifecycle };
}

/**
 * The tools and command only the job's own factories may register. A job's other extensions (the repository's, the
 * overlay's, a staged package's) that register one of them would answer for the job's servers, or reach servers of
 * its own: refused before the prompt (`mcp-shadowed`). Returns the first offending name, or null.
 */
export function mcpShadow({ tools, commands }) {
	const ours = (path) => MCP_FACTORY_NAMES.some((name) => path === `<inline:${name}>`);
	const reserved = (name) => name.startsWith("mcp__") || MCP_RESOURCE_TOOLS.includes(name) || MCP_DISCOVERY_TOOLS.includes(name);
	for (const tool of tools) if (reserved(tool.name) && !ours(tool.sourceInfo?.path)) return tool.name;
	for (const command of commands) if (command.name === "mcp" && !ours(command.sourceInfo?.path)) return "/mcp";
	return null;
}
