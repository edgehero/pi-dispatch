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

import { DAEMON_APPLIES_BOUNDS, DOCKER_ENDPOINT_LOCAL, RUNTIME_ADDS_NO_MOUNTS } from "./backends.mjs";

/**
 * The override for Podman's default mount list. When it exists, Podman reads it instead of
 * `/usr/share/containers/mounts.conf`, and an EMPTY one mounts nothing (measured on rootful Podman 5.8.2: `/run/secrets`
 * disappears from `/proc/self/mountinfo`).
 */
export const PODMAN_MOUNTS_CONF = "/etc/containers/mounts.conf";

/**
 * Every containers.conf a rootful Podman service reads a `volumes` or `mounts` key from: the two main files and the
 * four drop-in directories (container-libs pkg/config, `containers.conf.d` and the rootful-only `.rootful.conf.d`).
 * Not `default_mounts_file`: that is not a containers.conf key (`toml:"-"`), only a hidden flag.
 */
export const PODMAN_CONTAINERS_CONF_FILES = Object.freeze(["/usr/share/containers/containers.conf", "/etc/containers/containers.conf"]);
export const PODMAN_CONTAINERS_CONF_DIRS = Object.freeze([
	"/usr/share/containers/containers.conf.d",
	"/etc/containers/containers.conf.d",
	"/usr/share/containers/containers.rootful.conf.d",
	"/etc/containers/containers.rootful.conf.d",
]);

/** FIPS mode adds the host's crypto policy mounts outside `mounts.conf` (container-libs pkg/subscriptions). */
export const FIPS_ENABLED_PATH = "/proc/sys/crypto/fips_enabled";

/**
 * A key that adds to every container what no argv names, in any TOML spelling on a line that is not a comment: `volumes`,
 * `mounts`, `devices` (host device nodes) and `hooks_dir` (OCI hooks, which can mount). Matched bare or quoted at the start of the
 * bare or quoted at the start of a line, dotted (`containers.volumes = [...]` at the top level), or inside an inline table
 * (`containers = { volumes = [...] }`); all three measured honoured by Podman 5.8.2. Wider than Podman's own reading on
 * purpose: a string value that merely contains `volumes =` also matches, which withholds credit rather than giving it.
 */
export const MOUNT_KEY = /^[^#\n]*(?:^|[\s.{,"'])["']?(?:volumes|mounts|devices|hooks_dir)["']?\s*=/m;

/**
 * A quoted TOML key holding a backslash escape (`"volum\u0065s" = ...`), which TOML reads as the unescaped name and
 * `MOUNT_KEY` cannot see through. Refused outright rather than decoded: no containers.conf needs one.
 */
export const ESCAPED_KEY = /^[^#\n]*["'][^"'\n]*\\[^"'\n]*["']\s*=/m;

/** OCI hook directories Podman runs every `*.json` hook from (container-libs pkg/config); a hook can mount into a container. */
export const PODMAN_HOOKS_DIRS = Object.freeze(["/usr/share/containers/oci/hooks.d", "/etc/containers/oci/hooks.d"]);

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
export function observeRuntimeMounts(daemon, { fs, sameHost }) {
	const unread = notAnswered(daemon);
	if (unread) return unread;
	if (daemon.facts.podman !== true) return { value: true, evidence: "the daemon is not Podman, and Docker adds no mounts from a mounts.conf" };
	// Rootless Podman reads the user's own ~/.config/containers/mounts.conf before these, which a host check does not read.
	if (daemon.facts.rootless === true) return { value: false, evidence: "the daemon is rootless Podman, which reads the user's own mounts.conf first" };
	if (sameHost !== true) return { value: false, evidence: "the daemon is Podman on another machine, whose mounts.conf this host cannot read" };
	const read = (path) => {
		try {
			return { text: fs.readFileSync(path, "utf8") };
		} catch (error) {
			return { missing: error?.code === "ENOENT", error: error?.code ?? "error" };
		}
	};
	const fips = read(FIPS_ENABLED_PATH);
	if (!fips.missing && fips.text === undefined) return { value: false, evidence: `${FIPS_ENABLED_PATH} could not be read (${fips.error})` };
	if (String(fips.text ?? "").trim() === "1") return { value: false, evidence: "FIPS mode is on, and Podman then mounts the host's crypto policy into every container" };
	let size;
	try {
		size = fs.statSync(PODMAN_MOUNTS_CONF).size;
	} catch (error) {
		return { value: false, evidence: error?.code === "ENOENT" ? `${PODMAN_MOUNTS_CONF} does not exist, so Podman mounts the default list (/run/secrets on Fedora and RHEL)` : `${PODMAN_MOUNTS_CONF} could not be read (${error?.code ?? "error"})` };
	}
	if (size !== 0) return { value: false, evidence: `${PODMAN_MOUNTS_CONF} is not empty, so Podman mounts what it lists` };
	const files = [...PODMAN_CONTAINERS_CONF_FILES];
	for (const dir of PODMAN_CONTAINERS_CONF_DIRS) {
		let entries;
		try {
			entries = fs.readdirSync(dir);
		} catch (error) {
			if (error?.code === "ENOENT") continue;
			return { value: false, evidence: `${dir} could not be read (${error?.code ?? "error"})` };
		}
		for (const entry of [...entries].sort()) if (String(entry).endsWith(".conf")) files.push(`${dir}/${entry}`);
	}
	for (const file of files) {
		const got = read(file);
		if (got.missing) continue;
		if (got.text === undefined) return { value: false, evidence: `${file} could not be read (${got.error})` };
		if (MOUNT_KEY.test(got.text)) return { value: false, evidence: `${file} sets a volumes, mounts, devices or hooks_dir key, which Podman applies to every container` };
		if (ESCAPED_KEY.test(got.text)) return { value: false, evidence: `${file} has an escaped key, which this check does not decode` };
	}
	for (const dir of PODMAN_HOOKS_DIRS) {
		let entries;
		try {
			entries = fs.readdirSync(dir);
		} catch (error) {
			if (error?.code === "ENOENT") continue;
			return { value: false, evidence: `${dir} could not be read (${error?.code ?? "error"})` };
		}
		if ([...entries].some((entry) => String(entry).endsWith(".json"))) return { value: false, evidence: `${dir} holds an OCI hook, which can mount into every container` };
	}
	return { value: true, evidence: `${PODMAN_MOUNTS_CONF} is empty, no containers.conf sets volumes, mounts, devices or hooks, and no OCI hook is installed` };
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
export function observeHost({ endpoint, daemon, fs }) {
	const bounds = observeBounds(daemon);
	const mounts = observeRuntimeMounts(daemon, { fs, sameHost: podmanOnThisHost({ endpoint, facts: daemon?.facts }) });
	const endpointAnswer = endpoint?.local === true ? true : endpoint?.local === null && endpoint?.transient ? null : false;
	return {
		observations: { [DOCKER_ENDPOINT_LOCAL]: endpointAnswer, [DAEMON_APPLIES_BOUNDS]: bounds.value, [RUNTIME_ADDS_NO_MOUNTS]: mounts.value },
		evidence: { [DAEMON_APPLIES_BOUNDS]: bounds.evidence, [RUNTIME_ADDS_NO_MOUNTS]: mounts.evidence },
		reasons: {
			...(endpointAnswer === null ? { [DOCKER_ENDPOINT_LOCAL]: endpoint?.reason ?? "unknown" } : {}),
			...(bounds.value === null ? { [DAEMON_APPLIES_BOUNDS]: daemon?.reason ?? "not-read" } : {}),
			...(mounts.value === null ? { [RUNTIME_ADDS_NO_MOUNTS]: daemon?.reason ?? "not-read" } : {}),
		},
	};
}

/** The two runtime answers as one string, so a caller logs them only when they change. */
export function runtimeObservationKey(observed) {
	return `${observed.observations[DAEMON_APPLIES_BOUNDS]}|${observed.observations[RUNTIME_ADDS_NO_MOUNTS]}`;
}
