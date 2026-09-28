/**
 * The runtime observations (issue #345): what THIS HOST's daemon is observed to do about a container's bounds and its
 * mounts, turned into the `daemonAppliesBounds` and `runtimeAddsNoMounts` answers `backends.mjs`'s `effectiveWord`
 * reads. No container runs and no second daemon call is made: the bounds come from the one `docker info` read the job
 * user is decided from (`job-user.mjs`), and the mounts from files on this host.
 *
 * THREE ANSWERS, NEVER TWO. `true` earns the declared word; `false` degrades it to `asserted`, and a floor asking for
 * `enforced` refuses; `null` is NOT ANSWERED (the daemon did not answer, or answered in a shape nothing reads), which a
 * floor turns into a retry rather than a refusal, the endpoint read's transient rule. No credit is ever given for a
 * missing or unreadable fact: the polarity every observation in `backends.mjs` keeps.
 *
 * The evidence strings are fixed text plus a file path or a daemon field NAME, never a value the daemon or a file
 * carries, so they can be logged and put in a refusal.
 */

import { realpathSync } from "node:fs";
import { execDockerBounded } from "./backend-local.mjs";
import { DAEMON_APPLIES_BOUNDS, DOCKER_ENDPOINT_LOCAL, PODMAN_CONF_WIDENS_JOB, PODMAN_ROOTFUL_WIDENING_KEYS, RUNTIME_ADDS_NO_MOUNTS } from "./backends.mjs";

/**
 * The override for Podman's default mount list. When it exists, Podman reads it instead of
 * `/usr/share/containers/mounts.conf`, and an EMPTY one mounts nothing (measured on rootful Podman 5.8.2: `/run/secrets`
 * disappears from `/proc/self/mountinfo`).
 */
export const PODMAN_MOUNTS_CONF = "/etc/containers/mounts.conf";

/**
 * The system containers.conf chain a rootful Podman reads (containers/common v0.67.0 `systemConfigs`): the vendor file,
 * the `/etc` file and every `*.conf` in `/etc/containers/containers.conf.d`. Measured for issue #448 (gate round 1 of PR
 * #473) with a drop-in in each candidate place, on rootful Podman 5.8.1 and 4.9.3, through the API service and the root
 * podman CLI alike: `/usr/share/containers/containers.conf.d` and both `containers.rootful.conf.d` directories were NOT
 * read, so they are not on the chain. Root's own conf, `--module` files and `CONTAINERS_CONF` are added by
 * `rootfulConfChain`. Not `default_mounts_file`: that is not a containers.conf key (`toml:"-"`), only a hidden flag.
 */
export const PODMAN_CONTAINERS_CONF_FILES = Object.freeze(["/usr/share/containers/containers.conf", "/etc/containers/containers.conf"]);
export const PODMAN_CONTAINERS_CONF_DIRS = Object.freeze(["/etc/containers/containers.conf.d"]);

/** FIPS mode adds the host's crypto policy mounts outside `mounts.conf` (container-libs pkg/subscriptions). */
export const FIPS_ENABLED_PATH = "/proc/sys/crypto/fips_enabled";

/**
 * A key that adds to every container what no argv names: `volumes`, `mounts`, `devices` (host device nodes) and
 * `hooks_dir` (OCI hooks, which can mount). Matched in ANY LETTER CASE (Podman's TOML decoding matches keys
 * case-insensitively: `Volumes` and `CONTAINERS.VOLUMES` both mount, measured on Podman 5.8.2), bare or quoted at the start
 * of a line, dotted (`containers.volumes = [...]`), or inside an inline table (`containers = { volumes = [...] }`), on any
 * line that is not a whole-line comment: a `#` inside a string earlier on the line is not a comment (measured, an
 * `env = ["X=#"]` before the key still mounts). Wider than Podman's own reading on purpose: a string value or a trailing
 * comment that merely contains `volumes =` also matches, which withholds credit rather than giving it.
 */
export const MOUNT_KEY = /^(?!\s*#).*?(?:^|[\s.{,"'])["']?(?:volumes|mounts|devices|hooks_dir)["']?\s*=/im;

/**
 * A quoted TOML key holding a backslash escape (`"volum\u0065s" = ...`), which TOML reads as the unescaped name and
 * `MOUNT_KEY` cannot see through, on any line that is not a whole-line comment. Refused outright rather than decoded: no
 * containers.conf needs one.
 */
export const ESCAPED_KEY = /^(?!\s*#).*?["'][^"'\n]*\\[^"'\n]*["']\s*=/m;

/**
 * A file this check cannot read the way Podman's TOML decoder does, on any line, comment or not (issue #428): a non-ASCII
 * character or a multi-line string opener. Each was measured bypassing the key patterns while Podman honoured the key:
 * Go's case folding matches `"pa\u017fta_options"` (a LONG S) to `pasta_options` where a JS `/i` does not; a `"""` or
 * `'''` string whose content has a line starting `#` reads here as a comment and there as a string, so a key after it
 * on the same TOML line is hidden; and U+2028 or U+2029 inside a string is a line break to a JS regex and not to TOML.
 * Refused outright rather than decoded, as `ESCAPED_KEY` is: a stock containers.conf is plain ASCII with no multi-line
 * string (Fedora 44's, and containers/common v0.57.4's, which Ubuntu 24.04 packages), so the rule costs nothing real.
 */
export const UNREAD_SPELLING = /[^\x00-\x7f]|"""|'''/;

/**
 * The first line (1-based, split on `\n` only, as TOML counts lines) holding an `UNREAD_SPELLING`, as `{ line, kind }`
 * with `kind` `"non-ascii"` or `"multi-line"` (a line holding both is named for its non-ASCII character), or `null`.
 * So a refusal can say WHERE, and which of the two, rather than send an operator through the whole file.
 */
export function unreadSpelling(text) {
	const lines = String(text).split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (/[^\x00-\x7f]/.test(lines[i])) return { line: i + 1, kind: "non-ascii" };
		if (/"""|'''/.test(lines[i])) return { line: i + 1, kind: "multi-line" };
	}
	return null;
}

/**
 * The read errors that say nothing about the file, only about this moment (issue #428): out of descriptors or memory,
 * an I/O error, a busy or stale mount, an interrupted or timed-out call. A conf file or drop-in directory that fails
 * with one of these is NOT ANSWERED (`null`, so a floor retries and the podman venue's refusal retries) rather than
 * withheld (`false`, refused): refusing it turned a full descriptor table into a dropped job. Every other code
 * (`EACCES`, `EPERM`, `ENOTDIR`, `ELOOP`, `EISDIR`, an unknown one) stays determinate, the precedent, because a retry
 * reads the same permissions; listed this way round so an errno nobody thought of fails closed, not into a retry loop.
 */
export const TRANSIENT_READ_ERRORS = new Set(["EMFILE", "ENFILE", "EIO", "EAGAIN", "EWOULDBLOCK", "EBUSY", "ENOMEM", "EINTR", "ETIMEDOUT", "ESTALE"]);

/**
 * A host file or directory an observation could not read, as a finding: `null` for a transient code, carrying
 * `reason: "file-unread"` so the retry names a file rather than a daemon, else `false`. The ONE rule for every file an
 * observation reads (round 2 of the #428 review: the conf chain had it and its sibling reads, mounts.conf, the hooks
 * directories and the FIPS file, still turned EMFILE into a floor refusal that dropped the job).
 */
export function unreadFileFinding(path, code) {
	return TRANSIENT_READ_ERRORS.has(code) ? { value: null, evidence: `${path} could not be read (${code})`, reason: "file-unread" } : { value: false, evidence: `${path} could not be read (${code})` };
}

/** OCI hook directories Podman runs every `*.json` hook from (container-libs pkg/config); a hook can mount into a container. */
export const PODMAN_HOOKS_DIRS = Object.freeze(["/usr/share/containers/oci/hooks.d", "/etc/containers/oci/hooks.d"]);

/** What a containers.conf matching `MOUNT_KEY` is said to do, the evidence `observeRuntimeMounts` has always given. */
export const MOUNT_KEY_SAYS = "sets a volumes, mounts, devices or hooks_dir key, which Podman applies to every container";

/**
 * One host file's text, as `{ text }`, or `{ missing, error }` when it could not be read. Exported (issue #354) so the
 * rootless podman venue's observations read files by the one rule the rootful ones do.
 */
export function readHostFile(fs, path) {
	try {
		return { text: fs.readFileSync(path, "utf8") };
	} catch (error) {
		return { missing: error?.code === "ENOENT", error: error?.code ?? "error" };
	}
}

/**
 * FIPS mode as a finding: `{ value: false, evidence }` when it is on or its file cannot be read, `null` when it is off or
 * the kernel has no such file. FIPS mode mounts the host's crypto policy into every Podman container, rootful or not.
 */
export function fipsFinding(fs) {
	const fips = readHostFile(fs, FIPS_ENABLED_PATH);
	if (!fips.missing && fips.text === undefined) return unreadFileFinding(FIPS_ENABLED_PATH, fips.error);
	if (String(fips.text ?? "").trim() === "1") return { value: false, evidence: "FIPS mode is on, and Podman then mounts the host's crypto policy into every container" };
	return null;
}

/**
 * Whether `path` is a directory (following a symlink, as Podman's own walk does), so a directory named `x.conf` in a
 * drop-in directory is skipped the way Podman skips it (gate round 2 of PR #473: it was refused with EISDIR). A stat that
 * fails, or a fake without `isDirectory`, reads as a file, whose own read then says what it is.
 */
export function isDirectoryAt(fs, path) {
	try {
		return fs.statSync(path)?.isDirectory?.() === true;
	} catch {
		return false;
	}
}

/**
 * The containers.conf files Podman would read from `files` and every `*.conf` in `dirs` (sorted per directory, missing
 * directories skipped), as `{ files }`, or `{ finding }` when a directory exists and cannot be listed: a drop-in nobody
 * could see must withhold credit, not read as none.
 */
export function confFilesIn(fs, { files = [], dirs = [] }) {
	const out = [...files];
	for (const dir of dirs) {
		let entries;
		try {
			entries = fs.readdirSync(dir);
		} catch (error) {
			if (error?.code === "ENOENT") continue;
			return { finding: unreadFileFinding(dir, error?.code ?? "error") };
		}
		for (const entry of [...entries].sort()) if (String(entry).endsWith(".conf") && !isDirectoryAt(fs, `${dir}/${entry}`)) out.push(`${dir}/${entry}`);
	}
	return { files: out };
}

/**
 * The first of `files` that sets a key `key` matches (`says` completes the sentence naming it), or holds an escaped key,
 * a non-ASCII character or a multi-line string this check cannot decode (`UNREAD_SPELLING`), or exists and cannot be
 * read, as `{ value: false, evidence }` (`value: null` for a transient read error); `null` when none does. A
 * missing file is simply not read, which is how Podman treats it too. `says` may be a function of the match (issue #428),
 * for a key set whose members each do something different, so the sentence names the one that was found.
 */
export function confKeyFinding(fs, files, { key, says }) {
	for (const file of files) {
		const got = readHostFile(fs, file);
		if (got.missing) continue;
		if (got.text === undefined) return unreadFileFinding(file, got.error);
		const match = key.exec(got.text);
		if (match) return { value: false, evidence: `${file} ${typeof says === "function" ? says(match) : says}` };
		if (ESCAPED_KEY.test(got.text)) return { value: false, evidence: `${file} has an escaped key, which this check does not decode`, spelling: "escaped" };
		const unread = unreadSpelling(got.text);
		if (unread) return { value: false, evidence: `${file} line ${unread.line} has ${unread.kind === "non-ascii" ? "a non-ASCII character" : "a multi-line string (\"\"\" or ''')"}, which this check does not decode`, spelling: unread.kind };
	}
	return null;
}

/**
 * The pattern that finds any of `keys` in a containers.conf, as `MOUNT_KEY` finds its own: any letter case, bare or
 * quoted, dotted or inside an inline table, never on a whole-line comment and never inside a longer key name. The one
 * capture group is the key, so a refusal names the key it found.
 */
export function widenKeyPattern(keys) {
	return new RegExp(`^(?!\\s*#).*?(?:^|[\\s.{,"'])["']?(${keys.join("|")})["']?\\s*=`, "im");
}

/**
 * CHAIN-AGNOSTIC (issue #448): the first of `files` that sets one of `keys`, as `{ value: false, key, evidence }` with
 * `says[key]` completing the sentence that names the file, or one this check cannot decode (an escaped key, a non-ASCII
 * character, a multi-line string) as `{ value: false, key: null, evidence, spelling }`, else `null`. A missing file is
 * not read, as Podman does not read it. A file that exists and cannot be read is `{ value, key: null, evidence }` by
 * `unreadFileFinding`'s rule (`null` for a transient code), UNLESS the caller passes an `unread` array: then a
 * determinate code is pushed there as `{ path, code }` and the scan goes on, which is how a caller whose chain includes
 * files it is not expected to read (root's own, for a worker that is not root) names them rather than refusing on them.
 * The rootless podman venue's check (`podmanConfWidening`) calls it with no `unread`, so its answers are what they were.
 * `pattern` replaces the one built from `keys` (the mounts observation passes `MOUNT_KEY`, whose `says` is one string),
 * and `strip` blanks what the caller accepts before the key is looked for (`stripStockBlocks`).
 */
export function confWidening(fs, files, { keys, pattern = widenKeyPattern(keys), says, unread = null, nameable = () => true, strip = null }) {
	for (const file of files) {
		const got = readHostFile(fs, file);
		if (got.missing) continue;
		if (got.text === undefined) {
			const finding = unreadFileFinding(file, got.error);
			// Collected only where the caller says a path may go unread (gate round 1 of PR #473: root's own config home, never
			// a `0600` drop-in in /etc, which the service applied while this named it and moved on).
			if (Array.isArray(unread) && finding.value === false && nameable(file)) {
				unread.push({ path: file, code: got.error });
				continue;
			}
			return { ...finding, key: null };
		}
		// `strip` (issue #448) blanks a block the caller accepts as it ships, line for line, before the key is looked for.
		const text = typeof strip === "function" ? strip(got.text) : got.text;
		const match = pattern.exec(text);
		if (match) {
			const key = match[1]?.toLowerCase() ?? null;
			return { value: false, key, evidence: `${file} ${typeof says === "string" ? says : says[key]}` };
		}
		if (Array.isArray(keys) && keys.includes("runtimes") && runtimesTableSet(text)) return { value: false, key: "runtimes", evidence: `${file} ${says.runtimes}` };
		if (ESCAPED_KEY.test(got.text)) return { value: false, key: null, evidence: `${file} has an escaped key, which this check does not decode`, spelling: "escaped" };
		const spelled = unreadSpelling(got.text);
		if (spelled) return { value: false, key: null, evidence: `${file} line ${spelled.line} has ${spelled.kind === "non-ascii" ? "a non-ASCII character" : "a multi-line string (\"\"\" or ''')"}, which this check does not decode`, spelling: spelled.kind };
	}
	return null;
}

/**
 * Whether a containers.conf sets a runtime in the `[engine.runtimes]` table (issue #448, gate round 1: a wrapper named
 * there ran for every job, rootful and rootless). A TABLE, so the key pattern cannot see it: a key assigned while that
 * table is open, a `[engine.runtimes.<x>]` subtable, or a dotted `runtimes.<x>` or `engine.runtimes.<x>` key. The header
 * alone is not a setting: the stock files of Fedora 44 and Ubuntu 24.04 carry `[engine.runtimes]` with every entry under
 * it commented out, and pass. Any letter case, quotes and spaces inside the header ignored.
 */
export function runtimesTableSet(text) {
	let table = "";
	for (const raw of String(text).split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const header = /^\[\s*([^\[\]]+?)\s*\](?:\s*#.*)?$/.exec(line);
		if (header) {
			table = header[1].replace(/["'\s]/g, "").toLowerCase();
			if (table.startsWith("engine.runtimes.")) return true;
			continue;
		}
		if (/^\[\[/.test(line)) {
			table = "";
			continue;
		}
		const key = /^["']?([A-Za-z0-9_.-]+?)["']?\s*(?:\.\s*["']?[A-Za-z0-9_-]+["']?\s*)*=/.exec(line);
		if (!key) continue;
		const dotted = line.slice(0, line.indexOf("=")).replace(/["'\s]/g, "").toLowerCase();
		if (table === "engine.runtimes") return true;
		if (table === "engine" && dotted.startsWith("runtimes.")) return true;
		if (table === "" && dotted.startsWith("engine.runtimes.")) return true;
	}
	return false;
}

/** An installed OCI hook (any `*.json` in `PODMAN_HOOKS_DIRS`) as `{ value: false, evidence }`, else `null`. */
export function hooksFinding(fs, dirs = PODMAN_HOOKS_DIRS) {
	for (const dir of dirs) {
		let entries;
		try {
			entries = fs.readdirSync(dir);
		} catch (error) {
			if (error?.code === "ENOENT") continue;
			return unreadFileFinding(dir, error?.code ?? "error");
		}
		if ([...entries].some((entry) => String(entry).endsWith(".json"))) return { value: false, evidence: `${dir} holds an OCI hook, which can mount into every container` };
	}
	return null;
}

/**
 * A daemon read that gave no facts, as an observation: `null` (not answered, so a floor retries) for a transient
 * failure, and `false` (answered, so a floor refuses) for a determinate one: a clean `docker info` exit that parses to no
 * known shape (`unparseable`, which the job-user decision likewise treats as determinate), or no docker CLI at all.
 * `undefined` when there are facts to read.
 */
function notAnswered(daemon) {
	if (daemon?.answered && daemon.facts) return undefined;
	if (daemon && daemon.answered === false && daemon.transient === false) return { value: false, evidence: `the daemon answered in a shape nothing here reads (${daemon.reason ?? "unparseable"})` };
	// No docker CLI at all is not a daemon still starting: the endpoint read treats it as determinate, and so does this.
	if (daemon?.reason === "docker-not-found") return { value: false, evidence: "no docker CLI was found on PATH" };
	return { value: null, evidence: `the daemon's info was not read (${daemon?.reason ?? "not asked"})` };
}

/**
 * `daemonAppliesBounds` from a daemon read (`{ answered, facts }` or `{ answered: false, reason }`), as
 * `{ value, evidence }`.
 */
export function observeBounds(daemon) {
	const unread = notAnswered(daemon);
	if (unread) return unread;
	const { facts } = daemon;
	if (facts.rootless === true) return { value: false, evidence: "the daemon is rootless, where the bounds it reports need cgroup delegation it does not report" };
	if (facts.podman === true || !facts.bounds) return { value: false, evidence: "the daemon is Podman, whose Docker API reports PidsLimit and MemoryLimit whether or not a container's bounds apply" };
	const missing = [facts.bounds.pids !== true ? "PidsLimit" : null, facts.bounds.memory !== true ? "MemoryLimit" : null].filter(Boolean);
	if (missing.length > 0) return { value: false, evidence: `the daemon reports ${missing.join(" and ")} false` };
	return { value: true, evidence: "the daemon reports PidsLimit and MemoryLimit" };
}

/**
 * `runtimeAddsNoMounts` from a daemon read and this host's files, as `{ value, evidence }`. `fs` is
 * `{ statSync, readFileSync, readdirSync }`; `sameHost` says whether a Podman service's files are this host's (a unix
 * socket on this host, not a remote service).
 */
export function observeRuntimeMounts(daemon, { fs, sameHost, unit, env = {}, now = Date.now(), memory }) {
	const notRead = notAnswered(daemon);
	if (notRead) return notRead;
	if (daemon.facts.podman !== true) return { value: true, evidence: "the daemon is not Podman, and Docker adds no mounts from a mounts.conf" };
	// Rootless Podman reads the user's own ~/.config/containers/mounts.conf before these, which a host check does not read.
	if (daemon.facts.rootless === true) return { value: false, evidence: "the daemon is rootless Podman, which reads the user's own mounts.conf first" };
	if (sameHost !== true) return { value: false, evidence: "the daemon is Podman on another machine, whose mounts.conf this host cannot read" };
	// Issue #448: the SAME chain the rootful widening check reads (`rootfulConfChain`: the system files and drop-ins, root's
	// own conf, `--module` files, the unit's and the manager's CONTAINERS_CONF and CONTAINERS_CONF_OVERRIDE), read FIRST
	// and remembered before any answer returns (gate round 2 of PR #473: with no mounts.conf, stock Ubuntu, the memory
	// was never written, so a file deleted under the running service went unseen). `unit` is `systemctl show
	// podman.service` as the caller read it; a caller that read none (`undefined`) judges the files alone.
	const chain = rootfulConfChain({ fs, unit: unit ?? { read: false, reason: "not-asked" }, env, facts: daemon.facts });
	if (unit !== undefined) rememberChain({ fs, unit, chain, memory });
	const fips = fipsFinding(fs);
	if (fips) return fips;
	let size;
	try {
		size = fs.statSync(PODMAN_MOUNTS_CONF).size;
	} catch (error) {
		if (error?.code !== "ENOENT") return unreadFileFinding(PODMAN_MOUNTS_CONF, error?.code ?? "error");
		return { value: false, evidence: `${PODMAN_MOUNTS_CONF} does not exist, so Podman mounts the default list (/run/secrets on Fedora and RHEL)` };
	}
	if (size !== 0) return { value: false, evidence: `${PODMAN_MOUNTS_CONF} is not empty, so Podman mounts what it lists` };
	// The chain under its rule: a part under root's own config home this account cannot read is named in the evidence; any
	// other part that cannot be read, or a module that names no file, withholds the credit (gate round 1: a `0600` drop-in
	// setting `volumes` earned the credit).
	if (chain.transient) return unreadFileFinding(chain.transient.path, chain.transient.code);
	if (chain.unreadable) return unreadFileFinding(chain.unreadable.path, chain.unreadable.code);
	if (chain.unjudgeable) return { value: false, evidence: moduleEvidence(chain.unjudgeable.module) };
	const unread = [...chain.unread];
	const conf = confWidening(fs, chain.files, { pattern: MOUNT_KEY, says: MOUNT_KEY_SAYS, unread, nameable: chain.nameable });
	if (conf) return conf.value === null ? { value: null, evidence: conf.evidence, reason: "file-unread" } : { value: false, evidence: conf.evidence };
	const hooks = hooksFinding(fs);
	if (hooks) return hooks;
	// The running service keeps the containers.conf it started with (measured for #448 with `volumes`: a key removed while
	// it ran was still mounted into the next job, and one added was not, until a restart). mounts.conf is read per
	// container (measured: a line added and removed while it ran reached and left the next job), so it is not watched.
	if (unit !== undefined) {
		const stale = serviceChangedSince({ fs, unit, chain, unread, now, memory });
		if (stale.transient) return unreadFileFinding(stale.transient.path, stale.transient.code);
		if (stale.unreadable) return unreadFileFinding(stale.unreadable.path, stale.unreadable.code);
		const evidence = staleEvidence(stale, "what it mounts may not be what the files say until it restarts");
		if (evidence) return { value: false, evidence };
	}
	const residual = rootfulUnreadList(dedupeUnread(unread));
	return { value: true, evidence: `${PODMAN_MOUNTS_CONF} is empty, no containers.conf sets volumes, mounts, devices or hooks, and no OCI hook is installed${residual ? `; not read, so not judged: ${residual}` : ""}` };
}

/**
 * Whether a Podman service's files are this host's: the docker CLI observed on a local unix socket (the real docker CLI
 * pointed at Podman), or Podman's own shape naming a unix socket (podman-docker, which reports `serviceIsRemote: true`
 * for the local rootful service too, measured, so only the socket's form is read; `parseDaemonFacts` keeps only a unix
 * path). A socket that is really a tunnel to another machine, or `podman machine`'s forwarded socket, reads as this
 * host: the files read are then this host's, where no override exists, so the answer is `false`, never a false credit
 * from files the service does not read, except where an operator created the override on a host that does not run it.
 */
export function podmanOnThisHost({ endpoint, facts }) {
	if (endpoint?.local === true && typeof endpoint.endpoint === "string" && endpoint.endpoint.startsWith("unix://")) return true;
	if (facts?.shape === "podman" && typeof facts.remoteSocketPath === "string") return true;
	return false;
}

/**
 * Every observation `backends.mjs` names, for one endpoint read and one daemon read, as `{ observations, evidence,
 * reasons }`: the map `effectiveWord` and `observationRefusals` take, what each answer rests on, and for an observation
 * that was not answered, the reason token of the read that did not answer. The endpoint's own answer is `null` only for
 * a TRANSIENT failure to ask, as the endpoint read's boot and per-job rule already treats it.
 */
export function observeHost({ endpoint, daemon, fs, unit, env = {}, now, memory }) {
	const bounds = observeBounds(daemon);
	const mounts = observeRuntimeMounts(daemon, { fs, sameHost: podmanOnThisHost({ endpoint, facts: daemon?.facts }), unit, env, ...(now !== undefined ? { now } : {}), memory });
	const endpointAnswer = endpoint?.local === true ? true : endpoint?.local === null && endpoint?.transient ? null : false;
	return {
		observations: { [DOCKER_ENDPOINT_LOCAL]: endpointAnswer, [DAEMON_APPLIES_BOUNDS]: bounds.value, [RUNTIME_ADDS_NO_MOUNTS]: mounts.value },
		evidence: { [DAEMON_APPLIES_BOUNDS]: bounds.evidence, [RUNTIME_ADDS_NO_MOUNTS]: mounts.evidence },
		reasons: {
			...(endpointAnswer === null ? { [DOCKER_ENDPOINT_LOCAL]: endpoint?.reason ?? "unknown" } : {}),
			...(bounds.value === null ? { [DAEMON_APPLIES_BOUNDS]: daemon?.reason ?? "not-read" } : {}),
			...(mounts.value === null ? { [RUNTIME_ADDS_NO_MOUNTS]: mounts.reason ?? daemon?.reason ?? "not-read" } : {}),
		},
	};
}

/** The two runtime answers as one string, so a caller logs them only when they change. */
export function runtimeObservationKey(observed) {
	return `${observed.observations[DAEMON_APPLIES_BOUNDS]}|${observed.observations[RUNTIME_ADDS_NO_MOUNTS]}`;
}

// --- issue #448: rootful Podman's containers.conf keys that reach a `local` job ------------------------------------

/**
 * The systemd unit that runs rootful Podman's Docker API service behind `/run/podman/podman.sock` (`podman.socket`
 * starts it on the first request, and it exits after a few idle seconds). Read with `systemctl show`, which any account
 * may run: `LoadState` and `ActiveState`, when its process started (`--timestamp=us+utc`, so the answer parses the same
 * in every locale), the `Environment=` and `EnvironmentFile=` it starts Podman with, its `ExecStart` (for `--module`), and
 * the unit files it was built from. Two more reads beside it (gate round 1 of PR #473): the manager's own environment
 * (`systemctl show-environment`, which `DefaultEnvironment=` and `set-environment` fill, and which the service inherits,
 * measured: a `CONTAINERS_CONF_OVERRIDE` there reached jobs) and `podman.socket`'s `Listen=`, so the service is trusted
 * only for the socket it actually serves.
 */
export const PODMAN_SERVICE_UNIT = "podman.service";
export const PODMAN_SOCKET_UNIT = "podman.socket";
export const PODMAN_SERVICE_SHOW_ARGS = Object.freeze(["show", PODMAN_SERVICE_UNIT, "--timestamp=us+utc", "-p", "LoadState", "-p", "ActiveState", "-p", "ExecMainStartTimestamp", "-p", "Environment", "-p", "EnvironmentFiles", "-p", "FragmentPath", "-p", "DropInPaths", "-p", "ExecStart"]);
export const PODMAN_MANAGER_ENV_ARGS = Object.freeze(["show-environment"]);
export const PODMAN_SOCKET_SHOW_ARGS = Object.freeze(["show", PODMAN_SOCKET_UNIT, "-p", "Listen"]);
export const PODMAN_SERVICE_TIMEOUT_MS = 5000;

/** The unit states in which the service's process may be alive, holding the configuration it started with. */
const SERVICE_RUNNING_STATES = new Set(["active", "reloading", "deactivating", "activating", "refreshing"]);

/**
 * The variables of the service's environment that move which containers.conf it reads (issue #448, measured on rootful
 * Podman 5.8.1: `CONTAINERS_CONF` and `CONTAINERS_CONF_OVERRIDE` on podman.service were honoured, and so was root's own
 * `~/.config/containers/containers.conf` with no `HOME` in the unit). `HOME` and `XDG_CONFIG_HOME` move that last one.
 */
export const PODMAN_SERVICE_CONF_VARS = Object.freeze(["CONTAINERS_CONF", "CONTAINERS_CONF_OVERRIDE", "HOME", "XDG_CONFIG_HOME"]);

/**
 * Where rootful Podman resolves a relative `--module <name>` (containers/common `ModuleDirectories`: `/etc` first, then
 * `/usr/share`; the user's own directory only when rootless). A module is one more containers.conf, read after the
 * system chain and before `CONTAINERS_CONF_OVERRIDE` (measured: `--module` in the unit's `LOGGING=` reached jobs).
 */
export const PODMAN_MODULE_DIRS = Object.freeze(["/etc/containers/containers.conf.modules", "/usr/share/containers/containers.conf.modules"]);

/** `systemctl show`'s space-separated value as words: a `"..."` word may hold spaces and backslash escapes. */
export function splitUnitWords(value) {
	const words = [];
	const text = String(value ?? "");
	let i = 0;
	while (i < text.length) {
		while (text[i] === " ") i++;
		if (i >= text.length) break;
		let word = "";
		let quoted = false;
		for (; i < text.length; i++) {
			const c = text[i];
			if (c === "\\" && i + 1 < text.length) {
				word += text[++i];
				continue;
			}
			if (c === '"') {
				quoted = !quoted;
				continue;
			}
			if (c === " " && !quoted) break;
			word += c;
		}
		words.push(word);
	}
	return words;
}

/**
 * Every `--module` a list of words passes (`--module x` and `--module=x`). Read from `ExecStart`'s argv AND from every
 * value of the environment, split on whitespace, since an argv `$LOGGING` expands a variable's words into it (measured:
 * `LOGGING=--log-level=info --module=/x.conf`); a variable no argv names only makes the list longer, never shorter.
 */
export function moduleArgsIn(words) {
	const out = [];
	const list = [...words];
	for (let i = 0; i < list.length; i++) {
		const w = String(list[i]);
		if (w === "--module" && i + 1 < list.length) out.push(String(list[++i]));
		else if (w.startsWith("--module=")) out.push(w.slice("--module=".length));
	}
	return out.filter((m) => m !== "");
}

/** A `--timestamp=us+utc` value (`Mon 2026-09-28 06:18:14.656913 UTC`) as epoch milliseconds, or `null`. */
export function parseUnitTimestamp(value) {
	const m = /(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))? UTC$/.exec(String(value ?? "").trim());
	if (!m) return null;
	const [, y, mo, d, h, mi, s, frac = "0"] = m;
	return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) + Number(frac.padEnd(6, "0")) / 1000;
}

/** `NAME=VALUE` assignments as `{ vars, modules }`: the `PODMAN_SERVICE_CONF_VARS` kept, every value's `--module` read. */
function assignmentsOf(assignments) {
	const vars = {};
	const values = [];
	for (const word of assignments) {
		const eq = word.indexOf("=");
		if (eq <= 0) continue;
		const name = word.slice(0, eq);
		const value = word.slice(eq + 1);
		values.push(...value.split(/\s+/));
		if (PODMAN_SERVICE_CONF_VARS.includes(name)) (vars[name] ??= []).push(value);
	}
	return { vars, modules: moduleArgsIn(values) };
}

/**
 * `systemctl show`'s answer for `PODMAN_SERVICE_SHOW_ARGS`, as `{ loaded, running, startedAtMs, environment,
 * environmentFiles, unitPaths, modules }`, or `null` when no line names a load state. `environment` holds only the
 * `PODMAN_SERVICE_CONF_VARS` (every value of each, in order), never the rest, so nothing else the unit carries is ever
 * kept or logged; `modules` is every `--module` its `ExecStart` or its environment passes.
 */
export function parsePodmanServiceShow(stdout) {
	const props = {};
	for (const line of String(stdout ?? "").split("\n")) {
		const at = line.indexOf("=");
		if (at <= 0) continue;
		const name = line.slice(0, at);
		(props[name] ??= []).push(line.slice(at + 1));
	}
	if (!props.LoadState) return null;
	const { vars: environment, modules: envModules } = assignmentsOf((props.Environment ?? []).flatMap((v) => splitUnitWords(v)));
	// `ExecStart={ path=... ; argv[]=/usr/bin/podman $LOGGING system service ; ignore_errors=no ; ... }`, one per line.
	const argv = (props.ExecStart ?? []).flatMap((v) => {
		const m = /argv\[\]=(.*?)(?: ;|$)/.exec(v);
		return m ? m[1].split(/\s+/) : [];
	});
	// One `EnvironmentFiles=` line per file, `<path> (ignore_errors=yes|no)`; a path may be a wildcard pattern.
	const environmentFiles = (props.EnvironmentFiles ?? []).map((v) => v.replace(/\s+\(ignore_errors=\w+\)\s*$/, "").trim()).filter((p) => p.startsWith("/"));
	const unitPaths = [...(props.FragmentPath ?? []), ...(props.DropInPaths ?? []).flatMap((v) => splitUnitWords(v))].filter((p) => p.startsWith("/"));
	return {
		loaded: props.LoadState[0] === "loaded",
		running: SERVICE_RUNNING_STATES.has(props.ActiveState?.[0] ?? ""),
		startedAtMs: parseUnitTimestamp(props.ExecMainStartTimestamp?.[0]),
		environment,
		environmentFiles,
		unitPaths,
		modules: [...moduleArgsIn(argv), ...envModules],
	};
}

/**
 * `systemctl show-environment`'s answer as `{ environment, modules }`: one `NAME=VALUE` per line, where a value systemd
 * had to quote is printed `$'...'` (its C escapes undone here only for `\\` and `\'`, which is all a path needs).
 */
export function parseShowEnvironment(stdout) {
	const words = String(stdout ?? "")
		.split("\n")
		.filter((l) => l.includes("="))
		.map((l) => {
			const eq = l.indexOf("=");
			let value = l.slice(eq + 1);
			if (value.startsWith("$'") && value.endsWith("'")) value = value.slice(2, -1).replace(/\\(['\\])/g, "$1");
			return `${l.slice(0, eq)}=${value}`;
		});
	const { vars, modules } = assignmentsOf(words);
	return { environment: vars, modules };
}

/** `systemctl show -p Listen podman.socket`'s answer as the unix socket paths it listens on (`<path> (Stream)` each). */
export function parseSocketListen(stdout) {
	return String(stdout ?? "")
		.split("\n")
		.filter((l) => l.startsWith("Listen="))
		.map((l) => l.slice("Listen=".length).replace(/\s+\(\w+\)\s*$/, "").trim())
		.filter((p) => p.startsWith("/"));
}

/** A reader's failure as a reason token: `systemctl-not-found`, `timeout`, `exit-<n>` or `spawn-failed`. */
function runFailure(result) {
	const error = result?.error ?? null;
	if (error?.code === "ENOENT") return "systemctl-not-found";
	if (error || result?.code !== 0) return error?.timedOut || error?.killed ? "timeout" : typeof result?.code === "number" ? `exit-${result.code}` : "spawn-failed";
	return null;
}

/**
 * The reader: `async () => ({ read: true, loaded, running, startedAtMs, environment, environmentFiles, unitPaths,
 * modules, manager, listen })` or `{ read: false, reason }`. `manager` is `{ read: true, environment, modules }` or
 * `{ read: false, reason }`, and `listen` the socket's paths or `{ reason }`: each of the two extra reads fails on its own,
 * as a named residual, never the whole answer. `run(args)` is the seam, returning `{ code, stdout, error }` as the docker
 * readers' does. No `sudo`: every read is one any account may make.
 */
export function makePodmanServiceReader({ run = (args) => execDockerBounded(args, { bin: "systemctl", timeoutMs: PODMAN_SERVICE_TIMEOUT_MS }) } = {}) {
	const ask = async (args) => {
		try {
			return await run(args);
		} catch (err) {
			return { code: null, stdout: "", error: err };
		}
	};
	return async function readPodmanService() {
		const result = await ask(PODMAN_SERVICE_SHOW_ARGS);
		const failed = runFailure(result);
		if (failed) return { read: false, reason: failed };
		const parsed = parsePodmanServiceShow(result.stdout);
		if (!parsed) return { read: false, reason: "unparseable" };
		const env = await ask(PODMAN_MANAGER_ENV_ARGS);
		const envFailed = runFailure(env);
		const sock = await ask(PODMAN_SOCKET_SHOW_ARGS);
		const sockFailed = runFailure(sock);
		return {
			read: true,
			...parsed,
			manager: envFailed ? { read: false, reason: envFailed } : { read: true, ...parseShowEnvironment(env.stdout) },
			listen: sockFailed ? { reason: sockFailed } : parseSocketListen(sock.stdout),
		};
	};
}

/** The values an environment file sets, by systemd's `KEY=VALUE` lines, quotes stripped, as `assignmentsOf` reads them. */
function envFileAssignments(text) {
	const words = [];
	for (const raw of String(text).split("\n")) {
		const line = raw.trim().replace(/^export\s+/, "");
		if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		let value = line.slice(eq + 1).trim();
		if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
		words.push(`${line.slice(0, eq).trim()}=${value}`);
	}
	return assignmentsOf(words);
}

/** Root's home from `/etc/passwd` (uid 0), or `null`: where Podman looks for root's own containers.conf with no HOME set. */
function rootHomeFrom(fs) {
	const got = readHostFile(fs, "/etc/passwd");
	for (const line of String(got.text ?? "").split("\n")) {
		const f = line.split(":");
		if (f.length >= 7 && f[2] === "0" && f[5].startsWith("/")) return f[5];
	}
	return null;
}

/** A shell glob component (`*`, `?`, `[...]`) as an anchored RegExp, the only wildcard systemd's `EnvironmentFile=` takes. */
function globComponent(part) {
	let re = "";
	for (let i = 0; i < part.length; i++) {
		const c = part[i];
		if (c === "*") re += "[^/]*";
		else if (c === "?") re += "[^/]";
		else if (c === "[") {
			const close = part.indexOf("]", i + 1);
			if (close < 0) re += "\\[";
			else {
				re += `[${part.slice(i + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
				i = close;
			}
		} else re += c.replace(/[.+^${}()|\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`);
}

/**
 * An `EnvironmentFile=` path with its wildcards expanded against the host, as `{ paths }`, or `{ unreadable: { path,
 * code } }` / `{ transient }` when a directory on the way cannot be listed (gate round 1: systemd takes a wildcard
 * pattern there, which the first reading treated as one literal path and so never read). A pattern with no wildcard is
 * itself. Hidden entries are not matched by `*`, as in a shell.
 */
export function expandEnvironmentFilePattern(fs, pattern) {
	if (!/[*?[]/.test(pattern)) return { paths: [pattern] };
	let bases = ["/"];
	for (const part of pattern.split("/").filter((p) => p !== "")) {
		const next = [];
		for (const base of bases) {
			if (!/[*?[]/.test(part)) {
				next.push(`${base === "/" ? "" : base}/${part}`);
				continue;
			}
			let entries;
			try {
				entries = fs.readdirSync(base);
			} catch (error) {
				const code = error?.code ?? "error";
				if (code === "ENOENT" || code === "ENOTDIR") continue;
				if (TRANSIENT_READ_ERRORS.has(code)) return { transient: { path: base, code } };
				return { unreadable: { path: base, code } };
			}
			const re = globComponent(part);
			for (const e of [...entries].sort()) if (!String(e).startsWith(".") && re.test(String(e))) next.push(`${base === "/" ? "" : base}/${e}`);
		}
		bases = next;
	}
	return { paths: bases };
}

/**
 * EVERY containers.conf rootful Podman's API service may read (issue #448), as `{ files, watched, unread, nameable,
 * envFiles }`, plus at most one stop: `transient: { path, code }` when a read failed for a moment,
 * `unreadable: { path, code }` when a part outside root's own config home exists and cannot be read, or
 * `unjudgeable: { module }`. The chain is containers/common v0.67.0's
 * (`systemConfigs`, measured on rootful Podman 5.8.1 and 4.9.3 by a drop-in in each candidate place):
 *   - `PODMAN_CONTAINERS_CONF_FILES` and every `*.conf` in `/etc/containers/containers.conf.d` (NOT
 *     `/usr/share/containers/containers.conf.d` nor either `containers.rootful.conf.d`: no Podman measured read them);
 *   - ROOT'S OWN `<config home>/containers/containers.conf` and its `containers.conf.d`, measured honoured by the service
 *     (with no `HOME` in the unit Podman takes root's home from passwd). The config home is every `XDG_CONFIG_HOME` and
 *     every `HOME`/.config the unit, its environment files or the manager set, and root's passwd home (`/root` when
 *     passwd names none);
 *   - every `--module` the unit passes, resolved as Podman does (`PODMAN_MODULE_DIRS`, or the path when absolute);
 *   - every file `CONTAINERS_CONF` and `CONTAINERS_CONF_OVERRIDE` name, from the unit's `Environment=`, each
 *     `EnvironmentFile=` (wildcards expanded) and the manager's environment, and, where the docker command is
 *     podman-docker (`shape: "podman"`, which may run Podman in the worker's own process), the worker's own. JUDGED IN
 *     ADDITION to the system chain, never instead of it: a superset can only refuse more.
 * READ WHAT CAN BE READ, REFUSE WHAT CANNOT, with ONE exception (gate round 1, where a `0600` root drop-in in `/etc`
 * applied `env` to jobs while doctor said ✓): a path under a root config home (`nameable`) that this account cannot read
 * is named and not judged, since root's home is `0550` or `0700` on every stock host and a worker that is not root reads
 * none of it; any other part of the chain that exists and cannot be read is `unreadable`, which refuses (and withholds
 * `mountSet`), as the native venue's chain always has.
 * A drop-in directory's `*.conf` that is itself a directory is skipped, as Podman skips it; a `--module` that names no
 * file is `unjudgeable` (`{ module }`) and refuses, since systemctl's unquoted argv cannot say where a path with a
 * space ends. The first such stop is returned BESIDE `files` and `watched`, never instead of them, so the deletion memory
 * still records every existing file before the refusal (gate round 2 of PR #473).
 * `files` is every chain file judged, and `watched` what the running service may have
 * read: every existing chain file, every drop-in directory that exists (a drop-in added, removed or renamed changes it),
 * every module and environment file, and the unit's own files. NOT a chain file's parent directory: unrelated files
 * live there (`sed -i registries.conf` changed `/etc/containers` and refused jobs, gate round 1), and a chain file's own
 * change time already moves when it is replaced by a rename.
 */
export function rootfulConfChain({ fs, unit, env = {}, facts = {} }) {
	const unread = [];
	const unitRead = unit?.read === true;
	const values = Object.fromEntries(PODMAN_SERVICE_CONF_VARS.map((name) => [name, [...(unitRead ? (unit.environment?.[name] ?? []) : [])]]));
	const modules = [...(unitRead ? (unit.modules ?? []) : [])];
	const managerRead = unitRead && unit.manager?.read === true;
	if (managerRead) {
		for (const name of PODMAN_SERVICE_CONF_VARS) values[name].push(...(unit.manager.environment?.[name] ?? []));
		modules.push(...(unit.manager.modules ?? []));
	}
	if (facts?.shape === "podman") {
		for (const name of PODMAN_SERVICE_CONF_VARS) if (typeof env?.[name] === "string" && env[name] !== "") values[name].push(env[name]);
	}
	// The config homes first, so `nameable` is known before anything is read. An environment file cannot move them: it is
	// read below, and a HOME it sets is judged too (added after), so a file it names is read, never merely named.
	const homesOf = () => new Set([rootHomeFrom(fs) ?? "/root", ...values.HOME.filter((h) => h.startsWith("/"))]);
	const configHomesOf = () => [...new Set([...values.XDG_CONFIG_HOME.filter((x) => x.startsWith("/")), ...[...homesOf()].map((h) => `${h}/.config`)])];
	let homesNow = configHomesOf();
	const nameable = (path) => homesNow.some((c) => path === c || path.startsWith(`${c}/`));
	// The FIRST part that stops the judgement (`transient`, `unreadable`, `unjudgeable`) is kept and the walk goes on, so
	// the caller still learns every chain file that exists: the deletion memory records them before any refusal returns
	// (gate round 2 of PR #473: a file only ever refused for a key was never remembered, so deleting it under the running
	// service let the next job through while the service still applied the key, measured on Ubuntu).
	let stop = null;
	const cannotRead = (path, code) => {
		if (TRANSIENT_READ_ERRORS.has(code)) stop ??= { transient: { path, code } };
		else if (nameable(path)) unread.push({ path, code });
		else stop ??= { unreadable: { path, code } };
	};
	const envFiles = [];
	for (const pattern of unitRead ? (unit.environmentFiles ?? []) : []) {
		const expanded = expandEnvironmentFilePattern(fs, pattern);
		if (expanded.transient) {
			stop ??= { transient: expanded.transient };
			continue;
		}
		if (expanded.unreadable) {
			cannotRead(expanded.unreadable.path, expanded.unreadable.code);
			continue;
		}
		envFiles.push(...expanded.paths);
	}
	for (const file of envFiles) {
		const got = readHostFile(fs, file);
		if (got.missing) continue;
		if (got.text === undefined) {
			cannotRead(file, got.error);
			continue;
		}
		const { vars, modules: m } = envFileAssignments(got.text);
		for (const [name, vs] of Object.entries(vars)) values[name].push(...vs);
		modules.push(...m);
	}
	const absolute = (v) => (v.startsWith("/") ? v : `/${v}`);
	const configHomes = configHomesOf();
	homesNow = configHomes;
	const named = [...values.CONTAINERS_CONF, ...values.CONTAINERS_CONF_OVERRIDE].filter((v) => v !== "").map(absolute);
	const moduleFiles = modules.flatMap((m) => (m.startsWith("/") ? [m] : PODMAN_MODULE_DIRS.map((d) => `${d}/${m}`)));
	// A `--module` that names no file is UNJUDGEABLE, and refuses (gate round 2 of PR #473): systemctl prints an argv
	// unquoted (`--module /etc/a b.conf` is two words or one, it cannot say), and a variable's words split the way
	// `$LOGGING` splits them, not the way `${LOGGING}` would, so a module path holding a space is read cut short. A path
	// that exists is what Podman read; one that does not is either such a cut or a module Podman itself fails to load,
	// and neither is guessed at. A stat that fails for another reason is left to the read below.
	for (const m of modules) {
		const candidates = m.startsWith("/") ? [m] : PODMAN_MODULE_DIRS.map((d) => `${d}/${m}`);
		const missing = candidates.every((c) => {
			try {
				fs.statSync(c);
				return false;
			} catch (error) {
				return error?.code === "ENOENT";
			}
		});
		if (missing) stop ??= { unjudgeable: { module: m } };
	}
	const files = [...new Set([...PODMAN_CONTAINERS_CONF_FILES, ...configHomes.map((c) => `${c}/containers/containers.conf`), ...moduleFiles, ...named])];
	const dirs = [...PODMAN_CONTAINERS_CONF_DIRS, ...configHomes.map((c) => `${c}/containers/containers.conf.d`)];
	const dropIns = [];
	const existingDirs = [];
	for (const dir of dirs) {
		let entries;
		try {
			entries = fs.readdirSync(dir);
		} catch (error) {
			const code = error?.code ?? "error";
			if (code === "ENOENT") continue;
			cannotRead(dir, code);
			continue;
		}
		existingDirs.push(dir);
		for (const entry of [...entries].sort()) if (String(entry).endsWith(".conf") && !isDirectoryAt(fs, `${dir}/${entry}`)) dropIns.push(`${dir}/${entry}`);
	}
	const judged = [...files, ...dropIns];
	const watched = [...new Set([...judged, ...existingDirs, ...(unitRead ? (unit.unitPaths ?? []) : []), ...envFiles])];
	return { files: judged, watched, unread, nameable, envFiles, ...(stop ?? {}) };
}

/**
 * The vendor's own blocks both venues accept as they ship (issue #448): the stock containers.conf of Fedora 44
 * (containers-common 0.67.0) and Ubuntu 24.04 (golang-github-containers-common) both set, uncommented,
 * `default_sysctls = ["net.ipv4.ping_group_range=0 0"]`, which was measured reaching a job (its ping_group_range read
 * `0 0`, and `1 0` once a drop-in replaced it). Refusing the key on presence would refuse every stock host, which is
 * worse, and the exception is exact: that block, at the start of a line, with only whitespace and an optional trailing
 * comma around its one string, is blanked before the scan; any other value, spelling, or a second sysctl beside it is
 * still refused.
 */
export const STOCK_CONF_BLOCKS = Object.freeze([/^[ \t]*default_sysctls[ \t]*=[ \t]*\[\s*"net\.ipv4\.ping_group_range=0 0"\s*,?\s*\][ \t]*(?:#[^\n]*)?$/gm]);

/** `text` with every `STOCK_CONF_BLOCKS` match blanked, its newlines kept so line numbers stay true. */
export function stripStockBlocks(text) {
	return STOCK_CONF_BLOCKS.reduce((t, block) => t.replace(block, (m) => m.replace(/[^\n]/g, " ")), String(text));
}

/** What each key the rootful check refuses does to a local job, completing the sentence that names the file it is in. */
export const ROOTFUL_WIDENING_KEY_SAYS = Object.freeze({
	annotations: "sets annotations, which rootful Podman adds to every container, where run.oci.keep_original_groups=1 gives a local job the supplementary groups of the Podman service that starts it (root's, and any SupplementaryGroups= on podman.service)",
	env: "sets env, which under [containers] adds variables to every local job past the worker's own closed environment, and under [engine] is the Podman service's own environment",
	helper_binaries_dir: "sets helper_binaries_dir, which is where rootful Podman finds the netavark and aardvark-dns it runs as root to set up every local job's network, so another program can stand in for them",
	default_sysctls: "sets default_sysctls, which rootful Podman sets in every local job (any value but the vendor's own ping_group_range block)",
	default_ulimits: "sets default_ulimits, which rootful Podman sets on every local job's processes",
	userns: "sets userns, which puts every local job in a user namespace the worker's argv does not name (with auto and no subordinate range, the job cannot even be created)",
	pidns: "sets pidns, which asks for a PID namespace the worker's argv does not name (the host's was refused at create against the job's --init)",
	ipcns: "sets ipcns, which asks for an IPC namespace the worker's argv does not name (the host's was refused at create against the job's --shm-size)",
	utsns: "sets utsns, which gives every local job the UTS namespace it names, the host's hostname with host",
	cgroupns: "sets cgroupns, which gives every local job the cgroup namespace it names, the host's with host",
	netns: "sets netns, which gives a local job with no network of its own the network namespace it names, the host's with host",
	seccomp_profile: "sets seccomp_profile, which replaces the seccomp filter of every local job",
	apparmor_profile: "sets apparmor_profile, which replaces every local job's AppArmor profile where AppArmor runs (unconfined removed the containers-default profile, measured)",
	init_path: "sets init_path, which names the binary that runs as every local job's PID 1",
	dns_servers: "sets dns_servers, which writes the nameservers of a local job with no network of its own",
	dns_options: "sets dns_options, which writes every local job's resolver options",
	dns_searches: "sets dns_searches, which writes every local job's resolver search list",
	base_hosts_file: "sets base_hosts_file, which names the file every local job's /etc/hosts starts from",
	label: "sets label, which with false runs every local job unconfined by SELinux (spc_t, measured)",
	cgroup_conf: "sets cgroup_conf, which writes cgroup files of every local job past its own bounds (pids.max=max outlasted --pids-limit, measured)",
	host_containers_internal_ip: "sets host_containers_internal_ip, which names the address every local job reaches as host.containers.internal",
	runtimes: "sets runtimes, which as the [engine.runtimes] table names the OCI runtime binary that creates every local job (a wrapper there ran for every job, measured)",
	conmon_path: "sets conmon_path, which names the conmon that monitors every local job (a wrapper there ran for every job, measured)",
	cgroups: "sets cgroups, which with disabled runs every local job outside its cgroup with its pids and memory bounds unapplied (measured)",
});

/**
 * Whether a local job runs on rootful Podman's Docker API service ON THIS HOST (issue #448): the daemon answered as
 * Podman, not rootless (an unknown answer counts, so the check fails closed), with its files this host's
 * (`podmanOnThisHost`). A remote endpoint, Docker, and rootless Podman are not this check's, and get exactly what they got.
 */
export function rootfulPodmanHere({ endpoint, daemon }) {
	return daemon?.answered === true && daemon.facts?.podman === true && daemon.facts.rootless !== true && podmanOnThisHost({ endpoint, facts: daemon.facts });
}

/** The unix socket path this endpoint reaches: the docker endpoint's own, else podman-docker's reported socket. */
export function endpointSocketPath({ endpoint, facts }) {
	if (endpoint?.local === true && typeof endpoint.endpoint === "string" && endpoint.endpoint.startsWith("unix://")) return endpoint.endpoint.slice("unix://".length);
	if (facts?.shape === "podman" && typeof facts.remoteSocketPath === "string") return facts.remoteSocketPath.replace(/^unix:\/\//, "");
	return null;
}

/**
 * The per-worker memory the deletion rule reads (`{ startedAtMs, files, deleted }`, mutated in place): which chain files
 * existed while the same service start ran. A file that existed then and is gone now was DELETED after the running
 * service read it, which no change time shows (the file has none, and its directory's also moves for unrelated files).
 * Sticky until the service's start changes, so the widening check and the mounts observation, which both ask, agree.
 */
export function makeRootfulMemory() {
	return { startedAtMs: null, files: new Set(), deleted: null };
}

/**
 * `fs` answering each `statSync`, `readFileSync` and `readdirSync` call ONCE per distinct arguments, a thrown error
 * included, for one job's (or one boot's) two checks, the widening check and the mounts observation, which read the same
 * chain (gate round 3 of PR #473: with 1000 drop-ins the two cost 44 ms a job, 8025 stats and 2011 reads, each path
 * stat-ed several times over). One per job, never kept past it: a file must be read afresh by the next job.
 */
export function onceFs(fs) {
	const memo = (fn) => {
		const seen = new Map();
		return (...args) => {
			const key = JSON.stringify(args);
			if (!seen.has(key)) {
				try {
					seen.set(key, { value: fn(...args) });
				} catch (error) {
					seen.set(key, { error });
				}
			}
			const got = seen.get(key);
			if ("error" in got) throw got.error;
			return got.value;
		};
	};
	return { statSync: memo((...a) => fs.statSync(...a)), readFileSync: memo((...a) => fs.readFileSync(...a)), readdirSync: memo((...a) => fs.readdirSync(...a)) };
}

/** Whether `path` exists (a stat that fails other than ENOENT counts as existing: it is there, only not stat-able). */
function existsAt(fs, path) {
	try {
		fs.statSync(path);
		return true;
	} catch (error) {
		return error?.code !== "ENOENT";
	}
}

/**
 * Records in `memory` every path the running service may have read that exists now (`chain.watched`: the chain files,
 * the drop-in directories, the environment and unit files, and the part that stopped the walk), while podman.service
 * runs from one parseable start, and starts afresh when that start changes (a stopped service is reset by
 * `serviceChangedSince`, and a new start always has a new time). Called FIRST by both callers, before any refusal returns
 * (gate round 2 of PR #473): a file refused for a key, unreadable, or seen only by an observation that returned early
 * (stock Ubuntu has no mounts.conf) is still remembered, so deleting it under the running service holds the next job.
 * An environment file is remembered too: deleted, the service still has what it set, while the chain no longer names
 * the file it pointed at.
 */
export function rememberChain({ fs, unit, chain, memory }) {
	if (!memory || !unit?.read || !unit.loaded || !unit.running || typeof unit.startedAtMs !== "number") return;
	if (memory.startedAtMs !== unit.startedAtMs) Object.assign(memory, { startedAtMs: unit.startedAtMs, files: new Set(), deleted: null });
	const stopped = chain.unreadable?.path ?? chain.transient?.path;
	for (const f of [...(chain.watched ?? []), ...(stopped ? [stopped] : [])]) if (existsAt(fs, f)) memory.files.add(f);
}

/**
 * THE RUNNING SERVICE (ledger L20), one rule for the widening check and the mounts observation, as `{ path }` (a watched
 * path changed after the service started), `{ deleted }` (a chain file this worker saw during this service start is
 * gone), `{ skew }` (a change time later than now), `{ transient: { path, code } }`, `{ unreadable: { path, code } }`,
 * or `{}`. Judged by CHANGE TIME (`ctimeMs`), which the kernel sets and no `cp -p` or `touch -d` can set back (gate round
 * 1: a key removed by a copy that kept an old mtime, and a future mtime that refused forever, restarts included). A
 * change time after `now` is the host clock's problem, said as such, never "restart". What cannot be judged about the
 * service is named: systemctl that did not answer, a unit not loaded, a running one whose start did not parse.
 */
function serviceChangedSince({ fs, unit, chain, unread, now, memory }) {
	if (!unit?.read) {
		unread.push({ path: PODMAN_SERVICE_UNIT, code: unit?.reason ?? "not-read" });
		return {};
	}
	if (!unit.loaded) {
		unread.push({ path: PODMAN_SERVICE_UNIT, code: "not-loaded" });
		return {};
	}
	if (!unit.running) {
		if (memory) Object.assign(memory, makeRootfulMemory());
		return {};
	}
	if (typeof unit.startedAtMs !== "number") {
		unread.push({ path: PODMAN_SERVICE_UNIT, code: "start-time-unread" });
		return {};
	}
	const existing = new Set();
	let found = {};
	for (const path of chain.watched) {
		let st;
		try {
			st = fs.statSync(path);
		} catch (error) {
			const code = error?.code ?? "error";
			if (code === "ENOENT") continue;
			if (TRANSIENT_READ_ERRORS.has(code)) return { transient: { path, code } };
			if (chain.nameable(path)) {
				unread.push({ path, code });
				existing.add(path);
				continue;
			}
			return { unreadable: { path, code } };
		}
		existing.add(path);
		const ctimeMs = st?.ctimeMs;
		if (typeof ctimeMs !== "number" || found.path || found.skew) continue;
		if (ctimeMs > now) found = { skew: path };
		else if (ctimeMs > unit.startedAtMs) found = { path };
	}
	if (memory) {
		rememberChain({ fs, unit, chain, memory });
		// Deleted means gone from disk, not merely off the chain: a file the chain stopped naming because its environment
		// file went is caught by that file's own deletion (remembered above), and one still on disk is not a deletion.
		if (!memory.deleted) memory.deleted = [...memory.files].find((f) => !existing.has(f) && !existsAt(fs, f)) ?? null;
		if (!found.path && !found.skew && memory.deleted) return { deleted: memory.deleted };
	}
	return found;
}

/** The evidence for a `--module` that names no file (`rootfulConfChain`'s `unjudgeable`). */
function moduleEvidence(module) {
	return `${PODMAN_SERVICE_UNIT} passes --module ${module}, which names no file here, so what it loads cannot be judged (systemctl prints the service's arguments unquoted, so a module path holding a space is read cut short)`;
}

/** The evidence of a `serviceChangedSince` answer that holds jobs back until the service restarts, or `null`. */
function staleEvidence(stale, what) {
	if (stale.skew) return `${stale.skew} has a change time later than this host's clock, so whether the running ${PODMAN_SERVICE_UNIT} read it cannot be told`;
	if (stale.deleted) return `${stale.deleted} was removed after the running ${PODMAN_SERVICE_UNIT} started, and a running Podman service keeps the containers.conf it started with, so ${what}`;
	if (stale.path) return `${stale.path} changed after the running ${PODMAN_SERVICE_UNIT} started, and a running Podman service keeps the containers.conf it started with, so ${what}`;
	return null;
}

/**
 * The rootful chain judged (issue #448), as `{ refusal, unread }`. `refusal` is a `podman-conf-widens-job` finding with
 * `rootful: true`, or `null`:
 *   - a file in `rootfulConfChain` that sets `PODMAN_ROOTFUL_WIDENING_KEYS` (`key`), or one this check cannot decode
 *     (`key: null`, `spelling`), or a part outside root's config home that exists and cannot be read (`key: null`), by
 *     `confWidening`, the scan the rootless check uses;
 *   - `transient: true` when a read failed for a moment;
 *   - `restart: true` (THE RUNNING SERVICE, ledger L20): podman.service is running and a path it may have read changed
 *     after it started, or a chain file this worker saw during this start is gone; `skew: true` when a change time is
 *     later than now. Measured: a running service does not read its containers.conf again. These three are RETRIES,
 *     never a final refusal (gate round 1): each heals by itself, the first two once the service restarts or idles
 *     out, the last once the clock passes, so the caller throws for the queue's retry and a boot exits 1.
 * `unread` is every part not judged, NAMED, never refused on: a path under a root config home this account cannot read,
 * and podman.service or the manager's environment when `systemctl` did not answer for it, or when the worker's socket is
 * not the one `podman.socket` listens on (then the service behind it is not podman.service, and its environment and
 * start are another process's, root's to read: the files are still judged).
 */
export function rootfulConfWidening({ fs, unit, env = {}, facts = {}, now = Date.now(), memory }) {
	const chain = rootfulConfChain({ fs, unit, env, facts });
	rememberChain({ fs, unit, chain, memory });
	const retry = (evidence, extra) => ({ refusal: { cause: PODMAN_CONF_WIDENS_JOB, key: null, rootful: true, ...extra, evidence }, unread: [] });
	if (chain.transient) return retry(`${chain.transient.path} could not be read (${chain.transient.code})`, { transient: true });
	if (chain.unreadable) return { refusal: { cause: PODMAN_CONF_WIDENS_JOB, key: null, rootful: true, evidence: `${chain.unreadable.path} could not be read (${chain.unreadable.code})` }, unread: [] };
	if (chain.unjudgeable) return { refusal: { cause: PODMAN_CONF_WIDENS_JOB, key: null, rootful: true, module: chain.unjudgeable.module, evidence: moduleEvidence(chain.unjudgeable.module) }, unread: [] };
	const unread = [...chain.unread];
	if (unit?.read && unit.manager && unit.manager.read !== true) unread.push({ path: "the systemd manager environment", code: unit.manager.reason ?? "not-read" });
	const done = (refusal) => ({ refusal, unread: dedupeUnread(unread) });
	const found = confWidening(fs, chain.files, { keys: PODMAN_ROOTFUL_WIDENING_KEYS, says: ROOTFUL_WIDENING_KEY_SAYS, unread, nameable: chain.nameable, strip: stripStockBlocks });
	if (found?.value === null) return retry(found.evidence, { transient: true });
	if (found) return done({ cause: PODMAN_CONF_WIDENS_JOB, key: found.key, rootful: true, evidence: found.evidence, ...(found.spelling ? { spelling: found.spelling } : {}) });
	const stale = serviceChangedSince({ fs, unit, chain, unread, now, memory });
	if (stale.transient) return retry(`${stale.transient.path} could not be read (${stale.transient.code})`, { transient: true });
	if (stale.unreadable) return done({ cause: PODMAN_CONF_WIDENS_JOB, key: null, rootful: true, evidence: `${stale.unreadable.path} could not be read (${stale.unreadable.code})` });
	const evidence = staleEvidence(stale, "a key removed since may still reach every local job");
	if (evidence) return done({ cause: PODMAN_CONF_WIDENS_JOB, key: null, rootful: true, ...(stale.skew ? { skew: true } : { restart: true }), evidence });
	return done(null);
}

/** `unread` with each path once, sorted, so a list said twice reads the same. */
function dedupeUnread(unread) {
	const seen = new Set();
	return unread.filter((u) => (seen.has(u.path) ? false : (seen.add(u.path), true))).sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

/**
 * `rootfulConfWidening` for one local job's endpoint and daemon read, or `null` where it does not apply
 * (`rootfulPodmanHere`): so a Docker host, a remote endpoint and rootless Podman read no file and spawn nothing.
 * `readService` is `makePodmanServiceReader()`'s reader; `memory` the caller's `makeRootfulMemory()`.
 */
export async function observeRootfulConf({ endpoint, daemon, fs, readService, env = {}, unit, now, memory }) {
	if (!rootfulPodmanHere({ endpoint, daemon })) return null;
	return rootfulConfWidening({ fs, unit: unit ?? (await readRootfulService({ endpoint, daemon, readService })), env, facts: daemon.facts, ...(now !== undefined ? { now } : {}), memory });
}

/** `path` with every symlink resolved (`fs.realpathSync`), or `path` itself when it cannot be (it does not exist here). */
export function realpathOrSelf(path) {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * `systemctl show podman.service` where `rootfulPodmanHere` holds, else `undefined` (nothing spawned): read ONCE per boot
 * or job and handed to both `observeHost` (the mounts observation) and `observeRootfulConf`, so the two judge one answer.
 * TRUSTED ONLY FOR ITS OWN SOCKET (gate round 1: a second rootful API service on another socket, with its own
 * `CONTAINERS_CONF_OVERRIDE`, reached jobs while this check read podman.service's clean environment): when the worker's
 * socket is not one `podman.socket` listens on, or that could not be read, the unit is not this service's, and is
 * answered `{ read: false, reason }`, a named residual. Named rather than refused: that other service's environment,
 * modules and start are its own process's, which only root can read, the same class as root's own config home; the
 * files it shares with every rootful Podman on the host are still judged, and doctor says which socket was not trusted.
 * A reader that throws is `{ read: false, reason: "spawn-failed" }`.
 */
export async function readRootfulService({ endpoint, daemon, readService, realpath = realpathOrSelf }) {
	if (!rootfulPodmanHere({ endpoint, daemon })) return undefined;
	let unit;
	try {
		unit = await readService();
	} catch {
		return { read: false, reason: "spawn-failed" };
	}
	if (!unit?.read) return unit;
	const socket = endpointSocketPath({ endpoint, facts: daemon.facts });
	// Both sides RESOLVED before they are compared (gate round 2 of PR #473): `/var/run/podman/podman.sock` is
	// `/run/podman/podman.sock` through the `/var/run` symlink, and the string compare named podman.service untrusted.
	const resolved = new Set((Array.isArray(unit.listen) ? unit.listen : []).map((p) => realpath(p)));
	if (!Array.isArray(unit.listen)) return { read: false, reason: `${PODMAN_SOCKET_UNIT} not read (${unit.listen?.reason ?? "not-read"}), so the service behind ${socket ?? "this socket"} is not known to be ${PODMAN_SERVICE_UNIT}` };
	if (socket === null || !resolved.has(realpath(socket))) return { read: false, reason: `the worker's socket ${socket ?? "(none)"} is not the one ${PODMAN_SOCKET_UNIT} listens on (${unit.listen.join(", ") || "none"}), so the service behind it is not ${PODMAN_SERVICE_UNIT}` };
	return unit;
}

/** The unread parts of a rootful chain, as one clause: `/root/.config/containers/containers.conf (EACCES), ...`. */
export function rootfulUnreadList(unread) {
	return (unread ?? []).map((u) => `${u.path} (${u.code})`).join(", ");
}

/** The residual said beside a rootful answer with parts unread (issue #448): doctor's line and the worker's log. */
export function rootfulConfResidual(unread) {
	return `rootful Podman's service may also read ${rootfulUnreadList(unread)}, which this account cannot read, so a key set there is not judged: run the worker as an account that can read them, or check them yourself as root for any key the local venue refuses (docs/podman.md) or a volumes, mounts, devices or hooks_dir key`;
}

/**
 * THE HOLD (gate round 2 of PR #473): a local job held by `restart` or `skew` is moved back to the queue's delayed set
 * every `PODMAN_RESTART_HOLD_RECHECK_MS` WITHOUT spending an attempt (`moveToDelayed`, as the pause and wait gates do),
 * because a service held up past one 60 s retry backoff turned a "retried, heals by itself" job into a terminal failure
 * (measured). Bounded: past `PODMAN_RESTART_HOLD_MAX_MS` of holding, the job fails with its own reason token,
 * `PODMAN_RESTART_HOLD_EXPIRED`, whose forge comment names the restart.
 */
export const PODMAN_RESTART_HOLD_RECHECK_MS = 60_000;
export const PODMAN_RESTART_HOLD_MAX_MS = 3_600_000;
export const PODMAN_RESTART_HOLD_EXPIRED = "podman-service-restart-hold-expired";

/** Whether a rootful finding holds jobs back only until something heals by itself (a retry), not a configuration fix. */
export function rootfulConfRetries(found) {
	return found?.transient === true || found?.restart === true || found?.skew === true;
}

/** The remedy half of `rootfulConfRefusal`, alone, for doctor's fix line. */
export function rootfulConfFix(found) {
	const restart = `sudo systemctl restart ${PODMAN_SERVICE_UNIT} while no local job runs (a running job's docker run holds the service up), or stop it and let podman.socket start it again on the next request`;
	const held = `each local job is held, never refused: it goes back to the queue and is checked again every minute without spending an attempt, and fails, with a comment naming this, only after an hour of holding; a boot exits 1 to be restarted`;
	if (found?.transient) return "the read failed for a moment, not for a reason in the file; a job refused this way is retried once (the queue's second attempt) and a boot exits to be restarted, so if it recurs, fix what the host ran out of (file descriptors, memory, a failing disk)";
	if (found?.skew) return `fix this host's clock, or wait until it passes that file's change time; until then ${held}. Then ${restart} if it runs`;
	if (found?.restart) return `${restart}, so the service reads the files as they are now; until it does, ${held}. It heals by itself once the service idles out`;
	if (found?.module) return `give that module a path with no space, or remove that --module from ${PODMAN_SERVICE_UNIT} (its ExecStart or the variable that carries it), then ${restart}: the local venue judges every module the service loads, and refuses one it cannot find rather than guess where its path ends`;
	if (found?.key) {
		const listed = PODMAN_ROOTFUL_WIDENING_KEYS.join(", ").replace(/, ([^,]*)$/, " or $1");
		return `remove that key from that file, then ${restart}. The local venue refuses any containers.conf rootful Podman's service reads that sets ${listed}, whatever the value, because no flag on a job's command line takes it back. A setting you need for your own containers goes on their own command line instead, not host-wide`;
	}
	if (found?.spelling) return `rewrite ${found.spelling === "escaped" ? "that key without a backslash escape" : "that line in plain ASCII with no \"\"\" or ''' multi-line string"}: this check reads a containers.conf only in plain ASCII with plain keys, and refuses what it cannot read rather than guess`;
	return "make that file readable by the worker's account (only root's own config home may stay unreadable, and is then named, not judged): the local venue must read every other containers.conf rootful Podman's service reads to know that none of them widens a job, and refuses what it cannot read";
}

/** The operator text for a rootful finding: the boot refusal, doctor's fix and the per-job log line, never a forge comment. */
export function rootfulConfRefusal(found) {
	return `${found?.transient ? "Not read yet" : rootfulConfRetries(found) ? "Not run yet" : "Refused"}: ${found?.evidence ?? "rootful Podman's containers.conf chain was not read"}; ${rootfulConfFix(found)} (issue #448).`;
}
