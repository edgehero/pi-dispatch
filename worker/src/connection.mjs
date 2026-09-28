import { AbstractConnector, Command, Redis } from "ioredis";
import { Socket, connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { valkeyAuthRefusal } from "./valkey-auth.mjs";
import { decodedUserinfo, judgeValkeyAtStart as judgeEndpointAtStart, judgedEndpoint, killSwitchValkeyUrls, defaultValkeyContext, urlShown, useValkeyContext, valkeyClientContext, valkeyContextFromKeys, VALKEY_CONTEXT_KEYS, valkeyPasswordFor, valkeyUrlFor } from "./valkey-endpoint.mjs";

// Re-exported for the receiver and the admin, which import this module from the package (issues #464 and #468).
export { killSwitchValkeyUrls, defaultValkeyContext, urlShown, useValkeyContext, valkeyClientContext, valkeyContextFromKeys, VALKEY_CONTEXT_KEYS, valkeyPasswordFor, valkeyUrlFor };

/**
 * The VALKEY_URL a CLI command uses from `cwd` (`valkeyUrlFor`), with a disagreement or an unreadable `.env` written as
 * one warning line through `warn`. The one resolver every CLI verb and `service restart --drain` share.
 */
export function cliValkeyUrl(env, { cwd, warn = (line) => process.stderr.write(line) } = {}) {
	const resolved = valkeyUrlFor(valkeyClientContext({ env, ...(cwd ? { cwd } : {}) }));
	if (resolved.note) warn(`warning: ${resolved.note}\n`);
	return resolved.url;
}

/**
 * An error a Valkey client reports, without the command it failed on (issue #468, PR #475's review). ioredis hangs
 * `command: { name, args }` on every reply error, and for a failed AUTH the args ARE the password: after a rotation,
 * a client still sending the old one emitted `WRONGPASS` with it attached, and BullMQ, whose Queue and Worker had no
 * `error` listener, fell back to `console.error(err)`, which prints the whole object, password included (measured
 * against a real Redis with CONFIG SET requirepass and CLIENT KILL). The args also carry job data (task text) for any
 * other failed command. So only the command's NAME is kept. Mutates and returns `err`; anything else passes through.
 */
export function scrubValkeyError(err) {
	if (err && typeof err === "object" && err.command && typeof err.command === "object") {
		try {
			err.command = { name: err.command.name };
		} catch {
			// A frozen error: nothing this client made.
		}
	}
	return err;
}

/**
 * WHERE the scrub runs (PR #475's review, round 2 corrected the first version of this comment, which claimed the emit
 * hook alone covered every path). ioredis hands an error to three kinds of consumer, and a failed AUTH reaches all
 * three with the password in `command.args`:
 *   - a listener, through `emit("error")`;
 *   - nobody, through `silentEmit("error")`, which SKIPS `emit()` when the client has no `error` listener (the worker's
 *     shared client, a CLI probe): ioredis then prints only `error.stack`, but the same object was already handed
 *   - to every command waiting on the connection, through that command's `reject` (`flushQueue`, `abortError`, a
 *     reply error): an awaited or unhandled rejection that anything may print whole (measured by the review: two
 *     occurrences of the password from a listener-less client after a rotation).
 * So the hook sits where each of them receives the object: `Redis.prototype.emit` and `silentEmit` for the events, and
 * every `Command`'s `reject` (wrapped as `initPromise` makes it) for the rejections. BullMQ and this module share the
 * one ioredis, so its clients are covered by the same hooks.
 */
const SCRUBS = Symbol.for("pi-dispatch.valkey-error-scrub");
if (!Redis.prototype[SCRUBS]) {
	const emit = Redis.prototype.emit;
	Redis.prototype.emit = function emitScrubbed(event, ...args) {
		if (event === "error") scrubValkeyError(args[0]);
		return emit.call(this, event, ...args);
	};
	const silentEmit = Redis.prototype.silentEmit;
	Redis.prototype.silentEmit = function silentEmitScrubbed(event, arg, ...rest) {
		if (event === "error") scrubValkeyError(arg);
		return silentEmit.call(this, event, arg, ...rest);
	};
	const initPromise = Command.prototype.initPromise;
	Command.prototype.initPromise = function initPromiseScrubbed(...args) {
		const out = initPromise.apply(this, args);
		const reject = this.reject;
		if (typeof reject === "function") this.reject = (err) => reject(scrubValkeyError(err));
		return out;
	};
	Redis.prototype[SCRUBS] = true;
}

/**
 * The `error` listener every BullMQ Queue and Worker of the project carries (issue #468): without one, BullMQ prints
 * the whole error object with `console.error`. This writes one line, the message only (scrubbed of any command), and
 * `what` naming whose error it is.
 */
export function onValkeyError(emitter, what, write = (line) => process.stderr.write(line)) {
	emitter.on?.("error", (err) => write(`[pi-dispatch] Valkey error (${what}): ${String(scrubValkeyError(err)?.message ?? err)}\n`));
	return emitter;
}

/**
 * Connection helpers for BullMQ and the budget's raw Redis client, both from one VALKEY_URL.
 *
 * `maxRetriesPerRequest: null` is REQUIRED by BullMQ for its blocking connections (the Worker
 * uses BRPOPLPUSH); without it BullMQ throws at construction. It is harmless on the Queue and the
 * budget client, so it is set consistently.
 */

/**
 * BullMQ connection options parsed from a redis:// URL.
 *
 * `failFast` is for the CLI producer (a one-shot enqueue): if Valkey is unreachable it should
 * error in a couple of seconds with a clear message, not hang forever. The long-running WORKER
 * uses the default (persistent) options -- it should ride out a Valkey restart, not give up.
 */
export function parseConnection(url, { failFast = false, servername = null, context = null, judge = null, withoutPassword = false } = {}) {
	const u = new URL(url);
	const where = context ?? defaultValkeyContext();
	// Issue #468: the password this client sends, by `valkeyPasswordFor`'s rule (the URL's own, else VALKEY_PASSWORD from
	// the environment, else from the deployment `.env` for a loopback host). Here and nowhere else, so every client of the
	// project (the worker, the CLI, the receiver, the admin panel, doctor) authenticates the same way. The URL's userinfo
	// is percent-decoded: it was handed over raw before, so a password with `@` written `%40` never matched.
	const { password } = valkeyPasswordFor(url, where, { withoutPassword });
	return {
		// Issue #464 (gate round 2 follow-up): EVERY client made from these options connects through `JudgedConnector`,
		// which judges and pins the address (valkey-endpoint.mjs) before each connect; `host` below is only what ioredis
		// reports. `context` is where the client stands (`valkeyClientContext`), the process's own when not given.
		Connector: JudgedConnector,
		// `judge` is a test seam only: the function asked for the address (judgedEndpoint when not given).
		[JUDGE]: { url, context: where, ...(judge ? { judge } : {}) },
		// WHATWG URL keeps an IPv6 literal's brackets in `hostname` (`[::1]`), and net.connect then looks up the name
		// "[::1]", which never resolves, so a `redis://[::1]:6379` VALKEY_URL never connected (issue #464, measured on
		// Fedora 44: ETIMEDOUT). The address is the part inside them.
		host: u.hostname.replace(/^\[(.*)\]$/, "$1") || "127.0.0.1",
		port: Number(u.port || 6379),
		...(password ? { password } : {}),
		...(u.username && !withoutPassword ? { username: decodedUserinfo(u.username) } : {}),
		...(u.pathname && u.pathname !== "/" ? { db: Number(u.pathname.slice(1)) } : {}),
		// TLS for `rediss:` (issue #464, gate round 2). Host and port alone dropped it, so a `rediss:` VALKEY_URL reached
		// BullMQ as plaintext. `servername` is the name a certificate is checked against when the worker connects to a
		// pinned address rather than to that name (`pinnedValkeyUrl`).
		...(u.protocol === "rediss:" ? { tls: servername ? { servername } : {} } : {}),
		maxRetriesPerRequest: null, // required for BullMQ blocking connections
		...(failFast
			? {
					connectTimeout: 2000,
					enableOfflineQueue: false, // don't buffer commands while disconnected -- error now
					retryStrategy: (attempts) => (attempts > 2 ? null : 200), // give up after ~2 tries
				}
			: {}),
	};
}

/**
 * A raw ioredis client (the budget's INCR/EXPIRE, the registry and fleet reads, doctor's PING). Built from
 * `parseConnection`'s options, so it connects through `JudgedConnector` like every other client. `lazyConnect` and
 * `failFast` as ioredis and `parseConnection` read them.
 */
export function makeRedisClient(url, { servername = null, context = null, failFast = false, lazyConnect = false, judge = null, withoutPassword = false } = {}) {
	return new Redis({ ...parseConnection(url, { failFast, servername, context, judge, withoutPassword }), ...(lazyConnect ? { lazyConnect: true } : {}) });
}

/**
 * How the Valkey at `url` answers this client's credential (issue #468), through a fail-fast client built like every
 * other: `{ state }`, one of
 *   "ok"          PING answered PONG with what this client sends (a password or none);
 *   "noauth"      it requires a password and this client sent none (NOAUTH);
 *   "wrongpass"   it refused the password this client sent (WRONGPASS, or "invalid password");
 *   "unreachable" anything else (nothing answers, a refused owner), with its `error` text.
 * `withoutPassword` asks as a client that sends none would: "ok" then means this Valkey answers ANY local account.
 * The password itself never leaves this function; the answer names only which state it is. Never throws.
 */
export async function valkeyAuthState(url, { context = null, servername = null, withoutPassword = false, timeoutMs = 5000, makeClient = makeRedisClient } = {}) {
	const seen = [];
	let client;
	try {
		client = makeClient(url, { failFast: true, lazyConnect: true, context, servername, withoutPassword });
	} catch (err) {
		return { state: "unreachable", error: err?.message ?? String(err) };
	}
	// ioredis reports an AUTH or ready-check refusal as an "error" event and then reconnects (bounded by failFast), while
	// connect() itself may reject with only "Connection is closed.", so the events are kept and read with the reply.
	client.on("error", (err) => seen.push(err?.message ?? String(err)));
	let timer;
	try {
		const reply = await Promise.race([
			client.connect().then(() => client.ping()),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
			}),
		]);
		return reply === "PONG" ? { state: "ok" } : { state: "unreachable", error: `PING answered ${String(reply).slice(0, 40)}` };
	} catch (err) {
		const all = [err?.message ?? String(err), ...seen].join("\n");
		if (/\bWRONGPASS\b|invalid password/i.test(all)) return { state: "wrongpass" };
		if (/\bNOAUTH\b/.test(all)) return { state: "noauth" };
		return { state: "unreachable", error: err?.message ?? String(err) };
	} finally {
		clearTimeout(timer);
		client.disconnect();
	}
}

/**
 * `judgeValkeyAtStart` of valkey-endpoint.mjs (the owner judgement, retried while nothing answers), then this client's
 * credential asked once (issue #468): a Valkey that refuses it is a refusal (a configError, exit 2, like a refused
 * owner), since a restart sends the same credential, and names VALKEY_PASSWORD without its value. Nothing answering
 * stays what it was: the command's own connect says it could not reach Valkey. `checkAuth` is a seam, the real check
 * unless the caller injected its own `judge` (a test standing in for the host, which has no Valkey to ask).
 */
export async function judgeValkeyAtStart(url, context, opts = {}) {
	const endpoint = await judgeEndpointAtStart(url, context, opts);
	const checkAuth = opts.checkAuth !== undefined ? opts.checkAuth : opts.judge ? null : valkeyAuthState;
	if (checkAuth) {
		const where = context ?? defaultValkeyContext();
		const { state } = await checkAuth(url, { context: where, servername: endpoint?.servername ?? null });
		const refusal = state === "noauth" || state === "wrongpass" ? authRefusalFor(state, url, where) : null;
		if (refusal) throw Object.assign(new Error(refusal), { piDispatchConfig: true, valkeyRefused: true, valkeyAuth: state });
	}
	return endpoint;
}

/** The refusal sentence for an auth state, naming where the password would come from (never its value). */
export function authRefusalFor(state, url, context) {
	const { password, from } = valkeyPasswordFor(url, context);
	return valkeyAuthRefusal(new Error(state === "noauth" ? "NOAUTH" : "WRONGPASS"), { passwordSet: Boolean(password), from, envPath: context?.envPath ?? "the deployment's .env" });
}

/**
 * The key under which a client's options carry what `JudgedConnector` judges: the URL as written and the context. A
 * string, not a Symbol: ioredis merges its options with lodash `defaults`, which copies string keys only.
 */
const JUDGE = "piDispatchValkeyJudge";

/**
 * ioredis' connector for every client of this project (issue #464, gate round 2 follow-up): on each connect it asks
 * `judgedEndpoint` for the address, then dials that literal (with a `rediss:` URL's name kept as the TLS servername),
 * exactly as ioredis' own StandaloneConnector dials a host.
 *
 * A judgement that throws (nothing answers while the Valkey restarts, a refusal, a name that does not resolve) must NOT
 * reject `connect()`: ioredis 5.11.1 then sets the client's status to "end" and never retries, so one Valkey restart
 * killed every client for good (gate round 3, measured: "Connection is closed." on the next job, never retried). So
 * `connect()` resolves a socket already destroyed, with the error as `firstError`: ioredis' own branch for a stream that
 * failed before it was handed over, which reports that error and takes the close path, retrying by the client's
 * strategy and judging again on the next connect. A client with a bounded strategy (the CLI's failFast) then ends with
 * that error. Destroyed before it is returned, never on a later tick: a socket that is neither connecting nor destroyed
 * when ioredis looks is taken as connected, and its ready check then fails on a dead stream (measured on the VMs:
 * "Stream isn't writeable" printed beside every failed judgement).
 */
export class JudgedConnector extends AbstractConnector {
	constructor(options) {
		super(options.disconnectTimeout);
		this.options = options;
	}

	connect() {
		const { options } = this;
		this.connecting = true;
		const judge = options[JUDGE];
		if (!judge) return Promise.reject(new Error("a Valkey client was built without parseConnection's judged options"));
		return (judge.judge ?? judgedEndpoint)(judge.url, judge.context).then(
			(endpoint) => {
				if (!this.connecting) throw new Error("Connection is closed.");
				const target = { host: endpoint.host, port: options.port, ...(options.family != null ? { family: options.family } : {}) };
				if (options.tls) Object.assign(target, options.tls, endpoint.servername ? { servername: endpoint.servername } : {});
				this.stream = options.tls ? JudgedConnector.dial.tls(target) : JudgedConnector.dial.net(target);
				this.stream.once("error", (err) => {
					this.firstError = err;
				});
				return this.stream;
			},
			(err) => {
				if (!this.connecting) throw new Error("Connection is closed.");
				const stream = new Socket();
				this.stream = stream;
				this.firstError = err;
				// The destroyed socket's own "error" event comes on a later tick; ioredis reports firstError instead.
				stream.on("error", () => {});
				stream.destroy(err);
				return stream;
			},
		);
	}
}

/** How `JudgedConnector` dials, net and tls: a seam, so a test sees the options a pinned connect is made with. */
JudgedConnector.dial = { net: netConnect, tls: tlsConnect };

/**
 * Whether `connection` (options for BullMQ, or an ioredis client) connects through `JudgedConnector`. `makeQueue` and the
 * worker refuse any other, so no Queue or Worker of this project can be built on an unjudged connection.
 */
export function isJudgedConnection(connection) {
	const options = connection?.options ?? connection;
	return options?.Connector === JudgedConnector && Boolean(options?.[JUDGE]);
}

/** Throws unless `connection` is judged (`isJudgedConnection`). */
export function assertJudgedConnection(connection) {
	if (!isJudgedConnection(connection)) throw new TypeError("a Valkey connection must be built by parseConnection (connection.mjs), which judges and pins the address it dials (issue #464)");
}

/**
 * Record, then read back, which deployment folder the queue in a Valkey belongs to (PR #475's review, the volume gap):
 * `SET pi-dispatch:owner <folder> NX`, then `GET`. Docker volume labels cannot be added after creation, so a volume made
 * before the label (adopted with consent) carries its owner here, inside the data it describes, and every later start
 * on it checks this key. Retried for `waitMs` while a Valkey that was just started comes up. `{ owner, claimed }` where
 * `owner` is what the key holds (this folder, or another one's), or `{ error }` when it could not be read.
 */
export async function claimValkeyOwner(url, folder, { context = null, waitMs = 15000, makeClient = makeRedisClient, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
	const { OWNER_MARKER_KEY } = await import("./valkey-auth.mjs");
	const until = Date.now() + waitMs;
	let last = "no attempt";
	for (;;) {
		let client;
		try {
			client = makeClient(url, { failFast: true, lazyConnect: true, context });
			client.on("error", () => {});
			await client.connect();
			const set = await client.set(OWNER_MARKER_KEY, folder, "NX");
			const owner = await client.get(OWNER_MARKER_KEY);
			return { owner, claimed: set === "OK" };
		} catch (err) {
			last = err?.message ?? String(err);
			// NOAUTH and WRONGPASS will not change by waiting.
			if (/\bNOAUTH\b|\bWRONGPASS\b/.test(last) || Date.now() >= until) return { error: last };
		} finally {
			client?.disconnect();
		}
		await sleep(500);
	}
}
