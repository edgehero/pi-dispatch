/**
 * A terminal client of the operator console (issue #647, REQ-TERMINAL-CHAT): what `pi-dispatch chat` speaks to read a
 * run, follow its live transcript and send the console's own actions, through the same HTTP surface a browser uses.
 *
 * THE CONSOLE'S AUTH MODEL, UNCHANGED. The client signs in with a token through `POST /login`, exactly as the login
 * page does, and holds the `pdc_session` cookie it gets back in memory for the life of the process. A bearer header was
 * the obvious alternative and is rejected: it would be a second way in, judged by code the browser path never runs, and
 * every guard in `admin/src/console/guards.mjs` (Host, Origin, the JSON content type) would need a twin. The cookie is
 * never written anywhere, so a finished `chat` leaves no credential behind.
 *
 * WHAT THE GUARDS EXPECT, SENT AS A BROWSER WOULD. `Host` is the address dialled (`127.0.0.1:4790`, or `localhost` over
 * a unix socket, the one loopback name a socket has); `Origin` is `http://<Host>` on every request, so a write passes
 * the origin check the same way a page's fetch does; a write carries `Content-Type: application/json`.
 * `Sec-Fetch-Site` is NEVER sent: `originRefusal` accepts its absence as a non-browser client and judges `Origin` alone,
 * and a client that claimed `same-origin` would be claiming to be the console's own page, which it is not.
 *
 * THE STREAM. `GET /api/transcript?format=json` is Server-Sent Events. The parser here holds one event to 256 KiB
 * (`SSE_EVENT_MAX_BYTES`); an event past that is dropped whole and reported, never half-parsed, so a hostile or broken
 * stream cannot grow this process. A dropped connection reconnects with `Last-Event-ID` (the server resumes after it)
 * on a jittered exponential backoff, a 429 waits its `Retry-After` (at most 60 s), and a 401 or an `end` event (the
 * server ended the session: expiry, a revoke, a rotate) signs in again, at most once per `RELOGIN_WINDOW_MS`: a second
 * refusal within that window of a fresh sign-in is the end, said in a sentence. The window holds over the stream's whole
 * life, so a server that delivers one entry and then `end`, forever, cannot make the client sign in more than once a
 * minute (an entry between the two used to clear the rule, which was exactly that loop). A body that stops moving is
 * cut: `STREAM_IDLE_MS` on a stream (the console pings every 15 s), `timeoutMs` on any other response.
 *
 * THE TOKEN LEAVES THIS MACHINE ONLY WHEN THE OPERATOR SAID SO. The console speaks plain HTTP, so a non-loopback
 * address sends the token readable to everything on the path. `consoleAddressOf` therefore refuses a non-loopback
 * address that came from the deployment's `.env` (a file in whatever folder the command runs from, which may be a
 * repository someone else wrote), and marks every other address with `loopback`, so the command can warn and ask
 * before it signs in to one that is not (`chat-cli.mjs`).
 *
 * NOTHING SECRET IS PRINTED OR LOGGED. The token, the cookie and any message text never reach `log`, an error message
 * or the terminal from this module. Errors name the address, the route and the status; the console's own refusal
 * sentences (which name no secret: `server.mjs` keeps them so) are passed through, folded onto one line (`oneLine`).
 */
import * as nodeFs from "node:fs";
import * as nodeHttp from "node:http";
import { join } from "node:path";
import { formatMicros } from "./money.mjs";
import { readDeploymentEnv } from "./service-env.mjs";

/** Where the console listens when nothing names it: its own default (`admin/src/console/listen.mjs`). */
export const DEFAULT_CONSOLE_ADDRESS = "127.0.0.1:4790";

/** The largest single Server-Sent Event the client keeps. A transcript entry is capped well below this server side. */
export const SSE_EVENT_MAX_BYTES = 256 * 1024;

/** The largest JSON response read. `/api/run` and an action's answer are a few KiB. */
export const RESPONSE_MAX_BYTES = 1024 * 1024;

/** How long one request may take to answer (not a stream's life: only until its headers arrive). */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Reconnect pacing for a stream: the first wait is `baseMs`, doubling to `capMs`, each drawn from the upper half of
 * that window (jitter, so tabs and terminals that lost one console together do not all come back in the same
 * millisecond). After `maxFailures` connection failures in a row with nothing received the stream gives up loudly.
 */
export const BACKOFF = Object.freeze({ baseMs: 500, capMs: 30_000, maxFailures: 8 });

/** The longest `Retry-After` honoured. A larger one is clamped, so a confused server cannot park the client for long. */
export const RETRY_AFTER_MAX_MS = 60_000;

/** How long a stream may go without a byte before it is treated as cut. Three of the console's 15 s pings. */
export const STREAM_IDLE_MS = 45_000;

/**
 * A stream signs in again after a 401 or an `end` at most once in this window; a second one inside it is fatal. Long
 * enough that a server ending every connection cannot drive a sign-in loop, short against a real session's life.
 */
export const RELOGIN_WINDOW_MS = 60_000;

/** The longest refusal sentence passed through from the console, as one line. */
const REFUSAL_MAX_CHARS = 1000;

const HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
const BRACKETED_RE = /^\[[0-9A-Fa-f:.]+\]$/;
const ACTION_NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;
const COOKIE_RE = /^pdc_session=([^;]*)/;
const CODE_RE = /^[A-Z0-9_]{1,40}$/;

/** A refusal or failure this module raises: its message is a sentence an operator can act on, and names no secret. */
export class ConsoleError extends Error {
	constructor(message, { status = null } = {}) {
		super(message);
		this.name = "ConsoleError";
		this.status = status;
	}
}

const codeOf = (e) => (typeof e?.code === "string" && CODE_RE.test(e.code) ? e.code : "error");

/**
 * A console sentence as one line: every control character (a newline included) becomes a space, runs of space fold to
 * one, and the result is cut to 1000 characters. A refusal is printed on one terminal line whatever the server sent.
 */
export function oneLine(text) {
	const s = String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/ {2,}/g, " ").trim();
	return s.length > REFUSAL_MAX_CHARS ? `${s.slice(0, REFUSAL_MAX_CHARS)}...` : s;
}

/**
 * A console address as the client dials it: `unix:/abs/path`, or `[http://]host:port` with a hostname, an IPv4 literal
 * or a bracketed IPv6 literal. Returns `{kind: "unix", socketPath, hostHeader: "localhost", shown}` or
 * `{kind: "tcp", host, port, hostHeader, shown}`, or `{refusal}`.
 *
 * `https:` is refused rather than attempted: the console speaks plain HTTP on loopback by design (TLS is the tunnel's
 * job), and its origin check compares against `http://<Host>`, so a TLS client could read but never write.
 * A wildcard listen (`0.0.0.0`, `[::]`, which PI_CONSOLE_LISTEN may hold with PI_CONSOLE_BIND_PUBLIC) is dialled on
 * its loopback twin: the wildcard is where the console listens, never an address anything connects to.
 */
export function parseConsoleAddress(text) {
	const raw = typeof text === "string" ? text.trim() : "";
	if (raw === "") return { refusal: "the console address is empty; give host:port (127.0.0.1:4790) or unix:/abs/path" };
	if (raw.length > 1024) return { refusal: "the console address is longer than 1024 characters" };
	if (raw.startsWith("unix:")) {
		const socketPath = raw.slice("unix:".length);
		if (!socketPath.startsWith("/")) return { refusal: "a unix console address needs an absolute socket path: unix:/abs/path" };
		return { kind: "unix", socketPath, hostHeader: "localhost", shown: raw };
	}
	let rest = raw;
	const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(rest);
	if (scheme) {
		if (scheme[1].toLowerCase() !== "http") {
			return { refusal: `the console speaks plain http on loopback (a tunnel carries TLS), so a ${scheme[1].toLowerCase()}: address cannot be used; give http://host:port or host:port` };
		}
		rest = rest.slice(scheme[0].length);
	}
	if (rest.endsWith("/")) rest = rest.slice(0, -1);
	if (/[/?#@\s]/.test(rest)) return { refusal: "the console address must be just host:port (no path, query, user or spaces)" };
	let host;
	let portText;
	if (rest.startsWith("[")) {
		const close = rest.indexOf("]");
		if (close < 0 || rest[close + 1] !== ":") return { refusal: "an IPv6 console address is [address]:port, for example [::1]:4790" };
		host = rest.slice(0, close + 1);
		portText = rest.slice(close + 2);
		if (!BRACKETED_RE.test(host)) return { refusal: "the bracketed console address is not an IPv6 literal" };
	} else {
		const colon = rest.lastIndexOf(":");
		if (colon < 0) return { refusal: "the console address has no port; give host:port, for example 127.0.0.1:4790" };
		host = rest.slice(0, colon);
		portText = rest.slice(colon + 1);
		if (!HOSTNAME_RE.test(host)) return { refusal: "the console address's host is not a hostname or an IPv4 literal" };
	}
	if (!/^[0-9]{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) return { refusal: "the console address's port is not a number from 1 to 65535" };
	if (host === "0.0.0.0") host = "127.0.0.1";
	if (host === "[::]") host = "[::1]";
	const port = Number(portText);
	const hostHeader = `${host.toLowerCase()}:${port}`;
	return { kind: "tcp", host: host.startsWith("[") ? host.slice(1, -1) : host, port, hostHeader, shown: `http://${hostHeader}` };
}

/**
 * Whether a parsed address stays on this machine: a unix socket, `localhost`, an IPv4 literal in 127.0.0.0/8, or the
 * IPv6 loopback (a wildcard was already turned into its loopback twin by `parseConsoleAddress`). A hostname is judged
 * by its spelling, never resolved: a name that happens to resolve to 127.0.0.1 today is still not loopback by
 * construction, so it gets the warning.
 */
export function isLoopbackAddress(address) {
	if (address?.kind === "unix") return true;
	if (address?.kind !== "tcp" || typeof address.host !== "string") return false;
	const h = address.host.toLowerCase();
	if (h === "localhost") return true;
	if (/^127(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(h)) return true;
	return h === "::1" || h === "0:0:0:0:0:0:0:1" || /^::ffff:127\.[0-9.]+$/.test(h);
}

/**
 * Which console to dial, in order: the `--console` flag, `PI_CONSOLE_URL` from this shell, the deployment's
 * `PI_CONSOLE_LISTEN` (`deployment()` resolves it the way the service reads it, and is asked only when the first two
 * are absent), else `DEFAULT_CONSOLE_ADDRESS`. Returns `{address, source, loopback}` or `{refusal}`.
 *
 * An address from the deployment's `.env` must be loopback or a unix socket, or it is refused: that file is read from
 * the folder the command runs in, and a `.env` planted in a cloned repository must not be able to point the operator's
 * token at another host. A console elsewhere is named explicitly, with `--console` or `PI_CONSOLE_URL`. And a
 * `PI_CONSOLE_LISTEN` this shell does not set came from that file, so it is taken only when `envTrust()` returns null
 * (`dotenvTrustRefusal`: the file is this account's or root's, no group or other account can write it or its folders,
 * and it is not a symbolic link); loopback is not enough on its own, since another local account can listen on a
 * loopback port and collect the token. `envTrust` defaults to trusting, for callers with no folder of their own.
 */
export function consoleAddressOf({ flag = null, env = {}, deployment = () => ({ env: {} }), envTrust = () => null } = {}) {
	const pick = (value, source) => {
		const parsed = parseConsoleAddress(value);
		return parsed.refusal ? { refusal: `${source}: ${parsed.refusal}` } : { address: parsed, source, loopback: isLoopbackAddress(parsed) };
	};
	if (typeof flag === "string") return pick(flag, "--console");
	// env-internal PI_CONSOLE_URL: the operator's own shell names the console a terminal dials (often a tunnel's local
	// end); the deployment's .env is the service's, and its console address is PI_CONSOLE_LISTEN, read below.
	if (typeof env.PI_CONSOLE_URL === "string" && env.PI_CONSOLE_URL.trim() !== "") return pick(env.PI_CONSOLE_URL, "PI_CONSOLE_URL");
	const d = deployment();
	if (d?.problem) return { refusal: `${d.problem}, so the console's address (PI_CONSOLE_LISTEN) cannot be told; pass --console <host:port>` };
	const listen = typeof d?.env?.PI_CONSOLE_LISTEN === "string" ? d.env.PI_CONSOLE_LISTEN.trim() : "";
	if (listen !== "") {
		const fromShell = typeof env.PI_CONSOLE_LISTEN === "string" && env.PI_CONSOLE_LISTEN.trim() !== "";
		const distrust = fromShell ? null : envTrust();
		if (distrust) {
			return { refusal: `PI_CONSOLE_LISTEN comes from ${distrust}, so the console token is not sent where it names; name the console with --console <host:port> or PI_CONSOLE_URL` };
		}
		const got = pick(listen, "PI_CONSOLE_LISTEN");
		if (got.address && !got.loopback) {
			return { refusal: `PI_CONSOLE_LISTEN in the deployment's .env names ${got.address.shown}, which is not a loopback address or a unix socket, so the console token is not sent there; name a console on another host explicitly with --console <host:port> or PI_CONSOLE_URL` };
		}
		return got;
	}
	return pick(DEFAULT_CONSOLE_ADDRESS, "the default");
}

/**
 * Whether the `.env` in `dir` may name the console, as null or the reason, starting with its path: the panel's own rule
 * (`readDeploymentEnv`, issue #471: owned by this account or root, writable by no group or other account, and so is
 * every folder above it), and not a symbolic link (`lstat`), since a link is a second path whose target someone else
 * may own or swap. Absent or unreadable is a reason too: a value that cannot be traced to a file this account controls
 * is not trusted.
 */
export function dotenvTrustRefusal({ dir, fs = nodeFs, uid = process.geteuid?.() }) {
	const path = join(dir, ".env");
	let st;
	try {
		st = fs.lstatSync(path);
	} catch (e) {
		return `${path}, which could not be checked (${e?.code ?? "error"})`;
	}
	if (st.isSymbolicLink()) return `${path}, which is a symbolic link`;
	const got = readDeploymentEnv({ dir, fs, uid });
	if (got.unreadable) return `${path}, which could not be read (${got.unreadable})`;
	if (got.untrusted) return `${path}, which ${got.untrusted}`;
	return null;
}

/**
 * The console token: `PI_CONSOLE_TOKEN` from THIS SHELL's environment, else a hidden prompt (`askHidden`). Never the
 * deployment's `.env`: that file is the service's, readable by whoever runs the service, and a token in it would be an
 * operator credential sitting beside the worker's secrets. Returns `{token}` or `{refusal}`.
 */
export async function consoleToken({ env = {}, askHidden = null } = {}) {
	// env-internal PI_CONSOLE_TOKEN: an operator credential, read from this shell alone and never from a deployment file.
	const fromEnv = typeof env.PI_CONSOLE_TOKEN === "string" ? env.PI_CONSOLE_TOKEN.trim() : "";
	if (fromEnv !== "") return { token: fromEnv };
	const typed = typeof askHidden === "function" ? await askHidden("console token (input hidden): ") : null;
	if (typeof typed === "string" && typed.trim() !== "") return { token: typed.trim() };
	return { refusal: "no console token: set PI_CONSOLE_TOKEN in this shell, or run this in a terminal to type it (make one with pi-dispatch-console token add)" };
}

/**
 * Read one line from a TTY without echoing it. Returns the line, or null when `input` is not a TTY (nothing to hide
 * from, and nobody to ask) or the operator pressed Ctrl+C or Ctrl+D. At most 1024 characters are kept.
 */
export function askHidden(question, { input = process.stdin, output = process.stderr } = {}) {
	if (!input?.isTTY || typeof input.setRawMode !== "function") return Promise.resolve(null);
	return new Promise((resolve) => {
		let text = "";
		output.write(question);
		input.setRawMode(true);
		input.resume();
		const finish = (value) => {
			input.removeListener("data", onData);
			input.setRawMode(false);
			input.pause();
			output.write("\n");
			resolve(value);
		};
		const onData = (chunk) => {
			for (const ch of String(chunk)) {
				if (ch === "\r" || ch === "\n") return finish(text);
				if (ch === "\u0003" || ch === "\u0004") return finish(null);
				if (ch === "\u007f" || ch === "\b") text = text.slice(0, -1);
				else if (ch >= " " && text.length < 1024) text += ch;
			}
		};
		input.on("data", onData);
	});
}

/**
 * Ask a yes/no question on a TTY; true only for an explicit y or yes. Not a TTY is a no: every question this command
 * asks is a consent (a paid message, an unredacted transcript to a provider), and a pipe cannot give one.
 */
export function askYesNo(question, { input = process.stdin, output = process.stderr } = {}) {
	if (!input?.isTTY) {
		output.write(`${question}\nno terminal to answer on, so the answer is no\n`);
		return Promise.resolve(false);
	}
	return new Promise((resolve) => {
		let text = "";
		output.write(question);
		const onData = (chunk) => {
			text += String(chunk);
			const nl = text.search(/[\r\n]/);
			if (nl < 0 && text.length < 64) return;
			input.removeListener("data", onData);
			input.pause();
			resolve(/^\s*(y|yes)\s*$/i.test(nl < 0 ? text : text.slice(0, nl)));
		};
		input.on("data", onData);
		input.resume();
	});
}

/**
 * Milliseconds to wait before reconnect attempt `failures` (1 for the first): from the upper half of
 * `min(capMs, baseMs * 2^(failures-1))`. `random` is the seam (a test pins it).
 */
export function backoffMs(failures, { baseMs = BACKOFF.baseMs, capMs = BACKOFF.capMs, random = Math.random } = {}) {
	const n = Math.max(1, Math.min(30, Number.isSafeInteger(failures) ? failures : 1));
	const ceiling = Math.min(capMs, baseMs * 2 ** (n - 1));
	return Math.round(ceiling / 2 + (ceiling / 2) * Math.min(1, Math.max(0, random())));
}

/**
 * A `Retry-After` header as milliseconds (delta-seconds only, which is all the console sends), clamped to 1 s ..
 * `RETRY_AFTER_MAX_MS` (60 s); null when absent or not a number, so the caller falls back to its own backoff.
 */
export function retryAfterMs(header) {
	const text = Array.isArray(header) ? header[0] : header;
	if (typeof text !== "string" || !/^\s*[0-9]{1,9}\s*$/.test(text)) return null;
	return Math.min(RETRY_AFTER_MAX_MS, Math.max(1000, Number(text) * 1000));
}

/**
 * A Server-Sent Events parser (the WHATWG event-stream grammar, the parts the console uses): `push(chunk)` with bytes
 * or text as they arrive, `onEvent({event, data, id})` per dispatched event, `onRetry(ms)` for a `retry:` line.
 *
 * BOUNDED. An event whose lines add up past `maxEventBytes` is dropped whole (`onOversize()` once), including a single
 * line that never ends: the partial line is discarded as it grows, not buffered, and everything up to the event's
 * blank line is skipped. So memory stays under the cap whatever the server sends, and a dropped event can never be
 * misread as a smaller one made of its tail. Comments (`: ping`) are ignored; `id` updates the last event id even on
 * an event with no data, as the grammar says.
 *
 * An `id` that is not printable ASCII (a NUL, any control byte, anything past 0x7e) or is longer than 1024 characters
 * is ignored: the id goes back to the server as the `Last-Event-ID` header, and node refuses a header value with a
 * control character by throwing, which would turn a hostile id into a crash of the reconnect. The console's ids are
 * `<n>-<m>`. A CR that ends a chunk is remembered, so a CRLF split across two chunks is one line end, not two.
 */
export function makeSseParser({ onEvent, onRetry = () => {}, onOversize = () => {}, maxEventBytes = SSE_EVENT_MAX_BYTES } = {}) {
	const decoder = new TextDecoder("utf-8");
	let buf = "";
	let skipLine = false;
	let lastWasCR = false;
	let over = false;
	let size = 0;
	let event = "";
	let data = [];
	let id = null;
	let sawId = false;
	const reset = () => {
		over = false;
		size = 0;
		event = "";
		data = [];
		sawId = false;
	};
	const line = (text) => {
		if (text === "") {
			if (over) onOversize();
			else if (data.length > 0) onEvent({ event: event || "message", data: data.join("\n"), id: sawId ? id : null });
			reset();
			return;
		}
		if (over) return;
		size += Buffer.byteLength(text, "utf8") + 1;
		if (size > maxEventBytes) {
			over = true;
			data = [];
			return;
		}
		if (text.startsWith(":")) return;
		const colon = text.indexOf(":");
		const name = colon < 0 ? text : text.slice(0, colon);
		let value = colon < 0 ? "" : text.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (name === "event") event = value;
		else if (name === "data") data.push(value);
		else if (name === "id") {
			if (/^[\x20-\x7e]{0,1024}$/.test(value)) {
				id = value;
				sawId = true;
			}
		} else if (name === "retry" && /^[0-9]{1,9}$/.test(value)) onRetry(Number(value));
	};
	return {
		push(chunk) {
			buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
			for (;;) {
				// The CR is forgotten only once the next byte is here to judge: a chunk that ends on it keeps it.
				if (lastWasCR && buf !== "") {
					if (buf.startsWith("\n")) buf = buf.slice(1);
					lastWasCR = false;
				}
				const at = buf.search(/[\r\n]/);
				if (at < 0) break;
				const text = buf.slice(0, at);
				lastWasCR = buf[at] === "\r";
				buf = buf.slice(at + 1);
				if (skipLine) {
					skipLine = false;
					continue;
				}
				line(text);
			}
			if (skipLine) {
				buf = "";
			} else if (buf !== "" && (over || Buffer.byteLength(buf, "utf8") + size > maxEventBytes)) {
				// A line still growing past the cap, or any partial line of an event already over it: the event is over,
				// and the line's bytes are not kept.
				over = true;
				data = [];
				skipLine = true;
				buf = "";
			}
		},
		/** The last `id:` seen, the value a reconnect sends as `Last-Event-ID`. */
		get lastEventId() {
			return id;
		},
	};
}

/** The money a preview reserves, as one line, or null. A worker-side reading of the console's `reserve` object. */
export function reserveLine(r) {
	if (!r || typeof r !== "object") return null;
	if (r.unknown) return "reserve: unknown (the job's data could not be read)";
	if (r.zeroRated) return "reserve: 1 job slot and $0.00 (every model it may call is zero-rated)";
	if (Number.isSafeInteger(r.dollarsMicros) && r.dollarsMicros >= 0) return `reserve: 1 job slot and $${formatMicros(r.dollarsMicros)} (the per-job cap) in each dollar window that applies`;
	return "reserve: 1 job slot (no per-job dollar cap is set)";
}

/** An abortable sleep: resolves after `ms`, or at once (false) when `signal` aborts. */
function defaultSleep(ms, signal) {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve(false);
		const timer = setTimeout(() => {
			signal?.removeEventListener?.("abort", onAbort);
			resolve(true);
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve(false);
		};
		signal?.addEventListener?.("abort", onAbort, { once: true });
	});
}

/**
 * A console client for one address and one token. Every collaborator is a seam: `request` (node:http's), `sleep`,
 * `random`, `now` (the cookie's Expires and the re-login window), `timeoutMs` (a response's headers, and the longest
 * pause inside its body), `streamIdleMs`. Methods:
 *
 *   - `login()` -> `{name, role}`; throws ConsoleError on a refused token, a rate limit or an unreachable console.
 *   - `getJson(path)`, `postJson(path, body)` -> `{status, json}`; signs in first when there is no session, and again
 *     ONCE on a 401 (the session expired or was ended), then retries the request once.
 *   - `whoami()` -> `{name, role, readOnly}`; `run({id} | {url})` -> `{status, json}` of `/api/run`.
 *   - `act(name, body, {confirm, print})`: the console's two-step write. Preview (its summary and reserve go to `print`),
 *     then `confirm(preview)` (a y/n the caller asks; no `confirm` is a no), then the confirm with the preview's ticket.
 *     Returns `{ok, result}`, `{declined}`, `{unchanged}` or `{refusal, status}` with the console's sentence as it was
 *     sent, on one line (`oneLine`).
 *   - `stream(path, {onEvent, signal, lastEventId})`: follow an event stream until `done` (`{done: outcome}`) or the
 *     signal aborts (`{detached: true}`); reconnects as the module comment says. Throws ConsoleError when it gives up.
 */
export function makeConsoleClient({ address, token, request = nodeHttp.request, sleep = defaultSleep, random = Math.random, now = Date.now, timeoutMs = REQUEST_TIMEOUT_MS, streamIdleMs = STREAM_IDLE_MS, backoff = BACKOFF } = {}) {
	if (!address || (address.kind !== "tcp" && address.kind !== "unix")) throw new TypeError("makeConsoleClient: address must come from parseConsoleAddress");
	let cookie = null;
	let session = null;
	const where = address.shown;

	const baseHeaders = () => ({
		host: address.hostHeader,
		origin: `http://${address.hostHeader}`,
		...(cookie !== null ? { cookie: `pdc_session=${cookie}` } : {}),
	});

	/**
	 * Keep the session cookie a response sets, and drop it on a clear: an empty value, a Max-Age of zero or less, or an
	 * Expires already past (the two ways RFC 6265 deletes a cookie, whatever value rides along).
	 */
	const takeCookie = (headers) => {
		const set = headers?.["set-cookie"];
		for (const line of Array.isArray(set) ? set : typeof set === "string" ? [set] : []) {
			const m = COOKIE_RE.exec(line);
			if (!m) continue;
			const maxAge = /;\s*max-age=(-?[0-9]+)/i.exec(line);
			const expires = /;\s*expires=([^;]*)/i.exec(line);
			const expired = maxAge ? Number(maxAge[1]) <= 0 : expires ? Date.parse(expires[1]) <= now() : false;
			cookie = m[1] === "" || expired ? null : m[1];
		}
	};

	/** Open one request: resolves `{res}` once headers arrive, or rejects with a ConsoleError naming the address. */
	const open = (method, path, { body = null, accept = "application/json", extra = {}, signal = null } = {}) =>
		new Promise((resolve, reject) => {
			const payload = body === null ? null : Buffer.from(JSON.stringify(body), "utf8");
			const headers = { ...baseHeaders(), accept, ...extra, ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}) };
			const target = address.kind === "unix" ? { socketPath: address.socketPath } : { host: address.host, port: address.port };
			let settled = false;
			// `agent: false`: one connection per request, closed after it, so no idle keep-alive socket holds the command
			// open after its last answer.
			const req = request({ ...target, method, path, headers, agent: false });
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				req.destroy();
				reject(new ConsoleError(`the console at ${where} did not answer ${method} ${path.split("?")[0]} within ${Math.round(timeoutMs / 1000)} s`));
			}, timeoutMs);
			const onAbort = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				req.destroy();
				resolve({ aborted: true });
			};
			signal?.addEventListener?.("abort", onAbort, { once: true });
			req.on("response", (res) => {
				if (settled) return res.destroy();
				settled = true;
				clearTimeout(timer);
				takeCookie(res.headers);
				resolve({ res, req });
			});
			req.on("error", (e) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(new ConsoleError(`the console at ${where} could not be reached (${codeOf(e)}); is it running (pi-dispatch-console serve)? Name another with --console or PI_CONSOLE_URL`));
			});
			if (payload) req.write(payload);
			req.end();
		});

	/**
	 * A response body as JSON, at most `RESPONSE_MAX_BYTES`; `{json}` or `{json: null}` for a body that is not JSON. A body
	 * that pauses longer than `timeoutMs` is cut and rejected with a sentence: headers alone are no answer.
	 */
	const readJson = (res, what = "a request") =>
		new Promise((resolve, reject) => {
			const chunks = [];
			let n = 0;
			let done = false;
			let idle = null;
			const settle = (fn, value) => {
				if (done) return;
				done = true;
				clearTimeout(idle);
				fn(value);
			};
			const arm = () => {
				clearTimeout(idle);
				idle = setTimeout(() => {
					res.destroy();
					settle(reject, new ConsoleError(`the console at ${where} stopped sending its answer to ${what} for ${Math.round(timeoutMs / 1000)} s`));
				}, timeoutMs);
			};
			arm();
			res.on("data", (c) => {
				arm();
				n += c.length;
				if (n > RESPONSE_MAX_BYTES) {
					res.destroy();
					return settle(resolve, { json: null, tooLarge: true });
				}
				chunks.push(c);
			});
			res.on("end", () => {
				try {
					settle(resolve, { json: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
				} catch {
					settle(resolve, { json: null });
				}
			});
			res.on("error", () => settle(resolve, { json: null }));
			res.on("close", () => settle(resolve, { json: null }));
		});

	const errorOf = (status, json) => (typeof json?.error === "string" && oneLine(json.error) !== "" ? oneLine(json.error) : `the console answered ${status}`);

	async function login() {
		const { res } = await open("POST", "/login", { body: { token } });
		const { json } = await readJson(res, "POST /login");
		if (res.statusCode === 200 && cookie !== null) {
			session = { name: typeof json?.name === "string" ? json.name : "?", role: json?.role === "operator" ? "operator" : "viewer" };
			return session;
		}
		cookie = null;
		session = null;
		if (res.statusCode === 401) throw new ConsoleError(`the console at ${where} refused the token (${errorOf(401, json)}); check PI_CONSOLE_TOKEN`, { status: 401 });
		if (res.statusCode === 429) throw new ConsoleError(`the console at ${where} is limiting sign-ins (${errorOf(429, json)})`, { status: 429 });
		throw new ConsoleError(`signing in to the console at ${where} failed: ${errorOf(res.statusCode, json)}`, { status: res.statusCode });
	}

	async function requestJson(method, path, body = null) {
		if (cookie === null) await login();
		for (let attempt = 0; ; attempt += 1) {
			const { res } = await open(method, path, { body });
			const { json } = await readJson(res, `${method} ${path.split("?")[0]}`);
			if (res.statusCode === 401 && attempt === 0) {
				cookie = null;
				await login();
				continue;
			}
			return { status: res.statusCode, json };
		}
	}

	async function act(name, body, { confirm, print = () => {} } = {}) {
		if (!ACTION_NAME_RE.test(String(name))) throw new TypeError(`act: ${JSON.stringify(name)} is not an action name`);
		const pre = await requestJson("POST", `/api/act/${name}/preview`, body ?? {});
		if (pre.status !== 200 || !pre.json || typeof pre.json !== "object") return { refusal: errorOf(pre.status, pre.json), status: pre.status };
		const summary = Array.isArray(pre.json.summary) ? pre.json.summary.filter((l) => typeof l === "string") : [];
		for (const l of summary) print(l);
		if (pre.json.unchanged) return { unchanged: true };
		const reserve = reserveLine(pre.json.reserve);
		if (reserve) print(reserve);
		if (typeof pre.json.ticket !== "string" || pre.json.ticket === "") return { refusal: "the console's preview carried no ticket, so nothing can be confirmed", status: pre.status };
		const yes = typeof confirm === "function" ? await confirm(pre.json) : false;
		if (!yes) return { declined: true };
		const done = await requestJson("POST", `/api/act/${name}/confirm`, { ticket: pre.json.ticket });
		if (done.status !== 200) return { refusal: errorOf(done.status, done.json), status: done.status };
		return { ok: true, result: done.json ?? {} };
	}

	/**
	 * One connection of a stream: `{status, retryAfter, error}` for a refused open, or how it ended once open:
	 * `{done, outcome}`, `{end: true}` (the server ended the session), `{closed: true, received}` or `{aborted: true}`.
	 */
	async function connectOnce(path, lastEventId, signal, onEvent, onRetry) {
		const extra = lastEventId !== null ? { "last-event-id": lastEventId } : {};
		const opened = await open("GET", path, { accept: "text/event-stream", extra, signal });
		if (opened.aborted) return { aborted: true };
		const { res, req } = opened;
		if (res.statusCode !== 200) {
			const { json } = await readJson(res, `GET ${path.split("?")[0]}`);
			return { status: res.statusCode, retryAfter: retryAfterMs(res.headers["retry-after"]), error: errorOf(res.statusCode, json) };
		}
		return new Promise((resolve) => {
			let finished = false;
			let received = 0;
			let lastId = lastEventId;
			let idle = null;
			const finish = (value) => {
				if (finished) return;
				finished = true;
				clearTimeout(idle);
				signal?.removeEventListener?.("abort", onAbort);
				req.destroy();
				resolve({ ...value, received, lastEventId: lastId });
			};
			// A stream that goes quiet past three pings is a dead connection the kernel has not noticed: cut it and resume.
			const arm = () => {
				clearTimeout(idle);
				idle = setTimeout(() => finish({ closed: true, idle: true }), streamIdleMs);
			};
			const onAbort = () => finish({ aborted: true });
			signal?.addEventListener?.("abort", onAbort, { once: true });
			if (signal?.aborted) return finish({ aborted: true });
			const parser = makeSseParser({
				onRetry,
				onOversize: () => onEvent({ event: "oversize", data: null, id: null }),
				onEvent: (ev) => {
					if (finished) return;
					if (ev.id !== null) lastId = ev.id;
					if (ev.event === "end") return finish({ end: true });
					if (ev.event === "done") {
						let outcome = "unknown";
						try {
							const parsed = JSON.parse(ev.data);
							if (typeof parsed?.outcome === "string") outcome = parsed.outcome;
						} catch {
							// a done event whose body is not JSON still ends the stream
						}
						return finish({ done: true, outcome });
					}
					received += 1;
					onEvent(ev);
				},
			});
			arm();
			res.on("data", (chunk) => {
				arm();
				parser.push(chunk);
			});
			res.on("end", () => finish({ closed: true }));
			res.on("error", () => finish({ closed: true }));
			res.on("close", () => finish({ closed: true }));
		});
	}

	async function stream(path, { onEvent = () => {}, signal = null, lastEventId = null, onState = () => {} } = {}) {
		let last = lastEventId;
		let failures = 0;
		let lastRelogin = null;
		let relogins = 0;
		let baseMs = backoff.baseMs;
		const onRetry = (ms) => {
			baseMs = Math.min(backoff.capMs, Math.max(backoff.baseMs, ms));
		};
		const wait = async (ms) => {
			onState({ waiting: ms });
			return sleep(ms, signal);
		};
		for (;;) {
			if (signal?.aborted) return { detached: true };
			if (cookie === null) await login();
			let got;
			try {
				got = await connectOnce(path, last, signal, onEvent, onRetry);
			} catch (e) {
				if (!(e instanceof ConsoleError)) throw e;
				failures += 1;
				if (failures >= backoff.maxFailures) throw new ConsoleError(`${e.message} (gave up after ${failures} tries)`);
				if (!(await wait(backoffMs(failures, { baseMs, capMs: backoff.capMs, random })))) return { detached: true };
				continue;
			}
			if (got.aborted) return { detached: true };
			if (got.lastEventId !== undefined && got.lastEventId !== null) last = got.lastEventId;
			if (got.done) return { done: got.outcome };
			if (got.end || got.status === 401) {
				// Once per window over the stream's whole life: entries in between do not reset it (that was a sign-in loop).
				if (lastRelogin !== null && now() - lastRelogin < RELOGIN_WINDOW_MS) {
					throw new ConsoleError(`the console at ${where} ended this sign-in again within ${Math.round(RELOGIN_WINDOW_MS / 1000)} s of a fresh one; the token may have been revoked or rotated`, { status: 401 });
				}
				relogins += 1;
				cookie = null;
				onState({ relogin: true });
				// A short pause before signing in again, growing with each re-login, so even the allowed ones are paced.
				if (!(await sleep(backoffMs(relogins, { baseMs: backoff.baseMs, capMs: backoff.capMs, random }), signal))) return { detached: true };
				lastRelogin = now();
				continue;
			}
			if (got.status === 429) {
				failures += 1;
				if (failures >= backoff.maxFailures) throw new ConsoleError(`the console at ${where} kept refusing the stream as busy: ${got.error}`, { status: 429 });
				if (!(await wait(got.retryAfter ?? backoffMs(failures, { baseMs, capMs: backoff.capMs, random })))) return { detached: true };
				continue;
			}
			if (got.status === 503 || got.status === 502 || got.status === 504) {
				failures += 1;
				if (failures >= backoff.maxFailures) throw new ConsoleError(`the console at ${where} could not serve the stream: ${got.error}`, { status: got.status });
				if (!(await wait(got.retryAfter ?? backoffMs(failures, { baseMs, capMs: backoff.capMs, random })))) return { detached: true };
				continue;
			}
			if (got.status !== undefined) throw new ConsoleError(got.error, { status: got.status });
			// Open, then closed without `done`: a cut stream (a slow reader, a restart). Reconnect from `last`.
			failures = got.received > 0 ? 1 : failures + 1;
			if (failures >= backoff.maxFailures) throw new ConsoleError(`the console at ${where} kept closing the stream before it ended (gave up after ${failures} tries)`);
			if (!(await wait(backoffMs(failures, { baseMs, capMs: backoff.capMs, random })))) return { detached: true };
		}
	}

	return {
		address,
		login,
		get session() {
			return session;
		},
		getJson: (path) => requestJson("GET", path),
		postJson: (path, body) => requestJson("POST", path, body),
		async whoami() {
			const got = await requestJson("GET", "/api/whoami");
			if (got.status !== 200 || !got.json) throw new ConsoleError(`the console at ${where} did not say who is signed in: ${errorOf(got.status, got.json)}`, { status: got.status });
			return { name: String(got.json.name ?? "?"), role: got.json.role === "operator" ? "operator" : "viewer", readOnly: got.json.readOnly === true };
		},
		run(query) {
			const params = new URLSearchParams();
			if (typeof query?.id === "string") params.set("id", query.id);
			else if (typeof query?.url === "string") params.set("url", query.url);
			else throw new TypeError("run: want {id} or {url}");
			return requestJson("GET", `/api/run?${params}`);
		},
		act,
		stream,
	};
}
