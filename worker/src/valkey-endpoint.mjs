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
import { DEFAULT_VALKEY_URL } from "./config.mjs";
import { VALKEY_SHARED_KEY, judgeValkeyListeners, passwdNameFrom, pinnedValkeyUrl, probeTcpAddress, readStackKeys, readSubuidRanges, readValkeyKeys, valkeySharedOn, valkeySchemeOf } from "./podman-stack.mjs";
import { VALKEY_PASSWORD_KEY, isLoopbackHost } from "./valkey-auth.mjs";

/** A refused Valkey: tagged as the configError it is, so the worker's CLI exits 2 on it. */
export function valkeyRefusal(message) {
	return Object.assign(new Error(message), { piDispatchConfig: true, valkeyRefused: true });
}

/**
 * Where a client stands when its caller names no context (issue #468): `valkeyClientContext()`, the `.env` in the
 * working directory, unless a process installed its own (`useValkeyContext`). The admin panel installs one built from
 * the ONE `.env` reader it has (issue #471's `readDeploymentEnv`, through the worker's shared resolver, the pointer's
 * folder only, and nothing from a file another account can change), so no second reader of a `.env` runs in the panel.
 */
let contextProvider = null;

/** Install (or with null, remove) the function that makes the default context. */
export function useValkeyContext(fn) {
	contextProvider = typeof fn === "function" ? fn : null;
}

/** The context a client gets when its caller names none. */
export function defaultValkeyContext() {
	return contextProvider ? contextProvider() : valkeyClientContext();
}

/**
 * Where a client stands (issue #464, gate round 3): `{ envPath, shared, rootRefused, error, password }`.
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
 *
 * `password` (issue #468): `{ environment, file }`, VALKEY_PASSWORD from this process's environment (the service's
 * loader puts the `.env` there) and from the `.env` in `cwd` (so `pi-dispatch pause` in the deployment folder needs no
 * export), each null when unset or empty. Which one a client sends is `valkeyPasswordFor`'s rule. The values are never
 * logged; a line may say only whether one is set.
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
	const fileKeys = {};
	if (content !== null) {
		const stack = readStackKeys(content, { loader: "systemd", path: envPath });
		if (stack.error) error = stack.error;
		else if (typeof stack.keys.PI_BACKENDS === "string") fileKeys.PI_BACKENDS = stack.keys.PI_BACKENDS;
		const keys = readValkeyKeys(content, { loader: "systemd", path: envPath });
		if (keys.error) error ??= keys.error;
		else for (const k of [VALKEY_SHARED_KEY, VALKEY_PASSWORD_KEY, "VALKEY_URL"]) if (typeof keys.keys[k] === "string") fileKeys[k] = keys.keys[k];
	}
	return valkeyContextFromKeys({ env, envPath, fileKeys, error, platform, rootRefused });
}

/**
 * A context from issue #471's resolution of the service keys (`resolveServiceEnv`'s `{ env, fromFile, disagreements }`,
 * doctor's): this shell's side is what the resolution did NOT take from the file, the file's side is what it did, or the
 * file's value where the two disagree. So a password the resolution took from the file is sent as the file's, to a
 * loopback Valkey only (`valkeyPasswordFor`), and a shell's stays the shell's.
 */
export function valkeyContextFromResolution({ service, envPath = null, shared, platform = process.platform } = {}) {
	const fileValue = (key) => service?.fromFile?.[key] ?? service?.disagreements?.find((d) => d.key === key)?.file;
	const shellValue = (key) => (Object.hasOwn(service?.fromFile ?? {}, key) ? undefined : service?.env?.[key]);
	const env = {};
	const fileKeys = {};
	for (const key of ["VALKEY_URL", VALKEY_PASSWORD_KEY]) {
		if (typeof shellValue(key) === "string") env[key] = shellValue(key);
		if (typeof fileValue(key) === "string") fileKeys[key] = fileValue(key);
	}
	if (typeof service?.env?.PI_BACKENDS === "string") env.PI_BACKENDS = service.env.PI_BACKENDS;
	if (typeof shared === "string") fileKeys[VALKEY_SHARED_KEY] = shared;
	return valkeyContextFromKeys({ env, envPath, fileKeys, platform });
}

/** The keys a client's context takes from a deployment `.env` (`valkeyContextFromKeys`). */
export const VALKEY_CONTEXT_KEYS = Object.freeze(["VALKEY_URL", VALKEY_PASSWORD_KEY, VALKEY_SHARED_KEY, "PI_BACKENDS"]);

/**
 * A context from keys a caller has already read out of the deployment's `.env` (`fileKeys`, the `VALKEY_CONTEXT_KEYS`
 * it supplied) and this process's environment. `valkeyClientContext` reads the file itself; the admin panel passes what
 * issue #471's resolver read, so the panel has one `.env` reader. `error` is a reason the file could not be read, as
 * `valkeyClientContext`'s.
 */
export function valkeyContextFromKeys({ env = process.env, envPath = null, fileKeys = {}, error = null, platform = process.platform, rootRefused } = {}) {
	const fileVenue = typeof fileKeys.PI_BACKENDS === "string" ? { PI_BACKENDS: fileKeys.PI_BACKENDS } : {};
	const shared = valkeySharedOn(fileKeys[VALKEY_SHARED_KEY]);
	const filePassword = fileKeys[VALKEY_PASSWORD_KEY] || null;
	const fileUrl = typeof fileKeys.VALKEY_URL === "string" ? fileKeys.VALKEY_URL : null;
	const envPassword = typeof env[VALKEY_PASSWORD_KEY] === "string" && env[VALKEY_PASSWORD_KEY] !== "" ? env[VALKEY_PASSWORD_KEY] : null;
	let venues = { localUsed: true, podmanUsed: false };
	try {
		venues = venuesOf({ PI_BACKENDS: typeof env.PI_BACKENDS === "string" ? env.PI_BACKENDS : fileVenue.PI_BACKENDS });
	} catch {
		// An unparseable list: the default venue, as doctor reads it; the worker refuses to boot on it anyway.
	}
	const derived = platform === "linux" && venues.podmanUsed && !venues.localUsed;
	const envUrl = typeof env.VALKEY_URL === "string" ? env.VALKEY_URL : null;
	return { envPath, shared, rootRefused: typeof rootRefused === "boolean" ? rootRefused : derived, error, password: { environment: envPassword, file: filePassword }, url: { environment: envUrl, file: fileUrl } };
}

/**
 * Why `url` cannot name a Valkey database, as a sentence, or null (PR #478's gate). The path of a VALKEY_URL is the
 * database number (`redis://host:port/2`); anything else (`/abc`, `/0,x=y`) became `db: NaN`, and ioredis's SELECT
 * then failed outside any caller's await, so doctor and every client died on "an unhandled rejection: ERR value is not
 * an integer or out of range" (measured on pd-fedora). A URL that does not parse is left to the callers that already
 * say so. The path is shown through `urlShown`, which never prints a credential.
 */
export function valkeyUrlProblem(url) {
	let u;
	try {
		u = new URL(String(url));
	} catch {
		return null;
	}
	// A scheme no client here speaks gets its own sentence (gate round 2: `unix:///path` was "<no host> names no
	// database", and before this change it dialled 127.0.0.1, ioredis' default host).
	if (valkeySchemeOf(u.protocol) === null) return `VALKEY_URL uses the scheme ${JSON.stringify(u.protocol.replace(/[^\x21-\x7e]/g, " ").slice(0, 20))}, which pi-dispatch does not connect with: write redis://host:port (or rediss://host:port for TLS; valkey:// and valkeys:// are the same two)`;
	// Leading zeros are the number they spell (gate round 2): ioredis and the code before this read `/01` as database 1,
	// so an upgrading deployment with one keeps its database.
	if (!u.pathname || u.pathname === "/" || /^\/[0-9]{1,9}$/.test(u.pathname)) return null;
	return `VALKEY_URL ${urlShown(url)} names no database: its path must be a whole number (redis://host:port/0 is database 0, and no path means the same), not ${JSON.stringify(u.pathname.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(0, 60))}`;
}

/**
 * The sentence for a VALKEY_URL whose database the server refuses to SELECT (gate round 2 of PR #478): `databases` is
 * the server's count when it could be read, null when it could not, undefined when it was not asked. Measured on Valkey: `/16` on a default server answers `ERR DB
 * index is out of range`, and ioredis only emitted an `error` and carried on on database 0, which may be another
 * deployment's queue.
 */
export function valkeyDbRangeSentence(url, db, databases) {
	// `databases`: the server's count; null where it could not be read; undefined where it was not asked (a client's own
	// refusal, which has only the server's answer to go on).
	const has = Number.isInteger(databases) && databases > 0 ? `it has ${databases} (databases 0 to ${databases - 1}, its \`databases\` setting)` : databases === null ? "its `databases` setting could not be read" : "it answered the SELECT with \"DB index is out of range\"";
	return `VALKEY_URL ${urlShown(url)} names database ${db}, which that Valkey does not have: ${has}. No client uses another database in its place; name one it has, or raise \`databases\` in that Valkey's configuration`;
}

/** The default VALKEY_URL, the worker's own, defined once in config.mjs. */
export { DEFAULT_VALKEY_URL };

/**
 * The VALKEY_URL a command run from a deployment folder uses (PR #475's review), by the same rule as the password it
 * sends: this shell's when it sets one, else the deployment `.env`'s, else the default. `pi-dispatch run`, `pause`,
 * `resume`, `status`, `cancel` and `service restart --drain` read the password from `.env` already and read the URL
 * from the shell alone, so in the deployment folder of a Valkey on another port they dialled 6379 with that
 * deployment's password. A shell and a `.env` that disagree are NAMED in `note` (the shell's is used: it is the
 * operator's explicit choice, and the kill switch must never refuse over it); a `.env` that could not be read is too.
 * Returns `{ url, from, note }`, `from` naming the source ("the environment", the `.env` path, or null for the default).
 */
export function valkeyUrlFor(context) {
	const envUrl = context?.url?.environment ?? null;
	const fileUrl = context?.url?.file ?? null;
	if (typeof envUrl === "string") {
		const note = typeof fileUrl === "string" && fileUrl !== envUrl ? `VALKEY_URL is ${urlShown(envUrl)} in this shell and ${urlShown(fileUrl)} in ${context.envPath}: using this shell's, while the service uses the file's` : null;
		return { url: envUrl, from: "the environment", note };
	}
	if (typeof fileUrl === "string") return { url: fileUrl, from: context.envPath, note: null };
	return { url: DEFAULT_VALKEY_URL, from: null, note: context?.error ? `${context.error}, so VALKEY_URL is the default, ${DEFAULT_VALKEY_URL}` : null };
}

/**
 * The Valkey(s) a kill switch acts on (PR #475's review, rounds 2 and 3), for the CLI's `pause`, `resume`, `status` and
 * `cancel` and the panel's `/dispatch pause|resume`: ONE rule, so the two surfaces cannot disagree about which queue
 * "paused" is true of.
 *   - `flagUrl` (the CLI's `--valkey-url`) when given. Refused when it carries a password: a command line is readable by
 *     every account in /proc, so the password belongs in VALKEY_PASSWORD, which every client sends. When it names
 *     neither this shell's VALKEY_URL nor the deployment .env's, `note` says which it is.
 *   - else this shell's (or the process environment's, the panel's pointer layered in) and the deployment .env's
 *     VALKEY_URL: when both are set and differ, BOTH, with `disagreement` naming the two; the caller pauses both, shows
 *     both, and refuses a resume or a cancel until one is named.
 *   - else `valkeyUrlFor`'s one URL, with its `note`.
 * Returns `{ urls, disagreement, note }` or `{ error }`. URLs in the sentences go through `urlShown`.
 */
export function killSwitchValkeyUrls({ env = process.env, cwd, flagUrl = null, context: given = null } = {}) {
	// `context`: a caller that has read the deployment's `.env` itself (the admin panel, issue #471) passes what it read.
	const context = given ?? valkeyClientContext({ env, ...(cwd ? { cwd } : {}) });
	const shell = context.url?.environment ?? null;
	const file = context.url?.file ?? null;
	if (flagUrl !== null && flagUrl !== undefined) {
		let u;
		try {
			u = new URL(String(flagUrl));
		} catch {
			return { error: `--valkey-url is not a URL (redis://host:port): ${urlShown(flagUrl)}` };
		}
		if (u.password || u.username) {
			return { error: `--valkey-url carries a password (or a user): a command line is readable by every account on this host in /proc, so the URL is refused. Put the password in ${VALKEY_PASSWORD_KEY} (this shell or ${context.envPath}), and give --valkey-url ${urlShown(flagUrl)}` };
		}
		const known = [shell, file].filter((x) => typeof x === "string").map(urlShown);
		const note = known.includes(urlShown(flagUrl)) ? null : `using --valkey-url ${urlShown(flagUrl)}, which is neither this shell's VALKEY_URL (${typeof shell === "string" ? urlShown(shell) : "unset"}) nor ${context.envPath}'s (${typeof file === "string" ? urlShown(file) : "unset"})`;
		return { urls: [String(flagUrl)], disagreement: null, note };
	}
	if (typeof shell === "string" && typeof file === "string" && shell !== file) {
		return { urls: [shell, file], disagreement: `VALKEY_URL is ${urlShown(shell)} in this shell and ${urlShown(file)} in ${context.envPath} (what the service uses)`, note: null };
	}
	const resolved = valkeyUrlFor(context);
	return { urls: [resolved.url], disagreement: null, note: resolved.note };
}

/**
 * A URL as doctor, the CLI and the panel may print it (issue #453, gate round 3 and the re-review; moved here in PR #475's
 * review so every surface prints a Valkey URL through ONE function): scheme, host, port and database only, never the
 * userinfo (a password or a username that is a token), the query (`password=`, a token) or the fragment; `<no host>`
 * without a host, and `<unparseable URL>` when it does not parse, since then nothing can say where a credential in it
 * starts or ends. Control characters are blanked: another party's value can reach this line.
 */
export function urlShown(url) {
	let parsed;
	try {
		parsed = new URL(String(url));
	} catch {
		return "<unparseable URL>";
	}
	if (!parsed.hostname) return "<no host>";
	return `${parsed.protocol}//${parsed.host}${parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : ""}`.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

/**
 * The password a client of `url` sends, and where it came from (issue #468): `{ password, from }`, both null for none.
 *   - the URL's own userinfo first: an operator's VALKEY_URL with a password (a managed Valkey) is left as it is;
 *   - else VALKEY_PASSWORD from the environment, for any host (the service's loader, compose's receiver container
 *     dialling `valkey:6379`, or an operator's export);
 *   - else VALKEY_PASSWORD from the deployment `.env`, and only for a loopback host: the password pi-dispatch generates
 *     belongs to the Valkey it starts on this machine, and is never sent to another one a shell's VALKEY_URL names.
 * `withoutPassword` is for a probe asking whether a Valkey answers clients that send none (doctor, `up`).
 */
export function valkeyPasswordFor(url, context, { withoutPassword = false } = {}) {
	if (withoutPassword) return { password: null, from: null };
	let u;
	try {
		u = new URL(url);
	} catch {
		return { password: null, from: null };
	}
	if (u.password) return { password: decodedUserinfo(u.password), from: "VALKEY_URL" };
	const pw = context?.password ?? {};
	if (pw.environment) return { password: pw.environment, from: "the environment" };
	if (pw.file && isLoopbackHost(u.hostname)) return { password: pw.file, from: context.envPath ?? ".env" };
	return { password: null, from: null };
}

/** A URL's userinfo part as the Valkey sees it: percent-decoded (`p%40ss` is `p@ss`), as written when it does not decode. */
export function decodedUserinfo(part) {
	try {
		return decodeURIComponent(part);
	} catch {
		return part;
	}
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
	// PR #478's gate: a path that names no database is a refusal (exit 2 at a start), said before anything connects.
	const dbProblem = valkeyUrlProblem(url);
	if (dbProblem) throw valkeyRefusal(dbProblem);
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
