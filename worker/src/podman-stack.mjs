/**
 * The native rootless `podman` venue's long-lived stack as Quadlet units (issue #430): Valkey, and while the egress
 * policy is armed the allowlist proxy on its named route-out network and the rootless network keeper (issue #458) on a
 * network of its own. ONE installer, used by both
 * `pi-dispatch service install` (user scope) and `pi-dispatch up`, on up.mjs's own doctrine that two ways of starting
 * one thing is two places for it to drift.
 *
 * Quadlet rather than `podman run --restart`: rootless Podman has no daemon to restart anything, so a container
 * started by hand is gone after a reboot. `podman-restart.service` could bring back `--restart=always` containers,
 * but it is a unit the operator would have to enable separately and it orders nothing; a Quadlet unit is a real
 * systemd user unit the worker's own unit can `Wants=`/`After=`. Measured on Fedora 44 with Podman 5.8.1:
 *   - `NetworkName=` and `ContainerName=` give exactly those names (no `systemd-` prefix), and `Network=X.network`
 *     resolves through the network file's `NetworkName=`.
 *   - `systemctl --user enable` REFUSES a generated unit ("transient or generated"); the generator reads the
 *     file's own `[Install] WantedBy=default.target` instead. So install is: write the files, daemon-reload,
 *     `systemctl --user start`. Never enable.
 *   - With linger on, the units were active 25 s after a reboot with nobody logged in; with linger off they did
 *     not start at all. Hence the linger read after every install.
 *   - `systemctl --user restart` of the proxy creates a NEW container (`--replace --rm`), and every per-job network
 *     the worker had connected to the old one is gone. New jobs connect at their start and are fine; see docs.
 *
 * This module decides and describes; it spawns only through the `run` seam it is handed and writes only through the
 * `fs` seam, so `service` and `up` each keep their own spawn helpers and their own tests' fakes.
 */
import { execFileSync } from "node:child_process";
import { connect as netConnect } from "node:net";
import { dirname, join } from "node:path";
import { DEFAULT_EGRESS_PROXY, egressProxyName } from "./egress.mjs";
import { VALKEY_PASSWORD_KEY, valkeyEnvFileText } from "./valkey-auth.mjs";
import { SYSTEMD_HAZARD_SHAPES, decodeEnvFile, envFileHazard, envFileSystemdHazard, envFileValueLines, invisibleCharacter, quotedRegions, readEnvAssignments } from "./env-file.mjs";
import { NETNS_KEEPER, NETNS_KEEPER_FORMAT, NETNS_KEEPER_NOW_FORMAT, STARTED_AT_FORMAT, NETNS_KEEPER_MIN_AGE_MS, NETNS_KEEPER_AFTER_PROXY_GRACE_MS, judgeNetnsKeeper, podmanNeedsNetnsKeeper, makeDetachGate, detachBlockedSentence, DETACH_GATE_READ_TIMEOUT_MS, DETACH_GATE_READ_MAX_BUFFER, runtimeFromFacts } from "./netns-keeper.mjs";

// The keeper's identity, its judge and the network detach gate live in the leaf `netns-keeper.mjs` (issue #452, gate
// round 3), because `egress.mjs`, which this module imports, routes every detach through that gate. Re-exported here.
export { NETNS_KEEPER, NETNS_KEEPER_FORMAT, NETNS_KEEPER_NOW_FORMAT, STARTED_AT_FORMAT, NETNS_KEEPER_MIN_AGE_MS, NETNS_KEEPER_AFTER_PROXY_GRACE_MS, judgeNetnsKeeper, podmanNeedsNetnsKeeper, makeDetachGate, detachBlockedSentence, DETACH_GATE_READ_TIMEOUT_MS, DETACH_GATE_READ_MAX_BUFFER, runtimeFromFacts };

/**
 * What to run for a keeper that does not hold: the proxy's restart when that is the damage the order rule cannot rule
 * out (`restartProxy`), else the keeper's own `reset-failed` and restart.
 */
export function netnsKeeperRemedy(judged, proxy) {
	const restartProxy = proxyRestartAdvice(proxy);
	if (judged.restartProxy) return restartProxy;
	if (judged.thenRestartProxy) return `start it as the worker's account: ${NETNS_KEEPER_START}, then ${restartProxy}, since the proxy has been up since before it`;
	return `start it as the worker's account: ${NETNS_KEEPER_START}`;
}

/** "restart the egress proxy once no job is running: <the command for this proxy's name>". */
export function proxyRestartAdvice(proxy) {
	return proxy === DEFAULT_EGRESS_PROXY ? `restart the egress proxy once no job is running: systemctl --user restart ${DEFAULT_EGRESS_PROXY}.service (podman restart ${DEFAULT_EGRESS_PROXY} for one started by hand)` : `restart the egress proxy once no job is running: podman restart ${proxy} (or its own unit)`;
}

/**
 * The installer's hint (PR #463 round 3): a plan that starts the keeper for the first time or restarts it, while the
 * proxy is NOT in the plan (an operator's own PI_EGRESS_PROXY, or `up` leaving a running proxy alone), leaves a proxy up
 * since before the keeper, which the worker's order rule then answers with a retry and a request for the proxy's
 * restart. So both commands say it now, with the proxy's real name. `null` when nothing of that happened.
 */
export function keeperUnderRunningProxyHint(plan, proxy, { keeperStarting = null } = {}) {
	const keeper = plan.files?.find((f) => f.unit === QUADLET_FILES.keeper.unit);
	if (!keeper) return null;
	const restarted = (plan.restart ?? []).includes(keeper.unit);
	// `keeperStarting`: a caller that knows the keeper was not running (`up` plans it only then) says so; otherwise a
	// file the plan writes new, or a restart, is what moves it (a `start` over a running unit changes nothing).
	if (!(keeperStarting ?? (keeper.state === "new" || restarted))) return null;
	if ((plan.start ?? []).includes(QUADLET_FILES.proxy.unit)) return null;
	return `${NETNS_KEEPER} was ${restarted ? "restarted" : "started"} while the egress proxy (${proxy}) is not part of this install: if it is running, ${proxyRestartAdvice(proxy)}; on Podman 4.x the worker retries every egress job, asking for exactly that, until the proxy has started after the keeper`;
}

/**
 * The start command every "the keeper is not holding" message names (doctor, the worker's preflight).
 */
export const NETNS_KEEPER_START = `systemctl --user reset-failed ${NETNS_KEEPER}-network.service ${NETNS_KEEPER}.service; systemctl --user restart ${NETNS_KEEPER}-network.service ${NETNS_KEEPER}.service`;

/**
 * The Quadlet files, in the order they are shown and written. `unit` is the service the generator makes of each; the
 * networks' units are pulled in by the containers' own `Requires=` (Quadlet adds it for `Network=X.network`), so only
 * the container services are ever started by name.
 */
export const QUADLET_FILES = Object.freeze({
	valkeyNetwork: Object.freeze({ file: "pi-dispatch-valkey.network", unit: "pi-dispatch-valkey-network.service" }),
	valkey: Object.freeze({ file: "pi-dispatch-valkey.container", unit: "pi-dispatch-valkey.service", container: "pi-dispatch-valkey" }),
	egressNetwork: Object.freeze({ file: "pi-dispatch-egress-out.network", unit: "pi-dispatch-egress-out-network.service" }),
	proxy: Object.freeze({ file: "pi-dispatch-egress-proxy.container", unit: "pi-dispatch-egress-proxy.service", container: DEFAULT_EGRESS_PROXY }),
	keeperNetwork: Object.freeze({ file: `${NETNS_KEEPER}.network`, unit: `${NETNS_KEEPER}-network.service` }),
	keeper: Object.freeze({ file: `${NETNS_KEEPER}.container`, unit: `${NETNS_KEEPER}.service`, container: NETNS_KEEPER }),
});

/** Every Quadlet file this project ships, for uninstall and status, which act on what exists rather than on a plan. */
export const ALL_QUADLET_FILES = Object.freeze(Object.values(QUADLET_FILES));

/** The two placeholders the proxy's template carries, and what each becomes (TEMPLATE_PINS in service.mjs pins both). */
export const PROXY_CONF_PLACEHOLDER = "/opt/pi-dispatch/deploy/egress-proxy.conf";
export const ALLOWLIST_PLACEHOLDER = "/opt/pi-dispatch/egress-allowlist.conf";

/**
 * Where the proxy's RULES are mounted from: an account-owned COPY of the package's `egress-proxy.conf`, never the
 * package file itself (issue #430 review round 2, E1). The mount carries `z`, which relabels the file, and rootless
 * Podman cannot relabel a file this account does not own: measured on Fedora 44 with the package installed by
 * `sudo npm i -g` under /usr/local/lib/node_modules, the unit failed with `lsetxattr ... operation not permitted`,
 * exit 126. A copy under this account's own config directory can always be relabelled, and is written, compared and
 * forced exactly like the Quadlet files (a planned write, shown before it happens). Not the deployment folder: that
 * is the operator's and may be shared with another account; this file belongs to the account whose Podman mounts it.
 */
export function proxyConfCopyPath(home) {
	return join(home, ".config", "pi-dispatch", "egress-proxy.conf");
}

/**
 * The file the Quadlet Valkey reads its password from (issue #468): `EnvironmentFile=%h/.config/pi-dispatch/valkey.env`
 * in the shipped unit, so the template needs no rewrite, and systemd expands `%h` to this account's home in both lines
 * Quadlet generates from it (measured on Podman 5.8.1 and 4.9.3). Mode 0600: it holds the password. Written, compared
 * and restarted-for like the proxy's rules copy, never printed (`service render` names it only).
 */
export function valkeyEnvPath(home) {
	return join(home, ".config", "pi-dispatch", "valkey.env");
}

/** The mode of `valkeyEnvPath`: this account alone may read it. */
export const VALKEY_ENV_MODE = 0o600;

/**
 * Where the user's Quadlet files live. ALWAYS `~/.config/containers/systemd`, deliberately not `$XDG_CONFIG_HOME`
 * from this shell: the generator runs in the user MANAGER's environment, which usually has no XDG_CONFIG_HOME at
 * all, so a shell that exports one would put the files where the generator never looks, and install would report a
 * start failure for units that simply do not exist.
 */
export function quadletDir(home) {
	return join(home, ".config", "containers", "systemd");
}

/**
 * Characters a path may not carry into a Quadlet `Volume=`. Each is a real parse on the way to `podman run`: `:`
 * splits the volume spec itself; whitespace splits the `RequiresMountsFor=` list Quadlet adds for every absolute
 * source; `%` is a systemd specifier there; `$` is expanded by systemd in the generated `ExecStart=` (`${X}` and
 * `$X` alike); quotes and backslashes are systemd's quoting; control bytes end the line.
 * Refused rather than escaped: none of the escapes was measured, and a unit that fails at boot is the worst place to
 * find out.
 */
const UNSAFE_VOLUME_PATH = /[:\s%$"'\\\x00-\x1f\x7f]/;

/** The port the Quadlet Valkey publishes on 127.0.0.1 when VALKEY_URL names none (the template's own). */
export const DEFAULT_VALKEY_PORT = 6379;

/** The opt-in, in the deployment `.env`, that lets a Valkey another uid holds be this deployment's queue (issue #464). */
export const VALKEY_SHARED_KEY = "PI_VALKEY_SHARED";

/** Whether `value` (PI_VALKEY_SHARED as the service reads it) opts in: exactly `1`, nothing else. */
export function valkeySharedOn(value) {
	return value === "1";
}

/**
 * Where the worker's queue client connects, from VALKEY_URL as the service reads it (issue #464): `{ host, port }`,
 * the host as the client dials it (an IPv6 literal without its brackets, as `parseConnection` hands it over), or
 * `{ error }` for a value that is not a redis URL. Unset is the worker's own default, redis://127.0.0.1:6379.
 */
/**
 * The scheme a VALKEY_URL is read as (gate round 3 of PR #478): `valkey:` and `valkeys:` are aliases of `redis:` and
 * `rediss:`, as Valkey's own clients take them, and connected before #477's scheme check; null for any other. Every
 * place that judges a scheme asks this, so the aliases cannot be accepted in one and refused in another.
 */
export function valkeySchemeOf(protocol) {
	return { "redis:": "redis:", "valkey:": "redis:", "rediss:": "rediss:", "valkeys:": "rediss:" }[protocol] ?? null;
}

export function valkeyTarget(url) {
	const raw = typeof url === "string" && url !== "" ? url : `redis://127.0.0.1:${DEFAULT_VALKEY_PORT}`;
	let parsed;
	try {
		parsed = new URL(raw);
	} catch {
		return { error: "VALKEY_URL is not a URL (redis://host:port)" };
	}
	if (valkeySchemeOf(parsed.protocol) === null) return { error: `VALKEY_URL's scheme is ${parsed.protocol}, not redis:, rediss:, valkey: or valkeys:` };
	const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase() || "127.0.0.1";
	return { host, port: parsed.port === "" ? DEFAULT_VALKEY_PORT : Number(parsed.port) };
}

/** The 4 bytes of a dotted IPv4 address, or null. */
function ipv4Bytes(address) {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
	if (!m) return null;
	const bytes = m.slice(1).map(Number);
	return bytes.every((b) => b <= 255) ? bytes : null;
}

/** The 16 bytes of an IPv6 address (`::` shorthand and a dotted IPv4 tail allowed, a zone dropped), or null. */
function ipv6Bytes(address) {
	let s = String(address).toLowerCase().replace(/%.*$/, "");
	const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
	let tail = [];
	if (dotted) {
		const v4 = ipv4Bytes(dotted[1]);
		if (!v4) return null;
		tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
		s = s.slice(0, -dotted[1].length);
		if (s.endsWith(":") && !s.endsWith("::")) s = s.slice(0, -1);
	}
	const halves = s.split("::");
	if (halves.length > 2) return null;
	const words = (part) => (part === "" ? [] : part.split(":").map((w) => (/^[0-9a-f]{1,4}$/.test(w) ? parseInt(w, 16) : NaN)));
	const head = words(halves[0]);
	const rest = halves.length === 2 ? words(halves[1]) : [];
	const given = head.length + rest.length + tail.length;
	if ([...head, ...rest].some(Number.isNaN)) return null;
	if (halves.length === 1 && given !== 8) return null;
	if (halves.length === 2 && given > 7) return null;
	const all = halves.length === 2 ? [...head, ...Array(8 - given).fill(0), ...rest, ...tail] : [...head, ...tail];
	return all.flatMap((w) => [w >> 8, w & 0xff]);
}

/**
 * An address as the client dials it, reduced to what a listener must answer: `{ family: 4, bytes }` for IPv4 and for
 * an IPv4-mapped IPv6 address (::ffff:a.b.c.d reaches the IPv4 listener), `{ family: 6, bytes }` for other IPv6, or
 * null for a string that is neither.
 */
function addressOf(address) {
	const v4 = ipv4Bytes(String(address));
	if (v4) return { family: 4, bytes: v4 };
	const v6 = ipv6Bytes(address);
	if (!v6) return null;
	if (v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff) return { family: 4, bytes: v6.slice(12) };
	return { family: 6, bytes: v6 };
}

/**
 * An address in the kernel's /proc/net/tcp{,6} spelling: each 32-bit word printed as the host reads it, which on a
 * little-endian host (x86_64, aarch64) is the word's bytes reversed. 127.0.0.1 is `0100007F`, ::1 is
 * `00000000000000000000000001000000`, ::ffff:127.0.0.1 is `0000000000000000FFFF00000100007F` (measured on Fedora 44
 * and Ubuntu 24.04, both aarch64).
 */
export function procNetHex(bytes) {
	let hex = "";
	for (let i = 0; i < bytes.length; i += 4) {
		for (const b of bytes.slice(i, i + 4).reverse()) hex += b.toString(16).toUpperCase().padStart(2, "0");
	}
	return hex;
}

/** An address shown as a client would write it with its port: `127.0.0.1:6379`, `[::1]:6379`. */
function hostPort(address, port) {
	return address.includes(":") ? `[${address}]:${port}` : `${address}:${port}`;
}

/**
 * The uids of the LISTEN sockets that answer a connection to `address`:`port`, read from /proc/net/tcp and
 * /proc/net/tcp6 (issue #464): `{ uids }`, or `{ error }` when neither file could be read. An IPv4 address is answered
 * by a socket bound to it or to 0.0.0.0, and on tcp6 by one bound to `::` or to the address IPv4-mapped; an IPv6 one by
 * a socket bound to it or to `::`. A `::` socket with IPV6_V6ONLY set does not answer IPv4, which /proc does not show;
 * it is counted only when the caller's probe of that address was answered, which is when this is asked. Measured on
 * Fedora 44 (Podman 5.8.1, pasta) and Ubuntu 24.04 (4.9.3, rootlessport): a rootless container's published port is a
 * socket of the ACCOUNT's uid, one run with `--network host` a socket of one of its SUBORDINATE uids, a rootful
 * container's or docker-proxy's a socket of root; every account can read both files, where `ss -p` names the process
 * only for the caller's own sockets.
 */
export function listenerUids(address, port, fs) {
	const at = addressOf(address);
	if (!at) return { error: `${address} is not an IP address` };
	const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
	const answers =
		at.family === 4
			? { "/proc/net/tcp": [procNetHex(at.bytes), "00000000"], "/proc/net/tcp6": ["0".repeat(32), procNetHex([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, ...at.bytes])] }
			: { "/proc/net/tcp": [], "/proc/net/tcp6": [procNetHex(at.bytes), "0".repeat(32)] };
	const uids = new Set();
	let read = 0;
	for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
		let text;
		try {
			text = String(fs.readFileSync(file, "utf8"));
		} catch {
			continue;
		}
		read += 1;
		for (const line of text.split("\n").slice(1)) {
			const f = line.trim().split(/\s+/);
			if (f.length < 8 || f[3] !== "0A") continue;
			const [addr, p] = String(f[1]).split(":");
			if (p?.toUpperCase() !== hexPort || !answers[file].includes(String(addr).toUpperCase())) continue;
			const uid = Number(f[7]);
			if (Number.isInteger(uid) && uid >= 0) uids.add(uid);
		}
	}
	return read === 0 ? { error: "neither /proc/net/tcp nor /proc/net/tcp6 could be read" } : { uids: [...uids] };
}

/**
 * The uid ranges this account's containers run as: its subordinate uids from /etc/subuid, the lines naming it by
 * `user` or by `euid` (issue #464). A container run with `--network host` publishes from a socket owned by one of these,
 * not by the account (measured: subuid 1467000998 for a valkey container of uid 1467). `[]` when the file cannot be read.
 */
export function subordinateUids(fs, { user, euid }) {
	let text;
	try {
		text = String(fs.readFileSync("/etc/subuid", "utf8"));
	} catch {
		return [];
	}
	const ranges = [];
	for (const line of text.split("\n")) {
		const [who, start, count] = line.trim().split(":");
		if (who === undefined || (who !== user && who !== String(euid))) continue;
		const lo = Number(start);
		const n = Number(count);
		if (Number.isInteger(lo) && Number.isInteger(n) && n > 0) ranges.push({ lo, hi: lo + n - 1 });
	}
	return ranges;
}

/**
 * This account's subordinate uid ranges as the system hands them out (issue #464, gate round 2): `getsubids(1)` where it
 * exists, which also answers for ranges an SSSD or LDAP provider serves (nsswitch `subid:`), else /etc/subuid. Returns
 * `{ ranges, source }`, `source` naming where they came from, for the refusal to say. `run(cmd, args)` returns stdout
 * or null (not installed, or it failed).
 */
export function readSubuidRanges({ user, euid, fs, run = defaultRunSync }) {
	if (user) {
		const out = run("getsubids", [user]);
		if (typeof out === "string") {
			const ranges = [];
			for (const line of out.split("\n")) {
				// `0: gx467c 1481000000 65536` (shadow-utils 4.14, measured on Fedora 44 and Ubuntu 24.04).
				const m = /^\s*\d+:\s+\S+\s+(\d+)\s+(\d+)\s*$/.exec(line);
				if (m && Number(m[2]) > 0) ranges.push({ lo: Number(m[1]), hi: Number(m[1]) + Number(m[2]) - 1 });
			}
			if (ranges.length > 0) return { ranges, source: "getsubids" };
		}
	}
	return { ranges: subordinateUids(fs, { user, euid }), source: "/etc/subuid" };
}

/** `cmd args` run to completion, bounded, its stdout, or null when it could not run or failed. */
function defaultRunSync(cmd, args) {
	try {
		return execFileSync(cmd, args, { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return null;
	}
}

/** The account a subordinate uid belongs to, from /etc/subuid, as `{ name, uid }`, or null (issue #464 gate round 2). */
function subuidOwnerOf(uid, fs) {
	let text;
	try {
		text = String(fs.readFileSync("/etc/subuid", "utf8"));
	} catch {
		return null;
	}
	for (const line of text.split("\n")) {
		const [who, start, count] = line.trim().split(":");
		const lo = Number(start);
		const n = Number(count);
		if (who && Number.isInteger(lo) && Number.isInteger(n) && uid >= lo && uid < lo + n) return who;
	}
	return null;
}

/**
 * Whether `address` is this host's: loopback (127.0.0.0/8, ::1), an unspecified address (0.0.0.0/8, ::, ::ffff:0.0.0.0,
 * which a connect reaches this host's loopback through), or an address on one of its interfaces.
 */
function isThisHost(address, interfaces) {
	const at = addressOf(address);
	if (!at) return false;
	if (at.family === 4 && (at.bytes[0] === 127 || at.bytes[0] === 0)) return true;
	if (at.family === 6 && at.bytes.slice(0, 15).every((b) => b === 0) && (at.bytes[15] === 1 || at.bytes[15] === 0)) return true;
	let all = {};
	try {
		all = interfaces() ?? {};
	} catch {
		// No interface list: only loopback is known to be this host.
	}
	const mine = Object.values(all).flat().map((i) => addressOf(i?.address)).filter(Boolean);
	return mine.some((m) => m.family === at.family && m.bytes.every((b, k) => b === at.bytes[k]));
}

/**
 * The address a connect to `address` actually reaches (issue #464, gate round 2): an unspecified address is this host's
 * loopback of its family (a client dialling 0.0.0.0 reaches 127.0.0.1, one dialling :: reaches ::1; measured on Fedora
 * 44: `redis://0.0.0.0:16483` reached another account's 127.0.0.1:16483), an IPv4-mapped address its IPv4 form, and
 * any other address itself. This is what is probed, judged and pinned.
 */
export function reachedAddress(address) {
	const at = addressOf(address);
	if (!at) return String(address);
	if (at.family === 4) return at.bytes[0] === 0 ? "127.0.0.1" : at.bytes.join(".");
	if (at.bytes.every((b) => b === 0)) return "::1";
	return String(address).toLowerCase().replace(/%.*$/, "");
}

/** `lookup(host)` bounded by `timeoutMs`: a resolver that does not answer is a name that did not resolve. */
function lookupWithin(lookup, host, timeoutMs) {
	let timer;
	return Promise.race([
		Promise.resolve().then(() => lookup(host, { all: true, verbatim: true })),
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(Object.assign(new Error(`no answer within ${timeoutMs} ms`), { code: "ETIMEOUT" })), timeoutMs);
		}),
	]).finally(() => clearTimeout(timer));
}

/**
 * THE owner rule for a Valkey the worker would use (issue #464), one function for the worker's own boot
 * (`resolveWorkerValkey`), `service install`, `up` and doctor, so none of them can disagree.
 *
 * VALKEY_URL's host is resolved ONCE, the way the worker's client resolves it (`lookup`, every address, in the order the
 * client tries them; bounded by `lookupTimeoutMs`). Each address is reduced to the one a connect reaches
 * (`reachedAddress`: an unspecified 0.0.0.0 or :: is this host's loopback), those that are this host's are probed in
 * that order, and each one something answers is judged by the uid of its listening socket in /proc/net/tcp{,6}: this
 * account's own when it is the euid or one of its subordinate uids (`readSubuidRanges`), someone else's otherwise.
 *
 * The CHOSEN address is the one the worker then connects to, as a literal (`pinnedValkeyUrl`), so no later DNS answer or
 * address order can send it elsewhere:
 *   - the first answering address this account holds, if any. A foreign listener on ANOTHER address of the same name
 *     (another account publishing [::1] beside this account's 127.0.0.1, measured on Fedora 44) is never dialled, and
 *     is reported in `elsewhere` rather than refused: refusing would let any account stop another's worker by
 *     publishing a port, while the pinned client cannot reach it;
 *   - else, with `shared` (PI_VALKEY_SHARED=1, read from the deployment `.env` only), the first answering address;
 *   - else nothing is chosen, and `refusal` names the owners of the answering addresses and both ways out.
 * Nothing answering chooses nothing and refuses nothing: the caller decides (install adds a Quadlet Valkey; the worker
 * waits, then retries through its service manager).
 *
 * Returns `{ error }` for a value that is not a redis URL, `{ remote: host }` when none of its addresses is this host's,
 * else `{ host, port, addresses, answered: [{ address, uids, own }], chosen, refusal, heldBy, own, elsewhere }`.
 * No uid ranges from login.defs: an LDAP or SSSD account sits above UID_MAX and Lima's default user at 501, below
 * UID_MIN, so a range cannot tell another person from a system service. Only this account's own uids are its own.
 */
export async function judgeValkeyListeners({ url, probeTcp, lookup, fs, euid, user = null, shared = false, rootOk = false, ownerName = () => null, interfaces = () => ({}), envPath = ".env", subuids = null, lookupTimeoutMs = 3000 }) {
	const target = valkeyTarget(url);
	if (target.error) return { error: target.error };
	const { host, port } = target;
	let addresses;
	if (addressOf(host)) addresses = [host];
	else {
		try {
			const found = await lookupWithin(lookup, host, lookupTimeoutMs);
			addresses = (Array.isArray(found) ? found : [found]).map((a) => a?.address).filter((a) => typeof a === "string");
		} catch (err) {
			// Gate round 3: a lookup that failed or timed out is NOT another host. It used to be read as one, and the client
			// then dialled the name unjudged, landing wherever the resolver answered next (measured: EAI_AGAIN, and a
			// resolver silent past the 3 s bound). Nothing can be judged, so the caller retries.
			return { unresolved: host, why: err?.code ?? err?.message ?? "no answer" };
		}
		if (addresses.length === 0) return { unresolved: host, why: "no address" };
	}
	const local = [...new Set(addresses.filter((a) => isThisHost(a, interfaces)).map(reachedAddress))];
	if (local.length === 0) return { remote: host };
	const { ranges, source } = subuids ?? { ranges: subordinateUids(fs, { user, euid }), source: "/etc/subuid" };
	const isOwn = (uid) => uid === euid || ranges.some((r) => uid >= r.lo && uid <= r.hi);
	const named = (uid) => {
		if (uid === 0) return "root (uid 0: docker-proxy, or a rootful container any account with sudo can start)";
		const name = ownerName(uid);
		if (name) return `${name} (uid ${uid})`;
		const parent = subuidOwnerOf(uid, fs);
		return parent ? `a container of ${parent} (its subordinate uid ${uid})` : `uid ${uid}`;
	};
	const answered = [];
	for (const address of local) {
		if (!(await probeTcp(address, port))) continue;
		const held = listenerUids(address, port, fs);
		const uids = held.uids ?? [];
		const why = held.error ?? (uids.length === 0 ? "no listening socket for it is in /proc/net/tcp or /proc/net/tcp6" : null);
		const own = why === null && uids.every(isOwn);
		// Gate round 3: three classes, not two. ROOT covers uid 0 (docker-proxy, a rootful container) and a listener no
		// socket row explains (a kernel NAT rule, which only root can set up); FOREIGN is any other uid.
		const cls = own ? "own" : why !== null || uids.filter((u) => !isOwn(u)).every((u) => u === 0) ? "root" : "foreign";
		answered.push({ address, uids, own, why, cls });
	}
	const base = { host, port, addresses: local, answered };
	const mineFirst = answered.find((a) => a.own) ?? null;
	const others = answered.filter((a) => !a.own);
	const ownersOf = (a) => (a.why ? "an owner /proc does not name" : [...new Set(a.uids.filter((u) => !isOwn(u)))].map(named).join(" and "));
	const describe = (list) => list.map((a) => `${hostPort(a.address, port)} (${a.why ? `held by an owner /proc does not name: ${a.why}` : `held by ${ownersOf(a)}`})`).join(", ");
	if (answered.length === 0) return { ...base, chosen: null, refusal: null, heldBy: null, own: true, elsewhere: [] };
	if (mineFirst) {
		const heldBy = mineFirst.uids.every((u) => u === euid) ? "this account" : `this account's containers (a subordinate uid of it, from ${source})`;
		return { ...base, chosen: mineFirst.address, refusal: null, heldBy, own: true, elsewhere: others.length > 0 ? [describe(others)] : [] };
	}
	if (shared) {
		const first = answered[0];
		return { ...base, chosen: first.address, refusal: null, heldBy: `${ownersOf(first)}, shared on purpose as ${VALKEY_SHARED_KEY}=1 in ${envPath} says`, own: false, elsewhere: [] };
	}
	// Root's listener where root is acceptable (every client but the podman venue's: docker's Valkey is published by
	// root's docker-proxy there). Another account's listener is never acceptable without the opt-in.
	const rootFirst = rootOk ? (answered.find((a) => a.cls === "root") ?? null) : null;
	if (rootFirst) {
		const foreign = answered.filter((a) => a.cls === "foreign");
		return { ...base, chosen: rootFirst.address, refusal: null, heldBy: rootFirst.why ? "an owner /proc does not name (root's NAT, as docker without its proxy)" : "root", own: false, elsewhere: foreign.length > 0 ? [describe(foreign)] : [] };
	}
	const ways = `Give this account a Valkey of its own on another port, VALKEY_URL=redis://127.0.0.1:<port> in ${envPath} (\`service install\` and \`up\` then publish the Quadlet Valkey there); or, if that Valkey is shared on purpose, say so with ${VALKEY_SHARED_KEY}=1 in ${envPath}`;
	const own = `this account (uid ${euid}) or its containers (subordinate uids read from ${source})`;
	const unknown = others.filter((a) => a.why);
	if (unknown.length === others.length) {
		const what = unknown.map((a) => hostPort(a.address, port)).join(" and ");
		return { ...base, chosen: null, heldBy: null, own: false, elsewhere: [], refusal: { short: `something answers ${what}, and which account holds it could not be told`, text: `something answers ${what}, and which account holds it could not be told (${unknown[0].why}), so it is not taken to be this account's Valkey. ${ways}`, fix: ways } };
	}
	// Only the addresses a refused uid holds are named, each with its own owner (gate round 2: an own 127.0.0.1 used to be
	// listed beside another account's ::1 as if both were that account's).
	const refusedAt = others.filter((a) => !a.why && (a.cls === "foreign" || !rootOk));
	const where = refusedAt.map((a) => hostPort(a.address, port)).join(" and ");
	const who = [...new Set(refusedAt.flatMap((a) => a.uids.filter((u) => !isOwn(u))))].map(named).join(" and ");
	// Gate round 3 nit: "are held by" when the refusal names more than one address.
	const held = refusedAt.length > 1 ? "are held by" : "is held by";
	return {
		...base,
		chosen: null,
		heldBy: null,
		own: false,
		elsewhere: [],
		refusal: {
			short: `${where} ${held} ${who}, not by ${own}`,
			text: `${where} ${held} ${who}, not by ${own}: taking it as this deployment's Valkey would put this account's jobs in a queue another account can read and drain. ${ways}`,
			fix: ways,
		},
	};
}

/**
 * VALKEY_URL with its host replaced by the judged literal `address` (issue #464, gate round 2), so every client the
 * worker makes connects exactly there. `servername` is the original host name for TLS (`rediss:`), so a certificate
 * for that name still verifies against a connection made to its address; null for a literal or plain `redis:`.
 */
export function pinnedValkeyUrl(url, address) {
	const u = new URL(url);
	const original = u.hostname.replace(/^\[(.*)\]$/, "$1");
	u.hostname = address.includes(":") ? `[${address}]` : address;
	const servername = valkeySchemeOf(u.protocol) === "rediss:" && !addressOf(original) ? original : null;
	return { url: u.toString(), servername };
}

/**
 * Whether the podman venue's stack adds its Valkey, and on which port (issue #464, and #430 before it). Returns
 * `{ include, port, notes, refusal, error? }`. The rule, on `judgeValkeyListeners`' verdict:
 *   - `local` blessed: never (docker's Valkey is the queue, as before).
 *   - VALKEY_URL on another host: never, and said.
 *   - a refusal (no answering address is this account's, and no PI_VALKEY_SHARED=1): refused, whether or not our Quadlet
 *     Valkey is installed. Not forceable: the way out is a port of this account's own, or the named opt-in.
 *   - our Quadlet Valkey already installed: kept (and republished on VALKEY_URL's port) while what the worker will use
 *     is this account's; a shared Valkey taken with the opt-in is the queue instead.
 *   - nothing answers: added, published on 127.0.0.1 at that port, when VALKEY_URL reaches 127.0.0.1 (an `[::1]` or
 *     interface-address URL would not reach it, which is an error naming the fix).
 *   - this account's listener (or a shared one, opted in): taken to be the queue, as `up` always did, and named, with
 *     any other account's listener on another address of the name said too (the worker never dials it).
 */
export async function decideValkey({ venues, url, installed, probeTcp, lookup, euid, user = null, shared = false, fs, ownerName = () => null, interfaces = () => ({}), envPath = ".env", subuids = null }) {
	const notes = [];
	if (venues.localUsed) return { include: false, port: DEFAULT_VALKEY_PORT, notes, refusal: null };
	const verdict = await judgeValkeyListeners({ url, probeTcp, lookup, fs, euid, user, shared, ownerName, interfaces, envPath, subuids });
	if (verdict.error) return { include: false, port: DEFAULT_VALKEY_PORT, notes, refusal: null, error: `${envPath}: ${verdict.error}` };
	if (verdict.unresolved) return { include: false, port: DEFAULT_VALKEY_PORT, notes, refusal: null, error: `VALKEY_URL's host ${verdict.unresolved} did not resolve here (${verdict.why}), so whose Valkey it reaches cannot be judged. Retry when it resolves, or write the address` };
	if (verdict.remote) {
		notes.push(`VALKEY_URL names ${verdict.remote}, not this host, so no Valkey is added here`);
		return { include: false, port: DEFAULT_VALKEY_PORT, notes, refusal: null, remote: true };
	}
	const { port } = verdict;
	if (verdict.refusal) return { include: false, port, notes, refusal: verdict.refusal };
	for (const other of verdict.elsewhere) notes.push(`another account also listens on an address VALKEY_URL's host resolves to: ${other}. The worker connects only to the address judged this account's, so it never reaches that one`);
	if (verdict.chosen === null || (installed && verdict.own)) {
		if (!verdict.addresses.includes("127.0.0.1")) {
			// Said as what it is (gate round 2): a literal is itself, or the loopback an unspecified one reaches, and only a name
			// "resolves" to something.
			const literal = addressOf(verdict.host) !== null;
			const is = !literal ? `resolves to ${verdict.addresses.join(", ")} here` : verdict.addresses[0] === verdict.host ? `is ${verdict.host}` : `is ${verdict.host}, which reaches ${verdict.addresses[0]}`;
			return { include: false, port, notes, refusal: null, error: `${envPath}: VALKEY_URL's host ${is}, not 127.0.0.1, and the Quadlet Valkey is published on 127.0.0.1 only, so the worker would not reach it. Write VALKEY_URL=redis://127.0.0.1:${port}` };
		}
		return { include: true, port, notes, refusal: null };
	}
	notes.push(`something already listens on ${hostPort(verdict.chosen, port)}, held by ${verdict.heldBy}, so no Valkey is added for it: that listener is taken to be your Valkey, as \`up\` does`);
	return { include: false, port, notes, refusal: null, chosen: verdict.chosen };
}

/**
 * The worker's own Valkey endpoint, judged at boot by `judgeValkeyListeners` (issue #464, gate round 2): the owner rule
 * where the connection is made, so a VALKEY_URL edited after `service install` refused it, a 0.0.0.0 URL, or another
 * account publishing on ::1 after the install cannot hand this account's jobs to someone else's queue.
 *
 * Only on the podman venue without `local`, on Linux (where /proc names the owner), as install, `up` and doctor judge
 * it: docker's Valkey is the queue wherever `local` is blessed, published by root's docker-proxy. PI_VALKEY_SHARED is
 * read from the deployment `.env` (`envText`) only; one in the worker's environment but not the file is ignored, and
 * said. Returns `{ url, servername, pinned, notes }` (the URL unchanged, pinned null, when nothing is judged), or throws:
 * a `configError` (exit 2, never restarted into the same answer) for a refusal, a plain Error (exit 1, restarted) when
 * nothing answers within `waitMs`, since then no owner can be judged and the Valkey may still be starting.
 */
export async function resolveWorkerValkey({ url, venues, platform, env, envText, envPath, probeTcp, lookup, fs, euid, user, ownerName, interfaces, subuids, waitMs = 20_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), configError: refuse }) {
	// Gate round 3: judged on EVERY venue on Linux, not only podman's. Another account's listener is refused everywhere
	// (item 7: a local-venue worker silently adopted another account's rootless Valkey); root's (docker-proxy) is refused
	// only where the podman venue is this deployment's and `local` is not.
	const rootRefused = venues.podmanUsed && !venues.localUsed;
	const same = { url, servername: null, pinned: null, notes: [], rootRefused };
	if (platform !== "linux") return same;
	const notes = [];
	let fileKeys = {};
	if (envText !== null && envText !== undefined) {
		// The file's BYTES through the hardened reader (gate round 3): a line systemd reads differently, or refuses to
		// load, is named and refused, never taken as "no opt-in" silently.
		const read = readValkeyKeys(envText, { loader: "systemd", path: envPath });
		if (read.error) throw refuse(`${read.error}. The worker reads PI_VALKEY_SHARED and VALKEY_URL from it, so it does not start`);
		fileKeys = read.keys;
	}
	if (typeof env[VALKEY_SHARED_KEY] === "string" && !Object.hasOwn(fileKeys, VALKEY_SHARED_KEY)) notes.push(`${VALKEY_SHARED_KEY} is set in the worker's environment and not in ${envPath}: ignored, since only the deployment's .env may say a Valkey is shared on purpose`);
	const shared = valkeySharedOn(fileKeys[VALKEY_SHARED_KEY]);
	const deadline = now() + waitMs;
	for (;;) {
		const verdict = await judgeValkeyListeners({ url, probeTcp, lookup, fs, euid, user, shared, rootOk: !rootRefused, ownerName, interfaces, envPath, subuids });
		if (verdict.error) throw refuse(`VALKEY_URL: ${verdict.error}`);
		if (verdict.remote) return { ...same, notes };
		if (verdict.refusal) throw refuse(`the Valkey VALKEY_URL reaches is refused: ${verdict.refusal.text}`);
		if (verdict.chosen) {
			for (const other of verdict.elsewhere) notes.push(`another account also listens on an address VALKEY_URL's host resolves to: ${other}; this worker connects only to ${hostPort(verdict.chosen, verdict.port)}`);
			const pinned = pinnedValkeyUrl(url, verdict.chosen);
			return { url: pinned.url, servername: pinned.servername, pinned: { address: verdict.chosen, port: verdict.port, heldBy: verdict.heldBy }, notes, rootRefused };
		}
		if (now() >= deadline) {
			if (verdict.unresolved) throw new Error(`VALKEY_URL's host ${verdict.unresolved} did not resolve here (${verdict.why}), so whose Valkey it reaches cannot be judged; the service manager retries`);
			throw new Error(`nothing answers VALKEY_URL (${verdict.addresses.map((a) => hostPort(a, verdict.port)).join(", ")}), so whose Valkey it is cannot be judged; the service manager retries`);
		}
		await sleep(500);
	}
}

/** An account's name from /etc/passwd through `fs`, or null (the owner a Valkey refusal names). */
export function passwdNameFrom(fs, uid) {
	try {
		for (const line of String(fs.readFileSync("/etc/passwd", "utf8")).split("\n")) {
			const f = line.split(":");
			if (f.length >= 3 && f[2] === String(uid) && f[0] !== "") return f[0];
		}
	} catch {
		// Unreadable: the uid alone is named.
	}
	return null;
}

/** A TCP connect to `host`:`port` that settles true when something answers within `timeoutMs`, else false. */
export function probeTcpAddress(host, port, timeoutMs = 1500) {
	return new Promise((resolvePromise) => {
		const socket = netConnect({ host, port });
		const done = (result) => {
			socket.destroy();
			resolvePromise(result);
		};
		socket.setTimeout(timeoutMs, () => done(false));
		socket.on("connect", () => done(true));
		socket.on("error", () => done(false));
	});
}

/**
 * What the stack for this deployment should hold, and why each part is or is not in it. Pure: every fact is a
 * parameter, so `service` and `up` can each answer "is it listening" and "is it already installed" their own way
 * and get the same rule.
 *
 *   valkey   only where `local` is NOT blessed. With `local` in the list, docker is on this host and its Valkey
 *            (compose, or up's docker step) is the queue, as it always was; a second Valkey on the same port would
 *            only fail to bind. Then `includeValkey` (the caller's own "listening / already installed" answer).
 *   proxy    only while the egress policy is armed, and only under the default name. A PI_EGRESS_PROXY naming
 *            another container is the operator's own proxy: a Quadlet of that name would `podman run --replace`
 *            it away, so it is left alone and the reason is said.
 *   keeper   whenever the egress policy is armed (issue #458), WHATEVER the proxy's name: the worker disconnects the
 *            proxy from every egress job's network, an operator's own proxy as much as ours, and that disconnect is
 *            what Podman 4.9 turns into a dead route out. On every Podman version, since on 5.x it is one idle
 *            container (measured harmless on 5.8.1), and a rule with no version read in it cannot misread one.
 */
export function stackComponents({ venues, env, includeValkey, armed, valkeyPort = DEFAULT_VALKEY_PORT, valkeyPassword = null }) {
	const notes = [];
	const valkey = !venues.localUsed && includeValkey;
	const keeper = armed === true;
	let proxy = false;
	if (armed) {
		const name = egressProxyName(env);
		if (name === DEFAULT_EGRESS_PROXY) proxy = true;
		else notes.push(`PI_EGRESS_PROXY names ${name}, your own proxy: the shipped ${DEFAULT_EGRESS_PROXY} unit is not installed for it, because its \`--replace\` would remove any container of that name. Keep ${name} running under this account's Podman yourself`);
	}
	// Issue #468: the password the Quadlet Valkey starts with (null for none, which starts it without one, as before).
	return { valkey, proxy, keeper, notes, valkeyPort, valkeyPassword: valkey ? valkeyPassword : null };
}

/**
 * The files and commands for `components`, rendered from the shipped templates (`readTemplate(name)`, separate from
 * `fs` because the templates are the PACKAGE's files while `fs` is the host's, and a caller's fake of the one is not a
 * fake of the other). Returns `{ error }` for a path the
 * proxy's mounts cannot carry, else `{ dir, files: [{ path, text, unit, state }], start: [units], actions }`, where
 * `state` is "new", "same" or "changed" against what is on disk, and `actions` is exactly what `applyStack` does,
 * in order: the caller shows these lines, and a test holds the two equal.
 */
export function planStack({ components, templatesDir, deployDir, home, fs, readTemplate = (name) => fs.readFileSync(join(templatesDir, name), "utf8"), restartUnits = [], restartAfterValkey = [] }) {
	const dir = quadletDir(home);
	const picked = [];
	if (components.valkey) picked.push(QUADLET_FILES.valkeyNetwork, QUADLET_FILES.valkey);
	if (components.proxy) picked.push(QUADLET_FILES.egressNetwork, QUADLET_FILES.proxy);
	if (components.keeper) picked.push(QUADLET_FILES.keeperNetwork, QUADLET_FILES.keeper);
	const conf = proxyConfCopyPath(home);
	const allowlist = join(deployDir, "egress-allowlist.conf");
	if (components.proxy) {
		for (const p of [conf, allowlist]) {
			if (UNSAFE_VOLUME_PATH.test(p)) {
				return { error: `the egress proxy's Quadlet unit would mount ${JSON.stringify(p)}, and a Quadlet Volume= cannot carry a colon, whitespace, %, $, a quote, a backslash or a control byte in a path (each is split or expanded on the way to podman run). Move the deployment folder, or start the proxy by hand (docs/podman.md)` };
			}
		}
	}
	const files = picked.map(({ file, unit }) => {
		let text = String(readTemplate(file));
		if (file === QUADLET_FILES.proxy.file) {
			// Function replacements: a computed path is the REPLACEMENT, and String.replace reads `$&` out of a string one.
			text = text.replace(`Volume=${PROXY_CONF_PLACEHOLDER}:`, () => `Volume=${conf}:`).replace(`Volume=${ALLOWLIST_PLACEHOLDER}:`, () => `Volume=${allowlist}:`);
		}
		if (file === QUADLET_FILES.valkey.file && Number.isInteger(components.valkeyPort) && components.valkeyPort !== DEFAULT_VALKEY_PORT) {
			// Issue #464: VALKEY_URL's loopback port, where this account's own Valkey is published (the container still
			// listens on 6379 inside). The template's line is pinned (TEMPLATE_PINS), so this replacement always lands.
			text = text.replace(`PublishPort=127.0.0.1:${DEFAULT_VALKEY_PORT}:6379`, () => `PublishPort=127.0.0.1:${components.valkeyPort}:6379`);
		}
		const path = join(dir, file);
		let state = "new";
		if (fs.existsSync(path)) {
			let current = null;
			try {
				current = String(fs.readFileSync(path, "utf8"));
			} catch {
				// Unreadable reads as changed: the write below is then what tells the operator.
			}
			state = current === text ? "same" : "changed";
		}
		// `restarts`: the unit a CHANGE to this file must restart. A .container file restarts its own unit; a .network file
		// restarts nothing, because its unit runs `podman network create --ignore`, which cannot change an existing
		// network, so restarting the container over it would cost the proxy's per-job networks and apply nothing.
		return { path, text, unit, state, restarts: file.endsWith(".container") ? unit : null };
	});
	if (components.proxy) {
		// The account-owned copy of the rules (E1), placed before the proxy's unit so it exists when the unit starts.
		// squid reads it only at start, so a changed copy restarts the proxy, as a changed unit file does.
		const text = String(readTemplate("egress-proxy.conf"));
		let state = "new";
		if (fs.existsSync(conf)) {
			let current = null;
			try {
				current = String(fs.readFileSync(conf, "utf8"));
			} catch {
				// Unreadable reads as changed, as for the unit files.
			}
			state = current === text ? "same" : "changed";
		}
		files.splice(files.findIndex((f) => f.unit === QUADLET_FILES.proxy.unit), 0, { path: conf, text, unit: null, state, restarts: QUADLET_FILES.proxy.unit, kind: "conf" });
	}
	if (components.valkey) {
		// Issue #468: the Valkey's password file, placed before its unit so it exists when the unit starts (its
		// EnvironmentFile= is not optional). Valkey reads the password only at start, so a changed file restarts it, as a
		// changed unit file does; the volume, and the queue in it, is kept across that restart. A file readable by anyone
		// else counts as changed, so the write puts its mode back to 0600.
		const path = valkeyEnvPath(home);
		const text = valkeyEnvFileText(components.valkeyPassword);
		let state = "new";
		if (fs.existsSync(path)) {
			let current = null;
			let wide = false;
			try {
				current = String(fs.readFileSync(path, "utf8"));
				wide = typeof fs.statSync === "function" && (fs.statSync(path).mode & 0o077) !== 0;
			} catch {
				// Unreadable reads as changed, as for the unit files.
			}
			state = current === text && !wide ? "same" : "changed";
		}
		files.splice(files.findIndex((f) => f.unit === QUADLET_FILES.valkey.unit), 0, { path, text, unit: null, state, restarts: QUADLET_FILES.valkey.unit, kind: "secret", mode: VALKEY_ENV_MODE });
	}
	const containers = files.filter((f) => f.path.endsWith(".container"));
	const start = containers.map((f) => f.unit);
	// A unit whose file changed is RESTARTED, not started: `start` on an active unit is a no-op, so a replaced file
	// would otherwise change nothing until the next reboot while the command said it was done.
	// `restartUnits`: units the caller knows are up but wrong with their files unchanged (PR #463 round 2: `up` meeting a
	// Quadlet keeper that does not hold, a paused one say), where `start` would be the same no-op.
	const restart = start.filter((u) => restartUnits.includes(u) || files.some((f) => f.state === "changed" && f.restarts === u));
	// A keeper (re)started under a proxy that stays up is what the worker and doctor read as possible damage (issue #458,
	// PR #463 round 2): a teardown while it was down cuts the proxy's route out for good, nothing outside shows it, so
	// both ask for a proxy restart whenever the keeper started more than the grace (15 s) after the proxy. So a plan that
	// restarts the keeper, or starts it beside a proxy whose unit file it leaves as it was (an upgrade: that proxy has
	// been up all along), restarts the proxy with it. Both files new is a first install: both start together.
	const keeperFile = files.find((f) => f.unit === QUADLET_FILES.keeper.unit);
	const proxyFile = files.find((f) => f.unit === QUADLET_FILES.proxy.unit);
	const keeperMoves = keeperFile && (restart.includes(keeperFile.unit) || keeperFile.state === "new");
	if (keeperMoves && proxyFile && proxyFile.state === "same" && !restart.includes(proxyFile.unit)) restart.push(proxyFile.unit);
	const fresh = start.filter((u) => !restart.includes(u));
	const actions = [];
	for (const f of files) if (f.state !== "same") actions.push({ kind: "write", path: f.path });
	if (files.length > 0) {
		// daemon-reload even when every file is unchanged: a file written by an earlier run that failed before its own
		// reload is otherwise invisible to the manager, and the reload is idempotent.
		actions.push({ kind: "run", argv: ["systemctl", "--user", "daemon-reload"] });
		if (fresh.length > 0) actions.push({ kind: "run", argv: ["systemctl", "--user", "start", ...fresh] });
		if (restart.length > 0) actions.push({ kind: "run", argv: ["systemctl", "--user", "restart", ...restart] });
	}
	// Issue #468: a Valkey whose password this plan changes (a first password for a deployment that had none, most often)
	// is one every running client of it can no longer talk to, since the worker and the receiver read VALKEY_PASSWORD at
	// start. `restartAfterValkey` names those the caller found running; they are restarted after it (`try-restart`: one
	// that stopped meanwhile stays stopped). A worker restart lets its in-flight job finish first (its SIGTERM drain).
	const secret = files.find((f) => f.kind === "secret");
	const clients = secret && secret.state !== "same" ? restartAfterValkey : [];
	if (clients.length > 0) actions.push({ kind: "run", argv: ["systemctl", "--user", "try-restart", ...clients] });
	return { dir, files, start, restart, actions, clientsRestarted: clients };
}

/**
 * What a plan that sets Valkey's password costs, said wherever one does (issue #468): the Valkey restart, and the running
 * clients restarted after it. Null when the plan leaves the password file as it is.
 */
export function valkeyPasswordRestartWarning(plan) {
	const secret = plan.files?.find((f) => f.kind === "secret");
	if (!secret || secret.state === "same") return null;
	const valkeyMoves = (plan.restart ?? []).includes(QUADLET_FILES.valkey.unit);
	if (!valkeyMoves) return null;
	const clients = plan.clientsRestarted ?? [];
	return `${QUADLET_FILES.valkey.unit} restarts with the password in ${secret.path} (the queue in its volume is kept)${clients.length > 0 ? `, and ${clients.join(" and ")} ${clients.length === 1 ? "restarts" : "restart"} after it to send that password` : ""}. A job running right now is interrupted: pause first if one is (pi-dispatch pause, wait for active jobs, then pi-dispatch resume)`;
}

/** The measured cost of restarting the proxy, said wherever a plan restarts it. */
export function proxyRestartWarning(plan) {
	if (!plan.restart?.includes(QUADLET_FILES.proxy.unit)) return null;
	return `restarting ${QUADLET_FILES.proxy.unit} makes a NEW proxy container (measured: the unit runs podman run --replace --rm), so a job running right now loses its only route out for the rest of that run. Pause first if one is (pi-dispatch pause, wait for active jobs, then pi-dispatch resume)`;
}

/**
 * Containers this plan would REPLACE without owning them (issue #430 review). A Quadlet container unit runs
 * `podman run --replace`, which removes any container of the same name, running or not: a proxy started by hand from
 * docs/podman.md, with every job's per-job network on it, would vanish without a word. One rule for both commands and
 * both containers: a container of the unit's name that does not carry the `PODMAN_SYSTEMD_UNIT` label naming OUR unit
 * is someone else's, and the caller refuses unless told to replace it. Podman labels a container with the unit
 * that started it from the `PODMAN_SYSTEMD_UNIT` variable the generated unit sets (the auto-update mechanism reads
 * the same label).
 *
 * `runQuery(cmd, args)` resolves `{ code, stdout, stderr }`, the two streams SEPARATE (round 2, E2): podman prints
 * warnings on stderr on an ordinary account ("cgroupv2 manager is set to systemd but there is no systemd user session
 * available", "/ is not a shared mount"), and a merged capture made our own containers read as foreign. Only stdout
 * is the label.
 *
 * FAILS CLOSED (round 2, E3). podman exits 125 for a container that does not exist AND for a store it cannot open
 * ("database is locked"), so a non-zero exit is "absent" only when stderr says no such container or object; any other
 * failure means the state is not known, and a caller must not run a `--replace` into it.
 *
 * Returns `{ found: [{ container, unit, label }], unknown: [{ container, detail }] }`.
 */
export async function foreignContainers(plan, runQuery) {
	const found = [];
	const unknown = [];
	for (const q of [QUADLET_FILES.valkey, QUADLET_FILES.proxy, QUADLET_FILES.keeper]) {
		if (!plan.start.includes(q.unit)) continue;
		const res = await runQuery("podman", ["container", "inspect", "--format", '{{index .Config.Labels "PODMAN_SYSTEMD_UNIT"}}', q.container]);
		if (res.code === 0) {
			const label = String(res.stdout ?? "").trim();
			if (label !== q.unit) found.push({ container: q.container, unit: q.unit, label });
			continue;
		}
		if (res.code !== null && /no such (container|object)/i.test(String(res.stderr ?? ""))) continue;
		unknown.push({ container: q.container, detail: res.code === null ? "podman could not be run" : `podman container inspect exited ${res.code} without saying the container does not exist` });
	}
	return { found, unknown };
}

/** The refusal for containers whose state could not be read. Not forceable: `--replace` into an unknown is a guess. */
export function unknownContainerRefusal(unknown) {
	return `whether ${unknown.map((u) => u.container).join(" and ")} already ${unknown.length === 1 ? "exists" : "exist"} could not be read (${unknown.map((u) => u.detail).join("; ")}). The unit's podman run --replace would remove whatever is there, so nothing is installed until podman answers: check \`podman ps -a\` as this account, then re-run`;
}

/**
 * The refusal when this process cannot reach its own user manager (round 2, E8, measured). `sudo -iu <account>` is the
 * natural way to act as a dedicated account and gives neither XDG_RUNTIME_DIR nor a session bus, so every
 * `systemctl --user` fails with "Failed to connect to user scope bus"; checked BEFORE anything is written, so a
 * refused run leaves no Quadlet file behind that nothing loaded. `null` when either is set.
 */
export function userBusRefusal({ env, user, euid }) {
	// env-internal XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: how systemctl --user finds the user manager; set by a login.
	if (env?.XDG_RUNTIME_DIR || env?.DBUS_SESSION_BUS_ADDRESS) return null;
	const uid = Number.isInteger(euid) ? euid : "<uid>";
	return `this shell has no user manager to talk to (neither XDG_RUNTIME_DIR nor DBUS_SESSION_BUS_ADDRESS is set, as under \`sudo -iu ${user}\`), so \`systemctl --user\` would fail after the files were written. Run it from a real login as ${user}, or \`machinectl shell ${user}@\`, or, while ${user}'s manager is running (linger on), \`sudo -iu ${user} env XDG_RUNTIME_DIR=/run/user/${uid} pi-dispatch ...\``;
}

/**
 * The user MANAGER's own environment, read before anything is written (PR #463 round 3, measured). Every Quadlet unit
 * this installer starts, and the worker unit, runs with the manager's environment, and the Quadlet generator reads its
 * unit files from the manager's XDG_CONFIG_HOME. On a host whose /etc/environment names another account's
 * XDG_RUNTIME_DIR or XDG_CONFIG_HOME (Ubuntu's user managers read /etc/environment through environment.d; a GitHub
 * runner image writes both), measured on Podman 4.9.3: the generator looked in the other home and the units were "not
 * found" (exit 5), and with that fixed, every podman command in a unit failed "XDG_RUNTIME_DIR directory
 * \"/run/user/1001\" is not owned by the current user". This installer writes to ~/.config/containers/systemd (see
 * `quadletDir`), so either value being another account's makes a stack that cannot start. `read` is
 * `systemctl --user show-environment`'s `{ code, stdout }`; `null` when both are this account's own or unset.
 * A manager that did not answer is left to the commands that follow, whose failures are said already.
 */
/**
 * One value as `systemctl --user show-environment` prints it (PR #463 round 3): plain when it needs no quoting, else
 * shell-quoted as `$'...'` with C escapes (systemd's shell_maybe_quote with ESCAPE_POSIX), so a home with a space reads
 * `XDG_CONFIG_HOME=$'/home/a b/.config'`. Anything else is taken as printed.
 */
export function unquoteShowEnvironment(value) {
	const m = /^\$'(.*)'$/s.exec(value);
	if (!m) return value;
	return m[1].replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_all, e) => {
		const simple = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };
		if (e[0] === "x") return String.fromCharCode(parseInt(e.slice(1), 16));
		if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
		return Object.hasOwn(simple, e) ? simple[e] : e;
	});
}

export function managerEnvRefusal(read, { home, euid, user, realpath = (p) => p }) {
	if (read?.code !== 0) return null;
	const env = {};
	for (const line of String(read.stdout ?? "").split("\n")) {
		const eq = line.indexOf("=");
		if (eq > 0) env[line.slice(0, eq)] = unquoteShowEnvironment(line.slice(eq + 1));
	}
	// A symlinked home (PR #463 round 3): the same directory under two spellings is the same directory.
	const same = (a, b) => {
		const tidy = (p) => p.replace(/\/+$/, "");
		if (tidy(a) === tidy(b)) return true;
		try {
			return tidy(realpath(tidy(a))) === tidy(realpath(tidy(b)));
		} catch {
			return false;
		}
	};
	const wrong = [];
	// env-internal XDG_RUNTIME_DIR, XDG_CONFIG_HOME: read from the user MANAGER's show-environment, never this process's.
	const ownRuntime = Number.isInteger(euid) ? `/run/user/${euid}` : null;
	if (env.XDG_RUNTIME_DIR !== undefined && ownRuntime !== null && !same(env.XDG_RUNTIME_DIR, ownRuntime)) wrong.push(`XDG_RUNTIME_DIR=${env.XDG_RUNTIME_DIR}, not ${ownRuntime}: every podman command in a unit would fail ("XDG_RUNTIME_DIR directory ... is not owned by the current user", measured)`);
	const ownConfig = typeof home === "string" && home ? join(home, ".config") : null;
	if (env.XDG_CONFIG_HOME !== undefined && ownConfig !== null && !same(env.XDG_CONFIG_HOME, ownConfig)) wrong.push(`XDG_CONFIG_HOME=${env.XDG_CONFIG_HOME}, not ${ownConfig}: the Quadlet generator would look for the units there, not in ${quadletDir(home)} where they are written, and say they do not exist (measured)`);
	if (wrong.length === 0) return null;
	return `${user}'s user manager runs with ${wrong.join("; and ")}. That environment is what every unit it starts inherits, so nothing is installed. Find where it is set (a line in /etc/environment, which Ubuntu's user managers read through environment.d, or a file in ~/.config/environment.d), override it for this account in ~/.config/environment.d/ (for example a file zz-pi-dispatch.conf with ${ownRuntime ? `XDG_RUNTIME_DIR=${ownRuntime}` : "XDG_RUNTIME_DIR=/run/user/<uid>"}${ownConfig ? ` and XDG_CONFIG_HOME=${ownConfig}` : ""}), restart the manager (sudo systemctl restart user@${Number.isInteger(euid) ? euid : "<uid>"}.service, which stops this account's units), check \`systemctl --user show-environment\`, and re-run`;
}

/** The refusal for `foreignContainers`' answer, naming both ways out. */
export function foreignContainerRefusal(found, { forceHint }) {
	const names = found.map((f) => f.container).join(" and ");
	return `${names} already ${found.length === 1 ? "exists" : "exist"} under this account's Podman and ${found.length === 1 ? "is" : "are"} not managed by the Quadlet ${found.length === 1 ? "unit" : "units"} (started by hand, or by an older setup). The unit's podman run --replace would remove ${found.length === 1 ? "it" : "them"} without asking, and a proxy takes every running job's per-job network with it. Remove ${found.length === 1 ? "it" : "them"} yourself (podman rm -f ${found.map((f) => f.container).join(" ")}), or ${forceHint}`;
}

/**
 * The three stack keys as a deployment's `.env` assigns them, for the loader that reads that file (issue #430 review,
 * D6). `{ keys }` (only keys the file assigns), or `{ error }` when a line touching one of them is in a form this
 * reader cannot vouch for. A key with NO record is not proof of no assignment: `PI_BACKENDS =podman` is set by
 * systemd 252 (measured, see env-file.mjs's ASSIGNMENT) and produces no record here, `export PI_BACKENDS=podman` is
 * ignored by systemd and set by the shells, and a line inside a multi-line quote belongs to the value above it. Any
 * such line, or any file-level hazard while a key is mentioned at all, refuses: guessing "no podman" installs a
 * docker-shaped worker for a podman deployment, and the opposite guess a stack for a docker one. So does a line systemd
 * splits differently from this reader (`envFileSystemdHazard`, issue #447), for the whole file.
 */
export const STACK_KEYS = Object.freeze(["PI_BACKENDS", "PI_EGRESS", "PI_EGRESS_PROXY"]);

/** The longest venue-key value `readStackKeys` accepts, in bytes (issue #447 gate round 2; systemd's own limit is ~128 KiB). */
export const STACK_VALUE_MAX = 4096;

/** A sourcing shell's named hazard (a NUL, a CRLF file), as the sentence that names it and its fix. systemd's shapes are refused above. */
function shapedRefusal(path, hazard, why) {
	const shape = SYSTEMD_HAZARD_SHAPES[hazard.shape];
	return `${path} line ${hazard.line} has ${shape.what}, and ${why}, so what the service reads for it is unknown: ${shape.fix}`;
}

export function readStackKeys(content, { loader = "systemd", path = ".env", assumeSpelled = false } = {}) {
	// The file's BYTES where the caller has them (issue #447, gate round 1): systemd refuses to LOAD a file with a NUL
	// or with invalid UTF-8 in a key or value, and the unit then fails with every key unset, which no reading of the
	// decoded text can see. Refused whatever the file assigns, because the service does not start on it at all.
	const { text, loadHazard } = decodeEnvFile(content, { loader });
	if (loadHazard !== null) {
		const shape = SYSTEMD_HAZARD_SHAPES[loadHazard.shape];
		return { error: `${path} line ${loadHazard.line} has ${shape.what}${loadHazard.detail ? ` (${loadHazard.detail})` : ""}: ${shape.fix}` };
	}
	const lines = String(text ?? "").split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
	// A line TOUCHES a key when the key is its leading word, `export ` allowed: that is where a loader could read an
	// assignment of it. A key name inside another key's value (`PI_ENV_SETUP=/opt/PI_BACKENDS.sh`) touches nothing.
	const touches = new RegExp(`^[ \\t]*(?:export[ \\t]+)?(${STACK_KEYS.join("|")})(?![A-Za-z0-9_])`);
	// `export K=v` is an assignment only to a loader that SOURCES the file (the macOS wrapper); systemd ignores it.
	const exact = new RegExp(`^[ \\t]*${loader === "shell" ? "(?:export[ \\t]+)?" : ""}(${STACK_KEYS.join("|")})=`);
	// A `#` line is a comment to every loader. A `;` line (a comment to systemd's EnvironmentFile=) needs no rule of its
	// own: its leading word is `;`, never a key, so it touches nothing and is not refused (the round 2 nit).
	const comment = /^[ \t]*#/;
	// WHERE systemd AND THIS READER DISAGREE ABOUT WHAT A LINE IS (issue #447): a lone CR, a quote reopened after a
	// close, a quoted value under a non-identifier key, a continuation the line scan misses, a quoted value whose extent
	// the reader's region model gets wrong. Refused rather than modelled, for the whole file, because such a line can
	// move a venue key into or out of another value anywhere below it, or split one out of the middle of a line
	// (`X=1<CR>PI_BACKENDS=podman`, which the `touches` scan above never sees).
	//
	// GATED on a venue key being SPELLED where a loader could read it as one, which is sound: systemd builds a key only
	// from contiguous text on one line, and a line that starts with `#` or `;` is a comment to it except for text after
	// a lone CR, which systemd reads as a line break (`# note<CR>PI_BACKENDS=podman` sets the key, measured). So a key
	// spelled on a non-comment line counts, and on a comment line only after a lone CR on that same line; a comment
	// that is really the tail of a continuation is value text, split into a line again only by such a CR. Counting
	// every comment spelling refused every docker deployment with an unrelated odd line, since `init` copies
	// `.env.example`, which spells all three keys in comments (gate round 1), and counting them all whenever the file
	// had a lone CR ANYWHERE did the same for a CR on another line (gate round 2). `assumeSpelled` is for a caller about
	// to WRITE a key into this file (the setup wizard), which must refuse on any hazard before it changes a byte.
	// A comment is a line that STARTS as one: a `#` line inside a value or a continuation for this loader is part of that
	// value, and to a shell part of the joined line (`X=a\` + `#;PI_EGRESS=0` sets PI_EGRESS, gate round 2).
	const afterLoneCr = (l) => (l.includes("\r") ? l.slice(l.indexOf("\r") + 1) : "");
	const inValue = loader === "cmd" ? [] : envFileValueLines(text, { loader });
	const spelledOutside = (commentLine) => (assumeSpelled ? STACK_KEYS[0] : STACK_KEYS.find((k) => lines.some((l, i) => (commentLine.test(l) && !inValue[i] ? afterLoneCr(l) : l).includes(k))));
	if (loader === "systemd") {
		const h = envFileSystemdHazard(text);
		const spelled = h === null ? undefined : spelledOutside(/^[ \t]*[#;]/);
		if (h !== null && spelled !== undefined) {
			const shape = SYSTEMD_HAZARD_SHAPES[h.shape];
			return { error: `${path} line ${h.line} has ${shape.what}. The service's systemd would read the lines of this file differently from this command, so which venue keys (${STACK_KEYS.join(", ")}) it sets is unknown: ${shape.fix}` };
		}
	}
	let touched = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (comment.test(line)) continue;
		const m = touches.exec(line);
		if (!m) continue;
		touched ??= { key: m[1], line: i + 1 };
		if (!exact.test(line)) {
			return { error: `${path} line ${i + 1} assigns ${m[1]} in a form other than a plain ${m[1]}=value line, which the loaders do not agree on (systemd sets \`${m[1]} =x\` and ignores \`export ${m[1]}=x\`; the shells do the opposite). Whether this deployment runs the podman venue is therefore unknown: write it as a plain ${m[1]}=value line` };
		}
	}
	if (touched) {
		// A value that OPENS with a quote continues across lines in systemd's parser until that quote closes (round 2,
		// E4: systemd's test-env-file.c, env_file_6), so a key line INSIDE such a value is part of it, not an
		// assignment. The general reader knows this too since #447; this check stays for the sentence it can say. Only a
		// key line inside a still-open region is in doubt (round 3, D1): the documented multi-line
		// GITHUB_APP_PRIVATE_KEY="-----BEGIN ...-----" closes, and a PI_BACKENDS above or below it reads normally
		// (measured on systemd 259: the unit saw both). A quote that never closes runs to the end of the file, so every
		// key line after it is in doubt.
		if (loader !== "cmd") {
			const regions = quotedRegions(text);
			for (let i = 0; i < lines.length; i++) {
				const m = touches.exec(lines[i]);
				if (!m || comment.test(lines[i])) continue;
				const inside = regions.find((r) => i + 1 > r.open && (r.close === null || i + 1 <= r.close));
				if (inside) {
					return { error: `${path} line ${i + 1} (${m[1]}) lies inside the quoted value that opens on line ${inside.open}${inside.close === null ? " and never closes" : ` and closes on line ${inside.close}`}, so the service reads it as part of that value, not as ${m[1]}. Close that quote on its own line, write the value's newlines as \\n escapes, or for a GitHub App key use GITHUB_APP_PRIVATE_KEY_PATH` };
				}
			}
		}
		const hazard = envFileHazard(text, { loader });
		if (hazard?.shape?.startsWith("shell-")) return { error: shapedRefusal(path, hazard, `the file assigns ${touched.key}`) };
		if (hazard !== null) {
			return { error: `${path} line ${hazard.line} is one this command cannot read (an open quote, a continuation, or a line that runs), and the file assigns ${touched.key}, so what the service reads for it is unknown. Fix that line first` };
		}
	} else if (loader === "shell" || (assumeSpelled && loader !== "cmd")) {
		// A sourcing shell can assign a key in the MIDDLE of a line (`X=a PI_EGRESS=0` is two assignments), which touches
		// no line at its start, so here the shell's file-level hazard is asked whenever a key is spelled on a line that is
		// not a comment (issue #447, gate round 1; the same gate as systemd's above, with `#` the shells' only comment).
		const named = spelledOutside(/^[ \t]*#/);
		const hazard = named === undefined ? null : envFileHazard(text, { loader });
		const why = assumeSpelled ? "a venue key is about to be written into it" : `the file names ${named}`;
		if (hazard?.shape?.startsWith("shell-")) return { error: shapedRefusal(path, hazard, why) };
		if (hazard !== null) {
			return { error: `${path} line ${hazard.line} is one this command cannot read (an open quote, a continuation, a line that runs, or a second assignment on one line), and ${why}, so what the service reads for it is unknown. Fix that line first` };
		}
	}
	const found = readEnvAssignments(text, STACK_KEYS, { loader });
	const keys = {};
	for (const key of STACK_KEYS) {
		const read = found[key];
		if (!read) continue;
		if (!read.plain) return { error: `${path} line ${read.line} assigns ${key} in a form this command cannot read the way the service's loader will ($, quotes, spaces or a backslash in the value), so whether this deployment runs the podman venue is unknown. Write it as a plain ${key}=value line` };
		// THE PROJECT'S OWN CAP, not systemd's (gate round 3 corrected the wording): systemd 259 passes a value up to about
		// 128 KiB, and past that the whole environment is `envFileLoadHazard`'s `exec-too-large`. A venue key names a list,
		// a switch or a container, so 4096 bytes is far more than one needs, and a longer one is a mistake worth naming.
		if (Buffer.byteLength(read.value, "utf8") > STACK_VALUE_MAX) return { error: `${path} line ${read.line} assigns ${key} a value of ${Buffer.byteLength(read.value, "utf8")} bytes, and a venue value longer than ${STACK_VALUE_MAX} bytes is refused by pi-dispatch (a venue key never needs that much; systemd itself passes up to about 128 KiB). Shorten it to at most ${STACK_VALUE_MAX} bytes` };
		keys[key] = read.value;
	}
	return { keys };
}

/**
 * Keys of a deployment `.env` as the service's loader reads them, through the hardened reader (issue #464, gate round
 * 3): `content` as BYTES where the caller has them, so what systemd refuses to LOAD (a NUL, invalid UTF-8, an
 * environment too big to exec) is seen before decoding erases it (`decodeEnvFile`, issue #447's rule); then a line
 * systemd splits or joins differently from this reader (`envFileHazard`, systemd's own line structure included), when
 * the file spells one of `keys` at all; then each key's own line, which must be one every loader reads the same.
 * `{ keys }` (only keys the file assigns), or `{ error }` naming the line and the fix. Never an error dropped into
 * "unset": a key this cannot read is not a key the service lacks.
 */
export function readServiceKeys(content, keys, { loader = "systemd", path = ".env" } = {}) {
	const { text, loadHazard } = decodeEnvFile(content, { loader });
	if (loadHazard !== null) {
		const shape = SYSTEMD_HAZARD_SHAPES[loadHazard.shape];
		return { error: `${path} line ${loadHazard.line} has ${shape.what}${loadHazard.detail ? ` (${loadHazard.detail})` : ""}: ${shape.fix}` };
	}
	if (keys.some((k) => text.includes(k))) {
		const hazard = envFileHazard(text, { loader });
		if (hazard !== null) {
			const shape = hazard.shape !== undefined ? SYSTEMD_HAZARD_SHAPES[hazard.shape] : null;
			return { error: `${path} line ${hazard.line} is one this command cannot read the way the service's loader will${shape ? ` (${shape.what}): ${shape.fix}` : " (an open quote, a continuation, or a line that runs): fix that line first"}, and the file assigns ${keys.filter((k) => text.includes(k)).join(" or ")}` };
		}
	}
	const lines = text.split("\n");
	const found = readEnvAssignments(text, keys, { loader });
	const out = {};
	for (const key of keys) {
		const read = found[key];
		if (!read) continue;
		if (!read.plain) {
			const cause = unplainCause(String(lines[read.line - 1] ?? "").replace(/\r$/, "").replace(/^[^=]*=/, ""));
			return { error: `${path} line ${read.line} assigns ${key} in a form this command cannot read the way the service's loader will (${cause})` };
		}
		out[key] = read.value;
	}
	return { keys: out };
}

/**
 * VALKEY_URL, PI_VALKEY_SHARED and VALKEY_PASSWORD as a deployment's `.env` assigns them (issues #464 and #468), through
 * `readServiceKeys`: `service install`, `up`, the worker and every client judge the Valkey the SERVICE will use and
 * send the password the service will send, so they read these where the service does, and a line they cannot read is
 * refused, naming what in it is the problem.
 */
export function readValkeyKeys(content, { loader = "systemd", path = ".env" } = {}) {
	const read = readServiceKeys(content, ["VALKEY_URL", VALKEY_SHARED_KEY, VALKEY_PASSWORD_KEY], { loader, path });
	return read.error ? { error: `${read.error}, so which Valkey the worker uses is unknown` } : read;
}

/** What in a `.env` value keeps it from reading the same under every loader, with the way to write it (issue #464). */
export function unplainCause(value) {
	const v = String(value).replace(/[ \t]+$/, "");
	const quoted = /^["']/.test(v);
	if (!quoted && /[[\]]/.test(v)) return `an unquoted [ or ]: the macOS wrapper sources the file with sh, which may read it as a filename pattern. Quote the value, for example VALKEY_URL="redis://[::1]:6379", which every loader reads the same`;
	// A control or invisible character is refused quoted or not (gate round 2 of PR #478), so quoting cannot help.
	const hidden = invisibleCharacter(v);
	if (hidden !== null) return `${hidden}, which doctor does not show back, quoted or not. Remove it`;
	if (/\$/.test(v)) return "a $, which the loaders expand differently. Write the value out";
	if (/^[ \t]/.test(v)) return "a space before the value, which the shells drop. Remove it";
	if (quoted) return "a quote that is not the whole value, or a $, \\ or ` inside double quotes. Write it as one quoted value with none of those";
	if (/\\/.test(v)) return "a backslash, which the loaders read differently. Remove it";
	if (/\s/.test(v)) return "a space in the value. Remove it, or quote the whole value";
	// Issue #477: the reader's bare set takes `=` inside a value, and refuses it at the start or after a `:`, where zsh
	// expands it; each of those, and any other character, is named as what it is.
	if (v.startsWith("=")) return "an = at the start of an unquoted value, which zsh expands as a command name. Quote the whole value";
	if (v.includes(":=")) return "a := in an unquoted value, which zsh expands as a command name. Quote the whole value";
	const bad = /[^A-Za-z0-9_@+=:,./-]/u.exec(v)?.[0];
	const shown = bad === undefined ? "" : /^[\x21-\x7e]$/.test(bad) ? `\`${bad}\` ` : `U+${bad.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")} `;
	return `a character (${shown.trim() || "one"}) outside A-Z, a-z, 0-9 and _@+=:,./- in an unquoted value. Quote the whole value`;
}

/** The shown form of one action. `applyStack` runs the same objects these lines were made from. */
export function describeAction(action) {
	return action.kind === "write" ? `write ${action.path}` : action.argv.join(" ");
}

/**
 * Carry out `plan.actions`, in order, stopping at the first failure. `run(cmd, args)` resolves an exit code, null for
 * a command that could not launch. Returns `{ ok: true }` or `{ ok: false, failed, code, ran }`, `ran` saying whether
 * any command had run before the failure.
 *
 * Issue #464: `journal`, when given, is an array each write is recorded in BEFORE it happens (`journalWrite`), so a
 * caller can put every file back when a later step fails (`rollBackWrites`). `beforeRuns`, when given, is awaited
 * once after the last write and before the first command, and a `{ ok: false, ... }` from it stops the apply there:
 * `service install` writes its worker unit in it, so every file is written before anything is started.
 */
export async function applyStack(plan, { fs, run, journal = null, beforeRuns = null }) {
	const byPath = new Map(plan.files.map((f) => [f.path, f]));
	let ran = false;
	const gate = async () => {
		if (!beforeRuns) return null;
		const hook = beforeRuns;
		beforeRuns = null;
		const res = await hook();
		return res && res.ok === false ? { ...res, ran } : null;
	};
	for (const action of plan.actions) {
		if (action.kind === "write") {
			try {
				fs.mkdirSync(dirname(action.path), { recursive: true });
				journalWrite(fs, journal, action.path, byPath.get(action.path).text, { mode: byPath.get(action.path).mode });
			} catch (err) {
				return { ok: false, failed: describeAction(action), code: null, message: err?.message, ran };
			}
			continue;
		}
		const stopped = await gate();
		if (stopped) return stopped;
		const [cmd, ...args] = action.argv;
		ran = true;
		const code = await run(cmd, args);
		if (code !== 0) return { ok: false, failed: describeAction(action), code, ran };
	}
	const stopped = await gate();
	if (stopped) return stopped;
	return { ok: true };
}

/**
 * Write `text` to `path`, first recording in `journal` (when given) what was there: `{ path, existed, previous }`.
 * Recorded before the write so a write that fails part way is put back too.
 */
export function journalWrite(fs, journal, path, text, { mode } = {}) {
	// Issue #468: a file with a `mode` (the Valkey's password file) is created with it, and an existing one is narrowed
	// to it BEFORE the new text goes in, so the password is never in a file another account may read.
	const write = () => {
		if (mode === undefined) {
			fs.writeFileSync(path, text);
			return;
		}
		if (fs.existsSync(path)) fs.chmodSync(path, mode);
		fs.writeFileSync(path, text, { mode });
		fs.chmodSync(path, mode);
	};
	if (!journal) {
		write();
		return;
	}
	let existed = false;
	let previous = null;
	if (fs.existsSync(path)) {
		existed = true;
		previous = fs.readFileSync(path);
	}
	const entry = { path, existed, previous };
	journal.push(entry);
	try {
		write();
	} catch (err) {
		// A write refused before it touched the file (EACCES, EROFS at open) left nothing to put back, and a rollback that
		// then tried to write the same path would fail the same way and report a file this run never changed. Dropped
		// from the journal only when the file reads exactly as before.
		let unchanged = false;
		try {
			unchanged = existed ? fs.existsSync(path) && String(fs.readFileSync(path)) === String(previous) : !fs.existsSync(path);
		} catch {
			// Unreadable now: kept, and the rollback says what it could not do.
		}
		if (unchanged) journal.splice(journal.indexOf(entry), 1);
		throw err;
	}
}

/**
 * Put back every write in `journal`, newest first: a file that existed gets its old bytes, a new one is removed (an
 * already absent one counts as removed). Returns `{ restored, removed, left: [{ path, message }] }`, `left` being the
 * files that could not be put back and so remain as this run wrote them. Directories a write created are left: empty
 * and harmless, and one may hold files that are not ours.
 */
export function rollBackWrites(fs, journal) {
	const restored = [];
	const removed = [];
	const left = [];
	const seen = new Set();
	for (const entry of [...(journal ?? [])].reverse()) {
		// The FIRST record of a path holds what was there before this run; a later one would hold this run's own bytes.
		const first = journal.find((e) => e.path === entry.path);
		if (seen.has(entry.path)) continue;
		seen.add(entry.path);
		try {
			if (first.existed) {
				fs.writeFileSync(first.path, first.previous);
				restored.push(first.path);
			} else {
				try {
					fs.unlinkSync(first.path);
				} catch (err) {
					if (err?.code !== "ENOENT") throw err;
				}
				removed.push(first.path);
			}
		} catch (err) {
			left.push({ path: first.path, message: err?.message ?? String(err) });
		}
	}
	return { restored, removed, left };
}

/**
 * The sentence for a rollback's result, for a refusal message: what was put back and what remains. `partial` is a
 * rollback of only some of this run's files (the worker unit, after a stack command failed), whose caller names the
 * rest itself, so it never says that no file of this run remains.
 */
export function describeRollBack(rolled, { partial = false } = {}) {
	const parts = [];
	if (rolled.removed.length > 0) parts.push(`removed ${rolled.removed.join(", ")}`);
	if (rolled.restored.length > 0) parts.push(`put back the earlier ${rolled.restored.join(", ")}`);
	const done = parts.length > 0 ? `rolled back what this run wrote (${parts.join("; ")})` : "this run had written nothing";
	if (rolled.left.length === 0) return partial ? done : `${done}; no file of this run remains`;
	return `${done}; these could NOT be put back and remain as this run wrote them: ${rolled.left.map((l) => `${l.path} (${l.message})`).join(", ")}`;
}

/**
 * The worker unit's dependency lines on the stack. `Wants=`, never `Requires=`: a Valkey that failed to start must not
 * also take the worker down with it, since the worker's own queue connection retries and says why, and a proxy that
 * is down refuses jobs pre-spend by itself. `After=` so a boot starts the queue before the worker reaches for it.
 */
export function workerUnitDeps(units) {
	if (units.length === 0) return "";
	return `# Added by \`pi-dispatch service install\` for the podman venue (issue #430): the Quadlet units it installed.\nWants=${units.join(" ")}\nAfter=${units.join(" ")}\n`;
}

/**
 * Linger, read without side effects. `loginctl show-user <user> -p Linger` prints `Linger=yes|no`, and unlike
 * `systemctl --machine=<user>@ --user status` it does not START the user manager it asks about (measured: that probe
 * starts it, and the units with it, which would report a boot-time answer that is not one). Returns true, false, or
 * null when loginctl could not answer.
 */
export async function readLinger(user, runCapture) {
	const res = await runCapture("loginctl", ["show-user", user, "-p", "Linger"]);
	if (res.code !== 0) return null;
	const m = /^Linger=(yes|no)\s*$/m.exec(String(res.output ?? ""));
	return m ? m[1] === "yes" : null;
}

/** The sentence for each linger answer, shared by `service install` and `up`. */
export function lingerNote(linger, user) {
	if (linger === true) return `linger is on for ${user}: measured, the Quadlet units come back at boot with nobody logged in\n`;
	if (linger === false) return `⚠ linger is OFF for ${user}: measured, without it neither these Quadlet units nor a user-scope worker start at boot. Turn it on:  sudo loginctl enable-linger ${user}\n`;
	return `note: could not read linger for ${user} (loginctl did not answer). Without linger these units start only while you have a session:  sudo loginctl enable-linger ${user}\n`;
}
