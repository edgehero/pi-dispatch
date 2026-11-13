import { AbstractConnector, Command, Redis } from "ioredis";
import { Socket, connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { valkeyAuthRefusal } from "./valkey-auth.mjs";
import { valkeySchemeOf } from "./podman-stack.mjs";
import { decodedUserinfo, judgeValkeyAtStart as judgeEndpointAtStart, judgedEndpoint, killSwitchValkeyUrls, defaultValkeyContext, urlShown, useValkeyContext, valkeyClientContext, valkeyContextFromKeys, VALKEY_CONTEXT_KEYS, valkeyPasswordFor, valkeyDbRangeSentence, valkeyRefusal, valkeyUrlFor, valkeyUrlProblem } from "./valkey-endpoint.mjs";

// Re-exported for the receiver and the admin, which import this module from the package (issues #464 and #468).
export { killSwitchValkeyUrls, defaultValkeyContext, urlShown, useValkeyContext, valkeyClientContext, valkeyContextFromKeys, VALKEY_CONTEXT_KEYS, valkeyPasswordFor, valkeyUrlFor, valkeyUrlProblem };

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
 * A database the server refuses is a REFUSAL, never database 0 (gate round 2 of PR #478). ioredis 5.11.1 applies `db`
 * with a SELECT in its connect handler (redis/event_handler.js), before the ready check, and on a failure only
 * `silentEmit`s the error and carries on: the client went ready on database 0, so `status`, `cancel`, the worker and
 * doctor used database 0 of a Valkey whose `/16` does not exist, possibly another deployment's queue (measured against
 * Valkey: "ERR DB index is out of range", then a write through the `/16` client read back from database 0).
 *
 * Here, where that error surfaces, the client is stopped before its ready check can finish: the refusal
 * (`valkeyRefusal`, a configuration error naming the index) rejects every command queued so far, the client closes
 * without reconnecting, `JudgedConnector.check` fails the ready check that was already in flight, and a later connect
 * rejects with the same refusal. Every client of the project is built on that connector, so none goes ready on
 * another database. The start judgements (`judgeValkeyAtStart`, the worker's `refuseValkeyAuth`) and doctor read the
 * server's `databases` count for their sentence (`valkeyAuthState`).
 */
export const DB_REFUSED = Symbol.for("pi-dispatch.valkey-db-refused");
const SELECT_HOOK = Symbol.for("pi-dispatch.valkey-select-refusal");

/**
 * The database a client holds a refusal of (`DB_REFUSED`), as `{ db }` (null where the client no longer says which), or
 * null when it holds none. Issue #845: the refusal is held for the client's life, so only a restart of a long-lived
 * process tries the database again, and the console says so on every page from this.
 */
export function refusedDatabaseOf(client) {
	if (!client?.[DB_REFUSED]) return null;
	const db = client.condition?.select ?? client.options?.db;
	return { db: Number.isSafeInteger(db) ? db : null };
}

/** Whether `err` is a server's refusal of a SELECT for a database it does not have. */
function isSelectRangeError(err) {
	return Boolean(err) && typeof err === "object" && String(err.command?.name ?? "").toLowerCase() === "select" && /DB index is out of range|invalid DB index/i.test(String(err.message ?? ""));
}
if (!Redis.prototype[SELECT_HOOK]) {
	const silentEmit = Redis.prototype.silentEmit;
	Redis.prototype.silentEmit = function silentEmitSelectRefused(event, arg, ...rest) {
		if (event === "error" && isSelectRangeError(arg)) {
			if (!this[DB_REFUSED]) {
				const refusal = Object.assign(valkeyRefusal(valkeyDbRangeSentence(this.options?.[JUDGE]?.url ?? "", this.condition?.select ?? this.options?.db)), { valkeyDbRange: true, cause: scrubValkeyError(arg) });
				this[DB_REFUSED] = refusal;
				if (this.connector) this.connector[DB_REFUSED] = refusal;
				try {
					this.flushQueue(refusal);
				} catch {}
				this.disconnect();
			}
			// Said to a listener only: without one, every command of the client already rejects with the refusal, and
			// ioredis' own "Unhandled error event" print would add a stack trace to that sentence.
			return this.listeners("error").length > 0 ? silentEmit.call(this, event, this[DB_REFUSED], ...rest) : false;
		}
		return silentEmit.call(this, event, arg, ...rest);
	};
	Redis.prototype[SELECT_HOOK] = true;
}

/**
 * The `error` listener every BullMQ Queue and Worker of the project carries (issue #468): without one, BullMQ prints
 * the whole error object with `console.error`. This writes one line, the message only (scrubbed of any command), and
 * `what` naming whose error it is.
 *
 * `quietly`: the same line for the same `what` is said once per `VALKEY_ERROR_QUIET_MS`, across every emitter of the
 * process, for the reader's raw client and for a queue that gives up (`makeQueue`): a reader that replaces its queues
 * (`createFleetReader`) repeats the line on a new emitter per read, and a one-shot queue of a CLI verb or a worker's boot says
 * it once instead of a few times. A message not said in that minute is said at once, so a new fault is not held back; two
 * faults taking turns are each said once a minute. The raw client going ready ends the quiet for every line (a BullMQ queue
 * does not pass that event on), since a fault after that is a new outage in the same words. Off for a client that rides a
 * restart out: a running worker's and a receiver's retry lines are how a second outage shows in their logs.
 */
export const VALKEY_ERROR_QUIET_MS = 60_000;
const VALKEY_ERRORS_HELD = 256;
const saidAt = new Map();
export function onValkeyError(emitter, what, write = (line) => process.stderr.write(line), { quietly = false, now = () => Date.now() } = {}) {
	if (quietly) emitter.on?.("ready", () => saidAt.clear());
	emitter.on?.("error", (err) => {
		const message = String(scrubValkeyError(err)?.message ?? err);
		if (quietly) {
			const key = `${what}\u0000${message}`;
			const at = now();
			const last = saidAt.get(key);
			if (last !== undefined && at >= last && at - last < VALKEY_ERROR_QUIET_MS) return;
			if (saidAt.size >= VALKEY_ERRORS_HELD) saidAt.clear();
			saidAt.set(key, at);
		}
		write(`[pi-dispatch] Valkey error (${what}): ${message}\n`);
	});
	return emitter;
}

/** Whether `parseConnection` built this connection to give up after a couple of tries (`failFast`). */
export function givesUp(connection) {
	return connection?.[JUDGE]?.failFast === true;
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
 * A failFast client whose retries ran out has ended for good, so anything that holds one for longer than a question must
 * replace it (`createFleetReader`), or hold a persistent one instead (`noOfflineQueue` on `makeRedisClient`).
 *
 * `freshContext` is for a persistent client of a long-running surface that names no context: each connect judges by the
 * context as it is then, not as it was at construction, so an operator's fix of the deployment's `.env` reaches a client
 * that has been refused since it started. Off by default, so a worker's judgement stays the one it booted on. Its password
 * is read again before each connect too (issue #845, `freshPassword` below), so a password rotated in that `.env`, or one
 * a bad line kept from being read at start, is what the next connect sends. Not its URL: a changed `VALKEY_URL` is
 * another Valkey, which a running client is never moved to (the console says it needs a restart for that instead).
 *
 * `commandTimeoutMs` (issue #867) is a bound on each command of a `failFast` client, for a one-shot BullMQ queue that
 * must not wait for as long as a Valkey that is connected and stopped answering (`kill -STOP`, a partition) stays so:
 * `failFast` refuses while nothing is connected, and a command already sent had no bound. A command past it rejects with
 * ioredis' "Command timed out"; one that was sent may still run when Valkey wakes, so its error says so
 * (`valkeyMayStillRun`, the hook below), and it is never sent again on a later connection. It needs `failFast`: that
 * client has no offline queue, and on one that has, ioredis sends a command that timed out there once Valkey returns.
 * `makeRedisClient` takes such a command out of its own queue (`BoundedRedis`), but BullMQ builds this client itself, so
 * nothing could. Never for a Worker: its blocking reads wait longer than any bound by design, and its connection is a
 * persistent one, which this refuses.
 */
export function parseConnection(url, { failFast = false, servername = null, context = null, judge = null, withoutPassword = false, freshContext = false, commandTimeoutMs = null } = {}) {
	const u = new URL(url);
	// PR #478's gate: a path that is not a database number was `db: NaN`, and the SELECT ioredis then sent failed outside
	// every caller's await (an unhandled rejection). Refused here, where every client of the project is made, as the
	// configuration refusal it is; `judgeValkeyAtStart` says it first at each start.
	const dbProblem = valkeyUrlProblem(url);
	if (dbProblem) throw valkeyRefusal(dbProblem);
	const bounded = Number.isSafeInteger(commandTimeoutMs) && commandTimeoutMs > 0;
	if (bounded && !failFast) throw new TypeError("parseConnection: a command bound (commandTimeoutMs) is for a failFast client only, which has no offline queue to send a command that timed out from later");
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
		// `freshPassword` (issue #845): a client that judges by the context as it is at each connect sends the password that
		// context gives then, unless it was built to send none (`withoutPassword`, a probe of what another account sees).
		[JUDGE]: { url, context: where, ...(judge ? { judge } : {}), ...(freshContext && !context ? { freshContext: true, ...(withoutPassword ? {} : { freshPassword: true }) } : {}), ...(failFast ? { failFast: true } : {}), ...(bounded ? { commandBound: true } : {}) },
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
		// `valkeys:` is `rediss:`'s alias (`valkeySchemeOf`, gate round 3): TLS as well.
		...(valkeySchemeOf(u.protocol) === "rediss:" ? { tls: servername ? { servername } : {} } : {}),
		maxRetriesPerRequest: null, // required for BullMQ blocking connections
		...(failFast
			? {
					connectTimeout: 2000,
					enableOfflineQueue: false, // don't buffer commands while disconnected -- error now
					retryStrategy: (attempts) => (attempts > 2 ? null : 200), // give up after ~2 tries
				}
			: {}),
		// ioredis' resend of what was on a connection that died is off with the bound: the caller was told such a command
		// failed, and a resend on the next connection would make it run after that.
		...(bounded ? { commandTimeout: commandTimeoutMs, autoResendUnfulfilledCommands: false } : {}),
	};
}

/**
 * What `BoundedRedis` does for its own clients, done for a client `parseConnection` built with a command bound (issue
 * #867), which BullMQ constructs itself as a plain ioredis client, so it cannot be a subclass. On the prototype, like the
 * scrub above, and inert for every client without the bound (a worker's, a receiver's, every `makeRedisClient` client).
 *
 * Two things. The command's timer is unref'd, since ioredis' is ref'd and a one-shot that has said its last line must not
 * wait out a bound on a command nobody awaits. And a command that was WRITTEN (it is the newest entry of the client's
 * command queue right after the send; without an offline queue, one that was not is refused at once and never sent) and
 * then rejected with anything but Valkey's own reply carries `valkeyMayStillRun`: it reached a socket, so Valkey may run
 * it when it wakes, or ran it before its answer was lost. Measured against the pinned ioredis: a SET past the bound on a
 * `kill -STOP`ed Valkey rejects with "Command timed out" and is applied once the process is continued. Besides the
 * timeout that is "Connection is closed.", for a command on a connection whose retries ran out. A refusal this project
 * raised itself (`valkeyRefused`, a database the server does not have) is no lost answer.
 */
const COMMAND_BOUND_HOOK = Symbol.for("pi-dispatch.valkey-command-bound");
if (!Redis.prototype[COMMAND_BOUND_HOOK]) {
	const sendCommand = Redis.prototype.sendCommand;
	Redis.prototype.sendCommand = function sendCommandWithBound(command, stream) {
		const answer = sendCommand.call(this, command, stream);
		if (this.options?.[JUDGE]?.commandBound !== true) return answer;
		command._commandTimeoutTimer?.unref?.();
		if (this.commandQueue?.peekBack?.()?.command !== command) return answer;
		answer?.catch?.((err) => {
			if (!err || typeof err !== "object" || err.name === "ReplyError" || err.valkeyRefused) return;
			if (err.message === "Command timed out") err.code ??= "ETIMEDOUT";
			err.valkeyMayStillRun = true;
		});
		return answer;
	};
	Redis.prototype[COMMAND_BOUND_HOOK] = true;
}

/**
 * A client whose commands have a bound. Its caller has been told a command that timed out failed, so that command must
 * not go out later, and ioredis would send it: the timer rejects it and leaves it in the offline queue for when Valkey
 * returns. A cancel the page said was not made then stopped the run hours later. One already on the socket of a Valkey
 * that stopped answering cannot be taken back, so its error says so (`valkeyMayStillRun`), and the caller can too.
 *
 * ioredis' timer is also ref'd, so a client told to stop with commands still waiting held its process for up to one more
 * bound. Reaches into two internals of the pinned ioredis, both held by
 * `worker/test/connection.test.mjs`. REJECTED: `enableOfflineQueue: false`, which refuses a client's first command too,
 * before it has had a chance to connect.
 */
class BoundedRedis extends Redis {
	sendCommand(command, stream) {
		const answer = super.sendCommand(command, stream);
		command._commandTimeoutTimer?.unref?.();
		answer?.catch?.((err) => {
			if (err?.message !== "Command timed out") return;
			err.code ??= "ETIMEDOUT";
			const queue = this.offlineQueue;
			for (let i = 0; i < queue.length; i += 1) {
				if (queue.peekAt(i)?.command === command) {
					queue.removeOne(i);
					return;
				}
			}
			err.valkeyMayStillRun = true;
		});
		return answer;
	}
}

/**
 * How long one command of a short-lived client may wait for its answer (`commandTimeoutMs`), in the offline queue or on a
 * Valkey that stopped answering: the console's own clients wait as long, and `pi-dispatch cancel` (issue #846) takes it
 * from here, so a cancel against a Valkey that went away ends with a sentence rather than waiting as long as it is gone.
 */
export const VALKEY_COMMAND_TIMEOUT_MS = 5_000;

/**
 * A raw ioredis client (the budget's INCR/EXPIRE, the registry and fleet reads, doctor's PING). Built from
 * `parseConnection`'s options, so it connects through `JudgedConnector` like every other client. `lazyConnect` and
 * `failFast` as ioredis and `parseConnection` read them.
 */
export function makeRedisClient(url, { servername = null, context = null, failFast = false, lazyConnect = false, judge = null, withoutPassword = false, disconnectTimeoutMs = null, noOfflineQueue = false, commandTimeoutMs = null, freshContext = false } = {}) {
	// `disconnectTimeoutMs` (issue #599): how long ioredis's `disconnect()` waits for a socket to close before it destroys
	// it (its default is 2 s, on a ref'd timer). A one-shot read that must not hold its process passes 0.
	// A shell monitor must reconnect across an outage without accumulating stale control commands (#771).
	// Keep the persistent retry strategy, but reject each command while disconnected and bound in-flight retries.
	// `commandTimeoutMs`: how long one command may wait for its answer, in the offline queue or on a Valkey that stopped
	// answering. Without it a persistent client's command waits for as long as the outage lasts. With it, what timed out is
	// never sent again: `BoundedRedis` takes it out of the offline queue, and no resend covers what was on a connection that
	// died.
	const bounded = Number.isSafeInteger(commandTimeoutMs) && commandTimeoutMs > 0;
	const options = { ...parseConnection(url, { failFast, servername, context, judge, withoutPassword, freshContext }), ...(noOfflineQueue ? { enableOfflineQueue: false, maxRetriesPerRequest: 1 } : {}), ...(lazyConnect ? { lazyConnect: true } : {}), ...(Number.isSafeInteger(disconnectTimeoutMs) && disconnectTimeoutMs >= 0 ? { disconnectTimeout: disconnectTimeoutMs } : {}), ...(bounded ? { commandTimeout: commandTimeoutMs, autoResendUnfulfilledCommands: false } : {}) };
	return bounded ? new BoundedRedis(options) : new Redis(options);
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
		if (client[DB_REFUSED]) return { state: "dbrange", error: await dbRangeSentenceFor(url, client, { context, servername, makeClient, timeoutMs }) };
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
 * The refusal sentence for a client whose SELECT was refused, with the server's `databases` count read by a second
 * client on database 0 (`CONFIG GET databases`; null where that is refused, a managed Valkey say). The second client
 * only reads that setting and never touches a key.
 */
async function dbRangeSentenceFor(url, client, { context, servername, makeClient, timeoutMs }) {
	let databases = null;
	let probe;
	let timer;
	try {
		const u = new URL(url);
		u.pathname = "";
		probe = makeClient(u.toString(), { failFast: true, lazyConnect: true, context, servername });
		probe.on?.("error", () => {});
		const reply = await Promise.race([
			probe.connect().then(() => probe.config("GET", "databases")),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
			}),
		]);
		const n = Array.isArray(reply) ? Number(reply[1]) : NaN;
		databases = Number.isInteger(n) && n > 0 ? n : null;
	} catch {
		// Unreadable: the sentence says so.
	} finally {
		clearTimeout(timer);
		probe?.disconnect?.();
	}
	return valkeyDbRangeSentence(url, client.options?.db ?? client.condition?.select, databases);
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
		const { state, error } = await checkAuth(url, { context: where, servername: endpoint?.servername ?? null });
		// Gate round 2 of PR #478: a database the server does not have is a refusal too, never database 0.
		if (state === "dbrange") throw Object.assign(new Error(error), { piDispatchConfig: true, valkeyRefused: true, valkeyDbRange: true });
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

/** The connector's method that reads a `freshPassword` client's password again (`JudgedConnector`, the hook below it). */
const FRESH_PASSWORD = Symbol.for("pi-dispatch.valkey-fresh-password");

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

	/** ioredis' ready check: failed for a client whose SELECT was refused (`DB_REFUSED`), so it never goes ready. */
	check() {
		return !this[DB_REFUSED];
	}

	/**
	 * Issue #845: a `freshPassword` client's password, as `valkeyPasswordFor` reads it from the context as it is now, put
	 * where ioredis reads it for the connect about to start (the hook below). Here and not in `connect()`: by the time
	 * ioredis asks the connector for a stream it has already built that connect's AUTH from `options.password`. The options
	 * are the client's own object (ioredis hands its `options` to the Connector it constructs), so this is what the client
	 * sends. A password from VALKEY_URL's userinfo comes back as it is, so it stays fixed. The last password is kept by a
	 * context that:
	 *   - throws, or names an `error` (a `.env` that cannot be read, or a line in it the service's loader reads
	 *     differently): it cannot say which password the file holds, and dropping the one that worked would refuse a client
	 *     that is fine;
	 *   - finds no file (`absent`): a `.env` gone, for good or for the moment an editor replaces it, is not a file that
	 *     sets no password, so it does not drop one either (the console says to put the file back before a restart);
	 *   - no longer names the Valkey the client talks to: its VALKEY_URL (`valkeyUrlFor`, this shell's else the file's, as
	 *     every client of the process is given) differs from the one the context named when the client was built. A held
	 *     client never moves to another Valkey, so a password that came with a new VALKEY_URL is the new Valkey's, and sent
	 *     to the old one it is refused and the pages lose the old Valkey too (review of PR #878, measured with two Valkeys:
	 *     one deployment moving to another Valkey, and a symlinked deployment folder repointed, whose `.env` path is
	 *     spelled the same). A rotation keeps the URL, so it is taken;
	 *   - is read from another `.env` path than the one the client was built with: the pi extension's context follows the
	 *     deployment pointer, and that alone says the file is another deployment's.
	 * A context that passes all of these and gives no password drops it, as a restart would.
	 */
	[FRESH_PASSWORD]() {
		const judge = this.options?.[JUDGE];
		if (judge?.freshPassword !== true) return;
		let context;
		try {
			context = defaultValkeyContext();
		} catch {
			return;
		}
		if (!context || context.error || context.absent === true) return;
		if ((context.envPath ?? null) !== (judge.context?.envPath ?? null)) return;
		if (valkeyUrlFor(context).url !== valkeyUrlFor(judge.context).url) return;
		const { password } = valkeyPasswordFor(judge.url, context);
		if (password) this.options.password = password;
		else delete this.options.password;
	}

	connect() {
		const { options } = this;
		// A database the server refused stays refused: no reconnect goes ready on another one.
		if (this[DB_REFUSED]) return Promise.reject(this[DB_REFUSED]);
		this.connecting = true;
		const judge = options[JUDGE];
		if (!judge) return Promise.reject(new Error("a Valkey client was built without parseConnection's judged options"));
		// A promise chain, so a context read that throws takes the same path as a judgement that does: a client's connect
		// must not reject (below), or ioredis ends it for good.
		return new Promise((resolve) => resolve((judge.judge ?? judgedEndpoint)(judge.url, judge.freshContext ? defaultValkeyContext() : judge.context))).then(
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
 * Where a `freshPassword` client's password is read again (issue #845): before EVERY connect, its first and each
 * reconnect, on the prototype like the hooks above, so a client ioredis or BullMQ duplicates keeps it too. Measured
 * against the pinned ioredis 5.11.1 (`worker/test/valkey-clients.test.mjs` holds each line): `connect()` runs
 * `_connect()`, which builds the connect's AUTH (`this.condition.auth`) from `this.options.password` before it asks the
 * connector for a stream; a refused AUTH (WRONGPASS) and a refused ready check (NOAUTH) go to `recoverFromFatalError`,
 * which disconnects to reconnect, and the reconnect timer calls `self.connect()`. So a rotated password reaches a client
 * that has been refused since the rotation at its next try, by its own retry strategy, with no rebuild.
 *
 * Delegated to the client's connector, so the context read is the one of the copy of this module that built the client
 * (a bundle carries its own copy beside the shared ioredis, and the first copy loaded installs this hook). Inert for every
 * other client. A throw here would escape ioredis' reconnect timer, which does not catch one, so it is caught: the last
 * password is kept.
 *
 * REJECTED: rebuilding the client when its password changes, which every holder of one (the console's audit copy, the
 * fleet reader, a page's reads) would have to learn to swap; wrapping `connect` on each client `makeRedisClient` makes,
 * which misses a duplicate and a client BullMQ builds from `parseConnection`'s options; and reading the password in
 * `JudgedConnector.connect`, which is too late for that connect's AUTH (above).
 */
const FRESH_PASSWORD_HOOK = Symbol.for("pi-dispatch.valkey-fresh-password-hook");
if (!Redis.prototype[FRESH_PASSWORD_HOOK]) {
	const connect = Redis.prototype.connect;
	Redis.prototype.connect = function connectWithFreshPassword(...args) {
		try {
			this.connector?.[FRESH_PASSWORD]?.();
		} catch {
			// The last password stays.
		}
		return connect.apply(this, args);
	};
	Redis.prototype[FRESH_PASSWORD_HOOK] = true;
}

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
