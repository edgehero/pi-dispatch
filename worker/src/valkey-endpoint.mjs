/**
 * THE judge-and-pin every Valkey client of this project goes through (issue #464, gate round 2 follow-up).
 *
 * The owner rule (`judgeValkeyListeners`) first lived only in `service install`, `up` and doctor, then in the worker's
 * boot; every client that connected elsewhere (`pi-dispatch run`, the receiver, the admin panel, doctor's own probes)
 * still resolved VALKEY_URL's name itself, so during another account's `[::1]` squat a `localhost` URL carried a job's
 * task text to that account's Valkey (measured on Fedora 44 with `pi-dispatch run`). So the rule lives where every
 * connection is made: `connection.mjs` builds each ioredis and BullMQ client with `JudgedConnector`, which asks
 * `judgedEndpoint` for the address to dial on every connect, and `makeQueue` and the worker refuse a connection that
 * was not built that way. The receiver and the admin panel import `connection.mjs` from this package
 * (`@edgehero/pi-dispatch/connection`), so they share this function rather than carrying a copy of it.
 *
 * The rule, for every client (gate round 3's simpler rule: nothing here depends on the cwd or on a venue guess):
 *   - VALKEY_URL's host is resolved ONCE per process and URL, as the client would; an address that is not this host's
 *     (another machine's Valkey) is dialled by name, as before, since pinning a remote name would defeat its DNS
 *     failover. A name that does not resolve, or a resolver that does not answer, is a judgement that failed and is
 *     retried, never "another host".
 *   - On Linux, a listener held by a uid that is neither this account's euid, nor one of its subordinate uids, nor
 *     root is refused, from any cwd, unless PI_VALKEY_SHARED=1 in the deployment's `.env` says it is shared on purpose.
 *   - Root's listener (docker-proxy) is refused as well only where the deployment's venue is podman without `local`
 *     (`valkeyClientContext`'s `rootRefused`), which is where it cannot be the deployment's queue.
 *   - Of this host's addresses that answer, the first this account holds is pinned (else the first acceptable one), and
 *     every later connect of the process goes to that literal address, its owner judged again on each one (a Valkey that
 *     restarts is a port another account may take meanwhile).
 * A judgement that throws never ends a client: `JudgedConnector` hands ioredis a socket destroyed with the error, and
 * ioredis retries by its strategy and judges again (gate round 3).
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { networkInterfaces, userInfo } from "node:os";
import { join } from "node:path";
import { venuesOf } from "./backends.mjs";
import { VALKEY_SHARED_KEY, judgeValkeyListeners, passwdNameFrom, pinnedValkeyUrl, probeTcpAddress, readStackKeys, readSubuidRanges, readValkeyKeys, valkeySharedOn } from "./podman-stack.mjs";

/** A refused Valkey: tagged as the configError it is, so the worker's CLI exits 2 on it. */
export function valkeyRefusal(message) {
	return Object.assign(new Error(message), { piDispatchConfig: true, valkeyRefused: true });
}

/**
 * Where a client stands (issue #464, gate round 3): `{ envPath, shared, rootRefused, error }`.
 *
 * The owner decision itself does not depend on this (gate round 3's simpler rule): on Linux EVERY client refuses a
 * listener held by a uid that is neither this account's euid, nor one of its subordinate uids, nor root, from any cwd.
 * Only two facts come from here:
 *   - `rootRefused`: root's listener (and one no socket row explains) is refused too where the deployment's venue is
 *     podman without `local`: this environment's PI_BACKENDS, else the `.env` in `cwd`. Elsewhere root's is docker's
 *     Valkey, published by root's docker-proxy, and is accepted. A caller that has judged its venue (the worker) passes
 *     it.
 *   - `shared`: PI_VALKEY_SHARED=1 from the `.env` in `cwd`, and from nowhere else. NEVER from the environment, even
 *     where no `.env` is found: the opt-in states a fact about the DEPLOYMENT (this Valkey is shared on purpose), and
 *     the service's worker reads it from the deployment's `.env` alone. An environment opt-in would let `pi-dispatch run`
 *     from a shell, or a panel or receiver started from $HOME, send the deployment's jobs into another account's queue
 *     that its own worker refuses; a CLI user who means it runs the command in the deployment folder, whose `.env` says
 *     so.
 * The `.env` is read as BYTES through the hardened reader (`readStackKeys`, `readValkeyKeys`); a file that cannot be
 * read, or a line they refuse, is `error`, never dropped: a client whose judged listener is not this account's own is
 * then refused, naming it, since neither the opt-in nor the venue can be told.
 */
export function valkeyClientContext({ env = process.env, cwd = process.cwd(), platform = process.platform, rootRefused, readEnv = (p) => readFileSync(p) } = {}) {
	const envPath = join(cwd, ".env");
	let content = null;
	let error = null;
	try {
		content = readEnv(envPath);
	} catch (err) {
		if (err?.code !== "ENOENT") error = `${envPath} could not be read (${err?.code ?? err?.message})`;
	}
	let fileVenue = {};
	let shared = false;
	if (content !== null) {
		const stack = readStackKeys(content, { loader: "systemd", path: envPath });
		if (stack.error) error = stack.error;
		else fileVenue = stack.keys;
		const keys = readValkeyKeys(content, { loader: "systemd", path: envPath });
		if (keys.error) error ??= keys.error;
		else shared = valkeySharedOn(keys.keys[VALKEY_SHARED_KEY]);
	}
	let venues = { localUsed: true, podmanUsed: false };
	try {
		venues = venuesOf({ PI_BACKENDS: typeof env.PI_BACKENDS === "string" ? env.PI_BACKENDS : fileVenue.PI_BACKENDS });
	} catch {
		// An unparseable list: the default venue, as doctor reads it; the worker refuses to boot on it anyway.
	}
	const derived = platform === "linux" && venues.podmanUsed && !venues.localUsed;
	return { envPath, shared, rootRefused: typeof rootRefused === "boolean" ? rootRefused : derived, error };
}

let hostFacts = null;
/** This host's facts for the judge, read once per process: the euid, the account name and its subordinate ranges. */
function defaultHostFacts() {
	if (hostFacts) return hostFacts;
	const fs = { readFileSync };
	const euid = typeof process.geteuid === "function" ? process.geteuid() : null;
	let user = null;
	try {
		user = userInfo().username;
	} catch {
		// A uid with no passwd entry: its subordinate ranges are read by uid.
	}
	hostFacts = { fs, euid, user, subuids: readSubuidRanges({ user, euid, fs }), probeTcp: probeTcpAddress, lookup: (host, opts) => dnsLookup(host, opts), interfaces: networkInterfaces, ownerName: (uid) => passwdNameFrom(fs, uid) };
	return hostFacts;
}

/**
 * The address a client of `url` connects to, judged (see the header): `{ host, servername, pinned }`, `pinned` the
 * literal address when one was judged, null for another machine's Valkey dialled by name. Throws `valkeyRefusal` for a
 * refused Valkey, and a plain Error (`retryable`) when nothing answers or the name does not resolve: the client retries,
 * and the next connect judges again. `cache` holds the pinned address per URL for the life of the process: resolved
 * once, re-judged on every connect.
 */
export async function judgedEndpoint(url, context, { cache = PINNED, facts = defaultHostFacts() } = {}) {
	const key = `${url}\u0000${context.rootRefused}\u0000${context.shared}`;
	const known = cache.get(key);
	const judge = (target) => judgeValkeyListeners({ url: target, probeTcp: facts.probeTcp, lookup: facts.lookup, fs: facts.fs, euid: facts.euid, user: facts.user, shared: context.shared, rootOk: !context.rootRefused, ownerName: facts.ownerName, interfaces: facts.interfaces, envPath: context.envPath, subuids: facts.subuids });
	const verdict = await judge(known ? pinnedValkeyUrl(url, known).url : url);
	if (verdict.error) throw valkeyRefusal(`VALKEY_URL: ${verdict.error}`);
	if (verdict.unresolved) throw retryable(`VALKEY_URL's host ${verdict.unresolved} did not resolve here (${verdict.why}), so whose Valkey it reaches cannot be judged yet`);
	if (verdict.remote) return { host: verdict.remote, servername: null, pinned: null };
	if (verdict.refusal) throw valkeyRefusal(`the Valkey VALKEY_URL reaches is refused: ${verdict.refusal.text}`);
	const address = verdict.chosen;
	if (!address) throw retryable(`nothing answers VALKEY_URL (${verdict.addresses.join(", ")}:${verdict.port}), so whose Valkey it is cannot be judged yet`);
	// A listener this account does not hold, taken on a fact of the `.env` (the opt-in, or a venue that accepts root's),
	// is refused when that file could not be read: neither fact can then be told (gate round 3, item 5).
	if (!verdict.own && context.error) throw valkeyRefusal(`the Valkey VALKEY_URL reaches is held by ${verdict.heldBy}, not by this account, and ${context.error}, so whether it may be used cannot be told`);
	if (!known) cache.set(key, address);
	return { host: address, servername: pinnedValkeyUrl(url, address).servername, pinned: address };
}

/** A judgement that may succeed later (nothing answers yet, a name that does not resolve yet): retried, never final. */
function retryable(message) {
	return Object.assign(new Error(message), { valkeyRetryable: true });
}

/**
 * Judge `url` before a long-running process builds anything on it (the receiver, the poller, the CLI; issue #464, gate
 * round 3): the refusal thrown at once (a configError: exit 2, as the worker's boot does), a retryable judgement retried
 * every 500 ms for `waitMs`, then thrown as the plain Error it is (exit 1: the service manager starts it again).
 */
export async function judgeValkeyAtStart(url, context, { waitMs = 20_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), judge = judgedEndpoint } = {}) {
	const deadline = now() + waitMs;
	for (;;) {
		try {
			return await judge(url, context);
		} catch (err) {
			if (!err?.valkeyRetryable || now() >= deadline) throw err;
		}
		await sleep(500);
	}
}

/** The per-process pins, by URL and context. Exported for the worker to seed with its boot judgement, and for tests. */
export const PINNED = new Map();
