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
 * mounts are relabelled, and, with this host's files, the three observations the table's words rest on. Rootless-ness
 * and remoteness cannot change under a running worker without a restart (they are this account's and this process's
 * environment), so re-reading them per job would only add a spawn. The FILES an observation reads are re-read per job:
 * mounts.conf and containers.conf, because an operator creating the empty override must not need a restart, and the
 * account's user-manager cgroup (issue #453), because that manager can stop under a running worker (linger turned off,
 * the last login session ending) and the next job must then be judged without its bounds. One residual rides the
 * cache: the cgroup manager `podman info` reported at the first answered read is kept, so a user bus that appears or
 * disappears later is not seen until a restart.
 *
 * `backends.mjs` stays a leaf, so this module imports it and never the other way round.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { JOB_NAME_PREFIX, execDockerBounded, jobContainerName, makeReaper, makeStopContainer } from "./backend-local.mjs";
import { BACKENDS, PODMAN_ADDS_NO_MOUNTS, PODMAN_BACKEND, PODMAN_CONF_WIDENS_JOB, PODMAN_NETWORK_HELPER_KEYS, PODMAN_WIDENING_KEYS, PODMAN_BOUNDS_DELEGATED, PODMAN_SERVICE_LOCAL, observationRefusalIsTransient, observationRefusals, unobservedFloor } from "./backends.mjs";
import { CONTAINER_HOME, SHIPPED_IMAGE_UID } from "./container-spec.mjs";
import { buildPodmanRunArgs } from "./docker-run.mjs";
import { DEFAULT_EGRESS_PROXY, makeEgressPreflight } from "./egress.mjs";
import { NETNS_KEEPER, NETNS_KEEPER_FORMAT, QUADLET_FILES, STARTED_AT_FORMAT, judgeNetnsKeeper, netnsKeeperRemedy, podmanNeedsNetnsKeeper } from "./podman-stack.mjs";
import { makeImagePreflight } from "./image-preflight.mjs";
import { DAEMON_FACTS_TIMEOUT_MS, JOB_USER_FACTS_MAX_AGE_MS, STALE_FACTS_CEILING_MS } from "./job-user.mjs";
import { PODMAN_INFO_ARGS, parsePodmanInfo } from "./daemon-facts.mjs";

// Moved to the leaf `daemon-facts.mjs` (issue #452, gate round 3) and re-exported, so every importer keeps its path.
export { PODMAN_INFO_ARGS, parsePodmanInfo };
import { makeRunContainer } from "./run-container.mjs";
import { MOUNT_KEY, MOUNT_KEY_SAYS, PODMAN_HOOKS_DIRS, TRANSIENT_READ_ERRORS, confFilesIn, confKeyFinding, confWidening, stripStockBlocks, widenKeyPattern, fipsFinding, hooksFinding, unreadFileFinding } from "./runtime-observations.mjs";

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
 * `readInfo` with its last ANSWERED result kept for `maxAgeMs`, and concurrent callers sharing one read. An unanswered
 * read is never kept: a Podman that timed out once must be asked again, or every later job would retry on a stale
 * failure. Idempotent, so the boot wiring can wrap a reader once and hand the same one to the bundle and to its own boot
 * read (a second wrap keeps the first wrap's clock and age).
 *
 * The age (issue #596, gate round 2) is the job-user resolver's (`JOB_USER_FACTS_MAX_AGE_MS`), for the same reason:
 * this read carries the host's CPU count that every job's `--cpus` ceiling is built from, and a raised or lowered count
 * must be seen without a restart. STALE WHILE ERROR, also as there: a read past the age that does not answer keeps
 * serving the kept answer until a read does, logging `podman_info_stale` with the failed read's reason once per run of
 * failures, because the age exists to see a change and must not turn one slow `podman info` into a failed pickup.
 * Podman has no `invalidate`: it accepts a `--cpus` above the host's count (4.9.3 and 5.8.1, measured), so no job
 * refusal proves the kept count wrong.
 */
export function cachedPodmanInfo(readInfo, { now = Date.now, maxAgeMs = JOB_USER_FACTS_MAX_AGE_MS, log = () => {} } = {}) {
	if (readInfo?.[CACHED]) return readInfo;
	let kept = null;
	let keptAt = 0;
	let staleSaid = false;
	let inFlight = null;
	const cached = async () => {
		if (kept && now() - keptAt < maxAgeMs) return kept;
		if (inFlight) return inFlight;
		inFlight = (async () => {
			let read;
			try {
				read = await readInfo();
			} catch {
				read = { answered: false, reason: "spawn-failed", transient: true };
			}
			if (read?.answered === true && read.info) {
				kept = read;
				keptAt = now();
				staleSaid = false;
				return read;
			}
			// Not past `STALE_FACTS_CEILING_MS` (job-user.mjs says why): then the failed read is the answer, as a first one is.
			if (kept && now() - keptAt < STALE_FACTS_CEILING_MS) {
				if (!staleSaid) {
					staleSaid = true;
					log("podman_info_stale", { reason: read?.reason ?? "unanswered", ageMs: now() - keptAt });
				}
				return kept;
			}
			return read;
		})();
		try {
			return await inFlight;
		} finally {
			inFlight = null;
		}
	};
	cached[CACHED] = true;
	// Issue #452, gate round 4: the kept ANSWERED read, without reading, for a job's teardown.
	cached.peek = () => kept;
	return cached;
}

/**
 * The system containers.conf files and drop-in directories rootless Podman reads (containers/common v0.67.0
 * `systemConfigs`): the vendor and `/etc` files, `/etc/containers/containers.conf.d`, and for a uid above 0
 * `/etc/containers/containers.rootless.conf`, its `.d` and the `.d/<uid>` beneath it (added in `podmanConfFiles`).
 * Measured for issue #448 (gate round 1 of PR #473) with a drop-in in each place: Podman 5.8.1 read
 * `containers.rootless.conf`, which this list missed until then, and neither Podman read
 * `/usr/share/containers/containers.conf.d` or `/usr/share/containers/containers.rootless.conf.d`, so they are not on it.
 * Podman 4.9.3 read none of the `rootless` places; they stay, since a superset only refuses more.
 */
export const PODMAN_ROOTLESS_CONF_FILES = Object.freeze(["/usr/share/containers/containers.conf", "/etc/containers/containers.conf", "/etc/containers/containers.rootless.conf"]);
export const PODMAN_ROOTLESS_CONF_DIRS = Object.freeze(["/etc/containers/containers.conf.d", "/etc/containers/containers.rootless.conf.d"]);
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
		dirs: [...PODMAN_ROOTLESS_CONF_DIRS, `/etc/containers/containers.rootless.conf.d/${euid}`, `${configHome}/containers/containers.conf.d`],
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
			return unreadFileFinding(path, error?.code ?? "error");
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
 * The cgroup of this account's systemd user manager, whose `cgroup.controllers` says which controllers are delegated to
 * it. Measured (issue #453, Fedora 44): the path is absent while `user@<uid>.service` is inactive and present while it
 * runs, which is systemd's own behaviour (the unit's cgroup is removed when it stops).
 */
export function podmanUserManagerControllersPath(euid) {
	return `/sys/fs/cgroup/user.slice/user-${euid}.slice/user@${euid}.service/cgroup.controllers`;
}

/** What `observePodmanBounds` says when no systemd user manager runs for the account (issue #453); doctor keys its fix on the cause. */
export function podmanNoUserManagerEvidence(euid) {
	return `no systemd user manager is running for this account (${podmanUserManagerControllersPath(euid)} does not exist), so Podman leaves a job's pids, memory and cpu bounds unapplied, whichever cgroup manager it uses: with linger off the manager runs only while the account has a login session, and a \`sudo -iu\` shell starts none (measured). On a host without systemd managing cgroups under user.slice this path never exists, and the venue gives no credit there`;
}

/** Whether a `/proc/self/cgroup` text puts this process inside the account's user manager (a systemd user service). */
function insideUserManager(text, euid) {
	const line = String(text ?? "").split("\n").find((l) => l.startsWith("0::"));
	return typeof line === "string" && line.slice(3).startsWith(`/user.slice/user-${euid}.slice/user@${euid}.service/`);
}

/**
 * `podmanBoundsDelegated` from the info and this host's files: rootless, cgroup v2, a RUNNING systemd user manager for
 * this account with `pids`, `memory` and `cpu` delegated to it, Podman able to put its containers under that manager,
 * and no containers.conf taking containers out of their cgroup. Rootful Podman is refused as a venue, so it earns
 * nothing here either.
 *
 * WHAT DECIDES IT (issue #453, measured on Fedora 44 with rootless Podman 5.8.1, round-446 M0-e and the gate's L rows):
 *   - no user manager (linger off, a `sudo -iu` shell): the container landed in the caller's root-owned session scope,
 *     `pids.max`, `memory.max` and `cpu.max` `max`, exit 0, whichever cgroup manager was configured;
 *   - a user manager running AND Podman reaching it (`podman info` reports the `systemd` cgroup manager): applied;
 *   - a user manager running but NOT reachable over D-Bus (no user bus socket, a DBUS_SESSION_BUS_ADDRESS pointing
 *     nowhere, a system unit with `User=` and no user bus): Podman fell back to `cgroupfs`, the container landed in the
 *     caller's own root-owned cgroup, unbounded (gate L1, L2, L3);
 *   - `cgroupfs` from a process already inside `user@<uid>.service` (a user unit, with or without `Delegate=`): applied.
 * So credit needs the manager's cgroup with the three controllers, and then either the `systemd` cgroup manager or this
 * process inside that manager. `podman info`'s `host.cgroupControllers` decides nothing: it is the caller's own cgroup,
 * which listed all five with nothing applied. Fail-closed where not measured, or where measured applied but not
 * provable from here: an explicit `cgroupfs` from a shell outside the manager with a reachable bus applied (M0-e E3c)
 * and is not credited; no user manager with the caller in a cgroup of its own that the account owns (a system unit with
 * `User=` and `Delegate=yes`, linger off) was not measured and is not credited.
 */
function observePodmanBounds(info, { fs, home, env, euid }) {
	if (info.rootless !== true) return { value: false, evidence: "podman info does not report a rootless Podman, which is the only kind this venue runs on" };
	if (info.cgroupVersion !== "v2") return { value: false, evidence: `podman info reports cgroup ${info.cgroupVersion ?? "version unknown"}, and rootless bounds need cgroup v2` };
	if (!Number.isInteger(euid) || euid < 0) return { value: false, evidence: "the worker's uid is not known, so whether its systemd user manager runs could not be read" };
	const path = podmanUserManagerControllersPath(euid);
	let text;
	try {
		text = String(fs.readFileSync(path, "utf8"));
	} catch (error) {
		if (error?.code === "ENOENT") return { value: false, cause: "no-user-manager", evidence: podmanNoUserManagerEvidence(euid) };
		return unreadFileFinding(path, error?.code ?? "error");
	}
	const controllers = text.split(/\s+/).filter((c) => /^[a-z][a-z0-9_]{0,31}$/.test(c));
	const missing = ["pids", "memory", "cpu"].filter((c) => !controllers.includes(c));
	// Measured (gate 456, Fedora 44, Podman 5.8.1, a manager delegated only memory and pids): a job carrying `--cpus`
	// FAILED to start, crun exit 126 "controller `cpu` is not available", and one without it ran with no cpu.max at all.
	// Only the cpu case was measured, so the sentence says what a job gets without claiming more for the other two.
	if (missing.length > 0) return { value: false, evidence: `the ${missing.join(", ")} cgroup ${missing.length === 1 ? "controller is" : "controllers are"} not delegated to this account's systemd user manager (user@${euid}.service), so a job cannot have that bound: measured for cpu, Podman 5.8.1 refuses to start a container carrying --cpus (exit 126, "controller \`cpu\` is not available")` };
	if (info.cgroupManager !== "systemd") {
		let inside = false;
		try {
			inside = insideUserManager(fs.readFileSync("/proc/self/cgroup", "utf8"), euid);
		} catch (error) {
			if (error?.code !== "ENOENT") return unreadFileFinding("/proc/self/cgroup", error?.code ?? "error");
		}
		if (!inside) {
			return {
				value: false,
				cause: "user-manager-unreachable",
				evidence: `${info.cgroupManager === null ? "podman info does not say which cgroup manager Podman uses" : `Podman is using the ${info.cgroupManager} cgroup manager, not systemd`}, and this worker is not running inside the account's user manager (user@${euid}.service), so whether a job's pids, memory and cpu bounds are applied is not observed from here. Measured: where a configured systemd manager fell back to cgroupfs because Podman could not reach the user manager over D-Bus (no user bus socket, a DBUS_SESSION_BUS_ADDRESS pointing nowhere), the container landed in the worker's own cgroup unbounded; an explicit cgroupfs with the bus reachable had its bounds applied, and nothing read here tells the two apart`,
			};
		}
	}
	const listed = podmanConfFiles({ fs, home, env, euid });
	if (listed.finding) return listed.finding;
	const conf = confKeyFinding(fs, listed.files, { key: CGROUPS_KEY, says: "sets a cgroups key, which can run every container outside its cgroup with its bounds unapplied" });
	if (conf) return conf;
	return {
		value: true,
		controllers,
		evidence: `rootless Podman on cgroup v2, with this account's systemd user manager (user@${euid}.service) running and the pids, memory and cpu controllers delegated to it, ${info.cgroupManager === "systemd" ? "Podman using the systemd cgroup manager" : "this worker running inside that manager"}, and no containers.conf sets cgroups`,
	};
}

/**
 * A containers.conf key that WIDENS what a job reaches, and that no flag on the job's own command line takes back (issue
 * #428, measured on Fedora 44, rootless Podman 5.8.1, pasta, 2026-09-26):
 *   - `pasta_options`: Podman puts these BEFORE its own options in pasta's argv, for the job's `--network=private` AND for
 *     the rootless netns pasta behind every bridge network (a job's own non-internal bridge, the egress proxy's). Mapping
 *     the host's loopback (`--map-host-loopback 169.254.1.2`, `--map-gw`) handed an egress-off job, a bridged job and the
 *     proxy the host's 127.0.0.1 services, the job queue's Valkey among them; `-T 6379` made the job's own
 *     127.0.0.1:6379 the host's, and Podman then drops its own `-T none`.
 *   - `network_cmd_options`: slirp4netns's (`allow_host_loopback=true` under `default_rootless_network_cmd="slirp4netns"`,
 *     the rootless default before Podman 5, which was not measured) opened the same three through 10.0.2.2.
 *   - `annotations`: `run.oci.keep_original_groups=1` kept the account's supplementary groups inside the job, and a
 *     root:podman 0640 host file mounted into it became readable. `dockerExtra` refuses the flag; the conf set it anyway.
 *   - `env`, in any table: `[engine] env` is Podman's OWN environment, and `CONTAINERS_CONF_OVERRIDE` there made it read
 *     a containers.conf this check never reads (measured: pasta then got `--map-host-loopback`), as `CONTAINERS_CONF`,
 *     `XDG_CONFIG_HOME` or `HOME` could; `[containers] env` adds variables to every job past the worker's own closed
 *     environment. Both are account-wide and no argv takes them back. `env_host` is NOT this key (the pattern ends at
 *     `env`), and needs no refusal: `--env-host=false` is in `PODMAN_PINNED_FLAGS`.
 *   - `helper_binaries_dir` and `network_cmd_path` (issue #450, gate round 1): where Podman finds pasta, slirp4netns and
 *     its other helpers, and which slirp4netns it runs. Either one swaps the program behind every job's network for
 *     another: measured, a `helper_binaries_dir` naming a directory with a wrapper in it first ran the rootless network
 *     as `podpasta`, and a plain bridge container then reached the host's loopback. Neither is set in the stock files
 *     (Fedora 44's and Ubuntu 24.04's carry both commented out).
 *   - issue #448, measured with the venue's own argv on rootless Podman 5.8.1 and 4.9.3, each key alone in the account's
 *     own containers.conf: ten more reached the job, and are in the list for that (`PODMAN_WIDENING_KEYS` in backends.mjs
 *     says what each did); the rest measured were inert under the argv's own pins (`PODMAN_ROOTLESS_INERT_KEYS`). The
 *     vendor's own `default_sysctls` block, uncommented in the stock file both distributions ship, is accepted exactly
 *     as it ships (`STOCK_CONF_BLOCKS`), since refusing it would refuse every stock host.
 * REFUSED ON PRESENCE, whatever the value, as `CGROUPS_KEY` is, and for a stronger reason: no argv pins it back. Rejected:
 * pinning `--network=pasta:--map-host-loopback,none` (pasta takes the last mapping, so it cancels the first two, but a
 * conf `-T` survives it, measured); a per-job bridge for an egress-off job (the shared rootless netns pasta reads the
 * same options, measured open); a floor observation (with egress off no declared property covers what a job reaches on
 * the host, so no floor would ever ask on the deployments at risk); and judging the options' VALUES (an allowlist of
 * pasta flags is a parser for another program's argv, and the next release's flag is the one it misses). An egress-armed
 * job on its `--internal` network was closed in every row (no default route, and `--cap-drop=ALL` means it cannot add
 * one), but the venue is refused whatever `PI_EGRESS` says: `annotations` widens a job whatever its network, and the
 * proxy's own bridge takes the same pasta options (open under the loopback mappings, measured). Matched as `MOUNT_KEY` is: any letter case, bare or
 * quoted, dotted (`network.pasta_options`) or in an inline table, never on a whole-line comment, never inside a longer
 * key name. The one capture group is the key, so the refusal names the key it found.
 */
export const WIDENING_KEY = widenKeyPattern(PODMAN_WIDENING_KEYS);

/** `PODMAN_WIDENING_KEYS` as a sentence names them: "a, b, c or d". */
const WIDENING_KEYS_LISTED = `${PODMAN_WIDENING_KEYS.slice(0, -1).join(", ")} or ${PODMAN_WIDENING_KEYS.at(-1)}`;

/** What each widening key does, completing the sentence that names the file it was found in. */
const WIDENING_KEY_SAYS = Object.freeze({
	pasta_options: "sets pasta_options, which Podman hands to the pasta behind every job's network, where a host-loopback mapping (--map-host-loopback, --map-gw, -T) gives the job this host's 127.0.0.1 services",
	network_cmd_options: "sets network_cmd_options, which Podman hands to slirp4netns behind every job's network, where allow_host_loopback=true gives the job this host's 127.0.0.1 services",
	annotations: "sets annotations, which Podman adds to every container, where run.oci.keep_original_groups=1 keeps this account's supplementary groups inside the job",
	env: "sets env, which under [engine] is Podman's own environment (where CONTAINERS_CONF_OVERRIDE, CONTAINERS_CONF, XDG_CONFIG_HOME or HOME moves which containers.conf it reads) and under [containers] adds variables to every job",
	helper_binaries_dir: "sets helper_binaries_dir, which is where Podman finds the pasta and slirp4netns behind every job's network, so another program can stand in for them",
	network_cmd_path: "sets network_cmd_path, which names the slirp4netns Podman runs behind every job's network, so another program can stand in for it",
	default_sysctls: "sets default_sysctls, which Podman sets in every job (any value but the vendor's own ping_group_range block)",
	default_ulimits: "sets default_ulimits, which Podman sets on every job's processes",
	seccomp_profile: "sets seccomp_profile, which replaces the seccomp filter of every job",
	init_path: "sets init_path, which names the binary that runs as every job's PID 1",
	dns_servers: "sets dns_servers, which writes the nameservers of every job with no network of its own",
	dns_options: "sets dns_options, which writes every job's resolver options",
	dns_searches: "sets dns_searches, which writes every job's resolver search list",
	base_hosts_file: "sets base_hosts_file, which names the file every job's /etc/hosts starts from",
	oom_score_adj: "sets oom_score_adj, which Podman applies to every job's processes",
	privileged: "sets privileged, which gives every job a full capability bounding set, no seccomp filter, the host's devices and an unconfined SELinux label",
	label: "sets label, which with false runs every job unconfined by SELinux (spc_t, measured)",
	cgroup_conf: "sets cgroup_conf, which writes cgroup files of every job past its own bounds (pids.max=max outlasted --pids-limit, measured)",
	host_containers_internal_ip: "sets host_containers_internal_ip, which names the address every job reaches as host.containers.internal",
	runtimes: "sets runtimes, which as the [engine.runtimes] table names the OCI runtime binary that creates every job (a wrapper there ran for every job, measured)",
	conmon_path: "sets conmon_path, which names the conmon that monitors every job (a wrapper there ran for every job, measured)",
	cgroups: "sets cgroups, which with disabled runs every job outside its cgroup with its pids and memory bounds unapplied (measured)",
	umask: "sets umask, which every job's processes start with, so what a job writes to this host is as open as it says (measured)",
});

// The cause a widening containers.conf refuses the venue under, defined in the leaf (backends.mjs) and re-exported here.
export { PODMAN_CONF_WIDENS_JOB };

/**
 * A containers.conf this account's Podman reads that widens what a job reaches, as `{ cause, key, evidence }`, else
 * `null` (issue #428). Read over `podmanConfFiles`, the chain the observations read, per call, so removing the key needs
 * no restart. `key` is null when no key was found but the chain could not be read whole: `CONTAINERS_CONF` or
 * `CONTAINERS_CONF_OVERRIDE` set, an unknown home or uid, a file or drop-in directory that exists and cannot be read, or
 * a spelling this check does not decode (an escaped key, a non-ASCII character, a multi-line string). Each of those
 * REFUSES too, on the observations' rule (a drop-in nobody could see must not read as none), and is DETERMINATE: a retry
 * reads the same bytes. The one exception is a read that failed for a moment (`TRANSIENT_READ_ERRORS`: out of
 * descriptors, an I/O error), which comes back with `transient: true` and is retried, never refused, on
 * `observationRefusalIsTransient`'s rule. `podman info` is not an input.
 *
 * THEN THE LIVE NETWORK (issue #450), only when no containers.conf refused: a clean chain says what the NEXT rootless
 * network starts with, not what the running one carries, and that one keeps the options it started with until every
 * bridge container of the account stops (`podmanNetnsWidening`). Here rather than beside each caller, so the boot, the
 * per-job pre-spend check, the sandbox and doctor cannot disagree about it: they all call this one function.
 */
export function podmanConfWidening({ fs, home, env, euid, runRoot }) {
	const listed = podmanConfFiles({ fs, home, env, euid });
	// The chain-agnostic scan (issue #448) the rootful local check shares, with no `unread` list: every file this account's
	// Podman reads is one the worker can read, so one it cannot is refused, as it always was.
	// The vendor's own `default_sysctls` block is accepted as it ships (issue #448), as the rootful check accepts it: the
	// stock file is on this chain too, and refusing it would refuse every stock host.
	const found = listed.finding ?? confWidening(fs, listed.files, { keys: PODMAN_WIDENING_KEYS, says: WIDENING_KEY_SAYS, strip: stripStockBlocks });
	if (!found) return podmanNetnsWidening({ fs, euid, runRoot });
	if (found.value === null) return { cause: PODMAN_CONF_WIDENS_JOB, key: null, evidence: found.evidence, transient: true };
	return { cause: PODMAN_CONF_WIDENS_JOB, key: found.key ?? null, evidence: found.evidence, ...(found.spelling ? { spelling: found.spelling } : {}) };
}

/**
 * The operator text for a `podmanConfWidening` finding: the boot refusal, doctor's fix and the per-job log line, never a
 * forge comment (it names a host path). Names the file and key, says to remove it, and names the trade-off: a setting an
 * operator wanted account-wide (a pasta MTU, say) now goes on their own containers' command line instead.
 */
export function podmanConfRefusal(found) {
	return `${found?.transient ? "Not read yet" : "Refused"}: ${found?.evidence ?? "the containers.conf chain was not read"}; ${podmanConfFix(found)} (issue #${found?.live ? 450 : 428}).`;
}

/**
 * How to reset this account's rootless network (issue #450), measured on Podman 5.8.1 and 4.9.3: it lives until the LAST
 * running container on a bridge network stops, and a bridge container started meanwhile joins it as it is, so a restart
 * of one container at a time never resets it. The shipped Quadlet units are named, the worker's first so its queue does
 * not go under a running job, and the keeper through its unit: a `podman stop` of its container is undone a second
 * later by `Restart=always`, and a keeper back while another bridge container still runs rejoins the network as it is
 * (measured on 5.8.1 and 4.9.3). A unit the account does not have is reported "not loaded" and the others still stop
 * and start (measured, exit 5). A container this project did not start is the operator's to find (`podman ps`).
 */
export const ROOTLESS_NETNS_RESET = `stop every running container of this account that is on a bridge network, all of them at once, then start them again, since the rootless network they share lives until the last of them stops and a container started meanwhile joins it as it is: with this project's units, systemctl --user stop pi-dispatch-worker.service ${QUADLET_FILES.proxy.unit} ${QUADLET_FILES.keeper.unit} ${QUADLET_FILES.valkey.unit}, then podman stop any other container \`podman ps\` still lists, then systemctl --user start ${QUADLET_FILES.valkey.unit} ${QUADLET_FILES.keeper.unit} ${QUADLET_FILES.proxy.unit} pi-dispatch-worker.service (a worker installed at system scope is stopped and started with sudo systemctl stop and start pi-dispatch-worker.service instead; for containers started by hand, podman stop them all, then podman start them). Stop the keeper with systemctl, not podman stop: its unit starts it again a second later, and it then rejoins the network as it is while any other bridge container still runs. A unit this account does not have is reported as not loaded, and the others still stop and start`;

/** `PODMAN_NETWORK_HELPER_KEYS` (backends.mjs) as a set: the only keys whose remedy resets the rootless network. */
const NETWORK_HELPER_KEYS = new Set(PODMAN_NETWORK_HELPER_KEYS);

/** The remedy half of `podmanConfRefusal`, alone, for doctor's fix line. */
export function podmanConfFix(found) {
	if (found?.live && !found.transient) {
		return found.key
			? `${ROOTLESS_NETNS_RESET}. A worker this stopped at boot exits 2 and stays down until that start brings it back; a running one reads this network again before every podman job and admits the next once it no longer carries the option`
			: "the podman venue reads /proc to find this account's rootless network and the options it runs with; run the worker where /proc is mounted and lists the worker account's own processes";
	}
	if (found?.key && !NETWORK_HELPER_KEYS.has(found.key)) {
		// Gate round 1 of PR #473: a key Podman applies per container needs no network reset; the next job reads the file.
		return `remove that key from that file; the next podman job runs once it is gone, since Podman reads this account's containers.conf for every container it starts. The podman venue refuses any containers.conf this account's Podman reads that sets ${WIDENING_KEYS_LISTED}, whatever the value, because no flag on a job's command line takes it back. A setting you need for your own containers goes on their own command line or Quadlet unit instead, not account-wide`;
	}
	return found?.key
		? `remove that key from that file, then ${ROOTLESS_NETNS_RESET}. The podman venue refuses any containers.conf this account's Podman reads that sets ${WIDENING_KEYS_LISTED}, whatever the value, because no flag on a job's command line takes it back, and it refuses a rootless network still running with such an option after the key is gone. A setting you need for your own containers (a pasta MTU, say) goes on their own command line (--network=pasta:...) or Quadlet unit instead, not account-wide`
		: found?.transient
			? "the read failed for a moment, not for a reason in the file; a job refused this way is retried once (the queue's second attempt) and a boot exits to be restarted, so if it recurs, fix what the host ran out of (file descriptors, memory, a failing disk)"
			: found?.spelling
				? `rewrite ${found.spelling === "escaped" ? "that key without a backslash escape" : "that line in plain ASCII with no \"\"\" or ''' multi-line string"}: this check reads a containers.conf only in plain ASCII with plain keys, since a non-ASCII case fold, a multi-line string or an escape was measured hiding a key from it that Podman honoured, and it refuses what it cannot read rather than guess`
				: `the podman venue must read every containers.conf this account's Podman reads to know that none sets ${WIDENING_KEYS_LISTED}; make that file or directory readable by the worker's account, or unset the variable for it`;
}

/**
 * Where Podman 5 RECORDS this account's rootless network helper (issue #450, measured on 5.8.1 with pasta, and with
 * slirp4netns under `default_rootless_network_cmd`): the file holds the helper's host pid, and the helper's own argv
 * names the network under the same directory (`--netns <dir>/rootless-netns` for pasta, the positional path after
 * `--netns-type=path` for slirp4netns). `runRoot` is `podman info`'s `store.runRoot` (`/run/user/<uid>/containers` by
 * default, measured; wherever `XDG_RUNTIME_DIR` or a storage.conf moves it otherwise). No job can write there.
 */
export function rootlessNetnsRecord(runRoot) {
	const dir = `${runRoot}/networks/rootless-netns`;
	return { pidFile: `${dir}/rootless-netns-conn.pid`, netns: `${dir}/rootless-netns` };
}

/**
 * Podman 4.9.3's rootless network, as its slirp4netns's argv names it: `--netns-type=path
 * <XDG_RUNTIME_DIR>/netns/rootless-netns-<hex>` (measured). 4.9.3 does keep a record, a
 * `<engine tmp_dir>/rootless-netns/rootless-netns-slirp4netns.pid` (measured present while the helper runs), but `podman
 * info` does not report that directory (measured: no key names `libpod/tmp`), so on 4.x the helper is found by this path
 * instead, and only among processes in
 * the worker's OWN pid namespace (`NSpid` with one field, which a job's `--pid=private` process never has, and which the
 * worker reads from `/proc/<pid>/status` with no ptrace check a job could deny).
 */
const ROOTLESS_NETNS_4X = /\/netns\/rootless-netns-[0-9a-f]+$/;

/**
 * Which kind of helper `argv` is, from its SHAPE, never its name: a renamed binary (a `helper_binaries_dir` that puts
 * another program first, measured running as `podpasta`) keeps Podman's argv. slirp4netns is the one given
 * `--netns-type`; anything else Podman starts for the rootless network is pasta.
 */
export function rootlessNetnsKind(argv) {
	return argv.slice(1).some((t) => t === "--netns-type" || t.startsWith("--netns-type=")) ? "slirp4netns" : "pasta";
}

/** The values `argv` carries, each option's `=` value as well as each bare token. */
function argvValues(argv) {
	return argv.slice(1).map((t) => (t.startsWith("-") && t.includes("=") ? t.slice(t.indexOf("=") + 1) : t));
}
/**
 * What in a rootless network helper's argv gives a job this host's own services (issue #450), as phrases completing
 * "the rootless network still ...", empty when nothing does. Keyed on what Podman 5.8.1 and 4.9.3 were MEASURED to put
 * there when a containers.conf widened it, which is not always the option the conf named:
 *   - `--map-host-loopback`, in the space or the `=` form, and any prefix pasta's getopt_long takes for it (measured:
 *     Fedora 44's pasta 2026-01-20 ran with `--map-h 169.254.1.2` and `--tcp-n 6379`);
 *   - Podman's own `--no-map-gw` MISSING: a conf `--map-gw` never shows in the argv, Podman drops `--no-map-gw` instead
 *     (so issue #450's "look for --map-gw" would have missed it);
 *   - a `-T`/`--tcp-ns` (and `-U`/`--udp-ns`) other than `none`, attached or in a short cluster too, or Podman's own
 *     `-T none` MISSING, which a conf `-T <port>` makes Podman drop. `-U` was not measured widened; it gets the same
 *     rule because pasta's default for it is not `none` either, and every measured argv carried `-U none`;
 *   - on slirp4netns, Podman's own `--disable-host-loopback` MISSING, which `allow_host_loopback=true` removes.
 * Presence of the known narrowing options, not a list of harmless ones: an option this does not know is not judged,
 * which is why the containers.conf check beside it still refuses every value of the key.
 */
export function rootlessNetnsWidening(kind, argv) {
	const args = argv.slice(1);
	if (kind === "slirp4netns") return args.includes("--disable-host-loopback") ? [] : ["lacks Podman's own --disable-host-loopback, which allow_host_loopback=true removes, so 10.0.2.2 there is this host's 127.0.0.1"];
	let mapsLoopback = false;
	let noMapGw = false;
	const ns = { T: [], U: [] };
	args.forEach((t, i) => {
		if (t.startsWith("--")) {
			const eq = t.indexOf("=");
			const name = eq < 0 ? t : t.slice(0, eq);
			const value = eq < 0 ? args[i + 1] : t.slice(eq + 1);
			// getopt_long takes an unambiguous prefix: `--map-h` is --map-host-loopback, `--tcp-n` is --tcp-ns.
			if (name === "--no-map-gw") noMapGw = true;
			else if (name.length >= 7 && "--map-host-loopback".startsWith(name)) mapsLoopback = true;
			else if (name.length >= 7 && "--tcp-ns".startsWith(name)) ns.T.push(value);
			else if (name.length >= 7 && "--udp-ns".startsWith(name)) ns.U.push(value);
		} else if (/^-[^-]/.test(t)) {
			for (const letter of ["T", "U"]) {
				const at = t.indexOf(letter);
				if (at > 0) ns[letter].push(t.length > at + 1 ? t.slice(at + 1) : args[i + 1]);
			}
		}
	});
	const found = [];
	if (mapsLoopback) found.push("carries --map-host-loopback, which maps this host's 127.0.0.1 into it");
	if (!noMapGw) found.push("lacks Podman's own --no-map-gw, which a --map-gw option removes, so its gateway address is this host");
	for (const [letter, proto] of [["T", "TCP"], ["U", "UDP"]]) {
		if (ns[letter].length === 0) found.push(`lacks Podman's own -${letter} none, so pasta forwards to this host's loopback ${proto} ports`);
		else if (ns[letter].some((v) => v !== "none")) found.push(`carries a -${letter} other than none, which forwards to this host's loopback ${proto} ports`);
	}
	return found;
}

/**
 * This account's running rootless network helpers, from Podman's own record (issue #450), as `{ helpers: [{ pid, kind,
 * widened }] }` or `{ unread: { path, code } }`. Never found by process name, and never by a path a job could forge:
 *   1. Podman 5: the pid in `rootlessNetnsRecord(runRoot).pidFile`. That process is the helper when it is still this
 *      uid's and its argv names that record's pid file or network (so a pid the kernel has since handed to another
 *      process is not trusted). A missing file is no helper: Podman removes it when the last bridge container stops
 *      (measured), and with it missing under a running helper Podman itself could not start a job (TUNSETIFF,
 *      measured). A file whose pid is gone (a killed helper leaves it, measured) is no helper either.
 *   2. Podman 4.x, only when there is no such record: every process of this uid in the worker's own pid namespace
 *      whose argv carries `--netns-type=path <...>/netns/rootless-netns-<hex>` (`ROOTLESS_NETNS_4X`).
 * A process gone mid-read (ENOENT, ESRCH) is skipped; a status denied under `hidepid` is only ever another account's
 * and is skipped. What decides it and cannot be read REFUSES, the containers.conf chain's rule: the record (a
 * `runRoot` that is not an absolute path, a pid file that exists and cannot be read or holds no pid), a `/proc` that
 * exists and cannot be listed, or the argv of a process this rule has already taken for the helper. A transient errno
 * anywhere is the retry. A `/proc` that does not exist is not read, as a missing drop-in directory is not.
 *
 * UNCACHED, measured: the 4.x scan reads every `/proc/<pid>/status` synchronously, and with about 2200 processes took
 * a median of 24.5 ms (max 40.8) on Fedora 44 and 19.1 ms (max 31.9) on Ubuntu 24.04; with a 5.x record it reads three
 * files. A cache would be a window in which a network widened since reads as narrow.
 */
export function observeRootlessNetns({ fs, euid, runRoot }) {
	if (typeof runRoot !== "string" || !runRoot.startsWith("/")) return { unread: { path: "podman info's store.runRoot", code: "unreported" } };
	const gone = (code) => code === "ENOENT" || code === "ESRCH";
	const record = rootlessNetnsRecord(runRoot);
	let recorded;
	try {
		recorded = String(fs.readFileSync(record.pidFile, "utf8")).trim();
	} catch (error) {
		if (error?.code !== "ENOENT") return { unread: { path: record.pidFile, code: error?.code ?? "error" } };
	}
	if (recorded !== undefined) {
		if (!/^[1-9][0-9]{0,9}$/.test(recorded)) return { unread: { path: record.pidFile, code: "no-pid" } };
		const proc = readProcess(fs, recorded, euid);
		if (proc.unread) return proc;
		if (!proc.argv) return { helpers: [] };
		const values = argvValues(proc.argv);
		if (!values.includes(record.pidFile) && !values.includes(record.netns)) return { helpers: [] };
		// A pid the kernel handed on after the helper died, to a process that names the record (gate round 2 of PR #469:
		// a job's, after a pasta crash left the file behind): not the helper.
		const age = startedByRecord(fs, record.pidFile, recorded, proc.nspid);
		if (age.unread) return age;
		if (!age.trusted) return { helpers: [] };
		const kind = rootlessNetnsKind(proc.argv);
		return { helpers: [{ pid: Number(recorded), kind, widened: rootlessNetnsWidening(kind, proc.argv) }] };
	}
	let entries;
	try {
		entries = fs.readdirSync("/proc");
	} catch (error) {
		if (error?.code === "ENOENT") return { helpers: [] };
		return { unread: { path: "/proc", code: error?.code ?? "error" } };
	}
	const helpers = [];
	for (const entry of entries) {
		const pid = String(entry);
		if (!/^\d+$/.test(pid)) continue;
		const proc = readProcess(fs, pid, euid, { ownNamespaceOnly: true });
		if (proc.unread) return proc;
		if (!proc.argv) continue;
		const argv = proc.argv;
		const at = argv.findIndex((t, i) => t === "--netns-type=path" || (t === "--netns-type" && argv[i + 1] === "path"));
		if (at < 0 || !argv.slice(at + 1).some((t) => ROOTLESS_NETNS_4X.test(t))) continue;
		helpers.push({ pid: Number(pid), kind: "slirp4netns", widened: rootlessNetnsWidening("slirp4netns", argv) });
	}
	return { helpers };
}

/**
 * One process, as `{ argv }` when it is this uid's (and, with `ownNamespaceOnly`, in the worker's own pid namespace:
 * one `NSpid` field), `{}` when it is not, or is gone, or `{ unread }` when a read failed for a moment or its argv, once
 * it is this uid's, could not be read. A status denied (EACCES, EPERM) is another account's under `hidepid`.
 */
function readProcess(fs, pid, euid, { ownNamespaceOnly = false } = {}) {
	let status;
	try {
		status = String(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
	} catch (error) {
		if (TRANSIENT_READ_ERRORS.has(error?.code)) return { unread: { path: `/proc/${pid}/status`, code: error.code } };
		return {};
	}
	const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
	if (uid === undefined || Number(uid) !== euid) return {};
	const nspidLine = /^NSpid:\s+(.*)$/m.exec(status)?.[1];
	const nspid = nspidLine === undefined ? null : nspidLine.trim().split(/\s+/);
	if (ownNamespaceOnly && (nspid === null || nspid.length !== 1)) return {};
	let cmdline;
	try {
		cmdline = String(fs.readFileSync(`/proc/${pid}/cmdline`, "utf8"));
	} catch (error) {
		if (error?.code === "ENOENT" || error?.code === "ESRCH") return {};
		return { unread: { path: `/proc/${pid}/cmdline`, code: error?.code ?? "error" } };
	}
	const argv = cmdline.split("\0");
	if (argv.at(-1) === "") argv.pop();
	return argv.length > 0 ? { argv, nspid } : {};
}

/**
 * The units `/proc/<pid>/stat`'s start time is in: USER_HZ, which the kernel fixes at 100 for what `/proc` reports on
 * every architecture Podman ships for (x86_64, aarch64, ppc64le, s390x; alpha's 1024 is not one), whatever CONFIG_HZ is.
 */
export const PROC_USER_HZ = 100;

/**
 * How much later than its pid file's mtime the recorded process may have started and still be the one that wrote it
 * (gate round 2 of PR #469). The helper writes the file after it starts (pasta's own `--pid`, Podman's write for
 * slirp4netns), so its true start is never later; the slack is for the arithmetic: `btime` is whole seconds, rounded
 * down, which only makes the start read EARLIER; a start is in 10 ms ticks; and NTP may slew the wall clock by at most
 * 500 ppm between the write and this read, 1.8 s over an hour. 2 s covers those and no more, since a pid recycled
 * within it would need the helper to die within 2 s of starting.
 */
export const RECORD_START_TOLERANCE_MS = 2_000;

/**
 * Whether the recorded process is the one Podman's record was written for, as `{ trusted }` or `{ unread }`: it started
 * no later than the pid file's mtime (`/proc/<pid>/stat` field 22 in `PROC_USER_HZ` ticks after `/proc/stat`'s `btime`,
 * within `RECORD_START_TOLERANCE_MS`). A later start is a recycled pid, UNLESS the process is shaped as no job's process
 * can be: `NSpid` with exactly one field (the worker's own pid namespace, 5.8.1's slirp4netns, measured), or exactly
 * two ending in 1 (PID 1 of a namespace DIRECTLY beneath the worker's, 5.8.1's pasta, measured). A job's own
 * namespace is one level down too, but its PID 1 is always its `--init` process (`/run/podman-init -- <the image's
 * entrypoint>`, measured), whose argv names no record because the worker passes no command after the image (a job's
 * command travels in its environment) and the image is operator-authored: a job can put no string there, though an
 * image that bakes the record's path into its own entrypoint could (PR #469's gate round 4); and a namespace a job
 * makes for itself (`unshare -Urpf` succeeds in a job-shaped container, PR #469's gate round 3) is two levels down, so
 * its PID 1 has three or more fields and is not trusted. Measured on 5.8.1 with
 * pasta and with slirp4netns: the helper started 228 to 353 ms before its record's mtime. That
 * keeps a wall-clock step (which moves `btime` and not the file's mtime) from hiding the real helper: a step is judged
 * on the helper's shape, never read as "no helper". Anything that decides it and cannot be read refuses, named.
 */
function startedByRecord(fs, pidFile, pid, nspid) {
	const unread = (path, error) => ({ unread: { path, code: typeof error === "string" ? error : (error?.code ?? "error") } });
	let mtimeMs;
	try {
		mtimeMs = fs.statSync(pidFile)?.mtimeMs;
	} catch (error) {
		if (error?.code === "ENOENT") return { trusted: false };
		return unread(pidFile, error);
	}
	if (!Number.isFinite(mtimeMs)) return unread(pidFile, "no-mtime");
	let stat;
	try {
		stat = String(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
	} catch (error) {
		if (error?.code === "ENOENT" || error?.code === "ESRCH") return { trusted: false };
		return unread(`/proc/${pid}/stat`, error);
	}
	// Field 22, counted after the `(comm)` field, which may itself hold spaces and parentheses.
	const ticks = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
	if (!/^\d+$/.test(ticks ?? "")) return unread(`/proc/${pid}/stat`, "no-start-time");
	let btime;
	try {
		btime = /^btime\s+(\d+)$/m.exec(String(fs.readFileSync("/proc/stat", "utf8")))?.[1];
	} catch (error) {
		return unread("/proc/stat", error);
	}
	if (btime === undefined) return unread("/proc/stat", "no-btime");
	const startedMs = (Number(btime) + Number(ticks) / PROC_USER_HZ) * 1000;
	if (startedMs <= mtimeMs + RECORD_START_TOLERANCE_MS) return { trusted: true };
	return { trusted: Array.isArray(nspid) && (nspid.length === 1 || (nspid.length === 2 && nspid[1] === "1")) };
}

/**
 * The live half of `podmanConfWidening` (issue #450): this account's running rootless network, when it still carries
 * an option that gives a job this host's services, as a `podman-conf-widens-job` finding with `live: true`, else
 * `null`. The SAME cause, not a sibling: it is the same widening, a containers.conf key's, still in force after the key
 * went, and the cause is a fixed enum the forge comment and the run record already carry; the processor's comment for
 * a `live` finding says it is the running network, not the configuration. `key` is the conf key that gave the helper
 * that option (`pasta_options` for pasta, `network_cmd_options` for slirp4netns). No helper running is no live network:
 * the next bridge container starts one from the conf as it is now, which the chain above has just judged.
 *
 * `runRoot` is `podman info`'s `store.runRoot`: a path, or `null` for an answered info that reported none, which REFUSES
 * (named). `undefined` is an info read that has not answered, and is not judged here: that same read leaves the job user
 * undecided (`unknown`), which retries the job before any container, and the next judgement has the answer.
 */
export function podmanNetnsWidening({ fs, euid, runRoot }) {
	if (!Number.isInteger(euid) || runRoot === undefined) return null;
	const seen = observeRootlessNetns({ fs, euid, runRoot });
	if (seen.unread) {
		const { path, code } = seen.unread;
		const evidence = code === "unreported"
			? "podman info reports no store.runRoot, so where Podman records this account's running rootless network is not known"
			: code === "no-pid"
				? `${path} holds no pid, so which process is this account's running rootless network is not known`
				: code === "no-mtime" || code === "no-start-time" || code === "no-btime"
					? `${path} gives no ${code === "no-mtime" ? "modification time" : code === "no-btime" ? "boot time" : "start time"}, so whether the recorded process is the one Podman's record was written for is not known`
					: `${path} could not be read (${code}), so whether this account's running rootless network still carries an option that widens a job is not known`;
		return TRANSIENT_READ_ERRORS.has(code) ? { cause: PODMAN_CONF_WIDENS_JOB, key: null, live: true, evidence, transient: true } : { cause: PODMAN_CONF_WIDENS_JOB, key: null, live: true, evidence };
	}
	const widened = seen.helpers.find((h) => h.widened.length > 0);
	if (!widened) return null;
	return {
		cause: PODMAN_CONF_WIDENS_JOB,
		key: widened.kind === "pasta" ? "pasta_options" : "network_cmd_options",
		live: true,
		evidence: `this account's running rootless network (${widened.kind}, pid ${widened.pid}), which every container on a bridge network shares, the egress proxy's among them, still ${widened.widened.join(", and ")}: it keeps the options it started with, whatever containers.conf says now`,
	};
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
		// The controllers delegated to the account's user manager when the bounds hold (issue #453), for doctor's line: the
		// fact the answer rests on, never `podman info`'s caller-cgroup list.
		...(bounds.value === true ? { boundsControllers: bounds.controllers } : {}),
		// Which miss it was, when it was the user manager's, so doctor gives that fix and no other.
		...(bounds.cause ? { boundsCause: bounds.cause } : {}),
		// With an answered read, a `null` here is a host file that could not be read for a moment (`unreadFileFinding`),
		// and its reason says so, so the retry names a file rather than "unknown".
		reasons: {
			...(bounds.value === null ? { [PODMAN_BOUNDS_DELEGATED]: bounds.reason ?? "file-unread" } : {}),
			...(mounts.value === null ? { [PODMAN_ADDS_NO_MOUNTS]: mounts.reason ?? "file-unread" } : {}),
		},
	};
}

/**
 * An observation miss that rests on a read that did not answer, as the preflight's `{ unavailable, reason }`, plus
 * `message` (the evidence, which names the path) when that read was a HOST FILE, so the retry's words say which file
 * rather than blaming the runtime. Shared with `local`'s preflight in start.mjs.
 */
export function unavailableFor(observed, name) {
	const reason = observed?.reasons?.[name] ?? "unknown";
	return reason === "file-unread" ? { unavailable: true, reason, message: observed?.evidence?.[name] ?? null } : { unavailable: true, reason };
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
 * The venue half of a podman job's pre-spend preflight, over one info read (`read`, `readInfo()`'s answer), shaped
 * exactly as the bundle's `observationPreflight` answers: `{ ok: true, podman }`, `{ refused, message, observations }`
 * for an answered floor miss, `{ unavailable, reason }` when the miss rests only on a read that did not answer. Beside
 * `ok`, a refused identity rides as `jobUserRefused` and a widening containers.conf as `podmanConfRefused` (`{ reason,
 * key, message }`, issue #428); the processor refuses either before its image preflight.
 *
 * EXPORTED AND SHARED (issue #429) because a sandbox opened on this venue must be refused for exactly what a job is
 * refused for, in the same order, and "the same order" is a property a second copy loses first. The bundle wraps it
 * with its own log line (`onObserved`, called once per judgement that reached the observations) and nothing else.
 *
 * ORDER, and each step is before the next for a reason:
 *   1. the IDENTITY, from this same read. A venue whose job user is refused (rootful, remote, no podman) fails the
 *      observations too, and judging them first told every job naming it to fix a mounts.conf or delegate controllers
 *      when the one fix is its identity's. Handed back as `jobUserRefused`, which the processor acts on BEFORE its
 *      image preflight: that preflight asks the same Podman, so behind it a missing podman was retried forever and a
 *      rootful one without the image in its store was blamed on the image. No image can change an unmappable answer
 *      (`resolvePodmanImageUser` refuses it before reading any capability). An undecided read (`unknown`) is still
 *      judged here and is retried, never refused.
 *   2. the account's own containers.conf (issue #428), before the floor: it refuses whatever the floor says, since
 *      with egress off no declared property covers what the job reaches on the host, so a floor could never ask for it
 *      on the deployments at risk. Re-read per call, so removing the key needs no restart.
 *   3. the observations against `backendFloor`.
 */
export function judgePodmanVenue({ read, platform = process.platform, euid, egid, fs = { statSync, readFileSync, readdirSync }, home = homedir(), env = process.env, backendFloor = {}, onObserved = () => {} } = {}) {
	const decision = decidePodmanJobUser({ platform, euid, egid, read });
	if (decision.mode === "unmappable") return { ok: true, podman: read, jobUserRefused: { refused: "job-user-unmappable", cause: decision.cause } };
	// `runRoot` from this same read (issue #450): `undefined` while it has not answered, when the undecided job user retries.
	const widened = podmanConfWidening({ fs, home, env, euid, runRoot: read?.answered === true && read.info ? (read.info.runRoot ?? null) : undefined });
	// A transient read rides the same field with `transient: true`, which the processor retries rather than refuses.
	if (widened) return { ok: true, podman: read, podmanConfRefused: { reason: PODMAN_CONF_WIDENS_JOB, key: widened.key, message: podmanConfRefusal(widened), ...(widened.live ? { live: true } : {}), ...(widened.transient ? { transient: true, evidence: widened.evidence } : {}) } };
	const observed = observePodman({ read, fs, home, env, euid });
	onObserved(observed);
	const args = { backends: [PODMAN_BACKEND], backendFloor, observations: observed.observations, evidence: observed.evidence };
	const [refusal] = observationRefusals(args);
	if (!refusal) return { ok: true, podman: read };
	const missed = [...new Set(unobservedFloor(args.backends, args.backendFloor, args.observations).map((m) => m.observedBy))];
	if (observationRefusalIsTransient(args)) return unavailableFor(observed, missed[0]);
	return { refused: true, message: refusal, observations: missed };
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

/** The keeper read's bound: one `podman inspect`, on a pre-spend gate, like the proxy's own read beside it. */
export const NETNS_KEEPER_READ_TIMEOUT_MS = 10_000;

/**
 * The egress preflight on this venue, with the rootless network keeper (issue #458) added to what it checks. On Podman
 * 4.x (or a version `podman info` did not give) a job whose proxy is up but whose keeper does not hold would start,
 * spend, and get 503 from the proxy as soon as any earlier job's teardown ran: measured, every egress job after the
 * first. So it is `{ unavailable, keeper }`, an INFRA retry before anything is spent, carrying the sentence that names
 * the keeper and what to run. "Holds" is `judgeNetnsKeeper` with the clock and the proxy's start (PR #463 round 2):
 * running on its own bridge for at least 3 s (a crash loop reads as running for moments), and not started more than
 * the grace (15 s) after the proxy, since a keeper that restarted while the proxy ran may have let a teardown cut the
 * proxy's route out, which only a proxy restart repairs and nothing outside can see. A keeper that is only too young
 * (issue #476) is still not held, but the answer carries `young`, so its caller waits it out rather than failing on it.
 * On 5.x nothing is read. Nothing is cached across jobs but what the bundle already caches (`podman info`, for the
 * version): the keeper and the proxy's start are read on every armed job, two bounded `podman inspect`s.
 */
export function keeperPreflight(proxyPreflight, { armed, proxy, info, spawnFn = null, readKeeper = null, now = Date.now }) {
	const read =
		readKeeper ??
		(spawnFn
			? (args) =>
					execViaSpawn(spawnFn)("podman", args).then(
						(r) => ({ code: 0, stdout: r.stdout }),
						(err) => ({ code: typeof err?.code === "number" ? err.code : null, stdout: err?.stdout ?? "" }),
					)
			: (args) => execDockerBounded(args, { bin: "podman", timeoutMs: NETNS_KEEPER_READ_TIMEOUT_MS }));
	return async (...args) => {
		const result = await proxyPreflight(...args);
		if (!armed || result?.ok !== true) return result;
		const answered = await info();
		const version = answered?.answered === true ? answered.info?.version : null;
		if (!podmanNeedsNetnsKeeper(version)) return result;
		const name = result.proxy ?? proxy ?? DEFAULT_EGRESS_PROXY;
		const keeperRead = await read(["inspect", NETNS_KEEPER_FORMAT, NETNS_KEEPER]);
		const proxyRead = await read(["inspect", STARTED_AT_FORMAT, name]);
		const proxyStarted = proxyRead?.code === 0 ? String(proxyRead.stdout ?? "").trim() : "";
		const keeper = judgeNetnsKeeper(keeperRead, { now: now(), proxyStartedMs: /^\d+$/.test(proxyStarted) ? Number(proxyStarted) : null });
		if (keeper.holds) return result;
		const on = typeof version === "string" && version.trim() ? `Podman ${version.trim()}` : "a Podman of unreported version";
		const cause = keeper.restartProxy ? `the rootless network keeper ${NETNS_KEEPER} ${keeper.problem} (${on}, issue #458)` : `the rootless network keeper ${NETNS_KEEPER} ${keeper.problem}, and on ${on} a job network's teardown would then cut the egress proxy's route out (issue #458)`;
		return {
			unavailable: name,
			// The two halves on their own (issue #452, gate round 2), for a caller that is not about a job: the sandbox opener.
			cause,
			remedy: netnsKeeperRemedy(keeper, name),
			// The same facts without a job in them, for the worker's boot line (PR #463 round 3).
			keeperAtBoot: `${cause}, so every egress job is retried rather than started until this is fixed. To fix it, ${netnsKeeperRemedy(keeper, name)}`,
			keeper: `${cause}, so this job is retried rather than started. To fix it, ${netnsKeeperRemedy(keeper, name)}`,
			// Issue #476: a keeper whose only fault is its age (`{ startedMs, ageMs, waitMs }`), which the boot and the
			// sandbox opener wait out and a job is held for, without an attempt.
			...(keeper.young ? { young: keeper.young } : {}),
			// The judge's own words alone, which follow the keeper's name, for the crash-loop sentence a held job may end on.
			problem: keeper.problem,
		};
	};
}

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
	const info = cachedPodmanInfo(readInfo, { log });

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
		// Issue #452, gate round 4: the teardown's detach gate uses the `podman info` this venue admitted jobs on, never a
		// read of its own; before any answered read it falls back to one. A refused teardown is logged with its token.
		teardownRuntime: () => {
			const kept = info.peek?.();
			return kept?.info ? { podman: true, rootless: kept.info.rootless, version: kept.info.version } : undefined;
		},
		log,
		...spawnSeam,
	});

	// Logged only when the answer CHANGES, as `local`'s `runtime_observed` and `job_user` are: per job otherwise.
	let observedSaid = null;
	let jobUserSaid = null;

	// The floor's podman half, per job and pre-spend: `judgePodmanVenue` over this job's read, with the observation line
	// logged only when the answer CHANGES. The judgement itself is shared with a sandbox opened on this venue (issue #429).
	const observationPreflight = async () =>
		judgePodmanVenue({
			read: await info(),
			platform,
			euid,
			egid,
			fs,
			home,
			env,
			backendFloor,
			onObserved: (observed) => {
				if (podmanObservationKey(observed) !== observedSaid) {
					observedSaid = podmanObservationKey(observed);
					log("podman_observed", { ...observed.observations, changed: true });
				}
			},
		});

	const jobUserPreflight = async (_job, { capabilities = [], observed } = {}) => {
		const read = observed?.podman ?? (await info());
		const decision = decidePodmanJobUser({ platform, euid, egid, read });
		const said = `${decision.mode}|${decision.user}|${decision.cause}|${decision.reason}|${decision.relabel}`;
		if (said !== jobUserSaid) {
			jobUserSaid = said;
			log("job_user", { backend: PODMAN_BACKEND, mode: decision.mode, user: decision.user, cause: decision.cause, reason: decision.reason });
		}
		const chosen = resolvePodmanImageUser(decision, { capabilities, euid, egid });
		// Issue #429: the store this job's container lives in rides beside its user, so a retained run records it and a
		// sandbox or the retention sweep can tell another store's empty answer from "not open".
		const store = read?.answered === true ? read.info?.graphRoot : null;
		// Issue #596: the host's CPU count from the same read, for the job's `--cpus` ceiling. Absent when Podman did not say.
		const hostCpus = read?.answered === true ? read.info?.hostCpus : null;
		const stored = chosen.user && typeof store === "string" ? { ...chosen, store } : chosen;
		return chosen.user && Number.isSafeInteger(hostCpus) ? { ...stored, hostCpus } : stored;
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
		egressPreflight: keeperPreflight(makeEgressPreflightFn({ proxy: egressProxy, armed: egress, bin: "podman", ...spawnSeam }), { armed: egress, proxy: egressProxy, info, spawnFn }),
		stopContainer: makeStopContainerFn({ bin: "podman", ...execSeam }),
		reap: reap ?? makePodmanReaper({ log, ...execSeam }),
		jobUserPreflight,
		observationPreflight,
	};
}
