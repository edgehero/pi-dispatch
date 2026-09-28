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
 * The rule, for every client:
 *   - VALKEY_URL's host is resolved ONCE per process and URL, as the client would; an address that is not this host's
 *     (another machine's Valkey) is dialled by name, as before, since pinning a remote name would defeat its DNS
 *     failover.
 *   - Of this host's addresses that answer, the first this account holds is pinned, and every later connect of the
 *     process goes to that literal address, its owner judged again on each one (a Valkey that restarts is a port
 *     another account may take meanwhile).
 *   - Where the podman venue is this deployment's without `local`, on Linux (`enforce`), anything else is refused,
 *     unless PI_VALKEY_SHARED=1 in the deployment's `.env` says the Valkey is shared on purpose: the connect fails with
 *     the refusal, which the caller reports (a CLI exits, the panel shows it, the worker retries and says why).
 *   - Elsewhere (docker's Valkey, published by root's docker-proxy, is the queue wherever `local` is blessed) nothing is
 *     refused, and the first answering address is pinned: the one the client would have dialled anyway, now fixed.
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
 * Where a client stands (issue #464): whether the owner rule refuses here (`enforce`) and whether the deployment's `.env`
 * opts into a shared Valkey. Read from `env` (the process's own, or the worker's) and the `.env` in `cwd`, which for
 * every service of this project is the deployment folder. The venue is this environment's PI_BACKENDS, else the
 * `.env`'s, so a shell that runs `pi-dispatch run` in the deployment folder without exporting it is judged as the
 * service is. `enforce` given by a caller (the worker, which has already judged its venue) wins.
 */
export function valkeyClientContext({ env = process.env, cwd = process.cwd(), platform = process.platform, enforce, readEnv = (p) => readFileSync(p, "utf8") } = {}) {
	const envPath = join(cwd, ".env");
	let text = null;
	try {
		text = String(readEnv(envPath));
	} catch {
		// No .env here: nothing opts in, and the venue is this environment's.
	}
	let fileVenue = {};
	let shared = false;
	if (text !== null) {
		const stack = readStackKeys(text, { loader: "systemd", path: envPath });
		if (!stack.error) fileVenue = stack.keys;
		const keys = readValkeyKeys(text, { loader: "systemd", path: envPath });
		if (!keys.error) shared = valkeySharedOn(keys.keys[VALKEY_SHARED_KEY]);
	}
	let venues = { localUsed: true, podmanUsed: false };
	try {
		venues = venuesOf({ PI_BACKENDS: typeof env.PI_BACKENDS === "string" ? env.PI_BACKENDS : fileVenue.PI_BACKENDS });
	} catch {
		// An unparseable list: the default venue, as doctor reads it; the worker refuses to boot on it anyway.
	}
	const derived = platform === "linux" && venues.podmanUsed && !venues.localUsed;
	return { envPath, shared, enforce: typeof enforce === "boolean" ? enforce : derived };
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
 * refused Valkey, and a plain Error when nothing answers (the client retries, and the next connect judges again).
 * `cache` holds the pinned address per URL for the life of the process: resolved once, re-judged on every connect.
 */
export async function judgedEndpoint(url, context, { cache = PINNED, facts = defaultHostFacts() } = {}) {
	const key = `${url}\u0000${context.enforce}\u0000${context.shared}`;
	const known = cache.get(key);
	const judge = (target) => judgeValkeyListeners({ url: target, probeTcp: facts.probeTcp, lookup: facts.lookup, fs: facts.fs, euid: facts.euid, user: facts.user, shared: context.shared, ownerName: facts.ownerName, interfaces: facts.interfaces, envPath: context.envPath, subuids: facts.subuids });
	const verdict = await judge(known ? pinnedValkeyUrl(url, known).url : url);
	if (verdict.error) throw new Error(`VALKEY_URL: ${verdict.error}`);
	const servernameFor = (address) => pinnedValkeyUrl(url, address).servername;
	if (verdict.remote) return { host: verdict.remote, servername: null, pinned: null };
	let address = verdict.chosen;
	if (!address && verdict.refusal) {
		if (context.enforce) throw valkeyRefusal(`the Valkey VALKEY_URL reaches is refused: ${verdict.refusal.text}`);
		address = verdict.answered[0].address;
	}
	if (!address) throw new Error(`nothing answers VALKEY_URL (${verdict.addresses.join(", ")}:${verdict.port}), so whose Valkey it is cannot be judged yet`);
	if (!known) cache.set(key, address);
	return { host: address, servername: servernameFor(address), pinned: address };
}

/** The per-process pins, by URL and context. Exported for the worker to seed with its boot judgement, and for tests. */
export const PINNED = new Map();
