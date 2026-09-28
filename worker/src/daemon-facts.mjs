/**
 * daemon-facts.mjs -- what a container runtime's own `info` says, parsed (issue #452, gate round 3).
 *
 * A LEAF, importing nothing of this project's, and that is its reason to exist: the parsers the local venue decides its
 * job user with (`parseDaemonFacts`) and the podman venue decides its observations with (`parsePodmanInfo`) are also
 * what the network detach gate (`netns-keeper.mjs`) reads the runtime with, and that gate is used by `egress.mjs`, which
 * `job-user.mjs` and `backend-podman.mjs` sit above. Moved here unchanged and re-exported from both, so every existing
 * importer and test is untouched and there is still ONE copy of each rule.
 */

/**
 * The one daemon read. `{{json .}}` rather than a narrow template, deliberately and against `DOCKER_ENDPOINT_ARGS`'
 * rule, for a measured reason: a template field one runtime lacks is a TEMPLATE ERROR on the client, exactly what "no
 * daemon" and Podman's docker emulation also produce, while a missing key in a parsed body is just `null`. The body
 * carries proxy settings and storage paths, so it is parsed here, reduced to the facts below, and never logged or
 * returned.
 */
export const DAEMON_FACTS_ARGS = Object.freeze(["info", "--format={{json .}}"]);
export const DAEMON_FACTS_MAX_BUFFER = 256 * 1024;
// Longer than the endpoint read's 5 s: `docker info` counts containers and images, and on a busy host it is the slow
// one. A per-job `unknown` retries the job, so a bound the host routinely misses would retry every job forever. Boot
// is bounded separately (`settleWithin`), and a read still in flight there is joined by the first job.
export const DAEMON_FACTS_TIMEOUT_MS = 15_000;

// Podman's compat API has hard-coded this since v2 (pkg/api/handlers/compat/info.go); Docker CE packages say
// "Community Engine" and Docker Desktop omits the key (measured). Used only to withhold credit, never to grant it.
export const PODMAN_PRODUCT_LICENSE = "Apache-2.0";

/**
 * What a `docker info --format={{json .}}` answer says: `{ facts }`, `{ unreachable: true }`, or `null` when no line
 * parses to either shape.
 *
 * NO DAEMON IS NOT A SHAPE. When the CLI's `/info` request fails, the docker CLI still exits 0 under `--format` and
 * prints a Docker-shaped body with every server field empty and the error in `ServerErrors` (measured on 27.5.1
 * against a missing socket). From 28.1 a CONNECTION failure exits non-zero instead, which the reader already treats
 * as transient, but any other `/info` failure (an authorization plugin, an API version mismatch) still exits 0 with
 * `ServerErrors` on every version (source). Read as facts, that body has no rootless marker and decides `worker`, so it is
 * recognised FIRST: a non-empty `ServerErrors` is `unreachable` (the error text is never read), and a Docker-shaped
 * body with no `ServerVersion` is no shape at all. A daemon that answers `/info` always sets `ServerVersion`
 * (Docker and Podman's compat handler, source).
 *
 * TWO SHAPES, both measured. The real docker CLI against any daemon (Docker, or Podman's compat socket) prints the
 * Docker shape. Podman's docker emulation (podman-docker) prints Podman's own (`host.security.rootless`,
 * `host.serviceIsRemote`, `host.remoteSocket.path`), and that is the only facts source on that route, because it
 * resolves no docker context.
 *
 * `bounds` is `null` whenever the daemon is Podman: its compat `PidsLimit` is hard-coded true and `MemoryLimit`
 * follows the root cgroup's controllers, not whether a container's bounds apply (source; measured on a rootless host
 * reporting both true while applying neither). CPU is never read: rootful Podman reports `CpuCfsQuota: false` while
 * applying `--cpus` (measured).
 */
export function parseDaemonFacts(output) {
	const lines = String(output ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		let body;
		try {
			body = JSON.parse(lines[i]);
		} catch {
			continue;
		}
		if (!body || typeof body !== "object" || Array.isArray(body)) continue;
		if (Array.isArray(body.ServerErrors) && body.ServerErrors.length > 0) return { unreachable: true };
		if (body.host && typeof body.host === "object") {
			const rootless = body.host.security?.rootless;
			const selinux = body.host.security?.selinuxEnabled;
			const path = body.host.remoteSocket?.path;
			return { facts: {
				shape: "podman",
				podman: true,
				os: typeof body.host.os === "string" ? body.host.os : null,
				rootless: typeof rootless === "boolean" ? rootless : null,
				// Issue #355. Podman's own shape says it outright, so a missing or odd value is no fact rather than `false`.
				selinux: typeof selinux === "boolean" ? selinux : null,
				userns: false,
				bounds: null,
				serviceIsRemote: typeof body.host.serviceIsRemote === "boolean" ? body.host.serviceIsRemote : null,
				// Only a unix path is kept, because only a unix path is ever statted. Podman fills this from the SERVICE's own
				// listener (source): `unix://...` or `tcp://...` for a running service, the bare default path in-process.
				remoteSocketPath: isUnixSocketPath(path) ? path : null,
				serverVersion: displayVersion(body.version?.Version),
			} };
		}
		if (typeof body.ServerVersion === "string" && body.ServerVersion !== "" && (typeof body.OperatingSystem === "string" || Array.isArray(body.SecurityOptions))) {
			const options = Array.isArray(body.SecurityOptions) ? body.SecurityOptions.filter((o) => typeof o === "string") : [];
			const named = (name) => options.some((o) => o.split(",").includes(`name=${name}`));
			const podman = body.ProductLicense === PODMAN_PRODUCT_LICENSE;
			return { facts: {
				shape: "docker",
				podman,
				os: typeof body.OperatingSystem === "string" ? body.OperatingSystem : null,
				rootless: named("rootless"),
				// Issue #355, measured through rootful Podman 5.8.1's compat API on an enforcing Fedora 44 host:
				// `["name=seccomp,profile=default","name=selinux"]`. Docker Engine with `selinux-enabled` says the same word,
				// and that route is out of scope, so this fact alone decides nothing (`relabelsPrivateMounts`).
				selinux: named("selinux"),
				userns: named("userns"),
				bounds: podman ? null : { pids: body.PidsLimit === true, memory: body.MemoryLimit === true },
				serviceIsRemote: null,
				remoteSocketPath: null,
				serverVersion: displayVersion(body.ServerVersion),
			} };
		}
	}
	return null;
}

/**
 * A version string fit for doctor's display line (issue #345), or `null`. Display only, never a decision: validated to a
 * short run of version characters so a daemon's answer cannot put anything else on an operator's terminal. Exported for
 * the podman venue's `podman info` read (issue #354), so the two runtimes' versions pass one filter.
 */
export function displayVersion(value) {
	return typeof value === "string" && /^[0-9A-Za-z.+~_-]{1,40}$/.test(value) ? value : null;
}

function isUnixSocketPath(path) {
	return typeof path === "string" && (path.startsWith("/") || path.startsWith("unix:///"));
}


/** The one facts read. JSON, not a template: a template field one Podman lacks is an error, a missing key is `null`. */
export const PODMAN_INFO_ARGS = Object.freeze(["info", "--format", "json"]);

/**
 * What `podman info --format json` says, reduced to the facts this venue reads, or `null` when the output is not a JSON
 * object with a `host` object. Every field is `null` when absent or of the wrong type, never a guess: a missing
 * `rootless` must not read as rootless, nor a missing `serviceIsRemote` as local. Nothing else of the body (proxy
 * settings, store paths) survives this function, so nothing else can be logged.
 */
export function parsePodmanInfo(stdout) {
	let body;
	try {
		body = JSON.parse(String(stdout ?? "").trim());
	} catch {
		return null;
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) return null;
	const host = body.host;
	if (!host || typeof host !== "object" || Array.isArray(host)) return null;
	const bool = (value) => (typeof value === "boolean" ? value : null);
	const controllers = Array.isArray(host.cgroupControllers) ? host.cgroupControllers.filter((c) => typeof c === "string" && /^[a-z][a-z0-9_]{0,31}$/.test(c)) : null;
	return {
		rootless: bool(host.security?.rootless),
		serviceIsRemote: bool(host.serviceIsRemote),
		selinux: bool(host.security?.selinuxEnabled),
		// "v2" or "v1"; anything else is no fact rather than a string an operator's terminal is handed.
		cgroupVersion: typeof host.cgroupVersion === "string" && /^v[0-9]{1,2}$/.test(host.cgroupVersion) ? host.cgroupVersion : null,
		// Issue #453: the cgroup manager Podman actually uses for this call. `cgroupfs` when it was configured so, and when a
		// configured `systemd` could not reach the account's user manager over D-Bus (Podman then warns and falls back).
		// A short lower-case word, else no fact.
		cgroupManager: typeof host.cgroupManager === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(host.cgroupManager) ? host.cgroupManager : null,
		// The controllers of the CALLING process's own cgroup, as `podman info` reports them. Kept for what it is and for
		// nothing else: issue #453 measured it listing all five where no bound was applied, so no observation reads it.
		controllers,
		version: displayVersion(body.version?.Version),
		// Issue #429: the container STORE this account's Podman uses (`store.graphRoot`), which moves with HOME,
		// XDG_DATA_HOME or a storage.conf. Rootless `podman ps -a` over another store answers exit 0 with an EMPTY list
		// (measured, Podman 5.8.1), so a sandbox opened with another store is invisible to the retention sweep; the
		// sandbox and the sweep compare it with the one a run recorded. An absolute path with no control character, else
		// no fact.
		graphRoot: typeof body.store?.graphRoot === "string" && body.store.graphRoot.length <= 4096 && /^\/[^\u0000-\u001f\u007f]*$/.test(body.store.graphRoot) ? body.store.graphRoot : null,
	};
}
