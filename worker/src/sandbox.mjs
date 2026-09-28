import { execFile, spawn } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { release as osRelease } from "node:os";
import { promisify } from "node:util";
import { execDockerBounded, makeDockerEndpointResolver } from "./backend-local.mjs";
import { PODMAN_CONF_WIDENS_JOB, PODMAN_JOB_USER_FIX, decidePodmanJobUser, judgePodmanVenue, keeperPreflight, makePodmanInfoReader, resolvePodmanImageUser } from "./backend-podman.mjs";
import { DEFAULT_BACKEND, PODMAN_BACKEND, UNATTRIBUTED_BACKEND, parseBackendFloor, parseBackendList } from "./backends.mjs";
import { configError } from "./config.mjs";
import { assertJobUser, CONTAINER_HOME, SHIPPED_IMAGE_UID } from "./container-spec.mjs";
import { buildDockerRunArgs, buildPodmanRunArgs, insideDir } from "./docker-run.mjs";
import { makeImagePreflight } from "./image-preflight.mjs";
import { decideJobUser, JOB_USER_FIX, makeDaemonFactsReader, relabelsPrivateMounts, resolveImageUser, socketFacts } from "./job-user.mjs";
import { DEFAULT_EGRESS_PROXY, NETWORK_SUFFIX, createJobNetwork, egressArmed, egressEnv, egressProxyName, networkEndpoints, networkExists, networkNameFor, removeJobNetwork, removeNetworkOrSay } from "./egress.mjs";
import { NETNS_KEEPER, makeDetachGate, runtimeFromFacts } from "./netns-keeper.mjs";
import { NETNS_KEEPER_START } from "./podman-stack.mjs";
import { isSandboxTombstone, readManifest, readRetained, sandboxDeadline, sandboxEntryName } from "./sandbox-store.mjs";

/**
 * sandbox.mjs -- the operator session's container shape (INT-SANDBOX-CONTRACT).
 *
 * A SECOND container shape, deliberately not a second copy of the first. The argv comes from the run's VENUE's own
 * job builder (`buildDockerRunArgs` on `local`, `buildPodmanRunArgs` on `podman`, `SANDBOX_LAUNCHERS` below) through
 * its `extraFlags` seam, so `ISOLATION_FLAGS`, `--memory` and `--cpus` (and on podman keep-id and
 * `PODMAN_PINNED_FLAGS`) reach this container BY CONSTRUCTION: a future change to the boundary cannot land on job
 * containers and miss this one, which is the whole reason for reusing the builder rather than writing a leaner argv
 * here.
 *
 * What differs from a job, and every difference is the point:
 *   - `-i -t --entrypoint bash`. `INT-CONTAINER-RUNTIME-CONTRACT` says "No TTY (`-it` absent)" and stays
 *     true; this is a different contract for a different object, not an amendment to that one.
 *   - NO CREDENTIALS. Not the minted forge token, not the provider key, not one forwarded host variable.
 *     `buildContainerEnv` is deliberately NOT reused: it writes the mint into that forge's variable names
 *     (env-allowlist.mjs) and throws outright when no provider credential resolves, so a credential-free
 *     container cannot be produced from it. The env here is two variables about the terminal, plus the four
 *     proxy variables when an egress policy is armed, plus `HOME=/home/pi` beside `--user` when the run had a job
 *     user (issue #341).
 *   - No `/outbox`, no `/session`, no `/opt/pi-global`. The agent is not running; there is nothing to
 *     chain, no transcript to continue and no overlay to layer.
 *
 * The agent is not running. The operator is at the keyboard and brings their own auth if they need it.
 */

const exec = promisify(execFile);

/**
 * The venues a sandbox opens on, and how each one spells its container (issue #429): the CLI every spawn for that
 * venue goes through, and the job argv builder the session's argv is built by. Keyed by the venue name the manifest
 * records, so a run is reopened ONLY in the runtime that ran it: a podman run under docker would reproduce none of it
 * (another store, no keep-id, another uid map), and the reverse is as wrong.
 *
 * A TABLE rather than a `bin` read off the backend bundles, and that alternative was the obvious one: the bundles are
 * built by the worker at boot, and the CLI and the admin panel never build them (they would construct a
 * `runContainer`, a reaper and a `podman info` reader to open a shell). What the sandbox needs from a venue is two
 * facts, and both are the same values the bundles are built with (`bin: "podman"` and `buildPodmanRunArgs` in
 * `makePodmanBackend`); `sandbox.test.mjs` pins the pairing. A venue not in this table has no sandbox, by
 * construction: nothing here can reopen a run under a runtime it did not run in.
 *
 * Not "any venue declaring `remote: false`": a future non-remote venue on a third runtime would pass that and be
 * reopened under one of these two. Such a venue must add its own row, deliberately.
 */
export const SANDBOX_LAUNCHERS = Object.freeze({
	[DEFAULT_BACKEND]: Object.freeze({ bin: "docker", build: buildDockerRunArgs }),
	[PODMAN_BACKEND]: Object.freeze({ bin: "podman", build: buildPodmanRunArgs }),
});

/** The launcher for `venue`, or null. `Object.hasOwn`, so `"toString"` is not a venue. */
export function sandboxLauncher(venue) {
	return typeof venue === "string" && Object.hasOwn(SANDBOX_LAUNCHERS, venue) ? SANDBOX_LAUNCHERS[venue] : null;
}

/**
 * The blessed venues a sandbox can open on, in `PI_BACKENDS` order: the venues this host both runs and has a launcher
 * for. The retention reaper asks each one which sandboxes are open, and `--list` draws its RUNNING column from them.
 */
export function sandboxVenues(blessed) {
	return (Array.isArray(blessed) ? blessed : []).filter((venue) => sandboxLauncher(venue) !== null);
}

/**
 * `{ blessed, backendFloor }` as a sandbox opened from `env` sees them, through the worker's own two parsers. For the
 * admin panel, which deliberately never calls `loadConfig`; the CLI has the parsed config already. THROWS on a
 * malformed `PI_BACKENDS` or `PI_BACKEND_FLOOR`, exactly as the worker refuses to boot on one: a typo must never read
 * as "podman is not blessed" (a refusal an operator then chases in the wrong place) or as "no floor" (a podman sandbox
 * opened without the observations the deployment asks for). Read from THIS process's environment and never a
 * deployment's `.env`, which `OQ-038` records for the panel.
 */
export function sandboxVenuePolicy(env) {
	return { blessed: parseBackendList(env?.PI_BACKENDS), backendFloor: parseBackendFloor(env?.PI_BACKEND_FLOOR) };
}

/**
 * The name namespace, and it is load-bearing. The boot reaper filters `name=pi-job-`
 * (`makeReaper` in backend-local.mjs) and docker matches that as a SUBSTRING, so a sandbox must not contain it --
 * otherwise a worker restart kills the shell an operator is sitting in. `pi-sandbox-` is outside that
 * filter on purpose, and a test pins it.
 */
export const SANDBOX_NAME_PREFIX = "pi-sandbox-";

/**
 * `pi-sandbox-<jobId>`. `sanitizeJobId` already maps to `[A-Za-z0-9._-]`, which is a legal docker name. Through
 * `sandboxEntryName` (issue #446), the retained directory's own name, so the id a runtime reports for this container is
 * the name the retention sweep holds: an id whose sanitized form starts with `.` is retained under `_...`, and a
 * container named off the other spelling would never hold its own directory.
 */
export function sandboxContainerName(jobId) {
	return `${SANDBOX_NAME_PREFIX}${sandboxEntryName(jobId)}`;
}

/**
 * Turn `--publish` values into docker flags, BOUND TO LOOPBACK, always.
 *
 * `3000` publishes container 3000 on host 3000; `8080:3000` publishes container 3000 on host 8080. An
 * explicit bind address is refused rather than honoured: this container holds whatever the agent wrote,
 * and the deployment's own admin surface is 127.0.0.1-only for the same reason
 * (`DES-PANEL-SEPARATE-FROM-RECEIVER`). Making the LAN case merely inconvenient would be a worse answer
 * than making it unavailable.
 */
export function parsePublish(values = []) {
	const flags = [];
	for (const raw of values) {
		const match = /^(\d{1,5})(?::(\d{1,5}))?$/.exec(String(raw).trim());
		const host = match && Number(match[1]);
		const container = match && Number(match[2] ?? match[1]);
		if (!match || !inPortRange(host) || !inPortRange(container)) {
			throw configError(`invalid --publish ${JSON.stringify(raw)} (want <port> or <hostPort>:<containerPort>; the bind address is always 127.0.0.1)`);
		}
		flags.push("-p", `127.0.0.1:${host}:${container}`);
	}
	return flags;
}

function inPortRange(n) {
	return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/**
 * Build the `run` argv for one operator session (excluding the leading "docker" or "podman").
 *
 * @param venue        the venue the run used (`SANDBOX_LAUNCHERS`); its builder builds this argv. Defaults to
 *                     `local`, so every caller from before issue #429 gets the argv it always did, byte for byte.
 * @param image        the image the original run used, from its manifest
 * @param name         `pi-sandbox-<jobId>`
 * @param workspace    host path mounted /workspace:rw -- the retained clone, or the operator's own folder
 * @param jobDir       the retained per-job dir, mounted /job:ro exactly as the run had it
 * @param publish      already-parsed `-p` flags
 * @param term         the host's TERM, so the shell renders
 * @param idleSeconds  bash's own TMOUT; 0 omits it
 * @param network      this session's own egress network (REQ-EGRESS-ALLOWLIST); null = the default bridge
 * @param egressEnv    the proxy variables that go with it, or {} when no policy is armed
 * @param user         "<uid>:<gid>" the run had (issue #341), or null for the image's own USER
 * @param home         CONTAINER_HOME beside `user`, and required with it
 * @param relabel      true where the job's own mounts carried `:Z` (issue #355), so the retained ones do again
 * @param workspaceOwned true when `workspace` is the retained clone (the worker's own), false for an operator's folder
 */
export function buildSandboxRunArgs({ venue = DEFAULT_BACKEND, image, name, workspace, jobDir, publish = [], term, idleSeconds = 0, network = null, egressEnv: proxyEnv = {}, user = null, home = null, relabel = false, workspaceOwned = false }) {
	// Thrown, not defaulted to docker: a caller naming a venue this file has no launcher for is assembling a session
	// in a runtime nobody chose, which is the one mistake the table exists to make impossible.
	const launcher = sandboxLauncher(venue);
	if (!launcher) throw new Error(`buildSandboxRunArgs: no sandbox launcher for venue ${JSON.stringify(venue)} (have ${Object.keys(SANDBOX_LAUNCHERS).join(", ")})`);
	// Issue #341: the job path's pairing, for the same measured reason (a uid with no passwd entry gets HOME=/ or
	// HOME=/workspace), so a sandbox shell as that uid can write its own home.
	if (user !== null && home !== CONTAINER_HOME) {
		throw new Error(`buildSandboxRunArgs: a user (${user}) must be paired with HOME=${CONTAINER_HOME}`);
	}
	// Issue #362, and it throws where `openSandbox` returns a refusal because the two answer different
	// questions: that one is an operator's mistake with a fix, this one is a caller assembling an argv that
	// cannot mean what it says.
	//
	// It refuses on ANY network rather than on an internal one, and that is deliberate rather than loose:
	// this builder is handed a NAME and cannot see the flags the network was created with. What it can rely
	// on is that every network this project puts a session on is created `--internal` by `createJobNetwork`.
	// A `-p` on some other user-defined network does work (measured), so this is a refusal about this
	// project's shapes and not a claim about docker.
	if (publish.length > 0 && network !== null) {
		throw new Error(`buildSandboxRunArgs: a published port cannot be paired with a session network (${network}) -- every network this project puts a session on is created --internal, where docker accepts -p and binds nothing`);
	}
	// The venue's own JOB builder, so on podman `--userns=keep-id`, `PODMAN_PINNED_FLAGS` and, with no session network,
	// `--network=private` arrive exactly as a job's do. The last one is load-bearing rather than tidy: a containers.conf
	// `netns = "host"` puts a container launched with no `--network` on the host's network namespace (measured under
	// issue #354), so a podman sandbox with egress off must name its network as a job does. `buildPodmanRunArgs` also
	// refuses a null `user`, which `decideSandboxJobUser`'s podman branch never answers.
	return launcher.build({
		user,
		image,
		name,
		workspace,
		jobDir,
		// Issue #355: the job path's rule, by the same builder. The retained job dir is relabelled again for this one
		// container (the run that labelled it is gone); the workspace only when it is the retained clone, never an
		// operator's folder, which a private label would take away from every other container.
		relabel,
		workspaceOwned,
		// The terminal's two variables, and neither is a credential. TERM so the shell renders; TMOUT so a
		// forgotten session closes itself. HOME beside `--user` and the proxy variables below are the rest.
		// `buildDockerRunArgs` skips undefined, so an unset TERM or a disabled idle timeout emits nothing rather than
		// an empty string.
		// A sandbox joins the SAME kind of network a job did, by the same builder, so the boundary cannot
		// land on job containers and miss this one. Leaving sandboxes on the default bridge was the tempting
		// alternative and it is the wrong one: it reads as a convenience (install a missing dependency while
		// debugging) and it is a WIDER reach than the run the sandbox exists to reproduce. A shell that can
		// go where the run could not is not reproducing the run. Nothing an operator wants is lost, because
		// the forge and the registry are on the allowlist a job needed anyway.
		network,
		env: {
			TERM: term || undefined,
			TMOUT: idleSeconds > 0 ? String(idleSeconds) : undefined,
			// Beside `--user` only (issue #341). Not a credential either.
			HOME: user !== null ? home : undefined,
			// Still NO CREDENTIALS, and that clause is untouched: a proxy URL is not a credential, and
			// buildContainerEnv is still not reused here. The env is two variables about the terminal, HOME
			// beside `--user`, and, when a policy is armed, four about the network.
			...proxyEnv,
		},
		// Ahead of the env and the mounts, and well ahead of the image, which the builder keeps as
		// the final positional. The same four tokens on both venues, through the same `dockerExtra` allow-list. `--entrypoint` also clears the image's CMD; this repo's Dockerfile sets
		// none, so `bash` runs bare and `-it` makes it interactive, in the baked WORKDIR as the baked
		// non-root USER, or as `user` when the run had one.
		extraFlags: ["-i", "-t", "--entrypoint", "bash", ...publish],
	});
}

/**
 * The JOB IDS of sandboxes running right now -- ids, not container names, because that is the shape both
 * consumers want: the reaper compares them to directory names, and `--list` marks rows.
 *
 * THROWS when docker cannot be asked, and that is the point: "none are running" and "I could not find out"
 * must not arrive as the same empty array. The reaper deletes directories, and it treats the second case as
 * a reason to skip the whole sweep -- swallowing the error here would quietly turn a docker outage into a
 * blind sweep that can pull a bind mount out from under a live shell. The CLI, which only draws a column,
 * degrades on its own.
 *
 * TIMED, unlike the boot container reaper's own `docker ps`: an unreachable daemon does not fail the CLI
 * fast, it blocks, and this call sits in front of a worker that has not started draining yet.
 */
export async function listRunningSandboxes({ execFn = exec, bin = "docker", signal } = {}) {
	// `bin` (issue #429) is ONE runtime's CLI: a podman sandbox is invisible to `docker ps` and the reverse, so the
	// retention reaper asks the runtime each retained run records (`makeSandboxRuntimeWatch`), and `--list` each blessed
	// one. `--format {{.Names}}` reads on both.
	// `signal` (issue #446) lets the opener's post-launch look abandon an ask the moment the shell returns: `execFile`
	// kills the child and rejects on abort, so an exited shell never waits out this timeout. Passed only when given,
	// so every other caller's options are what they always were.
	const { stdout } = await execFn(bin, ["ps", "--filter", `name=${SANDBOX_NAME_PREFIX}`, "--format", "{{.Names}}"], { timeout: 5000, ...(signal ? { signal } : {}) });
	return stdout
		.split("\n")
		.map((n) => n.trim())
		.filter((n) => n.startsWith(SANDBOX_NAME_PREFIX))
		.map((n) => n.slice(SANDBOX_NAME_PREFIX.length));
}

/**
 * What the retention reaper asks before it deletes anything, and which runtimes its network sweep visits: `{
 * listRunning, sweepNetworks }` for `makeSandboxReaper` (issue #429, review rounds 1 and 2).
 *
 * PER RETAINED RUN, NEVER PER DEPLOYMENT. For each retained directory it reads the venue the run's manifest records
 * and asks THAT venue's runtime (its launcher's `bin`) which sandboxes are open, and `listRunning` answers the ids the
 * pass must HOLD: every id a runtime reports open, and every retained run whose runtime could not answer (no CLI, a
 * daemon that is down, a timeout, any error). Held means kept this pass, directory and network both; the next pass asks
 * again.
 *
 * WHY NOT THE WORKER'S `PI_BACKENDS`, which the first version of this used and a review refuted by reproduction: the
 * opener's blessing comes from the OPENER's environment (`sandboxVenueRefusal`), the reaper's from the worker's, and
 * `OQ-038` records that the two routinely differ. A worker with `PI_BACKENDS=podman` asked only podman, while an
 * operator shell with no `PI_BACKENDS` opened a run retained earlier under docker, and the pass deleted the directory
 * under the shell. The runtime a run opens in is a property of the RUN, so the question is asked of the run.
 *
 * A RUN THIS CANNOT PLACE is asked of EVERY runtime present (review round 2): a manifest that cannot be read or parsed
 * right now (an `EMFILE`, a rewrite caught mid-write), one naming a venue with no launcher, and (PR #466 gate round 1)
 * a directory with no manifest file at all, which a sandbox opened before its manifest went can still have mounted.
 * Such a run is held when any runtime present cannot answer or reports it open, and swept only once every one has
 * answered "not open". Skipping it was the defect: the reaper's own expiry then re-read the manifest, found it
 * unreadable, and deleted a directory an open sandbox was using with no runtime asked. Holding it forever was the other
 * wrong answer, since nothing would ever sweep it. With no runtime present at all there is nothing on this host that
 * could hold it open.
 *
 * A PODMAN RUN RECORDS ITS STORE (`podmanStore`, `podman info`'s graphRoot) and is held while the podman this asks uses
 * another, or cannot say which it uses (review round 2, measured on Podman 5.8.1): rootless `podman ps -a` over another
 * store (another HOME, XDG_DATA_HOME or storage.conf) answers exit 0 with an EMPTY list, which read as "not open" and
 * deleted the directory under a sandbox opened from that store. The store is read once per pass, only when a podman run
 * recorded one. A run from before the key is asked as it always was.
 *
 * FAIL CLOSED PER DIRECTORY, not per pass: a stale docker CLI with no daemon holds the docker runs and nothing else, so
 * a podman-only host still sweeps its podman runs, and a host with no docker CLI at all asks docker only if a retained
 * run says it ran there. A manifest with no `backend` key predates venue attribution and ran on `local`, which is how
 * `sandboxVenueRefusal` opens it, so docker is asked for it. THROWS only when the retention root itself cannot be
 * listed, which skips the whole pass, on `listRunningSandboxes`' rule.
 *
 * THE NETWORK SWEEP visits every runtime that has been PRESENT since this worker started: one a blessed venue names, or
 * one a retained run has recorded in any pass. Cumulative on purpose, so the network of the LAST run a runtime held is
 * still visited after that run's directory is gone. One sweeper per runtime, built once, and one failing does not stop
 * the other. A host that blesses neither `local` nor `podman` and has retained nothing from either spawns neither CLI,
 * which is the promise `start.mjs` makes for a host without Docker.
 *
 * Every log line is the family's `sandbox_reaper_skipped` (`OQ-007`'s one grep) with a fixed reason token and no CLI
 * text and no path: `runtime-unanswered` per runtime with the number of directories it held, and `podman-store-mismatch`
 * per directory held for its store.
 */
export function makeSandboxRuntimeWatch({ sandboxDir, blessed = [], fs = { lstatSync, readdirSync, readFileSync }, list = listRunningSandboxes, readPodmanStore = defaultPodmanStore, makeSweeper = makeSandboxNetworkSweeper, proxy = DEFAULT_EGRESS_PROXY, log = () => {} } = {}) {
	const blessedBins = new Set(sandboxVenues(blessed).map((venue) => sandboxLauncher(venue).bin));
	// Launcher-table order, so the asks and the log lines read the same on every pass.
	const allBins = [...new Set(Object.values(SANDBOX_LAUNCHERS).map((l) => l.bin))];
	const present = new Set(blessedBins);
	const sweepers = new Map();
	async function listRunning(pass = {}) {
		// The reaper's ONE read per directory (`pass.reads`, review round 3): the watch places each run by exactly the
		// read expiry will decide on. Standing alone (no pass handed in) it lists and reads for itself, the same way.
		let names = pass?.names;
		let reads = pass?.reads;
		if (!Array.isArray(names) || !(reads instanceof Map)) {
			try {
				// A tombstone is a run already decided for deletion (issue #446), never one to place.
				names = fs.readdirSync(sandboxDir).filter((name) => !isSandboxTombstone(name));
			} catch (err) {
				if (err?.code !== "ENOENT") throw err;
				names = [];
			}
			reads = new Map(names.map((name) => [name, readRetained(fs, join(sandboxDir, name))]));
		}
		const byBin = new Map();
		const unplaced = [];
		const stores = [];
		for (const name of names) {
			const read = reads.get(name);
			// A transient failure is the REAPER's hold, whatever any runtime says (nothing about the run is known). A
			// manifest that does not parse, or cannot be read for good, is a run this cannot place, and so, since PR #466
			// gate round 1, is a directory with NO manifest file: the reaper's `no-manifest` rule deletes it, and a
			// `pi-sandbox-<name>` container can still have it mounted (measured: one running over a directory whose
			// manifest was removed was deleted under it, the runtime never asked). Every runtime present is asked.
			if (!read || read.transient) continue;
			if (read.absent || !Object.hasOwn(read, "manifest")) {
				unplaced.push(name);
				continue;
			}
			const manifest = read.manifest;
			const launcher = sandboxLauncher(sandboxVenueOf(manifest));
			if (!launcher) {
				unplaced.push(name);
				continue;
			}
			if (!byBin.has(launcher.bin)) byBin.set(launcher.bin, []);
			byBin.get(launcher.bin).push(name);
			if (launcher.bin === "podman" && typeof manifest?.podmanStore === "string") stores.push([name, manifest.podmanStore]);
		}
		for (const bin of byBin.keys()) present.add(bin);
		const held = new Set();
		// Every runtime present is asked when a run could not be placed; otherwise only the runtimes a run recorded.
		for (const bin of allBins) {
			const entries = byBin.get(bin) ?? [];
			const asked = entries.length > 0 || (unplaced.length > 0 && present.has(bin));
			if (!asked) continue;
			try {
				for (const id of await list({ bin })) held.add(id);
			} catch {
				for (const entry of [...entries, ...unplaced]) held.add(entry);
				log("sandbox_reaper_skipped", { reason: "runtime-unanswered", runtime: bin, held: entries.length + unplaced.length });
			}
		}
		if (stores.length > 0) {
			let current = null;
			try {
				current = await readPodmanStore();
			} catch {
				current = null;
			}
			for (const [name, recorded] of stores) {
				if (current === recorded || held.has(name)) continue;
				held.add(name);
				log("sandbox_reaper_skipped", { entry: name, reason: "podman-store-mismatch" });
			}
		}
		return [...held];
	}
	/**
	 * Whether ONE retained run's sandbox is open right now (issue #446, gate round 1): the reaper asks it immediately
	 * before renaming the run aside, because the pass's `listRunning` answer can be much older by then. Asked of the
	 * run's own runtime, or of every runtime present for a run it cannot place; THROWS when a runtime cannot answer,
	 * which the reaper holds. A directory with no manifest file is one it cannot place (PR #466 gate round 1): no NEW
	 * open can be on it (`resolveSandbox` refuses it), but one opened before its manifest went can still have it
	 * mounted, so every runtime present is asked, as `listRunning` asks.
	 */
	async function isOpen({ name, read } = {}) {
		if (!read) return false;
		const manifest = Object.hasOwn(read, "manifest") ? read.manifest : null;
		const launcher = manifest ? sandboxLauncher(sandboxVenueOf(manifest)) : null;
		const bins = launcher ? [launcher.bin] : allBins.filter((bin) => present.has(bin));
		for (const bin of bins) if ((await list({ bin })).includes(name)) return true;
		return false;
	}
	async function sweepNetworks(args) {
		const bins = allBins.filter((bin) => present.has(bin));
		if (bins.length === 0) return { swept: [], notes: [] };
		for (const bin of bins) if (!sweepers.has(bin)) sweepers.set(bin, makeSweeper({ bin, proxy }));
		return combineSandboxNetworkSweepers(bins.map((bin) => ({ runtime: bin, sweep: sweepers.get(bin) })))(args);
	}
	return { listRunning, sweepNetworks, isOpen };
}

/** The store this account's Podman uses right now, from one bounded `podman info`, or null when it cannot say. */
async function defaultPodmanStore() {
	const read = await makePodmanInfoReader()();
	return read?.answered === true ? (read.info?.graphRoot ?? null) : null;
}

/**
 * The sweep's runner for one runtime: bounded, both streams, never throws. `execDockerBounded` already settles on its
 * own timer and kills with SIGKILL, which matters here for the reason `retention-sweep.mjs` records -- this
 * loop runs on a timer beside draining jobs, and `execFile`'s own `timeout` only signals and then still waits
 * for `close`, so a CLI wedged on a dead socket never settles. Its rejection carries `stderr` on the error,
 * which the "network is not there" rule needs and the bounded shape does not surface on its own.
 */
export function boundedRuntime(bin, { execFileFn } = {}) {
	// `opts` (issue #452, gate round 3): the detach gate's runtime read asks with the facts readers' own bound (15 s,
	// 1 MiB), which a `podman info` body needs; every network verb keeps the 10 s and 64 KiB it always had. `stderr` is
	// the CLI's own, which `execDockerBounded` now returns: `execFile` hands it to the callback, never onto the error, so
	// reading `error.stderr` got an empty string and the podman-docker `.Containers` fallback never fired here.
	return async function bounded(args, opts = {}) {
		// `withStderr`: matched by the "not found" and the podman-docker fallback rules, never logged.
		const { code, stdout, stderr } = await execDockerBounded(args, { timeoutMs: opts.timeoutMs ?? 10_000, ...(opts.maxBuffer ? { maxBuffer: opts.maxBuffer } : {}), bin, withStderr: true, ...(execFileFn ? { execFileFn } : {}) });
		return { code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
	};
}

/**
 * A network THIS project made for an operator session: the exact shape the producer builds. `docker`'s
 * `--filter name=` is a SUBSTRING match, so the listing alone is not a namespace -- measured on 27.4.0 while
 * fixing the same defect in the boot reaper (issue #357), where it returns an operator's own
 * `my-pi-job-notes`. The capture is the sanitised job id, which is also what the retained directories and
 * `listRunningSandboxes` are keyed by, so the three compare without a second grammar.
 *
 * Exported only so its test pins THIS constant. A test that rebuilds the pattern from the same two
 * prefixes asserts a property of a string the test wrote, which is the drift a hand-written copy always
 * has; the behavioural half of the same guard is the foreign names in the sweep's own fixtures.
 */
export const SANDBOX_NETWORK_SHAPE = new RegExp(`^${SANDBOX_NAME_PREFIX}(.*)${NETWORK_SUFFIX}$`);

/**
 * The container states that leave a session network free. An ALLOWLIST rather than a denylist, so a state a
 * future daemon adds is hands off by default: this decides whether something gets removed, and the safe
 * direction is a leftover surviving one more pass. `--rm` means an exited sandbox is normally gone already.
 *
 * PODMAN'S `.State` VOCABULARY IS UNMEASURED, and that is a stated limit rather than a guess (issue #363).
 * Docker 27.4.0 accepts `created`, `running`, `paused`, `exited`, `restarting`, `removing` and `dead` as
 * `--filter status=` values, all lowercase and single-word (`status=bogus` is refused as an invalid filter). If a runtime renders `stopped` where docker renders `exited`, every leftover network on that
 * host is held back forever behind a `sandbox-present` note: one network per run, named in the log, and the
 * safe direction of the two. Adding a word on a guess is the other direction, removing networks on a
 * vocabulary nobody has read, which is exactly what an allowlist is for.
 */
const SWEEPABLE_CONTAINER_STATES = new Set(["exited", "dead"]);

/**
 * Whether `docker ps -a`'s output holds a container of OURS for `id` in a state that is not finished.
 * `--filter name=` is as loose here as it is for networks, so an operator's own `my-pi-sandbox-notes` comes
 * back from a filter on `pi-sandbox-notes` and must never be sliced into the id vocabulary: the comparison
 * is against the whole name the producer builds.
 */
function containerHolds(stdout, id) {
	const mine = `${SANDBOX_NAME_PREFIX}${id}`;
	for (const line of String(stdout ?? "").split("\n")) {
		const [name, state] = line.trim().split("\t");
		// WHOLE name, never a prefix. `--filter name=` is not even a substring match, it is an UNANCHORED
		// REGEX (measured: `name=pi-sandbox-a.c` returns `pi-sandbox-abc`, and `sanitizeJobId` permits `.`),
		// so on this daemon `name=pi-sandbox-abc` comes back with an operator's `my-pi-sandbox-abc` AND with
		// another run's `pi-sandbox-abcdef`, which is not an invented id shape (`gh-1` beside `gh-12` collides
		// exactly so). Comparing the whole name the producer builds is what makes all of that harmless.
		if (name !== mine) continue;
		// Lowercased for the reason `networkAbsentInDaemonWords` is case-insensitive: this reads ANOTHER
		// tool's rendering, and a runtime that capitalised it would hold every leftover back forever.
		if (!SWEEPABLE_CONTAINER_STATES.has(String(state ?? "").trim().toLowerCase())) return true;
	}
	return false;
}

/** Whether `ps -a`'s output holds a container of ours for `id` by its WHOLE name, in a finished state only. */
function containerFinished(stdout, id) {
	const mine = `${SANDBOX_NAME_PREFIX}${id}`;
	return String(stdout ?? "")
		.split("\n")
		.map((line) => line.trim().split("\t"))
		.some(([name, state]) => name === mine && SWEEPABLE_CONTAINER_STATES.has(String(state ?? "").trim().toLowerCase()));
}

/**
 * The default `retained`, and it THROWS rather than answering "nothing is retained". Its sibling default in
 * `sandbox-store.mjs` can be a no-op because a missing sweeper means no sweep, which is safe; a missing
 * directory listing means a sweep that ignores every retained run, which is the #277 harm with no log line.
 * A caller that has no listing to give must say so by handing in `() => []`.
 */
function missingRetained() {
	throw new Error("sweepSandboxNetworks: `retained` is required, and an empty listing must be passed deliberately");
}

/**
 * Remove session networks whose run is gone (issue #337).
 *
 * WHAT THIS IS NOT. Issue #277 withdrew removing a network at OPEN time: two opens of the same run overlap
 * more easily than that check assumed, and the second removed the first's network after the first had
 * created it, disconnecting the proxy from a live shell. That decision stands. This is a different mechanism
 * with a different input -- a background sweep on the retention reaper, keyed on the directory listing the
 * pass STARTED with, which no open in progress can be absent from because `resolveSandbox` refuses a job
 * whose directory is gone. Nothing here runs while an operator is opening anything.
 *
 * THE DANGEROUS VERB IS `detach`, NOT `rm`, for a RUNNING container. Measured on docker 27.4.0: a
 * `network rm` of a network a running container is on FAILS ("has active endpoints"), so docker itself is
 * the backstop for the removal there. What docker will not stop is stripping the proxy off that session,
 * which is exactly the #277 harm, so the endpoint check gates what goes into the DETACH list, and the test
 * asserts no `network disconnect` is issued rather than asserting the network survived -- the weaker
 * assertion would pass on docker's refusal alone. The backstop does NOT extend to a container in `created`
 * state, where the `rm` succeeds and leaves that container unable to start ever, which is why the last call
 * before the removal is a `docker ps -a` for this id and not something inferred from the endpoint list.
 *
 * ORDER, since three of the four reads here only work in one arrangement: candidates first (`network ls`),
 * then every piece of evidence that protects one, freshest last. An open creates its network BEFORE its
 * container and AFTER the directory that made it legal, so evidence read before the candidate listing can be
 * older than the thing it must protect.
 *
 * Returns `{ swept, notes }` rather than logging, so the reaper owns the log vocabulary and this stays a
 * pure-ish function over its runner.
 */
export function makeSandboxNetworkSweeper({ bin = "docker", run = boundedRuntime(bin), proxy = DEFAULT_EGRESS_PROXY } = {}) {
	// `bin` (issue #429) is the one runtime this sweeper lists, inspects and removes in: a sweep that listed under one
	// CLI and removed under another would be the mixed venue every `bin` seam comment warns about. One sweeper per venue
	// a sandbox can open on (`combineSandboxNetworkSweepers`). Podman's `ps -a` renders `{{.State}}`; its endpoint read is
	// `networkEndpoints`' Podman path (issue #452: 4.9 renders no `.Containers`), whose `names` are the running and paused
	// members exactly as docker's are, so every guard below reads the same on both. A stopped member on Podman is not in
	// `names` and still makes the `rm` fail, which the failed-`rm` branch below handles for this run's own container and
	// reports for anything else. Its state WORDS are this file's stated residual, below.
	return async function sweepSandboxNetworks({ running = new Set(), keep = new Set(), retained = missingRetained, blocked = new Set() } = {}) {
		// ONE detach gate per pass (issue #452, gate round 3): its runtime read is made once, however many networks.
		const gate = makeDetachGate(run, { bin });
		// CANDIDATES FIRST, then every piece of evidence that protects one. The order is the point, not an
		// accident of writing: a network is created BEFORE the container that joins it and AFTER the directory
		// that made the open legal, so evidence read before this listing can be older than the thing it is
		// meant to protect. Read the other way round, anything that appears after this listing is simply not a
		// candidate this pass.
		const listed = await run(["network", "ls", "--filter", `name=${SANDBOX_NAME_PREFIX}`, "--format", "{{.Name}}"]);
		// A listing that did not answer is a FAULT, not a verdict about any network, and the two carry
		// different names on `OQ-007`'s property: the reaper turns `failed` into its family's
		// `sandbox_reaper_skipped` line, while `notes` are per-network outcomes of a pass that ran. Reporting
		// this as a note would say "one network was not reaped" about a look that saw none.
		if (listed?.code !== 0) return { swept: [], notes: [], failed: "network-list-failed" };

		// The retained directories as they are NOW, unioned by the caller with the listing its pass began
		// with. Each half covers what the other cannot, and this is the half that has to be read here rather
		// than handed in: `retainJobDir` creates a directory at job END, in this same process, so a run can be
		// retained and opened while the pass is still going. A read that throws leaves this function, which is
		// deliberate: half a keep set is worse than no sweep.
		for (const name of retained()) keep.add(name);

		const swept = [];
		const notes = [];
		for (const name of String(listed.stdout ?? "").split("\n").map((n) => n.trim()).filter(Boolean)) {
			const m = SANDBOX_NETWORK_SHAPE.exec(name);
			if (!m) continue; // the filter is not the namespace
			const id = m[1];
			// Either means the run is still reachable, and both are ordinary rather than notable: a shell is
			// open on it, or its workspace is still retained and the next open will want this network's name
			// free anyway. A line per retained run per pass would be noise.
			if (running.has(id) || keep.has(id)) {
				// SILENT for an ordinary retained run: a line per retained run per pass is noise, and that run's
				// network is wanted. SAID when the directory that retains it could not be REMOVED this pass,
				// which is not going to resolve by itself -- one note per stuck directory per pass, the same
				// frequency as the `sandbox_reaper_skipped` line it pairs with, so nothing new is noisy (#363).
				if (blocked.has(id)) notes.push({ network: name, reason: "directory-not-removed" });
				continue;
			}
			const { ok, names, absent, parked = [] } = await networkEndpoints(run, name, { bin });
			if (absent) continue;
			if (!ok) {
				notes.push({ network: name, reason: "unreadable" });
				continue;
			}
			// One guard gates the DETACH: a session container attached means an operator may be inside it.
			if (names.some((n) => n.startsWith(SANDBOX_NAME_PREFIX))) {
				notes.push({ network: name, reason: "sandbox-attached" });
				continue;
			}
			// ONE guard, asked LATE and asked TWICE (issue #363). It answers the question the two above cannot:
			// is there a container of ours for this id in a state that is not finished? Measured on docker
			// 27.4.0, a container between `docker create` and `docker start` is in `created` state, where
			// `docker ps` does not list it, `network inspect` does not list it as an endpoint, AND `network rm`
			// SUCCEEDS -- after which `docker start` fails with "network not found" and that sandbox can never
			// run. The daemon backstops a RUNNING endpoint and nothing else.
			//
			// PASSED DOWN rather than asked once here, and what actually changed is worth stating exactly,
			// because the obvious summary is wrong. The guard was ALREADY the statement immediately before the
			// detach loop, so the first disconnect was zero commands after a fresh answer then and now. What
			// moved is the `rm`: it sat k+1 commands out and is now always one. The issue says the detach is
			// the act the guard does not DIRECTLY protect, and directly is the right word -- an earlier version
			// of this comment said "not at all", which the command counts refute.
			//
			// ORDER IS THE POINT, and an earlier draft read this once at the TOP of the pass, which is the one
			// placement that cannot work: an open creates its network BEFORE its container, so a snapshot taken
			// before the candidate listing is older than the thing it has to protect, and a review pass drove
			// exactly that -- 486 ms of exposure, the network removed and the operator's `docker run` dead with
			// a 125.
			//
			// RESIDUAL, stated rather than implied: disconnect number i is still i commands after the guard. k
			// is 1 in every shape this project produces (the proxy), and a per-endpoint re-ask would double the
			// pass for a window no production shape opens. A check-then-act still has a gap; this makes it the
			// width of one command instead of two plus k.
			let lateReason = null;
			const stillClear = async () => {
				const held = await run(["ps", "-a", "--filter", `name=${SANDBOX_NAME_PREFIX}${id}`, "--format", "{{.Names}}\t{{.State}}"]);
				// Fail CLOSED on both, and with their own tokens: the two ways this can answer badly have
				// different causes and different fixes, and an operator grepping the log should not have to
				// guess which one did not answer.
				if (held?.code !== 0) {
					lateReason = "containers-unreadable";
					return false;
				}
				// Only a FINISHED container frees the network: `--rm` means an exited sandbox is normally gone
				// already, so one still listed is abnormal and its network is a leftover either way. Every other
				// state, and anything a future daemon adds, is hands off. Unlike the `keep` and `running` skips
				// this one is SAID, because a container stuck in `created` would otherwise hold its network back
				// forever with nothing on the host naming it.
				if (containerHolds(held.stdout, id)) {
					lateReason = "sandbox-present";
					return false;
				}
				return true;
			};
			// A STOPPED egress proxy is detached too, as the boot reaper and the canary sweep detach one (issue #452, gate
			// round 1). On Podman it is in `parked`, and Podman's `rm` refuses while it is attached (measured on 4.9.3 and
			// 5.8.1), so leaving it kept a dead session's network forever, `rm-failed` on every pass. Only the proxy this
			// worker is configured with, by name: any other stopped member is an operator's, and is named below instead.
			// Docker's read carries no `parked`, so its pass is what it was.
			const detach = [...names, ...parked.filter((n) => n === proxy)];
			// Through the detach gate, as every detach is (issue #452 with #458, gate round 3): `names` are the RUNNING members,
			// so a stopped proxy asks nothing; a refusal leaves the network whole and is said with the gate's token; a later
			// pass with the keeper holding removes it. On both venues, since `local` can be a rootless Podman too.
			const outcome = await removeNetworkOrSay(run, { network: name, detach, running: names, stillClear, bin, gate });
			if (outcome.blocked) {
				notes.push({ network: name, reason: outcome.blocked });
				continue;
			}
			if (outcome.aborted) {
				// `restored`/`lost` rather than `detached`: an endpoint put back was not removed by this pass,
				// and one that could not be put back is off a network someone may be using, which is the half an
				// operator has to act on.
				notes.push({
					network: name,
					reason: lateReason,
					...(outcome.restored?.length > 0 ? { restored: outcome.restored } : {}),
					...(outcome.lost?.length > 0 ? { lost: outcome.lost } : {}),
				});
				continue;
			}
			if (outcome.absent) continue;
			if (outcome.removed) swept.push({ network: name, detached: outcome.detached });
			else {
				// Podman keeps an EXITED container attached to its network (measured on 5.8.1: `network rm` then fails every
				// pass, and the network is never reaped). So on a failed `rm` only, this run's OWN container, by its whole
				// name and only in a finished state, is removed and the `rm` tried once more. Only on the failure path, so a
				// pass that removes the network first time issues exactly the commands it always did; never `-f`, never a
				// container in any other state, never another name (`containerFinished`'s whole-name rule).
				const own = `${SANDBOX_NAME_PREFIX}${id}`;
				const look = await run(["ps", "-a", "--filter", `name=${own}`, "--format", "{{.Names}}\t{{.State}}"]);
				let retried = false;
				if (look?.code === 0 && containerFinished(look.stdout, id) && (await run(["rm", own]))?.code === 0) {
					retried = (await run(["network", "rm", name]))?.code === 0;
				}
				if (retried) swept.push({ network: name, detached: outcome.detached, removedContainer: own });
				else {
					// WHAT HOLDS IT, named (issue #452, gate round 1): `detached: []` on every pass said nothing an operator
					// could act on. Read again now, after everything this pass did, through the same reader; bounded, as the
					// boot reaper bounds its own list, because this goes into a log line. Container names only, which are the
					// runtime's own vocabulary; an unreadable answer says so rather than naming nobody.
					const after = await networkEndpoints(run, name, { bin });
					const holding = after.ok ? [...after.names, ...(after.parked ?? [])] : null;
					notes.push({
						network: name,
						reason: "rm-failed",
						detached: outcome.detached,
						...(holding === null ? { holding: "unreadable" } : { holding: holding.slice(0, 5), more: holding.length > 5 ? holding.length - 5 : 0 }),
					});
				}
			}
			// Between networks, for `retention-sweep.mjs`'s reason: this loop runs on a timer beside draining
			// jobs, and `index.mjs` runs with `maxStalledCount: 0` against BullMQ's 30s lock.
			await new Promise((resolve) => setImmediate(resolve));
		}
		return { swept, notes };
	};
}

/**
 * One sweep over every runtime's session networks (issue #429): `entries` is `[{ runtime, sweep }]`, each sweeper's `{
 * swept, notes }` concatenated in order, and a listing that failed recorded as `{ reason, runtime }` in `failures`, EVERY
 * one and not only the first (review round 2), so the reaper's log names which runtime did not answer. `failed` stays
 * the first reason, for a caller that reads only that.
 *
 * Every sweeper is given the SAME `running`, `keep`, `retained` and `blocked`: the union of what every runtime holds is
 * conservative in the one direction that matters (an id held in either runtime keeps its network in both), and `keep`
 * is filled by each sweeper's own fresh read, which only ever adds. One runtime's failed listing does not stop the
 * other's pass: nothing it would remove depends on the failed runtime, whose own networks are simply not candidates
 * this pass.
 */
export function combineSandboxNetworkSweepers(entries) {
	return async function sweepSandboxNetworks(args) {
		const swept = [];
		const notes = [];
		const failures = [];
		for (const { runtime, sweep } of entries) {
			const outcome = await sweep(args);
			swept.push(...(outcome?.swept ?? []));
			notes.push(...(outcome?.notes ?? []));
			if (outcome?.failed) failures.push({ reason: outcome.failed, runtime });
		}
		return failures.length > 0 ? { swept, notes, failed: failures[0].reason, failures } : { swept, notes };
	};
}

/**
 * The default `keeperCheck` (issue #452, gate round 2): the worker's own job preflight for the keeper (`keeperPreflight`,
 * over this account's `podman info` and the keeper's and proxy's reads), with the proxy taken as up, since a missing
 * proxy already fails the open at network creation with its own message. `null` when the keeper holds or is not needed.
 */
export async function sandboxKeeperCheck({ proxy, info = makePodmanInfoReader(), readKeeper = null } = {}) {
	const answer = await keeperPreflight(async () => ({ ok: true, proxy }), { armed: true, proxy, info, ...(readKeeper ? { readKeeper } : {}) })();
	if (!answer?.unavailable) return null;
	return {
		refused: "netns-keeper-not-holding",
		message: `${answer.cause}, so this sandbox is not opened: closing it tears its network down under the proxy, which is that same teardown. To fix it, ${answer.remedy}`,
	};
}

/**
 * Whether a retained run can be re-opened HERE, judged by the venue it ran in (issue #277). `null` when it
 * can, else `{ refused, message }`. Exported for the admin panel, which asks before advertising the key.
 *
 * WHY THIS IS PER JOB. A sandbox opens a shell on THIS host, in the runtime the job ran in, against the job's retained
 * directory, so it can reproduce only a run whose container was built here. The check used to be deployment-wide
 * (refuse every sandbox when any blessed venue was remote) because the command takes a job id and could not learn its
 * venue; the manifest now records it, and the answer belongs to the job.
 *
 * HELD MEANS A VENUE THIS FILE HAS A LAUNCHER FOR (`SANDBOX_LAUNCHERS`: `local` through the docker CLI, `podman`
 * through this account's rootless podman), AND ONE `blessed` NAMES (issue #429). `blessed` is `PI_BACKENDS` as the
 * CALLER's process reads it: the CLI's `loadConfig`, the panel's own environment (`sandboxVenuePolicy`). A shell whose
 * `PI_BACKENDS` does not bless a venue has said it does not run that runtime, so reopening a run there would spawn a CLI
 * that environment took out of service. It is NOT what keeps an open shell's directory from the retention reaper, and
 * an earlier version of this comment said it was: the opener's `PI_BACKENDS` and the worker's routinely differ
 * (`OQ-038`), so the reaper asks the runtime each retained run records instead, whatever either blesses
 * (`makeSandboxRuntimeWatch`). It defaults to `local` alone, which is what `PI_BACKENDS` unset means, so a caller from
 * before issue #429 refuses and admits exactly as it did.
 *
 * Not "any venue declaring `remote: false`": a future non-remote venue on a third runtime would pass that and be
 * reopened under one of these two, reproducing a run from a runtime it never ran in. Such a venue must add its own
 * launcher row, deliberately.
 *
 * A MANIFEST WITH NO `backend` KEY predates venue attribution and ran on `local` (`UNATTRIBUTED_BACKEND`).
 * A key that is PRESENT but not a name is refused: `typeof` first, because the table's `backendFor(null)`
 * returns `local`, and a null stamp means the venue was never known, not that it was local.
 */
export function sandboxVenueRefusal({ jobId, manifest, blessed = [DEFAULT_BACKEND] }) {
	const venue = sandboxVenueOf(manifest);
	if (typeof venue !== "string" || venue === "") {
		return { refused: "venue-unreachable", message: `the manifest for ${jobId} names no backend, so this host cannot tell whether the run happened here` };
	}
	const launcher = sandboxLauncher(venue);
	const held = Array.isArray(blessed) && blessed.includes(venue);
	if (launcher && held) return null;
	if (launcher) {
		// A venue this file CAN open, on a host (as this process reads it) that does not bless it. The fix is an
		// environment, and it is named with where it is read: the CLI and the panel read `PI_BACKENDS` from the process
		// they run in, never from a deployment's `.env`, and "set it where you run this" is the whole remedy.
		return {
			refused: "venue-unreachable",
			message: `${jobId} ran on the ${JSON.stringify(venue)} backend, which PI_BACKENDS in this process's environment does not bless (it reads ${JSON.stringify((Array.isArray(blessed) ? blessed : []).join(","))}), so no sandbox opens on it here: a sandbox opens only on a venue this host blesses, through that venue's own CLI (${launcher.bin}). Set PI_BACKENDS where you run this as the worker's is set; it is read from this environment, not from the deployment's .env.`,
		};
	}
	return {
		refused: "venue-unreachable",
		// Names BOTH sides (issue #354): the venue that ran it, and the venues a sandbox opens through. "Not on this host's
		// docker daemon" was true only while every venue but `local` was elsewhere.
		message: `${jobId} ran on the ${JSON.stringify(venue)} backend, and a sandbox opens a shell only through a venue it has a launcher for on this host (${Object.entries(SANDBOX_LAUNCHERS).map(([name, l]) => `${JSON.stringify(name)} through the ${l.bin} CLI`).join(", ")}) against the retained directory, so it cannot reproduce that run. Open it on the venue that ran it.`,
	};
}

/** The venue a retained manifest records: its `backend` key when present (whatever it holds), else `UNATTRIBUTED_BACKEND`. */
export function sandboxVenueOf(manifest) {
	return Object.hasOwn(manifest ?? {}, "backend") ? manifest.backend : UNATTRIBUTED_BACKEND;
}

/**
 * The refusals `resolveSandbox` decides from the MANIFEST ALONE, in the order an operator should read
 * them. Not every manifest-only refusal on the `b` path: `decideSandboxJobUser` can refuse a run from
 * `manifest.jobUser` too, and it stays where it is for two MEASURED reasons rather than the vaguer "it
 * would change what the CLI refuses and when" this comment used to give (issue #367, item 5).
 *
 * IT IS NOT MANIFEST-ONLY. It returns `{ user: null, home: null }` on `darwin` and `win32` before it ever
 * reads the stamp, so the SAME malformed `jobUser` refuses everywhere else and does not refuse on macOS or
 * Windows. Measured across twelve platform strings: the split is darwin and win32 against every other
 * value, linux, the BSDs, sunos, aix and the empty string alike, which is wider than "linux" and is why
 * this says it that way. Folding it in would make this function's answer, and therefore whether the panel
 * advertises `b` at all, depend on the operator's own OS for an identical run. Every other refusal here is
 * a property of the run, and that is the whole of the argument.
 *
 * NOT because it is async, which is true of the function and is NOT a reason about this refusal: measured,
 * `job-user-stamp-invalid` is reached with zero calls to the endpoint resolver, the daemon-facts reader
 * and the image preflight, on every platform and every malformed shape. It is decided from the manifest
 * before any await that does work. A well-formed stamp does reach the daemon, which is why this function
 * stays async and out of a predicate called on every left and right between runs, but that is a cost of
 * moving the WHOLE function, not of the refusal #367 item 5 is about.
 *
 * Extracted (issue #337) because the admin panel needs the same answer before it advertises `b`, and the
 * alternative is the shape this file's own `openSandbox` docblock warns about: "Two callers assembling
 * the same session from parts is how one of them drops a part." The panel had exactly that, checking the
 * venue and not the other two, so a run whose manifest names no image was offered the key, given two
 * lines of detail about the session it would get, and refused the moment the key was pressed.
 *
 * SYNCHRONOUS AND MANIFEST-ONLY is the boundary, not an accident of what fitted. The panel reads this
 * inside a key handler, once per record; anything needing docker (a proxy that is not running, a sandbox
 * already up) stays in `openSandbox` where it belongs and is `OQ-038`'s residual for the panel.
 *
 * The VENUE comes first, and that ordering is #277's: for a run from another venue the image and the
 * workspace are symptoms, and the first refusal an operator reads should be the cause. A workspace that
 * happens to exist at the same path on this host would otherwise pass and silently reproduce the wrong
 * run.
 */
export function sandboxSyncRefusal({ jobId, manifest, fileExists = existsSync, blessed }) {
	const venue = sandboxVenueRefusal({ jobId, manifest, blessed });
	if (venue) return venue;
	if (!manifest?.image) {
		return { refused: "no-image", message: `the manifest for ${jobId} names no image, so the sandbox cannot reproduce the run` };
	}
	if (!manifest?.workspace || !fileExists(manifest.workspace)) {
		// The common cause for a local run: the operator's folder moved or was deleted. Naming the path is
		// the whole diagnosis, so name it.
		return { refused: "workspace-gone", message: `the workspace for ${jobId} is no longer at ${manifest.workspace} — a local folder that moved cannot be re-opened` };
	}
	return null;
}

/**
 * How close to its deadline a run may be and still open without `--pin` (issue #446): five minutes.
 *
 * WHY A MARGIN AND NOT THE DEADLINE ITSELF. The sweep holds a run whose sandbox a runtime reports open, but an open is
 * not in any `ps` until its container starts, and the opener spends that stretch on its own runtime asks (the running
 * check, the job user, the image, the network), each bounded in seconds. A sweep whose `ps` came before the container
 * and whose clock (`at`, read after its asks) is past the deadline would still delete the directory under the new
 * shell: window 1 of #446, reproduced. A run whose deadline is more than this far away cannot be past it by the time a
 * pass that missed the container decides, so the refusal closes that window with room to spare; inside it, `--pin`
 * writes a new deadline FIRST, which the sweep's own re-reads honour.
 */
export const SANDBOX_OPEN_GRACE_MS = 5 * 60 * 1000;

/**
 * The refusal of a run past its deadline, or within `SANDBOX_OPEN_GRACE_MS` of it, unless the open pins it first
 * (issue #446). `null` when the run may open.
 *
 * The deadline is `sandboxDeadline`'s, the sweep's own rule (the pin; else the earlier of the `retainUntil` the worker
 * wrote and `createdAt` plus THIS opener's window), so an opener whose own PI_SANDBOX_RETENTION_HOURS is larger than
 * the worker's is refused by the worker's deadline, not admitted by its own. The one case it cannot see, a worker
 * whose window was lowered after the run was retained, is the post-launch look's (`openSandbox`).
 * Shared by `resolveSandbox` and the admin panel's `readSandboxInfo`, which must not advertise `b` for a run the key
 * press would refuse; the panel has no pin, so its refusal is this one and it names the CLI command.
 */
export function sandboxWindowRefusal({ jobId, manifest, retentionHours, at, pin = false }) {
	if (pin) return null;
	const { until } = sandboxDeadline(manifest, retentionHours);
	const fix = `open it with \`pi-dispatch sandbox ${jobId} --pin\`, which extends its retention before anything starts`;
	if (until === null) {
		return { refused: "past-window", message: `the retained workspace for ${jobId} records no creation time, so the retention sweep deletes it on its next pass; ${fix}` };
	}
	if (until - at > SANDBOX_OPEN_GRACE_MS) return null;
	const when = new Date(until).toISOString();
	const where = until <= at ? `is past its retention window (it closed at ${when})` : `is within ${Math.round(SANDBOX_OPEN_GRACE_MS / 60000)} minutes of the end of its retention window (${when})`;
	return {
		refused: "past-window",
		message: `the retained workspace for ${jobId} ${where}, so the retention sweep may delete it under the shell; ${fix}`,
	};
}

/**
 * Resolve one retained run into a launchable argv, or a NAMED refusal.
 *
 * Split out from the launch so both callers -- the CLI and the admin panel -- refuse identically, the venue
 * refusal included, and so
 * the whole decision is testable without docker. Every refusal names what to do next, the posture
 * `doctor` sets: a bare "not found" for a run the operator watched finish ten minutes ago is the least
 * useful thing this could say.
 */
export function resolveSandbox({ jobId, sandboxDir, retentionHours, publish = [], fs, fileExists = existsSync, blessed, now = Date.now, pin = false }) {
	if (!jobId) return { refused: "no-job-id", message: "a job id is required (see `pi-dispatch sandbox --list`)" };

	const manifest = readManifest({ sandboxDir, jobId, ...(fs ? { fs } : {}) });
	if (manifest && typeof manifest.jobId === "string" && manifest.jobId !== String(jobId)) {
		// Two ids can share a directory only by sharing a `sanitizeJobId` form (`a:b` and `a_b`), and the run in it is
		// whichever was retained last (issue #446, gate round 1). Opening it under the other id would reproduce the wrong
		// run, so the refusal names the run that is there; `--list` shows ids exactly as a run records them.
		return { refused: "id-mismatch", message: `the retained workspace for ${jobId} holds run ${manifest.jobId}, not ${jobId} (two ids that differ only in characters a file name cannot hold share one directory); open it by the id \`pi-dispatch sandbox --list\` shows` };
	}
	if (!manifest) {
		return retentionHours === 0
			? { refused: "retention-off", message: "workspace retention is off — set PI_SANDBOX_RETENTION_HOURS to a positive number to make future runs resurrectable" }
			: // Neutral about WHEN (#446 gate round 2): the window that swept it was the worker's, or the run's own recorded
				// deadline, and this shell's `retentionHours` is neither.
				{ refused: "absent", message: `no retained workspace for ${jobId}: it was swept at the end of its retention window, or the run predates retention (\`pi-dispatch sandbox --list\` shows what is left)` };
	}
	// The venue BEFORE the image and the workspace (#277): for a run from another venue those two are the
	// symptoms, and the first refusal an operator reads should be the cause. A workspace that happens to
	// exist at the same path on this host would otherwise pass and silently reproduce the wrong run.
	const refusal = sandboxSyncRefusal({ jobId, manifest, fileExists, blessed });
	if (refusal) return refusal;
	// AFTER the run's own refusals (issue #446): a run from another venue, or with no image, cannot open pinned or not,
	// and the operator should read that cause rather than be told to pin it.
	const lapsed = sandboxWindowRefusal({ jobId, manifest, retentionHours, at: now(), pin });
	if (lapsed) return lapsed;

	// `venue` is the one the refusal above admitted, so it always has a launcher: every later step of the session reads
	// its runtime from this one answer rather than re-deriving it from the manifest.
	// `identity` (gate round 1): the retained directory's device and inode as it was resolved, so the post-launch look
	// can tell the run's own directory from one that has REPLACED it at the same path (a retry's fresh run, a runtime's
	// auto-created bind source on Docker). Null where the filesystem in use cannot say (an injected one without `lstatSync`).
	//
	// The container is named off the directory the run was FOUND in, not off the id (gate round 2): a run retained before
	// the escape lives under its old name, and the sweep holds a run by its directory name, so a container named off
	// the escaped id would never hold it. For every run retained since, the two are the same string.
	return { manifest, name: `${SANDBOX_NAME_PREFIX}${basename(manifest.dir)}`, publish, venue: sandboxVenueOf(manifest), identity: dirIdentity(fs ?? { lstatSync }, manifest.dir) };
}

/** `{ dev, ino }` of `dir` by `lstat`, or null when the filesystem cannot say. Never throws. */
function dirIdentity(fs, dir) {
	try {
		const st = typeof fs?.lstatSync === "function" ? fs.lstatSync(dir) : null;
		return st && Number.isFinite(st.ino) && Number.isFinite(st.dev) ? { dev: st.dev, ino: st.ino } : null;
	} catch {
		return null;
	}
}

/**
 * The egress posture a sandbox opened from `env` gets: `{ armed, proxy }`, through the same two readers the
 * worker's config uses. THROWS on a malformed `PI_EGRESS`, exactly as the worker refuses to boot on one: a
 * typo must never open a shell on the default bridge while the operator believes a policy is armed. For the
 * admin panel, which deliberately never calls `loadConfig`; the CLI has the parsed config already.
 */
export function sandboxEgress(env) {
	return { armed: egressArmed(env), proxy: egressProxyName(env) };
}

/**
 * Open one retained run as an operator shell: the ONE path from a job id to a running sandbox, for the CLI
 * and the admin panel alike (issue #277).
 *
 * WHY ONE FUNCTION. The CLI built the session's egress network, refused a sandbox already running and tore
 * the network down in a finally; the panel called `resolveSandbox` and `buildSandboxRunArgs` directly and did
 * none of it. So a sandbox opened from RUN_DETAIL ran on docker's default bridge -- the whole internet -- while
 * `PI_EGRESS` was armed and INT-SANDBOX-CONTRACT said it lands on the network the job did. Two callers
 * assembling the same session from parts is how one of them drops a part; this is where they now share every
 * part that decides what the container can reach.
 *
 * In order: `resolveSandbox` (every refusal, the venue one and the past-window one included) -> the pin, when the
 * caller asked for one (issue #446) -> the already-running refusal -> the argv, with this session's own network and
 * proxy variables when armed -> create the network (a network already under this name is REFUSED and named, never
 * removed) -> `beforeLaunch`, the caller's hook to print once the session is known to be openable, so after the last
 * refusal (issue #462) and removed with the network if it throws -> launch, watched until
 * the runtime lists it (issue #446) -> ask the runtime again, and remove the network in a finally unless the sandbox
 * is still running. Returns `{ refused, message }`, or `{ code, error }` from the launch, with `detached: true` when
 * the runtime still lists the sandbox as running after the shell returned (its network is left in place).
 * THROWS when `egress.armed` is not a boolean.
 *
 * NOT here, deliberately: the terminal check and `--publish` parsing, which are about the CLI's own arguments. The
 * pin IS here since issue #446 (`pin`), though only the CLI offers one, because WHEN it lands is the point: straight
 * after `resolveSandbox` and before any runtime call, where `beforeLaunch` used to run it after the running ask and
 * the job-user decision had each spent seconds of a window the sweep could close. A pin that fails REFUSES the open:
 * the warning it used to print let a shell open over a run the sweep could take, and a `-v` bind of a directory that
 * has gone mounts an empty one Docker creates (Podman refuses the bind, exit 125).
 *
 * EVERY RUNTIME STEP IS THE RUN'S VENUE'S (issue #429): the running asks, the job-user decision, the argv builder, the
 * network's creation and removal and the launch all go through `SANDBOX_LAUNCHERS[resolved.venue]`, decided once by
 * `resolveSandbox`. `running` is called with `{ bin }` and `launch` with `{ args, bin }`, and `beforeLaunch` is handed
 * `runtime` so a caller's own lines (`docker attach`, `podman attach`) name the CLI that ran it. `blessed` and
 * `backendFloor` are `PI_BACKENDS` and `PI_BACKEND_FLOOR` as the caller's process reads them; the first decides which
 * venues open at all, the second what a podman sandbox's observations must show, exactly as for a job.
 */
export async function openSandbox({
	jobId,
	sandboxDir,
	retentionHours,
	publish = [],
	term,
	idleSeconds = 0,
	egress,
	running = listRunningSandboxes,
	launch = launchSandbox,
	spawnNetwork = spawn,
	// Issue #341: `({ manifest }) => { user, home, relabel? } | { refused, message }` (`relabel`, issue #355, only ever true). Seamed like `launch`, so no test decides
	// a sandbox's user against a real daemon.
	resolveJobUser = decideSandboxJobUser,
	beforeLaunch = () => {},
	fs,
	fileExists,
	blessed,
	backendFloor = {},
	// Issue #446: `({ resolved }) => { pinned, keepUntil?, reason? }` when the caller asked for `--pin`, else null. Its
	// presence is also what admits a run past its window (`resolveSandbox`'s `pin`).
	pin = null,
	now = Date.now,
	// Issue #446: the post-launch look's two seams. `stop` removes this session's container, `pause` waits between asks.
	stop = stopSandbox,
	pause = launchWatchPause,
	// Issue #452, gate round 2: `({ proxy }) => null | { refused, message }`, asked before an egress-armed podman open.
	keeperCheck = sandboxKeeperCheck,
	// Issue #452, gate round 3: the detach gate this session's teardown asks, a seam for the tests; by default the one
	// `removeJobNetwork` builds over `spawnNetwork`, like every other teardown's.
	detachGate = null,
	// Issue #452, gate round 4: `(network, reason) => void`, told of a teardown the gate refused, which leaves the network.
	onNetworkKept = () => {},
}) {
	// The posture is REQUIRED, and a boolean. Every other part of this function defaults safely; this one would
	// default to the open bridge, which is the dropped part this function exists to stop a caller dropping.
	if (typeof egress?.armed !== "boolean") {
		throw new Error("openSandbox: egress.armed must be a boolean -- a caller that does not say whether egress is armed must not get the default bridge");
	}
	const pinning = typeof pin === "function";
	const resolved = resolveSandbox({ jobId, sandboxDir, retentionHours, publish, blessed, now, pin: pinning, ...(fs ? { fs } : {}), ...(fileExists ? { fileExists } : {}) });
	if (resolved.refused) return resolved;
	// Admitted by `resolveSandbox`, so never null here.
	const { bin } = sandboxLauncher(resolved.venue);

	// `--publish` AND AN ARMED POLICY ARE OPPOSITE DIRECTIONS, and docker resolves the contradiction SILENTLY
	// (issue #362). An armed policy puts this shell on its own `--internal` network, and a container attached
	// only to one publishes nothing: docker accepts `-p`, exits 0, and binds no host port. Measured on docker
	// 27.4.0: `docker ps --format {{.Ports}}` is empty and `docker port` prints nothing and exits 0. So the one
	// case the flag exists for, "start the app and click through it", did not work on a default deployment and
	// the CLI printed `published: ...` as though it had.
	//
	// REFUSED rather than repaired, and the alternative is named because it is the tempting one: attaching the
	// default bridge as a second network would make the flag work and would hand that session the whole
	// internet, which is the reach this session's own network exists to deny. Saying it in the CLI line and
	// leaving the behaviour was the third option and it keeps a flag that exits 0 and does nothing, which this
	// project calls the worst outcome available.
	//
	// HERE, and the position is load-bearing three ways. AFTER `resolveSandbox`, so a run that cannot be opened
	// at all says why first rather than being told about a flag. BEFORE the first docker ask, because a
	// determinate refusal must not cost a round trip. And BEFORE `beforeLaunch`, which is where the CLI prints
	// `published: ...`: one line later and it would print the false line and then refuse.
	if (resolved.publish.length > 0 && egress.armed === true) {
		// THE REASON DIFFERS BY RUNTIME, and the first version of this said the same thing of both, which a review measured
		// false (Podman 5.8.1, rootless, pasta): podman DOES publish on an `--internal` network, binding the host's
		// 127.0.0.1 and answering. The refusal stays on podman anyway, for the posture rather than the port: the flag is
		// documented as an egress-off feature on every venue, and an armed session is the one whose network is meant to
		// reach nothing but the proxy, so a published port there would be a second path in that no policy names. Where
		// the shell lands with the policy off differs too: the job's own `--network=private` on podman, a bridge on docker.
		const lands = bin === "podman" ? "this account's rootless podman's private network (`--network=private`, as a job with egress off)" : "docker's default bridge";
		const why =
			bin === "podman"
				? "this sandbox joins an `--internal` network, the session network the policy is meant to confine to its proxy, and podman would publish a host port into it anyway (it binds 127.0.0.1 there, measured), a path in that no policy names; a published port is an egress-off feature on every venue"
				: "this sandbox joins an `--internal` network, where docker accepts `-p`, exits 0 and binds no host port, so the flag would name a port that is not there";
		return {
			refused: "publish-needs-egress-off",
			message: `\`--publish\` is refused while the egress policy is armed: ${why}. Open this one with \`PI_EGRESS=0\` in the environment you run this from, and know what that buys: the shell lands on ${lands}, with the whole internet`,
		};
	}

	// THE PIN, FIRST (issue #446): after the refusals that cost nothing, so only those come first (a refusal from a
	// runtime ask later, an already-running sandbox say, still leaves the pin, which is the operator's asked-for act),
	// and before the first runtime call. The sweep's re-reads (the fresh read, then the read through its tombstone)
	// honour a manifest that changed, so a pin written here holds the run against a pass already in flight; a pin
	// that cannot be written means the run is going or gone, and the open is refused rather than warned about.
	if (pinning) {
		let pinned;
		try {
			pinned = await pin({ resolved });
		} catch (err) {
			pinned = { pinned: false, reason: err?.message ?? "pin-failed" };
		}
		if (pinned?.pinned !== true) {
			const reason = pinned?.reason === "absent" ? "its retained workspace is gone, swept since it was read" : String(pinned?.reason ?? "unknown");
			return {
				refused: "pin-failed",
				message: `could not pin ${jobId} (${reason}), so the sandbox is not opened: an unpinned open of it could have its workspace deleted under the shell${pinned?.reason === "absent" ? "" : "; fix the cause and run it again"}`,
			};
		}
	}

	// Whether THIS job's sandbox is running. `listRunningSandboxes` throws so the REAPER can tell "none" from
	// "could not ask"; here an unanswered ask costs only the early refusal (docker refuses a second container
	// under the same name anyway) and, after the launch, is treated as "not running" so the network is removed.
	// The retained directory's own name (issue #446), which is how the runtime reports this container.
	const id = basename(resolved.manifest.dir);
	// Asked of the run's OWN runtime (issue #429): a podman sandbox is not in `docker ps`, so asking docker would call
	// every podman session "not running", refuse nothing and tear a detached one's network down.
	const ask = (signal) => Promise.resolve().then(() => running(signal ? { bin, signal } : { bin })).then((ids) => ({ answered: true, live: new Set(ids) }), () => ({ answered: false, live: new Set() }));
	const before = await ask();
	if (before.live.has(id)) {
		return { refused: "already-running", message: `a sandbox for ${jobId} is already running; attach to it with \`${bin} attach ${resolved.name}\`, or exit it first` };
	}

	// Issue #341: WHO the shell runs as, before anything is created. The daemon is this CLI's own; the uid is the
	// run's, off its manifest, because that uid owns the retained files.
	// The venue rides along (issue #429): a podman run is decided by the podman rules, from `podman info`, and refused
	// for what a podman job is refused for (`judgePodmanVenue`), before any network or container exists.
	const jobUser = await resolveJobUser({ manifest: resolved.manifest, venue: resolved.venue, backendFloor });
	if (jobUser?.refused) return { refused: jobUser.refused, message: jobUser.message };

	// THE KEEPER, before anything exists (issue #452, gate round 2; #458). An egress-armed podman session ends in
	// `removeJobNetwork`, whose `network disconnect` of the running proxy is #458's trigger on Podman 4.x: without a
	// holding keeper, closing this shell would cut the proxy's route out for every job after it. So the open asks what a
	// job's preflight asks (`keeperPreflight`, with its age and order rules, since this admits a session that lasts) and
	// refuses with its reason and fix. On 5.x, and with the policy off, nothing is asked.
	if (egress.armed === true && bin === "podman") {
		const keeper = await keeperCheck({ proxy: egress.proxy });
		if (keeper?.refused) return keeper;
	}

	// REQ-EGRESS-ALLOWLIST: this session's own network, exactly like a job's, named off its own container so the
	// reaper's `pi-job-` filter never touches it -- a worker restart must not tear the network out from under a
	// shell an operator is sitting in.
	const network = egress?.armed === true ? networkNameFor(resolved.name) : null;
	const args = buildSandboxRunArgs({
		venue: resolved.venue,
		image: resolved.manifest.image,
		name: resolved.name,
		workspace: resolved.manifest.workspace,
		jobDir: resolved.manifest.dir,
		publish: resolved.publish,
		term,
		idleSeconds,
		network,
		egressEnv: egressEnv({ proxy: egress?.proxy, armed: egress?.armed === true }),
		user: jobUser?.user ?? null,
		home: jobUser?.home ?? null,
		relabel: jobUser?.relabel === true,
		// By containment, the rule `rebaseWorkspace` already moves the retained clone by: a workspace inside the retained
		// job dir is the worker's own clone, one outside it is the operator's folder. Not by the manifest's `kind`, so a run
		// retained before a preparer moved its clone is still judged by where the files actually are.
		workspaceOwned: insideDir(resolved.manifest.dir, resolved.manifest.workspace),
	});

	// No pre-spend gate here, deliberately: that is a MONEY gate and a sandbox spends nothing. A missing proxy
	// fails at network creation, in front of an operator at a terminal, which is the one place a late failure
	// is cheap.
	// In the run's runtime (issue #429): the network, the proxy's attachment and the container that joins it must all
	// live in ONE runtime, or `--network=` names a network the launching CLI has never heard of.
	if (network && !(await createJobNetwork(spawnNetwork, { network, proxy: egress.proxy, bin }))) {
		// A network ALREADY under this name is refused and named, never removed. It is either left by an earlier
		// session whose process died before its `finally` (a closed terminal, a SIGHUP -- pi's own handler exits
		// without unwinding), or a detached sandbox's that has since exited, or the network of an open of this
		// same run happening right now. Removing it automatically was tried under #277 and withdrawn: a second
		// open racing the first stripped the proxy from the first's live shell. Telling the two apart safely
		// needs more than this function can see, so the operator is told what it is and how to clear it. The
		// printed commands disconnect whatever is attached rather than the configured proxy, because a leftover
		// can carry a different one (a changed PI_EGRESS_PROXY, or two environments that disagree).
		// `createJobNetwork` rolls back a network it built itself, so one still present was almost always not
		// built here; the exception is a rollback whose own remove failed, which these commands also clear.
		if (await networkExists(spawnNetwork, network, { bin })) {
			// The member listing is per runtime (issue #452): Podman 4.9's `network inspect` renders no `.Containers`, so
			// the loop would disconnect nothing there, and its `network rm` refuses while a member in ANY state remains.
			// `ps -a --filter network=` names every member on both Podman versions (measured on 4.9.3 and 5.8.1). docker's
			// command is what it always was.
			const members = bin === "podman" ? `${bin} ps -a --filter network=${network} --format '{{.Names}}'` : `${bin} network inspect -f '{{range .Containers}}{{.Name}} {{end}}' ${network}`;
			return {
				refused: "egress-network-exists",
				// KEEPER FIRST on podman (issue #452, gate round 4): the loop below is a manual `network disconnect` of the running
				// proxy, which on Podman 4.x without the rootless network keeper is #458's trigger itself. docker's text is as it was.
				message: `the egress network ${network} already exists -- left by an earlier session of ${jobId} that did not clean up, or one opening right now. If \`pi-dispatch sandbox --list\` shows no sandbox running for it, ${bin === "podman" ? `first make sure the rootless network keeper is running (\`podman ps --filter name=^${NETNS_KEEPER}$\` lists it; if not, \`${NETNS_KEEPER_START}\`), because on Podman 4.x detaching the running proxy without it cuts the proxy's route out (issue #458); then ` : ""}disconnect whatever is attached and remove it: \`for c in $(${members}); do ${bin} network disconnect -f ${network} "$c"; done; ${bin} network rm ${network}\``,
			};
		}
		// Where the proxy comes from differs by venue: the compose file is docker-only, and on podman the proxy is
		// started by hand under this account's podman (docs/podman.md).
		const start = bin === "podman" ? "it runs under this account's rootless podman, started as docs/podman.md shows" : "`docker compose -f deploy/docker-compose.yml --profile egress up -d`";
		return {
			refused: "egress-network-failed",
			message: `could not create the egress network ${network} -- is the proxy running? ${start}. The egress setting is read from this process's environment (PI_EGRESS, PI_EGRESS_PROXY); a deployment that sets them only in its .env must export them where you run this.`,
		};
	}
	let detached = false;
	// THE POST-LAUNCH LOOK (issue #446). The refusal and the pin decide from what was on disk before the launch, and
	// two things can still take the run from under the new shell: the accepted residual (a worker whose window was
	// lowered below this opener's, whose pass missed the container), and the sweep's own rename and restore. So once
	// the runtime lists this sandbox, the run's own path is checked, and then KEPT checked for the life of the shell
	// (gate round 1: one check at listing was not enough, since a pass whose `ps` came before the container can reach
	// the directory later). The watching costs no runtime call: an `lstat` and a manifest read every
	// `SANDBOX_LAUNCH_WATCH_MS`. A run that is gone, or whose directory is no longer the one resolved (another inode at
	// the same path), has its container removed if that shows at the LAUNCH check, and is recorded and reported after
	// the shell exits if it shows later (gate round 2, below).
	//
	// CONCURRENT WITH THE SHELL, not ahead of it, and that is the stated limit: `run -it` hands the terminal over as the
	// container starts, and splitting it into a detached start and an attach would lose the prompt the shell prints
	// before the attach and changes the launch shape on two runtimes nobody has measured this on. Only a manifest file
	// that is NOT THERE, or a replaced directory, is a verdict: one that cannot be read for a moment, cannot be read for
	// good, or does not parse is not a verdict, since none of those says the run is gone. A shell that DETACHES is
	// no longer watched: the look ends with the shell's own return.
	let settled = false;
	let wake = () => {};
	const woken = new Promise((resolve) => {
		wake = resolve;
	});
	let swept = null;
	// STOPS WHEN THE SHELL RETURNS, promptly: the ask in flight is aborted (the default runner kills its `ps`), and the
	// look does not wait for it either way, so a `running` seam that ignores the signal cannot hold an exited shell for
	// the ask's own timeout.
	const abort = new AbortController();
	const shellBack = woken.then(() => null);
	// The injected `fs` when there is one (a test's), else the real one. One without `lstatSync` cannot look at all.
	const retainedFs = fs ?? { lstatSync, readFileSync };
	const runDir = resolved.manifest.dir;
	// `"swept"` (no manifest file at the run's path), `"replaced"` (a directory other than the one resolved), or null.
	const gone = () => {
		const read = readRetained(retainedFs, runDir);
		if (read.absent) return "swept";
		if (read.transient || !resolved.identity) return null;
		const now = dirIdentity(retainedFs, runDir);
		return now !== null && (now.dev !== resolved.identity.dev || now.ino !== resolved.identity.ino) ? "replaced" : null;
	};
	let lost = null;
	// Whether the look ever saw the container listed: a 125 WITHOUT that is the runtime refusing to start it.
	let everListed = false;
	const look = async () => {
		if (typeof retainedFs?.lstatSync !== "function") return;
		let listed = false;
		for (let i = 0; !listed && i < SANDBOX_LAUNCH_WATCH_TRIES; i++) {
			await Promise.race([pause(SANDBOX_LAUNCH_WATCH_MS), woken]);
			if (settled) return;
			const seen = await Promise.race([ask(abort.signal), shellBack]);
			if (settled || !seen) return;
			listed = seen.live.has(id);
		}
		everListed = listed;
		// THE LAUNCH CHECK removes the container: nothing an operator did can be in it yet, and a shell over an empty mount
		// is worse than none. AFTER it, a loss is RECORDED and never acted on (gate round 2): the shell may by then hold
		// state outside the mounts (processes, files under `/tmp`, an `apt install`), and a retry's `retainJobDir`
		// replacing the directory is an ordinary event that must not `rm -f` a working session. The operator is told when
		// the shell exits. Nothing reaps the replacing run meanwhile: this container still carries the run's name, so
		// every pass holds that directory as open.
		//
		// Only for a container the runtime LISTED: one never seen (its `ps` failing, or listed after the asking budget) is
		// not known to be the operator's fresh shell, so it is watched without being touched (gate round 3), for the whole
		// session, which costs an `lstat` and a manifest read per `SANDBOX_LAUNCH_WATCH_MS`.
		if (listed && gone()) {
			swept = { stopped: (await Promise.resolve().then(() => stop({ bin, name: resolved.name })).catch(() => false)) === true };
			return;
		}
		while (!settled) {
			await Promise.race([pause(SANDBOX_LAUNCH_WATCH_MS), woken]);
			if (settled) return;
			lost = gone();
			if (lost) return;
		}
	};
	try {
		// THE CALLER'S BANNER, AFTER THE LAST REFUSAL (issue #462): the CLI prints "opening ..." from here, and it ran before
		// the network was created, so a leftover network printed the banner and then refused. Inside the `try`, so a hook
		// that throws still has this session's network removed by the `finally`.
		await beforeLaunch({ resolved, args, network, runtime: bin });
		const watching = look().catch(() => {});
		let launched;
		try {
			launched = await launch({ args, bin });
		} finally {
			settled = true;
			abort.abort();
			wake();
		}
		await watching;
		const { code, error } = launched;
		if (swept) {
			const how = swept.stopped ? "was stopped" : `could not be stopped (\`${bin} rm -f ${resolved.name}\`)`;
			return {
				refused: "swept-at-launch",
				message: `the retained workspace for ${jobId} was deleted or replaced as this sandbox started, so the sandbox ${how}: its mounts were no longer the run's. \`pi-dispatch sandbox --list\` shows whether the run is still there to open again`,
				code: code ?? null,
			};
		}
		// A RUNTIME THAT REFUSED THE BIND (gate round 2, measured on podman): asked to mount a path that is not there,
		// podman refuses (`statfs ...: no such file or directory`, exit 125) where docker creates an empty directory. Its
		// words went to the terminal; the cause is the run's directory, so that launch is reported as swept rather than
		// left as a bare exit code. ONLY 125 and only a container never listed (gate round 3): any other exit is a shell
		// that ran, and a run gone by then is reported as lost below, from a check at exit.
		const lookable = typeof retainedFs?.lstatSync === "function";
		if (!error && code === 125 && !everListed && lookable && gone()) {
			return {
				refused: "swept-at-launch",
				message: `the retained workspace for ${jobId} was deleted or replaced as this sandbox started, so the sandbox could not start on it (the runtime refused the mount, exit ${code}). \`pi-dispatch sandbox --list\` shows whether the run is still there to open again`,
				code: code ?? null,
			};
		}
		// DETACHED, not exited: docker's detach sequence (Ctrl-P Ctrl-Q) returns with the container still running.
		// Tearing the network down then would strip the proxy from a live sandbox, so `docker attach` reopens a
		// shell with no egress at all. Leave it. An unanswered ask is NOT detached: the network is torn down, as it
		// always was. A network left this way outlives the sandbox, and the next open of this run names it.
		// Exit 0 as well: docker's detach returns 0, while a `docker run` that failed (125, a name taken by another
		// open of the same run with a different egress setting) must not be read as this session detaching.
		if (network && !error && code === 0) detached = (await ask()).live.has(id);
		// ONE MORE CHECK AT EXIT (gate round 3): the look can have missed a loss (it never saw the container listed, or
		// the loss landed after its last check), and the shell's return is when the operator is told.
		if (!lost && !error && lookable) lost = gone();
		const during = lost
			? {
					lost,
					message:
						lost === "replaced"
							? `the retained workspace for ${jobId} was REPLACED while this sandbox was open (a retry of the run, most likely), so what the shell had under /workspace was no longer the run on disk; nothing you saved there is in the new run's directory`
							: `the retained workspace for ${jobId} was DELETED while this sandbox was open (by the retention sweep, or by a retry of the run clearing it), so nothing you saved under /workspace survives; pin a run (\`--pin\`) before working in it late in its window`,
				}
			: {};
		return { code: code ?? null, error: error ?? null, ...(detached ? { detached: true } : {}), ...during };
	} finally {
		if (network && !detached) {
			// The runtime this session was ADMITTED on (issue #452, gate round 4), never a fresh read at the teardown; a
			// refused teardown is said with its token.
			await removeJobNetwork(spawnNetwork, {
				network,
				proxy: egress.proxy,
				bin,
				...(detachGate ? { gate: detachGate } : {}),
				...(jobUser?.runtime ? { readRuntime: async () => jobUser.runtime } : {}),
				onRefused: (reason) => onNetworkKept(network, reason),
			});
		}
	}
}

/** How often the post-launch look asks the runtime whether the sandbox is listed yet (issue #446). */
export const SANDBOX_LAUNCH_WATCH_MS = 250;

/** How many times it asks before giving up the look: thirty seconds, well past a container start with `--pull=never`. */
export const SANDBOX_LAUNCH_WATCH_TRIES = 120;

/** The look's default wait. `unref`, so a look still waiting never holds a process that is otherwise done. */
function launchWatchPause(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

/**
 * The argv that removes one session's container AT ONCE (issue #446, measured on pd-fedora in the #457 gate). A sandbox
 * runs an interactive bash under `--init`, which ignores SIGTERM, so `podman rm -f` without `--time=0` waits out
 * podman's 10 s stop timeout; the 10 000 ms bound below killed the `rm` first (rc 124 after 10004 ms) and the shell
 * stayed up over an emptied `/job`. `rm -f --time=0` took 106 ms. `-t, --time` is in podman 4.9.3, accepted beside
 * `--force` (doctor's `canaryProbeRemoval`, #431, rests on the same reading). docker's `rm -f` sends SIGKILL at once and
 * stays byte for byte what it was.
 */
export function sandboxRemovalArgs(bin, name) {
	return bin === "podman" ? ["rm", "-f", "--time=0", name] : ["rm", "-f", name];
}

/** Remove one session's container, bounded, never throws: true when the runtime said it did (issue #446). */
export async function stopSandbox({ bin = "docker", name, run = execDockerBounded }) {
	try {
		const { code } = await run(sandboxRemovalArgs(bin, name), { timeoutMs: 10_000, bin });
		return code === 0;
	} catch {
		return false;
	}
}

/**
 * Which uid a re-opened sandbox runs as (issue #341), as `{ user, home }` or `{ refused, message }`.
 *
 * TWO SOURCES, on purpose. The DAEMON facts are this CLI's own (platform, endpoint, one `docker info`), because the
 * sandbox runs on whatever daemon this shell reaches. The IDENTITY is the run's, from the manifest stamp, because
 * that uid owns the retained files, and because the CLI's own uid need not be the worker's: `sudo pi-dispatch
 * sandbox` would otherwise be refused as a root worker, or would run as the wrong uid.
 *
 * A stamp that is present but malformed is REFUSED, never read as "no stamp": the manifest is host-written, so a
 * bad shape means something else wrote it. A run from before the stamp existed decides from the CLI's own ids.
 *
 * `venue` (issue #429) picks the rules: a `podman` run is decided by `decidePodmanSandboxJobUser` below, from `podman
 * info`, and everything after this line is `local`'s, unchanged.
 */
export async function decideSandboxJobUser(opts = {}) {
	if (opts?.venue === PODMAN_BACKEND) return decidePodmanSandboxJobUser(opts);
	return decideLocalSandboxJobUser(opts);
}

const MALFORMED_STAMP = Object.freeze({ refused: "job-user-stamp-invalid", message: "the run's recorded job user is malformed, so the uid that owns its files is unknown; re-run the job instead" });

/**
 * The manifest's `jobUser` stamp, read: `{ malformed: true }`, `{ stamped: false }` (no stamp: a run from before it,
 * or a bare wiring), `{ stamped: true, user: null }` (the image's own user) or `{ stamped: true, user, uid, gid }`.
 * One reader for both venues, so a shape one refuses the other cannot quietly accept.
 */
function readJobUserStamp(stamp) {
	if (stamp === undefined || stamp === null) return { stamped: false };
	if (typeof stamp !== "object" || !("user" in stamp)) return { malformed: true };
	if (stamp.user === null) {
		if (stamp.home !== null && stamp.home !== undefined) return { malformed: true };
		return { stamped: true, user: null };
	}
	try {
		assertJobUser(stamp.user);
	} catch {
		return { malformed: true };
	}
	if (stamp.home !== CONTAINER_HOME) return { malformed: true };
	const [uid, gid] = stamp.user.split(":").map(Number);
	return { stamped: true, user: stamp.user, uid, gid };
}

async function decideLocalSandboxJobUser({
	manifest,
	platform = process.platform,
	release = osRelease(),
	euid = process.geteuid?.(),
	egid = process.getegid?.(),
	resolveEndpoint = makeDockerEndpointResolver(),
	readFacts = makeDaemonFactsReader(),
	imageCapabilities = (image) => makeImagePreflight({ image })({}),
	stat,
} = {}) {
	if (platform === "darwin" || platform === "win32") return { user: null, home: null };
	const stamp = manifest?.jobUser;
	const read = readJobUserStamp(stamp);
	if (read.malformed) return { ...MALFORMED_STAMP };
	const identity = !read.stamped ? { euid, egid } : read.user === null ? { euid: SHIPPED_IMAGE_UID, egid: SHIPPED_IMAGE_UID } : { euid: read.uid, egid: read.gid };
	const endpoint = await resolveEndpoint();
	const daemon = endpoint?.local === false ? { answered: false, reason: "not-read", transient: true } : await readFacts();
	const socketPath = endpoint?.local === true && typeof endpoint.endpoint === "string" && endpoint.endpoint.startsWith("unix://")
		? endpoint.endpoint
		: daemon?.answered ? daemon.facts.remoteSocketPath : null;
	const socket = socketFacts(socketPath, stat ? { stat } : {});
	const decision = decideJobUser({ platform, release, ...identity, endpoint, daemon, socket });
	// Issue #355: this CLI's own daemon facts, the same read the uid came from, decide whether the shell's mounts carry
	// `:Z`. Added to the answer only when true, so every host it does not apply to returns the shape it always did.
	const relabel = relabelsPrivateMounts(daemon?.answered ? daemon.facts : null, endpoint, platform) ? { relabel: true } : {};
	// A run from before the stamp, opened with sudo: the root here is this shell's, not the worker's, so the worker's
	// fix text would send the operator to change the wrong thing.
	if (decision.cause === "worker-is-root" && (stamp === undefined || stamp === null)) {
		return { refused: "job-user-unmappable", message: "this run recorded no job user, so a sandbox opened as root cannot tell which uid owns its files; open it as the worker's own account (issue #341)" };
	}
	// The shared fixed texts, without the forge comment's "Refused:" lead: the CLI prints its own `error:`.
	if (decision.mode === "unmappable") return { refused: "job-user-unmappable", message: `${JOB_USER_FIX[decision.cause] ?? "the job user could not be decided"} (issue #341)` };
	if (decision.mode === "unknown") {
		return { refused: "job-user-unknown", message: `which uid the sandbox may run as could not be decided (${decision.reason}); is the docker daemon running?` };
	}
	// `runtime` (issue #452, gate round 4): the facts this session was admitted on, for its teardown's detach gate.
	const runtime = daemon?.answered ? runtimeFromFacts(daemon) : undefined;
	if (decision.mode === "image") return withRuntime({ user: null, home: null, ...relabel }, runtime);
	const needsImage = identity.euid !== SHIPPED_IMAGE_UID;
	const caps = needsImage ? await imageCapabilities(manifest?.image) : { ok: true, capabilities: [] };
	if (needsImage && !caps?.ok) {
		return { refused: "job-user-image", message: `the retained image ${manifest?.image} could not be inspected, so whether it runs as another uid is unknown` };
	}
	const chosen = resolveImageUser(decision, { capabilities: caps.capabilities ?? [], euid: identity.euid, egid: identity.egid, socket });
	if (chosen.refused === "job-image-any-uid-unsupported") {
		return { refused: chosen.refused, message: `the retained image ${manifest?.image} does not declare anyUid, so it cannot run as the uid that owns this run's files (issue #341)` };
	}
	if (chosen.refused) return { refused: chosen.refused, message: `${JOB_USER_FIX[chosen.cause] ?? "the job user could not be decided"} (issue #341)` };
	return withRuntime({ user: chosen.user, home: chosen.home, ...relabel }, runtime);
}

/**
 * The runtime a sandbox was admitted on, carried BESIDE the job-user answer rather than in it (issue #452, gate round 4):
 * non-enumerable, so the answer's shape, which callers compare and print, is what it always was, while `openSandbox`'s
 * teardown hands it to the detach gate and reads the daemon nothing more.
 */
function withRuntime(answer, runtime) {
	if (runtime !== undefined) Object.defineProperty(answer, "runtime", { value: runtime, enumerable: false });
	return answer;
}

/**
 * Which uid a sandbox of a `podman` run runs as (issue #429), as `{ user, home, relabel? }` or `{ refused, message }`.
 * ALWAYS a user, as a podman job always has one: keep-id without `--user` runs the image's user with `/job` unreadable
 * (measured under issue #354), and `buildPodmanRunArgs` refuses the argv outright.
 *
 * THE UID IS THE ACCOUNT THAT OPENS IT, and it must be the run's. keep-id maps the host uid of the account running
 * `podman` into the container, and rootless Podman's store (the retained image with it) is that account's own. So,
 * unlike `local`, the stamp cannot choose another uid: a sandbox opened as another account would run as a uid that does
 * not own the retained files, from a store that may not hold the image. A stamp naming another uid is REFUSED with the
 * account to use, never "fixed" by passing the stamp's uid, which keep-id would map to a subordinate id that owns
 * nothing on the host. No stamp (a run from before it) decides from this process's ids, as `local` does.
 *
 * REFUSED FOR WHAT A JOB IS REFUSED FOR, IN THE JOB'S ORDER, by the job's own function (`judgePodmanVenue`): the
 * identity (not Linux, no podman, a remote service, rootful), then a containers.conf that widens a container
 * (`podman-conf-widens-job`, issue #428: its `pasta_options` reach a sandbox's network exactly as a job's, and its
 * `annotations` its groups), then the observations against `backendFloor`. A sandbox spends nothing, and these are
 * still not money gates: they are what the venue IS, and a shell over an agent-written workspace on a venue a job
 * would be refused on is the reach a sandbox exists not to widen. All of it before any network or container exists.
 *
 * sudo is refused FIRST, before `podman info` is asked: root's Podman is rootful and is not the worker's, so the
 * worker's fix text for a root worker would send the operator to change the wrong thing.
 */
async function decidePodmanSandboxJobUser({
	manifest,
	platform = process.platform,
	euid = process.geteuid?.(),
	egid = process.getegid?.(),
	backendFloor = {},
	readInfo = makePodmanInfoReader(),
	imageCapabilities = (image) => makeImagePreflight({ image, bin: "podman" })({}),
	fs,
	home,
	env,
} = {}) {
	const read = readJobUserStamp(manifest?.jobUser);
	if (read.malformed) return { ...MALFORMED_STAMP };
	// Before any spawn: nothing podman could say changes it, and on macOS the CLI may well be a `podman machine` client.
	if (platform !== "linux") return { refused: "job-user-unmappable", message: `${PODMAN_JOB_USER_FIX["podman-platform"]} (issue #354)` };
	if (euid === 0) {
		return { refused: "job-user-unmappable", message: "a sandbox on the podman venue opens under the rootless Podman of the account that runs it, and root's is neither rootless nor the worker's; open it as the worker's own account (issue #429)" };
	}
	const info = await readInfo();
	const judged = judgePodmanVenue({ read: info, platform, euid, egid, backendFloor, ...(fs ? { fs } : {}), ...(home ? { home } : {}), ...(env ? { env } : {}) });
	if (judged.jobUserRefused) return { refused: "job-user-unmappable", message: `${PODMAN_JOB_USER_FIX[judged.jobUserRefused.cause] ?? "the job user could not be decided"} (issue #354)` };
	// A containers.conf that could not be read JUST NOW (issue #428's transient rule) is a job's retry; a sandbox has no
	// queue to retry through, so it is refused in its own words, naming the file, and the operator tries again.
	if (judged.podmanConfRefused?.transient) {
		return { refused: "podman-conf-unread", message: `the podman venue's containers.conf could not be read just now, so whether it widens this sandbox is not known (${judged.podmanConfRefused.evidence ?? "no file named"}); try again` };
	}
	if (judged.podmanConfRefused) return { refused: PODMAN_CONF_WIDENS_JOB, message: judged.podmanConfRefused.message };
	if (judged.unavailable) {
		// `file-unread` names the host file that could not be read (issue #428), which is the operator's to fix or retry.
		const what = judged.reason === "file-unread" && judged.message ? judged.message : `it did not answer (${judged.reason})`;
		return { refused: "podman-unobserved", message: `PI_BACKEND_FLOOR asks for what only an answered \`podman info\` and this host's podman files show, and ${what}; try again, and check \`podman info\` answers as this account` };
	}
	if (judged.refused) return { refused: "backend-floor", message: judged.message };
	const decision = decidePodmanJobUser({ platform, euid, egid, read: info });
	if (decision.mode !== "worker") {
		return { refused: "job-user-unknown", message: `which uid the sandbox may run as could not be decided (${decision.reason ?? decision.cause}); is podman answering \`podman info\` as this account?` };
	}
	// THE STORE (issue #429, review round 2, measured on Podman 5.8.1): another HOME, XDG_DATA_HOME or storage.conf is
	// another container store, where the run's image is absent and, sharper, where this sandbox's container would be one
	// the worker's `podman ps` cannot see, so the retention sweep would read "not open" and delete the directory under
	// it. A run that recorded its store opens only under that store. A run from before the key opens as it did.
	const recorded = typeof manifest?.podmanStore === "string" ? manifest.podmanStore : null;
	const current = info?.answered === true ? (info.info?.graphRoot ?? null) : null;
	if (recorded !== null && current !== recorded) {
		return {
			refused: "podman-store-mismatch",
			message: `this run's container store is ${recorded}, and the podman you are running uses ${current ?? "a store it did not report"}; open it as the account the worker runs as, with the worker's HOME and XDG_DATA_HOME (and no storage.conf of your own), so the worker's retention sweep can see the sandbox is open (issue #429)`,
		};
	}
	if (read.stamped && read.user !== decision.user) {
		const ran = read.user === null ? "as the image's own user, which no podman run does" : `as ${read.user}`;
		return {
			refused: "job-user-unmappable",
			message: `this run ran ${ran}, and a sandbox on the podman venue runs as the account that opens it (${decision.user}) under keep-id, in that account's own Podman store; open it as the account the worker runs as (issue #429)`,
		};
	}
	const caps = euid !== SHIPPED_IMAGE_UID ? await imageCapabilities(manifest?.image) : { ok: true, capabilities: [] };
	if (euid !== SHIPPED_IMAGE_UID && !caps?.ok) {
		return { refused: "job-user-image", message: `the retained image ${manifest?.image} could not be inspected in this account's podman store, so whether it runs as another uid is unknown` };
	}
	const chosen = resolvePodmanImageUser(decision, { capabilities: caps?.capabilities ?? [], euid, egid });
	if (chosen.refused === "job-image-any-uid-unsupported") {
		return { refused: chosen.refused, message: `the retained image ${manifest?.image} does not declare anyUid, so it cannot run as this account's uid, which the podman venue always uses (issue #354)` };
	}
	if (chosen.refused) return { refused: chosen.refused, message: `${PODMAN_JOB_USER_FIX[chosen.cause] ?? "the job user could not be decided"} (issue #354)` };
	if (chosen.unavailable) return { refused: "job-user-unknown", message: `which uid the sandbox may run as could not be decided (${chosen.reason}); is podman answering \`podman info\` as this account?` };
	// `relabel` on podman is `podman info`'s SELinux fact, the rule a podman job's own mounts follow (issue #355).
	// `runtime` (issue #452, gate round 4): the same read, for the session teardown's detach gate, so it reads nothing again.
	return withRuntime({ user: chosen.user, home: chosen.home, ...(chosen.relabel === true ? { relabel: true } : {}) }, { podman: true, rootless: info.info?.rootless ?? null, version: info.info?.version ?? null });
}

/**
 * Launch one operator session, attached to the caller's terminal, and resolve its exit code.
 *
 * `spawn`, never `spawnSync`, and `stdio: "inherit"`: the same shape pi itself uses to hand the terminal
 * to `$EDITOR` (`extension-editor.js`), whose comment records why the synchronous form is wrong -- on
 * Windows it can keep libuv's console read active and race the child for input.
 *
 * The caller owns the terminal around this: the CLI simply has one, and the admin panel brackets the call
 * with `tui.stop()`/`tui.start()`.
 */
export function launchSandbox({ args, bin = "docker", spawnFn = spawn }) {
	// `bin` (issue #429) is the run's venue's CLI, handed in by `openSandbox`; the default keeps a caller from before it
	// on docker, which is what that caller built its argv for.
	return new Promise((resolve) => {
		const child = spawnFn(bin, args, { stdio: "inherit" });
		child.on("error", (err) => resolve({ code: null, error: err }));
		child.on("close", (code) => resolve({ code }));
	});
}
