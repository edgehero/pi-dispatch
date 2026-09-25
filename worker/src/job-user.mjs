/**
 * WHICH uid a job container runs as, decided from facts rather than probed (issue #341,
 * `DES-JOB-USER-INFERRED-READ-BACK-ON-REQUEST`).
 *
 * On a daemon that enforces bind-mount ownership, a job can read its 0700 job dir, write its mounts and leave files
 * the host can remove ONLY as the uid that owns them. The image runs as uid 1001, the worker as whoever started it,
 * and those differ on almost every native Linux host: measured, every job then fails. Docker Desktop maps ownership,
 * so there the image's own user works and nothing may change.
 *
 * Decided WITHOUT starting a container. `CONST-ISOLATION-CONTAINER-PER-JOB` rejects "probing at worker boot or per
 * job", so the decision reads what is already cheap to ask: the platform, the worker's own ids, the endpoint the
 * docker CLI resolves, one `docker info`, and the owner of a local socket. A wrong inference is not silent: the
 * runner refuses a job whose inputs it cannot read before any spend (`job-inputs-unreadable`), and `pi-dispatch
 * doctor --live` reads the mounts back on request.
 *
 * Pure parts (`parseDaemonFacts`, `decideJobUser`, `resolveImageUser`) take values, apart from `decideJobUser`'s
 * `os.release()` default; the two readers take seams.
 */

import { statSync } from "node:fs";
import { release as osRelease } from "node:os";
import { execDockerBounded } from "./backend-local.mjs";
import { CONTAINER_HOME, SHIPPED_IMAGE_UID } from "./container-spec.mjs";

/**
 * The one daemon read. `{{json .}}` rather than a narrow template, deliberately and against `DOCKER_ENDPOINT_ARGS`'
 * rule, for a measured reason: a template field one runtime lacks is a TEMPLATE ERROR on the client, exactly what "no
 * daemon" and Podman's docker emulation also produce, while a missing key in a parsed body is just `null`. The body
 * carries proxy settings and storage paths, so it is parsed here, reduced to the facts below, and never logged or
 * returned.
 */
export const DAEMON_FACTS_ARGS = Object.freeze(["info", "--format={{json .}}"]);
const DAEMON_FACTS_MAX_BUFFER = 256 * 1024;
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
 * Whether a job's OWN bind mounts carry `:Z` (issue #355): `true` only for a Podman daemon that reports SELinux, reached
 * through an endpoint on this host, from a Linux worker. Measured on an enforcing Fedora 44 host (rootful Podman 5.8.1,
 * container-selinux 2.247.0): every unlabelled bind source is denied to the container, `ls` included, with or without
 * `:ro`, so every job on the documented Podman route failed at `/job` before it spent anything.
 *
 * ONE function, read by the job path, doctor and the sandbox, so the three cannot disagree about when a mount is
 * relabelled. Each condition is a measured boundary rather than caution:
 *   - Podman only. Docker Engine with `selinux-enabled` reports the same `name=selinux` and was not measured, so its
 *     argv stays exactly what it was (out of scope, named in the design entry).
 *   - `selinux === true` only: `null` (a shape that did not say) is not a reason to relabel anything.
 *   - `endpoint.local === true` only: bind sources are the DAEMON's paths, and on another machine this worker's job
 *     directories are not what gets relabelled.
 *   - a Linux worker only: a Podman machine on macOS or Windows reports its Linux VM's SELinux while the bind sources are
 *     the host's own files shared into that VM, a route nobody measured with `:Z`.
 *
 * WHICH mounts is `containerSpec`'s business, not this function's: only the directories the worker creates per job.
 * `:Z` is PRIVATE (a per-container MCS pair), which is exactly right for a directory one container ever sees, and
 * measured to lock every other container out of what it relabels. So an operator's local folder and the shared global
 * overlay are NEVER relabelled; doctor names the `semanage fcontext` fix for those instead.
 */
export function relabelsPrivateMounts(facts, endpoint, platform = process.platform) {
	return platform === "linux" && facts?.podman === true && facts?.selinux === true && endpoint?.local === true;
}

/**
 * A version string fit for doctor's display line (issue #345), or `null`. Display only, never a decision: validated to a
 * short run of version characters so a daemon's answer cannot put anything else on an operator's terminal. Exported for
 * the podman venue's `podman info` read (issue #354), so the two runtimes' versions pass one filter.
 */
export function displayVersion(value) {
	return typeof value === "string" && /^[0-9A-Za-z.+~_-]{1,40}$/.test(value) ? value : null;
}

/**
 * `async () => ({ answered: true, facts } | { answered: false, reason, transient })`.
 *
 * A clean exit that parses to neither shape is DETERMINATE (`unparseable`): the CLI answered and said something no
 * rule can read. Every other failure is TRANSIENT here, on purpose and unlike the endpoint read: a clean exit whose
 * body says no daemon answered (`daemon-unreachable`, what a daemon down or still starting gives), a non-zero exit, a
 * timeout, a signal, no docker binary. A worker unit with `RestartPreventExitStatus=2` must never be stranded by a
 * daemon that is merely late. No CLI text is ever read or logged.
 */
export function makeDaemonFactsReader({ run = (args) => execDockerBounded(args, { timeoutMs: DAEMON_FACTS_TIMEOUT_MS, maxBuffer: DAEMON_FACTS_MAX_BUFFER }) } = {}) {
	return async function readDaemonFacts() {
		let result;
		try {
			result = await run(DAEMON_FACTS_ARGS);
		} catch (err) {
			result = { code: null, stdout: "", error: err };
		}
		if (result?.error || result?.code !== 0) {
			const error = result?.error;
			const reason = error?.timedOut || error?.killed ? "timeout"
				: typeof error?.signal === "string" ? `signal-${error.signal.toLowerCase()}`
				: error?.code === "ENOENT" ? "docker-not-found"
				: typeof result?.code === "number" ? `exit-${result.code}`
				: typeof error?.code === "number" ? `exit-${error.code}`
				: "spawn-failed";
			return { answered: false, reason, transient: true };
		}
		const parsed = parseDaemonFacts(result.stdout);
		if (parsed?.unreachable) return { answered: false, reason: "daemon-unreachable", transient: true };
		return parsed ? { answered: true, facts: parsed.facts } : { answered: false, reason: "unparseable", transient: false };
	};
}

/**
 * `{ uid, gid }` of a local unix socket, or `null`. Takes the docker endpoint's `unix://` path or Podman's
 * `remoteSocket.path`, which is a bare path when the service is local and `unix://...` when it is remote (both
 * measured). `stat`, never `lstat`: `/var/run/docker.sock` is a symlink on Docker Desktop, and a link pointing at a
 * rootless socket would read as root-owned. Any failure (EACCES on a 0700 parent, ENOENT) is simply no fact.
 */
export function socketFacts(path, { stat = statSync } = {}) {
	if (typeof path !== "string") return null;
	const bare = path.startsWith("unix://") ? path.slice("unix://".length) : path;
	if (!bare.startsWith("/")) return null;
	try {
		const s = stat(bare);
		return typeof s?.uid === "number" && typeof s?.gid === "number" ? { uid: s.uid, gid: s.gid } : null;
	} catch {
		return null;
	}
}

/** Is a Podman `remoteSocket.path` a unix socket (bare path or `unix://`), i.e. a local service? */
function isUnixSocketPath(path) {
	return typeof path === "string" && (path.startsWith("/") || path.startsWith("unix:///"));
}

// The fixed operator texts, one per cause, for the boot refusal, the sandbox and doctor. The forge comments keep
// their own shorter texts (a comment's reader may not be the operator), and no text carries CLI output, an endpoint
// or a path: a refusal that repeats what docker printed can repeat a credential.
export const JOB_USER_FIX = Object.freeze({
	rootless: "the container runtime runs rootless (a user namespace between the job and this worker), so no uid a job may run as can read the worker's 0700 job dir; run jobs on a rootful Docker or Podman daemon. If this was inferred from a socket this worker's uid owns on a rootful daemon (a systemd SocketUser= override), point the worker at the daemon's own socket",
	"userns-remap": "the Docker daemon remaps container uids (userns-remap), so no uid a job may run as can read the worker's 0700 job dir; run jobs on a daemon without userns-remap",
	"worker-is-root": "the worker runs as root, and a job must not run as root (nonRoot); run the worker as an unprivileged account, as deploy/worker.service's User= does",
	"desktop-linux-userns": "Docker Desktop on Linux maps container uids like a rootless daemon, so no uid a job may run as can read the worker's 0700 job dir; use Docker Engine on this host (WSL2 is not affected)",
	"runtime-unreadable": "the docker CLI answered `docker info` with something no rule can read, so which uid a job may run as is unknown; point the real docker CLI at a Docker or Podman daemon",
	"root-group": "the worker's primary group is gid 0, and a job runs with that group; run the worker with an unprivileged primary group",
	"docker-group": "the worker's primary group is the docker socket's group, and a job runs with that group; make docker a supplementary group (log out and back in rather than `newgrp docker`)",
	// Not a daemon cause: the per-image rule's refusal (`job-image-any-uid-unsupported`), here so every surface shares one text.
	"any-uid-unsupported": "the job image does not declare `anyUid` (`dev.pi-dispatch.capabilities`), so it cannot run as this worker's own uid, which this host's container runtime requires; rebuild it from a release that has this feature, or run the worker as uid 1001",
});

/**
 * The daemon half of the decision. Pure apart from the `release` default. Returns `{ mode, user, cause, reason }`,
 * one of FOUR modes:
 *   - `image`: the image's own USER runs, argv byte-identical to before issue #341;
 *   - `worker`: the job runs as `user`, the worker's own "<euid>:<egid>" (the per-image rule may still decline);
 *   - `unmappable`: no uid works, `cause` names why;
 *   - `unknown`: not decidable now (`reason`), never cached and never a boot exit.
 *
 * `endpoint` is the endpoint resolver's answer; `daemon` is `readDaemonFacts()`'s; `socket` is `socketFacts(...)`.
 * The rows are ORDERED, and the order is part of the contract (the design entry's table).
 */
export function decideJobUser({ platform, release = osRelease(), euid, egid, endpoint, daemon, socket = null }) {
	const image = (cause) => ({ mode: "image", user: null, cause, reason: null });
	const unmappable = (cause) => ({ mode: "unmappable", user: null, cause, reason: null });
	const unknown = (reason) => ({ mode: "unknown", user: null, cause: null, reason });

	// A daemon on these platforms runs in a Linux VM, and Docker Desktop's file sharing maps ownership (measured), so the
	// image's own user works. The other VM-backed daemons there (OrbStack, Colima, Podman machine) are unmeasured.
	if (platform === "darwin" || platform === "win32") return image("desktop-platform");
	// Bind-mount sources are another machine's paths: nothing about this host's uids applies, and doctor already warns.
	if (endpoint?.local === false) return image("endpoint-not-local");
	if (!daemon?.answered) return daemon?.transient === false ? unmappable("runtime-unreadable") : unknown(daemon?.reason ?? "no-daemon-facts");
	const facts = daemon.facts;
	if (endpoint?.local !== true) {
		// No docker endpoint resolved. Only Podman's own shape (its docker emulation) says enough to go on; a Docker
		// shape with no endpoint leaves the socket rows below blind.
		if (facts.shape !== "podman") return unknown("endpoint-unresolved");
		// A client of a service that listens on TCP: its path did not survive parsing, so there is no socket on this host
		// to read. A client reaching a unix-socket service over ssh reports that service's own unix path and is NOT
		// caught here (a residual the design entry names).
		if (facts.serviceIsRemote === true && facts.remoteSocketPath === null) return image("endpoint-not-local");
	}
	if (facts.os === "Docker Desktop") {
		if (!/microsoft/i.test(String(release))) return unmappable("desktop-linux-userns");
		// WSL2 bind mounts keep uids (unmeasured): the ordinary rows decide.
	}
	if (facts.rootless === true) return unmappable("rootless");
	if (facts.userns === true) return unmappable("userns-remap");
	if (typeof euid !== "number" || typeof egid !== "number") return unknown("no-process-ids");
	// A rootless daemon's socket belongs to the user running it. Needed for Podman before its compat info carried
	// name=rootless (absent at v4.3.1, present at v4.9.3); narrowed to THIS uid's socket, never any non-root owner.
	if (euid !== 0 && socket && socket.uid === euid) return unmappable("rootless");
	if (euid === 0) return unmappable("worker-is-root");
	return { mode: "worker", user: `${euid}:${egid}`, cause: null, reason: null };
}

/**
 * The per-image half, for a job about to run. Returns `{ user, home }` (`user` null means the image's own USER),
 * `{ refused, cause }` or `{ unavailable, reason }`.
 *
 * ORDER MATTERS. uid 1001 comes first: the image already runs as it, so no `--user` and no group rule, whatever the
 * image declares; a uid-1001 worker whose primary group is docker works today and must keep working once the shipped
 * image carries `anyUid`. Only a `--user` puts the worker's gid into the container, so the two group refusals live on
 * that path alone.
 */
export function resolveImageUser(decision, { capabilities = [], euid, egid, socket = null } = {}) {
	if (decision?.mode === "image") return { user: null, home: null };
	if (decision?.mode === "unmappable") return { refused: "job-user-unmappable", cause: decision.cause };
	if (decision?.mode !== "worker") return { unavailable: true, reason: decision?.reason ?? "unknown" };
	if (euid === SHIPPED_IMAGE_UID) return { user: null, home: null };
	if (!Array.isArray(capabilities) || !capabilities.includes("anyUid")) return { refused: "job-image-any-uid-unsupported", cause: "any-uid-unsupported" };
	if (egid === 0) return { refused: "job-user-unmappable", cause: "root-group" };
	if (socket && egid === socket.gid) return { refused: "job-user-unmappable", cause: "docker-group" };
	return { user: decision.user, home: CONTAINER_HOME };
}

/**
 * The causes that stop a worker whose default venue is `local` from booting: facts about the daemon or the worker's
 * own identity, which no job on that venue can get past. ONE set, read by the worker's boot and by doctor's severity,
 * so doctor cannot show a warning for a cause the worker refuses to boot on. The rest refuse per job: the group rows
 * apply only to a job whose image needs `--user`, and `runtime-unreadable` describes one answer.
 */
// A plain Set (read with `.has` only); `Object.freeze` would not stop `.add`, so it is not pretended.
export const BOOT_REFUSING_JOB_USER_CAUSES = new Set(["rootless", "userns-remap", "worker-is-root", "desktop-linux-userns"]);

/** The operator-facing refusal for an unmappable decision or cause. */
export function jobUserRefusal(causeOrDecision) {
	const cause = typeof causeOrDecision === "string" ? causeOrDecision : causeOrDecision?.cause;
	return `Refused: ${JOB_USER_FIX[cause] ?? "the job user could not be decided"} (issue #341).`;
}

/**
 * `async ({ endpoint, key }) => ({ decision, facts, daemon, socket })`, cached by `key` (the endpoint state string the
 * caller already keeps). Concurrent callers for one key share one read. `daemon` is the raw read result (`{ answered,
 * facts }` or `{ answered: false, reason, transient }`), which the runtime observations read (issue #345).
 *
 * NOT cached: `unknown`, `unmappable` `runtime-unreadable`, and any decision made without an answered read (an `image`
 * decided on macOS while the daemon was still starting). Each describes an answer rather than a daemon, and a cached one
 * would retry or refuse every later job on that endpoint, or leave the observations unread, until the worker restarted.
 * A cached decision is otherwise kept until the endpoint state changes: a daemon reconfigured behind an unchanged
 * endpoint (rootful to rootless on one socket path) is read again only after a restart, a residual the design entry names.
 */
export function makeJobUserResolver({
	readFacts,
	platform = process.platform,
	release = osRelease(),
	euid = process.geteuid?.(),
	egid = process.getegid?.(),
	stat = statSync,
} = {}) {
	let cached = null;
	const inFlight = new Map();
	return async function resolveJobUser({ endpoint, key }) {
		if (cached && cached.key === key) return cached.value;
		if (inFlight.has(key)) return inFlight.get(key);
		const work = (async () => {
			// Asked on EVERY platform and endpoint, although a VM-backed platform or an endpoint on another machine decides
			// `image` before any daemon fact is read: the same read is where the runtime observations come from (issue
			// #345), and a Docker Desktop host skipped here would never be credited with the bounds its daemon applies.
			const daemon = await readFacts();
			// A local docker endpoint's display form IS its unix path (credentials never ride a unix URL); with no endpoint,
			// Podman's own shape names the service socket.
			const socketPath = endpoint?.local === true && typeof endpoint.endpoint === "string" && endpoint.endpoint.startsWith("unix://")
				? endpoint.endpoint
				: daemon?.answered ? daemon.facts.remoteSocketPath : null;
			const socket = socketFacts(socketPath, { stat });
			const decision = decideJobUser({ platform, release, euid, egid, endpoint, daemon, socket });
			const value = { decision, facts: daemon?.answered ? daemon.facts : null, daemon, socket };
			// Cached only for an ANSWERED read: an `image` decided on a VM-backed platform while its daemon was still starting
			// must not pin "not read" for the runtime observations until the endpoint changes.
			if (decision.mode !== "unknown" && decision.cause !== "runtime-unreadable" && daemon?.answered === true) cached = { key, value };
			return value;
		})();
		inFlight.set(key, work);
		try {
			return await work;
		} finally {
			inFlight.delete(key);
		}
	};
}
