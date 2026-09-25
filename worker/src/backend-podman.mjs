/**
 * THE `podman` BACKEND: the worker account's own ROOTLESS Podman, through the real `podman` CLI (issue #354,
 * `DES-PODMAN-NATIVE-ROOTLESS-BACKEND`).
 *
 * `backends.mjs` says what the venue guarantees; this module is what makes it true. It is `local`'s machinery with the
 * runtime's two seams set (PR #425): `bin: "podman"` on every spawn, and `buildPodmanRunArgs`, which always emits
 * `--user <euid>:<egid> --userns=keep-id`. Nothing here re-implements a run, a stop, a preflight or a sweep; a podman
 * behaviour that differs from docker's is either handled in the shared code (the disconnect trap in `egress.mjs`) or
 * named as a residual in the design entry.
 *
 * ROOTLESS ONLY, and every refusal is a measurement rather than caution (Podman 5.8.1, Fedora 44, 2026-09-25):
 *   - rootful `podman run --userns=keep-id` is NOT refused by Podman: exit 0, an identity uid map, and the process gains
 *     supplementary group 0. So the venue refuses unless `podman info` says rootless (`podman-rootful`).
 *   - a remote service (`CONTAINER_HOST`, `--remote`) runs the job's bind sources and `-e` values on another machine
 *     (`podman-remote`), and a root worker would be uid 0 on the host (`worker-is-root`).
 *   - only Linux was measured; Podman machine on macOS and Windows was not (`podman-platform`).
 *
 * THE FACTS COME FROM ONE READ, `podman info --format json`, cached once it answers: it decides the job user, whether
 * mounts are relabelled, and the three observations the table's words rest on. Rootless-ness, remoteness and the
 * delegated controllers cannot change under a running worker without a restart (they are this account's and this
 * process's environment), so re-reading per job would only add a spawn; the FILES an observation reads (mounts.conf,
 * containers.conf) are re-read per job, because an operator creating the empty override must not need a restart.
 *
 * `backends.mjs` stays a leaf, so this module imports it and never the other way round.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { JOB_NAME_PREFIX, execDockerBounded, jobContainerName, makeReaper, makeStopContainer } from "./backend-local.mjs";
import { BACKENDS, PODMAN_ADDS_NO_MOUNTS, PODMAN_BACKEND, PODMAN_BOUNDS_DELEGATED, PODMAN_SERVICE_LOCAL, observationRefusalIsTransient, observationRefusals, unobservedFloor } from "./backends.mjs";
import { CONTAINER_HOME, SHIPPED_IMAGE_UID } from "./container-spec.mjs";
import { buildPodmanRunArgs } from "./docker-run.mjs";
import { makeEgressPreflight } from "./egress.mjs";
import { makeImagePreflight } from "./image-preflight.mjs";
import { DAEMON_FACTS_TIMEOUT_MS, displayVersion } from "./job-user.mjs";
import { makeRunContainer } from "./run-container.mjs";
import { MOUNT_KEY, MOUNT_KEY_SAYS, PODMAN_HOOKS_DIRS, confFilesIn, confKeyFinding, fipsFinding, hooksFinding } from "./runtime-observations.mjs";

/** The one facts read. JSON, not a template: a template field one Podman lacks is an error, a missing key is `null`. */
export const PODMAN_INFO_ARGS = Object.freeze(["info", "--format", "json"]);

/**
 * `docker info`'s bound, reused: `podman info` also walks the store, and a per-job `unknown` retries the job, so a bound a
 * busy host routinely misses would retry every job forever.
 */
/**
 * The bound on starting a container of the job image on this venue when nothing else bounds it (doctor's and the
 * conformance script's live read-back). Rootless Podman on an overlay store that cannot shift ids makes the FIRST
 * keep-id run of an image copy its layers to the mapped ids: 27.1 s for the job image on Fedora 44 (btrfs backing,
 * "Supports shifting: false"), then 152 ms, against 115 ms without keep-id (measured, Podman 5.8.1). The read-back's
 * 20 s step bound read that first run as a probe that never started.
 */
export const PODMAN_FIRST_START_TIMEOUT_MS = 120_000;

export const PODMAN_INFO_TIMEOUT_MS = DAEMON_FACTS_TIMEOUT_MS;

// `podman info --format json` is pretty-printed and carries the registries and store paths: tens of KiB, not one line.
const PODMAN_INFO_MAX_BUFFER = 1024 * 1024;

/**
 * The exits `podman run` spells "the runner never ran" (measured): 125 is podman itself (a name in use, an absent image
 * under `--pull=never`), 126 and 127 crun's not-executable and not-found when no `--init` wraps the entrypoint. The job
 * argv carries `--init`, under which catatonit reports both as exit 1: indistinguishable from the runner's own infra exit
 * except by a stderr line the job could print too, so NOT normalised (a residual the design entry names).
 */
export const PODMAN_NEVER_STARTED_EXITS = Object.freeze([125, 126, 127]);

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
		controllers,
		version: displayVersion(body.version?.Version),
	};
}

/**
 * `async () => ({ answered: true, info } | { answered: false, reason, transient })`. `run(args)` is the seam: a bounded
 * spawn of `podman` resolving `{ code, stdout, stderr }` (or `execDockerBounded`'s `{ code, stdout, error }`).
 *
 * TWO DETERMINATE answers, the rest transient, on `makeDaemonFactsReader`'s rule: no podman binary (`podman-not-found`),
 * and a clean exit that parses to nothing (`unparseable`). A non-zero exit, a timeout or a signal is a Podman that may
 * answer next time, and a worker unit with `RestartPreventExitStatus=2` must not be stranded by one that is merely slow.
 * No CLI text is read or logged: a remote service's error names its URL.
 */
export function makePodmanInfoReader({ run = (args) => execDockerBounded(args, { bin: "podman", timeoutMs: PODMAN_INFO_TIMEOUT_MS, maxBuffer: PODMAN_INFO_MAX_BUFFER }) } = {}) {
	return async function readPodmanInfo() {
		let result;
		try {
			result = await run(PODMAN_INFO_ARGS);
		} catch (err) {
			result = { code: null, stdout: "", error: err };
		}
		const error = result?.error ?? null;
		if (error?.code === "ENOENT") return { answered: false, reason: "podman-not-found", transient: false };
		if (error || result?.code !== 0) {
			const reason = error?.timedOut || error?.killed ? "timeout"
				: typeof error?.signal === "string" ? `signal-${error.signal.toLowerCase()}`
				: typeof result?.code === "number" ? `exit-${result.code}`
				: typeof error?.code === "number" ? `exit-${error.code}`
				: "spawn-failed";
			return { answered: false, reason, transient: true };
		}
		const info = parsePodmanInfo(result.stdout);
		return info ? { answered: true, info } : { answered: false, reason: "unparseable", transient: false };
	};
}

const CACHED = Symbol("podman-info-cached");

/**
 * `readInfo` with its first ANSWERED result kept, and concurrent callers sharing one read. An unanswered read is never
 * kept: a Podman that timed out once must be asked again, or every later job would retry on a stale failure. Idempotent,
 * so the boot wiring can wrap a reader once and hand the same one to the bundle and to its own boot read.
 */
export function cachedPodmanInfo(readInfo) {
	if (readInfo?.[CACHED]) return readInfo;
	let kept = null;
	let inFlight = null;
	const cached = async () => {
		if (kept) return kept;
		if (inFlight) return inFlight;
		inFlight = (async () => {
			try {
				const read = await readInfo();
				if (read?.answered === true && read.info) kept = read;
				return read;
			} catch {
				return { answered: false, reason: "spawn-failed", transient: true };
			}
		})();
		try {
			return await inFlight;
		} finally {
			inFlight = null;
		}
	};
	cached[CACHED] = true;
	return cached;
}

/** The system containers.conf files and drop-in directories rootless Podman reads (container-libs pkg/config). */
export const PODMAN_ROOTLESS_CONF_FILES = Object.freeze(["/usr/share/containers/containers.conf", "/etc/containers/containers.conf"]);
export const PODMAN_ROOTLESS_CONF_DIRS = Object.freeze([
	"/usr/share/containers/containers.conf.d",
	"/etc/containers/containers.conf.d",
	"/usr/share/containers/containers.rootless.conf.d",
	"/etc/containers/containers.rootless.conf.d",
]);
/** The system-wide mounts.conf a rootless Podman falls back to when the user has none (the user's one overrides it). */
export const PODMAN_SYSTEM_MOUNTS_CONF = "/etc/containers/mounts.conf";

/**
 * A key that takes a container out of its cgroup (`cgroups = "disabled"` or `"no-conmon"`), under which rootless Podman
 * accepts `--pids-limit` and `--memory` and applies neither (measured with the flag; the key sets the same option).
 * Any value withholds credit: only the default reads the bounds back. Matched as `MOUNT_KEY` is, in any case and any
 * TOML spelling; `cgroupns` and `cgroup_manager` do not match (the key must end at `cgroups`).
 */
export const CGROUPS_KEY = /^(?!\s*#).*?(?:^|[\s.{,"'])["']?cgroups["']?\s*=/im;

/**
 * The containers.conf files THIS account's Podman reads, as `{ files }` or `{ finding }`. `CONTAINERS_CONF` replaces the
 * whole list and `CONTAINERS_CONF_OVERRIDE` adds one, and neither is chased: set, the answer is `false`, never a credit
 * from files Podman may not read. `XDG_CONFIG_HOME` moves the user's own directory, as Podman's `GetConfigHome` does.
 */
function podmanConfFiles({ fs, home, env, euid }) {
	for (const name of ["CONTAINERS_CONF", "CONTAINERS_CONF_OVERRIDE"]) {
		if (typeof env?.[name] === "string" && env[name] !== "") return { finding: { value: false, evidence: `${name} is set, so which containers.conf Podman reads is not the list this check reads` } };
	}
	if (typeof home !== "string" || !home.startsWith("/")) return { finding: { value: false, evidence: "the worker account's home is not known, so its own containers.conf could not be read" } };
	if (!Number.isInteger(euid)) return { finding: { value: false, evidence: "the worker's uid is not known, so its per-uid containers.conf drop-ins could not be read" } };
	// env-internal XDG_CONFIG_HOME: Podman's own variable, read only to find the containers.conf the podman CLI this worker
	// spawns reads, never a pi-dispatch setting.
	const configHome = typeof env?.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.startsWith("/") ? env.XDG_CONFIG_HOME : `${home}/.config`;
	return confFilesIn(fs, {
		files: [...PODMAN_ROOTLESS_CONF_FILES, `${configHome}/containers/containers.conf`],
		dirs: [...PODMAN_ROOTLESS_CONF_DIRS, `/usr/share/containers/containers.rootless.conf.d/${euid}`, `/etc/containers/containers.rootless.conf.d/${euid}`, `${configHome}/containers/containers.conf.d`],
	});
}

/**
 * `podmanAddsNoMounts` from this host's files, as `{ value, evidence }`. The mounts.conf that WINS decides: the user's
 * `$HOME/.config/containers/mounts.conf` when it exists (Podman builds that path from `HOME`, not `XDG_CONFIG_HOME`),
 * else `/etc/containers/mounts.conf`, and an EMPTY winner suppresses `/usr/share/containers/mounts.conf`'s `/run/secrets`
 * default (measured rootless). Then the same containers.conf keys, OCI hooks and FIPS rule the rootful observation
 * reads, over the files a rootless Podman reads.
 */
function observePodmanMounts({ fs, home, env, euid }) {
	const fips = fipsFinding(fs);
	if (fips) return fips;
	if (typeof home !== "string" || !home.startsWith("/")) return { value: false, evidence: "the worker account's home is not known, so its own mounts.conf could not be read" };
	const userMounts = `${home}/.config/containers/mounts.conf`;
	let winner = null;
	for (const path of [userMounts, PODMAN_SYSTEM_MOUNTS_CONF]) {
		let size;
		try {
			size = fs.statSync(path).size;
		} catch (error) {
			if (error?.code === "ENOENT") continue;
			return { value: false, evidence: `${path} could not be read (${error?.code ?? "error"})` };
		}
		winner = { path, size };
		break;
	}
	if (!winner) return { value: false, evidence: `neither ${userMounts} nor ${PODMAN_SYSTEM_MOUNTS_CONF} exists, so Podman mounts the default list (/run/secrets on Fedora and RHEL)` };
	if (winner.size !== 0) return { value: false, evidence: `${winner.path} is not empty, so Podman mounts what it lists` };
	const listed = podmanConfFiles({ fs, home, env, euid });
	if (listed.finding) return listed.finding;
	const conf = confKeyFinding(fs, listed.files, { key: MOUNT_KEY, says: MOUNT_KEY_SAYS });
	if (conf) return conf;
	const hooks = hooksFinding(fs, PODMAN_HOOKS_DIRS);
	if (hooks) return hooks;
	return { value: true, evidence: `${winner.path} is empty, no containers.conf this account's Podman reads sets volumes, mounts, devices or hooks, and no OCI hook is installed` };
}

/**
 * `podmanBoundsDelegated` from the info and this host's files: rootless, cgroup v2, `pids`, `memory` and `cpu` among the
 * controllers delegated to this user, and no containers.conf taking containers out of their cgroup. Rootful Podman is
 * refused as a venue, so its (undelegated, whole-tree) controller list earns nothing here either.
 */
function observePodmanBounds(info, { fs, home, env, euid }) {
	if (info.rootless !== true) return { value: false, evidence: "podman info does not report a rootless Podman, which is the only kind this venue runs on" };
	if (info.cgroupVersion !== "v2") return { value: false, evidence: `podman info reports cgroup ${info.cgroupVersion ?? "version unknown"}, and rootless bounds need cgroup v2` };
	const missing = ["pids", "memory", "cpu"].filter((c) => !Array.isArray(info.controllers) || !info.controllers.includes(c));
	if (missing.length > 0) return { value: false, evidence: `the ${missing.join(", ")} cgroup ${missing.length === 1 ? "controller is" : "controllers are"} not delegated to this user, so rootless Podman accepts the bound and applies nothing` };
	const listed = podmanConfFiles({ fs, home, env, euid });
	if (listed.finding) return listed.finding;
	const conf = confKeyFinding(fs, listed.files, { key: CGROUPS_KEY, says: "sets a cgroups key, which can run every container outside its cgroup with its bounds unapplied" });
	if (conf) return conf;
	return { value: true, evidence: "rootless Podman on cgroup v2 with the pids, memory and cpu controllers delegated, and no containers.conf sets cgroups" };
}

/**
 * Every podman observation for one info read, as `observeHost`'s `{ observations, evidence, reasons }`.
 *
 * THREE ANSWERS, NEVER TWO, on `runtime-observations.mjs`'s rule: a TRANSIENT unanswered read is `null` for all three
 * (a floor retries) with the read's reason; a DETERMINATE one (no podman on PATH, an answer nothing parses) is `false`
 * (a floor refuses). The mounts answer rests on the read too: which mounts.conf wins depends on Podman being rootless.
 * `fs` is `{ statSync, readFileSync, readdirSync }`; `home`, `env` and `euid` are the account whose Podman runs the jobs.
 */
export function observePodman({ read, fs = { statSync, readFileSync, readdirSync }, home = homedir(), env = process.env, euid = process.geteuid?.() } = {}) {
	const names = [PODMAN_BOUNDS_DELEGATED, PODMAN_ADDS_NO_MOUNTS, PODMAN_SERVICE_LOCAL];
	if (!(read?.answered === true && read.info)) {
		const determinate = read && read.answered === false && read.transient === false;
		const value = determinate ? false : null;
		const evidence = determinate
			? read.reason === "podman-not-found" ? "no podman CLI was found on PATH" : `podman info answered in a shape nothing here reads (${read.reason ?? "unparseable"})`
			: `podman info was not read (${read?.reason ?? "not asked"})`;
		return {
			observations: Object.fromEntries(names.map((n) => [n, value])),
			evidence: Object.fromEntries(names.map((n) => [n, evidence])),
			reasons: value === null ? Object.fromEntries(names.map((n) => [n, read?.reason ?? "not-read"])) : {},
		};
	}
	const { info } = read;
	const bounds = observePodmanBounds(info, { fs, home, env, euid });
	const mounts = info.rootless === true ? observePodmanMounts({ fs, home, env, euid }) : { value: false, evidence: "podman info does not report a rootless Podman, whose own mounts.conf this check reads" };
	const service = info.serviceIsRemote === false
		? { value: true, evidence: "podman info reports serviceIsRemote false" }
		: { value: false, evidence: info.serviceIsRemote === true ? "podman info reports serviceIsRemote true (CONTAINER_HOST, --remote or a service destination)" : "podman info does not say whether its service is remote" };
	return {
		observations: { [PODMAN_BOUNDS_DELEGATED]: bounds.value, [PODMAN_ADDS_NO_MOUNTS]: mounts.value, [PODMAN_SERVICE_LOCAL]: service.value },
		evidence: { [PODMAN_BOUNDS_DELEGATED]: bounds.evidence, [PODMAN_ADDS_NO_MOUNTS]: mounts.evidence, [PODMAN_SERVICE_LOCAL]: service.evidence },
		reasons: {},
	};
}

/** The three podman answers as one string, so a caller logs them only when they change. */
export function podmanObservationKey(observed) {
	return `${observed.observations[PODMAN_BOUNDS_DELEGATED]}|${observed.observations[PODMAN_ADDS_NO_MOUNTS]}|${observed.observations[PODMAN_SERVICE_LOCAL]}`;
}

// The fixed operator texts per cause on this venue: the boot refusal, doctor and the per-job log. OUT of job-user.mjs's
// JOB_USER_FIX on purpose, since that map is pinned to `local`'s causes by backends-doc.test.mjs and is `local`'s
// vocabulary (a rootless DAEMON is a refusal there and the only kind this venue runs on). No text carries CLI output, a
// path or a URL: a refusal that repeats what podman printed can repeat a remote service's credentials.
export const PODMAN_JOB_USER_FIX = Object.freeze({
	"podman-platform": "the podman venue runs only on Linux (Podman machine on macOS and Windows was not measured); use the local venue with Docker Desktop, or run the worker on a Linux host",
	"podman-not-found": "no podman CLI was found on the worker's PATH; install Podman for the worker account, or remove podman from PI_BACKENDS",
	"podman-unreadable": "podman info answered with something no rule can read, so which uid a job may run as is unknown; check that `podman info --format json` works as the worker account",
	"podman-remote": "podman runs its containers through a remote service (CONTAINER_HOST, --remote or a containers.conf service destination), where a job's mounts and secrets are another machine's; unset it for the worker account",
	"podman-rootful": "podman is not rootless for this account, and the podman venue runs only on rootless Podman (rootful keep-id adds the root group); run the worker as an unprivileged account, or use rootful Podman through the local venue's Docker API route (docs/podman.md)",
	"worker-is-root": "the worker runs as root, and a job must not run as root (nonRoot); run the worker as an unprivileged account with its own rootless Podman",
	"root-group": "the worker's primary group is gid 0, and a podman job runs with that group; run the worker with an unprivileged primary group",
	"any-uid-unsupported": "the job image does not declare `anyUid` (`dev.pi-dispatch.capabilities`), so it cannot run as this worker's own uid, which the podman venue always uses; rebuild it from a release that has this feature, or run the worker as uid 1001",
});

/**
 * The causes that stop a worker whose DEFAULT venue is `podman` from booting: facts about the platform, the CLI and the
 * worker's identity, which no podman job can get past. A plain Set read with `.has`, as `BOOT_REFUSING_JOB_USER_CAUSES`.
 * `podman-unreadable` describes one answer, and the group and image rules one job, so they refuse per job.
 */
export const PODMAN_BOOT_REFUSING_CAUSES = new Set(["podman-platform", "podman-not-found", "podman-remote", "podman-rootful", "worker-is-root"]);

/** The operator-facing refusal for a podman cause or decision. */
export function podmanJobUserRefusal(causeOrDecision) {
	const cause = typeof causeOrDecision === "string" ? causeOrDecision : causeOrDecision?.cause;
	return `Refused: ${Object.hasOwn(PODMAN_JOB_USER_FIX, cause ?? "") ? PODMAN_JOB_USER_FIX[cause] : "the job user could not be decided"} (issue #354).`;
}

/**
 * Who a podman job runs as, decided from the info read (`read`, `readInfo()`'s answer) and the worker's own ids. Returns
 * `{ mode: "worker", user, relabel }`, `{ mode: "unmappable", cause }` or `{ mode: "unknown", reason }`. The rows are
 * ORDERED, and the order is the contract:
 *   1. not Linux: `podman-platform`, before any read, since nothing Podman could say changes it;
 *   2. an unanswered read: `unknown` when transient (retried, never a boot exit), else `podman-not-found` or
 *      `podman-unreadable`;
 *   3. a remote service (or one that does not say it is local): `podman-remote`;
 *   4. not rootless (or not saying): `podman-rootful`;
 *   5. no process ids: `unknown`; the worker is root: `worker-is-root`;
 *   6. else the worker's own `<euid>:<egid>`, with `relabel` true only where Podman reports SELinux on (the PR #424 rule:
 *      `:Z` on the job's own per-job directories, and only there).
 */
export function decidePodmanJobUser({ platform = process.platform, euid, egid, read } = {}) {
	const unmappable = (cause) => ({ mode: "unmappable", user: null, relabel: false, cause, reason: null });
	const unknown = (reason) => ({ mode: "unknown", user: null, relabel: false, cause: null, reason });
	if (platform !== "linux") return unmappable("podman-platform");
	if (!(read?.answered === true && read.info)) {
		if (read?.answered === false && read.transient === false) return unmappable(read.reason === "podman-not-found" ? "podman-not-found" : "podman-unreadable");
		return unknown(read?.reason ?? "no-podman-info");
	}
	const { info } = read;
	if (info.serviceIsRemote !== false) return unmappable("podman-remote");
	if (info.rootless !== true) return unmappable("podman-rootful");
	if (!Number.isInteger(euid) || !Number.isInteger(egid)) return unknown("no-process-ids");
	if (euid === 0) return unmappable("worker-is-root");
	return { mode: "worker", user: `${euid}:${egid}`, relabel: info.selinux === true, cause: null, reason: null };
}

/**
 * The per-image half, for a podman job about to run: `{ user, home, relabel }`, `{ refused, cause }` or `{ unavailable,
 * reason }`. The job ALWAYS runs as the worker's uid (keep-id needs `--user`, measured: without it the image's user runs
 * with `/job` unreadable), so unlike `local` there is no "image's own user" answer. `anyUid` is required unless that uid
 * is the image's own 1001; a primary group of 0 is refused here, before the builder would throw on it (`assertJobUser`).
 */
export function resolvePodmanImageUser(decision, { capabilities = [], euid, egid } = {}) {
	if (decision?.mode === "unmappable") return { refused: "job-user-unmappable", cause: decision.cause };
	if (decision?.mode !== "worker") return { unavailable: true, reason: decision?.reason ?? "unknown" };
	if (euid !== SHIPPED_IMAGE_UID && (!Array.isArray(capabilities) || !capabilities.includes("anyUid"))) return { refused: "job-image-any-uid-unsupported", cause: "any-uid-unsupported" };
	if (egid === 0) return { refused: "job-user-unmappable", cause: "root-group" };
	return { user: decision.user, home: CONTAINER_HOME, relabel: decision.relabel === true };
}

/**
 * A `promisify(execFile)`-shaped runner over a `spawn`-shaped one: resolves `{ stdout, stderr }` on exit 0, rejects with
 * `{ code, stdout, stderr }` otherwise, so the reaper and the stop can be driven by the same fake child a test hands the
 * run. A spawn `error` (no binary) rejects with that error, as `execFile` does.
 */
export function execViaSpawn(spawnFn) {
	return (cmd, args) =>
		new Promise((resolve, reject) => {
			let stdout = "";
			let stderr = "";
			let child;
			try {
				child = spawnFn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
			} catch (err) {
				reject(err);
				return;
			}
			child.stdout?.on?.("data", (c) => {
				stdout += String(c);
			});
			child.stderr?.on?.("data", (c) => {
				stderr += String(c);
			});
			child.on("error", reject);
			child.on("close", (code) => {
				if (code === 0) resolve({ stdout, stderr });
				else reject(Object.assign(new Error(`${cmd} exited ${code}`), { code, stdout, stderr }));
			});
		});
}

/**
 * The podman venue's boot reaper: `makeReaper` with `bin: "podman"`, so the sweep enumerates, removes and cleans networks
 * in the store the jobs actually ran in, and keeps its tri-state (a failed enumeration is `{ reaped: false }`). Built at
 * boot, early, like `local`'s, because the boot sweep runs before the bundle exists. `exec` (execFile-shaped) or
 * `spawnFn` (spawn-shaped, adapted) are the test seams.
 */
export function makePodmanReaper({ log, exec, spawnFn } = {}) {
	return makeReaper({ log: log ?? (() => {}), bin: "podman", ...(exec ? { exec } : spawnFn ? { exec: execViaSpawn(spawnFn) } : {}) });
}

/** The keys `makePodmanBackend` takes; anything else is refused, since a misspelt config key would be silently dropped. */
export const PODMAN_BACKEND_OPTIONS = Object.freeze([
	// makeRunContainer's deployment inputs, as start.mjs hands the local one.
	"image",
	"hostEnv",
	"egress",
	"egressProxy",
	"openJobLog",
	"globalPiDir",
	"allowGlobalExtensions",
	"packagePaths",
	"forwardEnv",
	"authFromPi",
	"forgeHosts",
	"onOutput",
	// the floor the per-job observation preflight judges, and the boot-built reaper
	"backendFloor",
	"reap",
	// the facts, the identity and the files the observations and the job user come from
	"readInfo",
	"platform",
	"euid",
	"egid",
	"fs",
	"home",
	"env",
	"log",
	// seams
	"spawnFn",
	"exec",
	"makeRunContainer",
	"makeImagePreflight",
	"makeEgressPreflight",
	"makeStopContainer",
]);

/**
 * The podman bundle: `{ name, declares, neverStartedExits, containerName, namePrefix, binds, runContainer,
 * imagePreflight, egressPreflight, stopContainer, reap, jobUserPreflight, observationPreflight }`.
 *
 * BUILT here from PR #425's factories with `bin: "podman"` (and `buildPodmanRunArgs` for the run), rather than taken
 * built as `makeLocalBackend` does, because the pairing IS the adapter: a run under one binary and a stop, a preflight or
 * a sweep under another is the mixed venue every `bin` seam comment warns about. The factory seams exist for the tests.
 *
 * `reap` is the boot-built `makePodmanReaper` (the sweep runs before the bundle exists); omitted, one is built here.
 * `readInfo` is wrapped by `cachedPodmanInfo`, so a boot read through the same wrapped reader is shared with every job.
 */
export function makePodmanBackend(opts = {}) {
	for (const key of Object.keys(opts ?? {})) {
		if (!PODMAN_BACKEND_OPTIONS.includes(key)) throw new Error(`backend "${PODMAN_BACKEND}": unknown option ${JSON.stringify(key)} (takes ${PODMAN_BACKEND_OPTIONS.join(", ")})`);
	}
	const {
		image,
		hostEnv = process.env,
		egress = false,
		egressProxy,
		openJobLog,
		globalPiDir = null,
		allowGlobalExtensions = true,
		packagePaths = [],
		forwardEnv = [],
		authFromPi = false,
		forgeHosts = {},
		onOutput,
		backendFloor = {},
		reap,
		readInfo = makePodmanInfoReader(),
		platform = process.platform,
		euid = process.geteuid?.(),
		egid = process.getegid?.(),
		fs = { statSync, readFileSync, readdirSync },
		home = homedir(),
		env = process.env,
		log = () => {},
		spawnFn,
		exec,
		makeRunContainer: makeRunContainerFn = makeRunContainer,
		makeImagePreflight: makeImagePreflightFn = makeImagePreflight,
		makeEgressPreflight: makeEgressPreflightFn = makeEgressPreflight,
		makeStopContainer: makeStopContainerFn = makeStopContainer,
	} = opts ?? {};
	if (reap !== undefined && typeof reap !== "function") throw new Error(`backend "${PODMAN_BACKEND}": reap must be a function (makePodmanReaper)`);
	const spawnSeam = spawnFn ? { spawnFn } : {};
	const execSeam = exec ? { exec } : spawnFn ? { exec: execViaSpawn(spawnFn) } : {};
	const info = cachedPodmanInfo(readInfo);

	const runContainer = makeRunContainerFn({
		image,
		hostEnv,
		egress,
		egressProxy,
		...(openJobLog ? { openJobLog } : {}),
		...(onOutput ? { onOutput } : {}),
		globalPiDir,
		allowGlobalExtensions,
		packagePaths,
		forwardEnv,
		authFromPi,
		forgeHosts,
		neverStartedExits: PODMAN_NEVER_STARTED_EXITS,
		bin: "podman",
		buildArgs: buildPodmanRunArgs,
		...spawnSeam,
	});

	// Logged only when the answer CHANGES, as `local`'s `runtime_observed` and `job_user` are: per job otherwise.
	let observedSaid = null;
	let jobUserSaid = null;

	// The floor's podman half, per job and pre-spend, shaped exactly like `local`'s: `{ ok: true, podman }`, `{ refused,
	// message, observations }` for an answered miss, `{ unavailable, reason }` when the miss rests only on a read that did
	// not answer (a retry, never a refusal). `podman` carries the read so the job user is decided from the same answer.
	const observationPreflight = async () => {
		const read = await info();
		// The identity FIRST, from this same read, as at boot. A venue whose job user is refused (rootful, remote, no
		// podman) fails the observations too, and judging them first told every job naming it to fix a mounts.conf or
		// delegate controllers when the one fix is its identity's. Handed back as `jobUserRefused`, which the processor
		// acts on BEFORE its image preflight: that preflight asks the same Podman, so behind it a missing podman was
		// retried forever and a rootful one without the image in its store was blamed on the image. No image can change
		// an unmappable answer (`resolvePodmanImageUser` refuses it before reading any capability). An undecided read
		// (`unknown`) is still judged here and is retried, never refused.
		const decision = decidePodmanJobUser({ platform, euid, egid, read });
		if (decision.mode === "unmappable") return { ok: true, podman: read, jobUserRefused: { refused: "job-user-unmappable", cause: decision.cause } };
		const observed = observePodman({ read, fs, home, env, euid });
		if (podmanObservationKey(observed) !== observedSaid) {
			observedSaid = podmanObservationKey(observed);
			log("podman_observed", { ...observed.observations, changed: true });
		}
		const args = { backends: [PODMAN_BACKEND], backendFloor, observations: observed.observations, evidence: observed.evidence };
		const [refusal] = observationRefusals(args);
		if (!refusal) return { ok: true, podman: read };
		const missed = [...new Set(unobservedFloor(args.backends, args.backendFloor, args.observations).map((m) => m.observedBy))];
		if (observationRefusalIsTransient(args)) return { unavailable: true, reason: observed.reasons[missed[0]] ?? "unknown" };
		return { refused: true, message: refusal, observations: missed };
	};

	const jobUserPreflight = async (_job, { capabilities = [], observed } = {}) => {
		const read = observed?.podman ?? (await info());
		const decision = decidePodmanJobUser({ platform, euid, egid, read });
		const said = `${decision.mode}|${decision.user}|${decision.cause}|${decision.reason}|${decision.relabel}`;
		if (said !== jobUserSaid) {
			jobUserSaid = said;
			log("job_user", { backend: PODMAN_BACKEND, mode: decision.mode, user: decision.user, cause: decision.cause, reason: decision.reason });
		}
		return resolvePodmanImageUser(decision, { capabilities, euid, egid });
	};

	return {
		name: PODMAN_BACKEND,
		// The table's own frozen words, never re-typed (`makeLocalBackend`'s reason).
		declares: BACKENDS[PODMAN_BACKEND].declares,
		neverStartedExits: PODMAN_NEVER_STARTED_EXITS,
		containerName: jobContainerName,
		namePrefix: JOB_NAME_PREFIX,
		// Bind mounts (`-v`, the shared builder), so `/job`'s read-only is the kernel's, as on `local`.
		binds: true,
		runContainer,
		imagePreflight: makeImagePreflightFn({ image, bin: "podman", ...spawnSeam }),
		egressPreflight: makeEgressPreflightFn({ proxy: egressProxy, armed: egress, bin: "podman", ...spawnSeam }),
		stopContainer: makeStopContainerFn({ bin: "podman", ...execSeam }),
		reap: reap ?? makePodmanReaper({ log, ...execSeam }),
		jobUserPreflight,
		observationPreflight,
	};
}
