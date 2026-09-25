import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { release as osRelease } from "node:os";
import { isAbsolute, relative } from "node:path";
import { promisify } from "node:util";
import { execDockerBounded, makeDockerEndpointResolver } from "./backend-local.mjs";
import { DEFAULT_BACKEND, UNATTRIBUTED_BACKEND } from "./backends.mjs";
import { configError } from "./config.mjs";
import { assertJobUser, CONTAINER_HOME, SHIPPED_IMAGE_UID } from "./container-spec.mjs";
import { buildDockerRunArgs } from "./docker-run.mjs";
import { makeImagePreflight } from "./image-preflight.mjs";
import { decideJobUser, JOB_USER_FIX, makeDaemonFactsReader, relabelsPrivateMounts, resolveImageUser, socketFacts } from "./job-user.mjs";
import { NETWORK_SUFFIX, createJobNetwork, egressArmed, egressEnv, egressProxyName, networkEndpoints, networkExists, networkNameFor, removeJobNetwork, removeNetworkOrSay } from "./egress.mjs";
import { sanitizeJobId } from "./run-history.mjs";
import { readManifest } from "./sandbox-store.mjs";

/**
 * sandbox.mjs -- the operator session's container shape (INT-SANDBOX-CONTRACT).
 *
 * A SECOND container shape, deliberately not a second copy of the first. The argv comes from
 * `buildDockerRunArgs` through its `extraFlags` seam, so `ISOLATION_FLAGS`, `--memory` and `--cpus` reach
 * this container BY CONSTRUCTION: a future change to the boundary cannot land on job containers and miss
 * this one, which is the whole reason for reusing the builder rather than writing a leaner argv here.
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
 * The name namespace, and it is load-bearing. The boot reaper filters `name=pi-job-`
 * (`makeReaper` in backend-local.mjs) and docker matches that as a SUBSTRING, so a sandbox must not contain it --
 * otherwise a worker restart kills the shell an operator is sitting in. `pi-sandbox-` is outside that
 * filter on purpose, and a test pins it.
 */
export const SANDBOX_NAME_PREFIX = "pi-sandbox-";

/** `pi-sandbox-<jobId>`. `sanitizeJobId` already maps to `[A-Za-z0-9._-]`, which is a legal docker name. */
export function sandboxContainerName(jobId) {
	return `${SANDBOX_NAME_PREFIX}${sanitizeJobId(jobId)}`;
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
 * Build the `docker run` argv for one operator session (excluding the leading "docker").
 *
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
export function buildSandboxRunArgs({ image, name, workspace, jobDir, publish = [], term, idleSeconds = 0, network = null, egressEnv: proxyEnv = {}, user = null, home = null, relabel = false, workspaceOwned = false }) {
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
	return buildDockerRunArgs({
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
		// Ahead of the env and the mounts, and well ahead of the image, which buildDockerRunArgs keeps as
		// the final positional. `--entrypoint` also clears the image's CMD; this repo's Dockerfile sets
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
export async function listRunningSandboxes({ execFn = exec } = {}) {
	const { stdout } = await execFn("docker", ["ps", "--filter", `name=${SANDBOX_NAME_PREFIX}`, "--format", "{{.Names}}"], { timeout: 5000 });
	return stdout
		.split("\n")
		.map((n) => n.trim())
		.filter((n) => n.startsWith(SANDBOX_NAME_PREFIX))
		.map((n) => n.slice(SANDBOX_NAME_PREFIX.length));
}

/**
 * The sweep's docker runner: bounded, both streams, never throws. `execDockerBounded` already settles on its
 * own timer and kills with SIGKILL, which matters here for the reason `retention-sweep.mjs` records -- this
 * loop runs on a timer beside draining jobs, and `execFile`'s own `timeout` only signals and then still waits
 * for `close`, so a CLI wedged on a dead socket never settles. Its rejection carries `stderr` on the error,
 * which the "network is not there" rule needs and the bounded shape does not surface on its own.
 */
async function boundedDocker(args) {
	const { code, stdout, error } = await execDockerBounded(args, { timeoutMs: 10_000 });
	return { code, stdout: String(stdout ?? ""), stderr: String(error?.stderr ?? "") };
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
export function makeSandboxNetworkSweeper({ run = boundedDocker } = {}) {
	return async function sweepSandboxNetworks({ running = new Set(), keep = new Set(), retained = missingRetained, blocked = new Set() } = {}) {
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
			const { ok, names, absent } = await networkEndpoints(run, name);
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
			const outcome = await removeNetworkOrSay(run, { network: name, detach: names, stillClear });
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
			else notes.push({ network: name, reason: "rm-failed", detached: outcome.detached });
			// Between networks, for `retention-sweep.mjs`'s reason: this loop runs on a timer beside draining
			// jobs, and `index.mjs` runs with `maxStalledCount: 0` against BullMQ's 30s lock.
			await new Promise((resolve) => setImmediate(resolve));
		}
		return { swept, notes };
	};
}

/**
 * Whether a retained run can be re-opened HERE, judged by the venue it ran in (issue #277). `null` when it
 * can, else `{ refused, message }`. Exported for the admin panel, which asks before advertising the key.
 *
 * WHY THIS IS PER JOB. A sandbox opens a shell on THIS host's docker daemon against the job's retained
 * directory, so it can reproduce only a run whose container was built here. The check used to be
 * deployment-wide (refuse every sandbox when any blessed venue was remote) because the command takes a job
 * id and could not learn its venue; the manifest now records it, and the answer belongs to the job.
 *
 * HELD MEANS THE LOCAL ADAPTER, by name. The launcher below is hard-wired to this host's docker CLI, which is
 * exactly the `local` bundle (its name is `DEFAULT_BACKEND`). Not "any venue declaring `remote: false`": a
 * future non-remote venue on another runtime would pass that and be reopened under docker, reproducing a
 * run from a runtime it never ran in. Such a venue must widen this deliberately.
 *
 * A MANIFEST WITH NO `backend` KEY predates venue attribution and ran on `local` (`UNATTRIBUTED_BACKEND`).
 * A key that is PRESENT but not a name is refused: `typeof` first, because the table's `backendFor(null)`
 * returns `local`, and a null stamp means the venue was never known, not that it was local.
 */
export function sandboxVenueRefusal({ jobId, manifest }) {
	const venue = Object.hasOwn(manifest ?? {}, "backend") ? manifest.backend : UNATTRIBUTED_BACKEND;
	if (typeof venue !== "string" || venue === "") {
		return { refused: "venue-unreachable", message: `the manifest for ${jobId} names no backend, so this host cannot tell whether the run happened here` };
	}
	if (venue === DEFAULT_BACKEND) return null;
	return {
		refused: "venue-unreachable",
		message: `${jobId} ran on the ${JSON.stringify(venue)} backend, not on this host's docker daemon — a sandbox opens a shell here against the retained directory, so it cannot reproduce that run. Open it on the venue that ran it.`,
	};
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
export function sandboxSyncRefusal({ jobId, manifest, fileExists = existsSync }) {
	const venue = sandboxVenueRefusal({ jobId, manifest });
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
 * Resolve one retained run into a launchable argv, or a NAMED refusal.
 *
 * Split out from the launch so both callers -- the CLI and the admin panel -- refuse identically, the venue
 * refusal included, and so
 * the whole decision is testable without docker. Every refusal names what to do next, the posture
 * `doctor` sets: a bare "not found" for a run the operator watched finish ten minutes ago is the least
 * useful thing this could say.
 */
export function resolveSandbox({ jobId, sandboxDir, retentionHours, publish = [], fs, fileExists = existsSync }) {
	if (!jobId) return { refused: "no-job-id", message: "a job id is required (see `pi-dispatch sandbox --list`)" };

	const manifest = readManifest({ sandboxDir, jobId, ...(fs ? { fs } : {}) });
	if (!manifest) {
		return retentionHours === 0
			? { refused: "retention-off", message: "workspace retention is off — set PI_SANDBOX_RETENTION_HOURS to a positive number to make future runs resurrectable" }
			: { refused: "absent", message: `no retained workspace for ${jobId} — it was swept after ${retentionHours}h, or the run predates retention (\`pi-dispatch sandbox --list\` shows what is left)` };
	}
	// The venue BEFORE the image and the workspace (#277): for a run from another venue those two are the
	// symptoms, and the first refusal an operator reads should be the cause. A workspace that happens to
	// exist at the same path on this host would otherwise pass and silently reproduce the wrong run.
	const refusal = sandboxSyncRefusal({ jobId, manifest, fileExists });
	if (refusal) return refusal;

	return { manifest, name: sandboxContainerName(jobId), publish };
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
 * In order: `resolveSandbox` (every refusal, the venue one included) -> the already-running refusal ->
 * the argv, with this session's own network and proxy variables when armed -> `beforeLaunch`, the caller's
 * hook to print or pin once the session is known to be openable -> create the network (a network already
 * under this name is REFUSED and named, never removed) -> launch -> ask docker again, and remove the network
 * in a finally unless the sandbox is still running. Returns `{ refused, message }`, or `{ code, error }` from
 * the launch, with `detached: true` when docker still lists the sandbox as running after the shell returned
 * (its network is left in place).
 * THROWS when `egress.armed` is not a boolean.
 *
 * NOT here, deliberately: the terminal check and `--publish` parsing, which are about the CLI's own
 * arguments, and the pin, which only the CLI offers (it runs in `beforeLaunch`).
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
}) {
	// The posture is REQUIRED, and a boolean. Every other part of this function defaults safely; this one would
	// default to the open bridge, which is the dropped part this function exists to stop a caller dropping.
	if (typeof egress?.armed !== "boolean") {
		throw new Error("openSandbox: egress.armed must be a boolean -- a caller that does not say whether egress is armed must not get the default bridge");
	}
	const resolved = resolveSandbox({ jobId, sandboxDir, retentionHours, publish, ...(fs ? { fs } : {}), ...(fileExists ? { fileExists } : {}) });
	if (resolved.refused) return resolved;

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
		return {
			refused: "publish-needs-egress-off",
			message: `\`--publish\` is refused while the egress policy is armed — this sandbox joins an \`--internal\` network, where docker accepts \`-p\`, exits 0 and binds no host port, so the flag would name a port that is not there. Open this one with \`PI_EGRESS=0\` in the environment you run this from, and know what that buys: the shell lands on docker's default bridge, with the whole internet`,
		};
	}

	// Whether THIS job's sandbox is running. `listRunningSandboxes` throws so the REAPER can tell "none" from
	// "could not ask"; here an unanswered ask costs only the early refusal (docker refuses a second container
	// under the same name anyway) and, after the launch, is treated as "not running" so the network is removed.
	const id = sanitizeJobId(jobId);
	const ask = () => Promise.resolve().then(() => running()).then((ids) => ({ answered: true, live: new Set(ids) }), () => ({ answered: false, live: new Set() }));
	const before = await ask();
	if (before.live.has(id)) {
		return { refused: "already-running", message: `a sandbox for ${jobId} is already running — attach to it with \`docker attach ${resolved.name}\`, or exit it first` };
	}

	// Issue #341: WHO the shell runs as, before anything is created. The daemon is this CLI's own; the uid is the
	// run's, off its manifest, because that uid owns the retained files.
	const jobUser = await resolveJobUser({ manifest: resolved.manifest });
	if (jobUser?.refused) return { refused: jobUser.refused, message: jobUser.message };

	// REQ-EGRESS-ALLOWLIST: this session's own network, exactly like a job's, named off its own container so the
	// reaper's `pi-job-` filter never touches it -- a worker restart must not tear the network out from under a
	// shell an operator is sitting in.
	const network = egress?.armed === true ? networkNameFor(resolved.name) : null;
	const args = buildSandboxRunArgs({
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
		workspaceOwned: isInsideDir(resolved.manifest.dir, resolved.manifest.workspace),
	});
	await beforeLaunch({ resolved, args, network });

	// No pre-spend gate here, deliberately: that is a MONEY gate and a sandbox spends nothing. A missing proxy
	// fails at network creation, in front of an operator at a terminal, which is the one place a late failure
	// is cheap.
	if (network && !(await createJobNetwork(spawnNetwork, { network, proxy: egress.proxy }))) {
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
		if (await networkExists(spawnNetwork, network)) {
			return {
				refused: "egress-network-exists",
				message: `the egress network ${network} already exists -- left by an earlier session of ${jobId} that did not clean up, or one opening right now. If \`pi-dispatch sandbox --list\` shows no sandbox running for it, disconnect whatever is attached and remove it: \`for c in $(docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' ${network}); do docker network disconnect -f ${network} "$c"; done; docker network rm ${network}\``,
			};
		}
		return {
			refused: "egress-network-failed",
			message: `could not create the egress network ${network} -- is the proxy running? \`docker compose -f deploy/docker-compose.yml --profile egress up -d\`. The egress setting is read from this process's environment (PI_EGRESS, PI_EGRESS_PROXY); a deployment that sets them only in its .env must export them where you run this.`,
		};
	}
	let detached = false;
	try {
		const { code, error } = await launch({ args });
		// DETACHED, not exited: docker's detach sequence (Ctrl-P Ctrl-Q) returns with the container still running.
		// Tearing the network down then would strip the proxy from a live sandbox, so `docker attach` reopens a
		// shell with no egress at all. Leave it. An unanswered ask is NOT detached: the network is torn down, as it
		// always was. A network left this way outlives the sandbox, and the next open of this run names it.
		// Exit 0 as well: docker's detach returns 0, while a `docker run` that failed (125, a name taken by another
		// open of the same run with a different egress setting) must not be read as this session detaching.
		if (network && !error && code === 0) detached = (await ask()).live.has(id);
		return { code: code ?? null, error: error ?? null, ...(detached ? { detached: true } : {}) };
	} finally {
		if (network && !detached) await removeJobNetwork(spawnNetwork, { network, proxy: egress.proxy });
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
 */
export async function decideSandboxJobUser({
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
	let identity = { euid, egid };
	if (stamp !== undefined && stamp !== null) {
		const malformed = { refused: "job-user-stamp-invalid", message: "the run's recorded job user is malformed, so the uid that owns its files is unknown; re-run the job instead" };
		if (typeof stamp !== "object" || !("user" in stamp)) return malformed;
		if (stamp.user === null) {
			if (stamp.home !== null && stamp.home !== undefined) return malformed;
			identity = { euid: SHIPPED_IMAGE_UID, egid: SHIPPED_IMAGE_UID };
		} else {
			try {
				assertJobUser(stamp.user);
			} catch {
				return malformed;
			}
			if (stamp.home !== CONTAINER_HOME) return malformed;
			const [uid, gid] = stamp.user.split(":").map(Number);
			identity = { euid: uid, egid: gid };
		}
	}
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
	if (decision.mode === "image") return { user: null, home: null, ...relabel };
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
	return { user: chosen.user, home: chosen.home, ...relabel };
}

/** Is `inner` a path strictly beneath `outer`? Both host paths from the manifest; `relative` so a separator is never assumed. */
function isInsideDir(outer, inner) {
	if (typeof outer !== "string" || typeof inner !== "string" || outer === "" || inner === "") return false;
	const rel = relative(outer, inner);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
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
export function launchSandbox({ args, spawnFn = spawn }) {
	return new Promise((resolve) => {
		const child = spawnFn("docker", args, { stdio: "inherit" });
		child.on("error", (err) => resolve({ code: null, error: err }));
		child.on("close", (code) => resolve({ code }));
	});
}
