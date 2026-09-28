import { AbstractConnector, Redis } from "ioredis";
import { Socket, connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { judgeValkeyAtStart, judgedEndpoint, valkeyClientContext } from "./valkey-endpoint.mjs";

// Re-exported for the receiver and the admin, which import this module from the package (issue #464).
export { judgeValkeyAtStart, valkeyClientContext };

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
export function parseConnection(url, { failFast = false, servername = null, context = null, judge = null } = {}) {
	const u = new URL(url);
	return {
		// Issue #464 (gate round 2 follow-up): EVERY client made from these options connects through `JudgedConnector`,
		// which judges and pins the address (valkey-endpoint.mjs) before each connect; `host` below is only what ioredis
		// reports. `context` is where the client stands (`valkeyClientContext`), the process's own when not given.
		Connector: JudgedConnector,
		// `judge` is a test seam only: the function asked for the address (judgedEndpoint when not given).
		[JUDGE]: { url, context: context ?? valkeyClientContext(), ...(judge ? { judge } : {}) },
		// WHATWG URL keeps an IPv6 literal's brackets in `hostname` (`[::1]`), and net.connect then looks up the name
		// "[::1]", which never resolves, so a `redis://[::1]:6379` VALKEY_URL never connected (issue #464, measured on
		// Fedora 44: ETIMEDOUT). The address is the part inside them.
		host: u.hostname.replace(/^\[(.*)\]$/, "$1") || "127.0.0.1",
		port: Number(u.port || 6379),
		...(u.password ? { password: u.password } : {}),
		...(u.username ? { username: u.username } : {}),
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
export function makeRedisClient(url, { servername = null, context = null, failFast = false, lazyConnect = false, judge = null } = {}) {
	return new Redis({ ...parseConnection(url, { failFast, servername, context, judge }), ...(lazyConnect ? { lazyConnect: true } : {}) });
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
