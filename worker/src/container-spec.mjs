/**
 * WHAT the box is, with no Docker vocabulary in it (issue #227).
 *
 * This module is the half of `INT-CONTAINER-RUNTIME-CONTRACT` that is not about Docker: the container-side
 * paths a job always sees, and the value that describes one container before any runtime spells it. The
 * other half -- `ISOLATION_FLAGS`, `dockerArgsFromSpec` -- stays in `docker-run.mjs`, which re-exports
 * everything below so no call site moved. Two modules import from here directly: `docker-run.mjs` for the
 * spec builder, and `packages.mjs` for `CONTAINER_GLOBAL_PI_DIR`. The second one is the one to keep in mind
 * when editing this file, because it is the reason the leaf property below is load-bearing.
 *
 * WHY IT IS ITS OWN FILE NOW AND WAS NOT BEFORE. Issue #261 split the spec from the argv but deliberately
 * kept both in one file, and said exactly what would change that:
 *
 *   "Rejected: a separate `container-spec.mjs`, which would have ... added an import edge before a second
 *    consumer exists; the split here is by function, and the move to its own module belongs to the PR that
 *    adds one."
 *
 * This is that PR. The second consumer is the backend seam: a backend that is not the local Docker daemon
 * consumes a spec and never produces a Docker argv, so the description of a container has to be reachable
 * without reaching the argv builder. Nothing about the value changed in the move -- same fields, same
 * order, same guards -- because a byte-identical local deployment is #227's first constraint.
 *
 * It imports NOTHING, which is the property `packages.mjs` depends on when it derives the staged-packages
 * root from `CONTAINER_GLOBAL_PI_DIR` rather than re-typing the path.
 */

/**
 * Where the operator's global pi overlay lands INSIDE the container (REQ-GLOBAL-PI-OVERLAY). Exported
 * because packages.mjs derives the staged-packages root from it: the mount and that root are ONE fact on
 * one side of the boundary, and two literals in two modules could drift apart with both test suites still
 * green. A Linux container path, so it is always built with "/" -- never `path.join`, which yields
 * backslashes when the worker itself runs on Windows.
 */
export const CONTAINER_GLOBAL_PI_DIR = "/opt/pi-global";

/**
 * The session mount and the file inside it, exported together and used by both the argv builder in
 * docker-run.mjs and the env builder in env-allowlist.mjs. Two literals in two modules is how a mount and
 * the variable naming a path inside it drift apart with both suites green -- the runner would then look for
 * a transcript at a path nothing mounted, find none, and cold-start every job without saying so.
 *
 * Nothing key-derived crosses the boundary: the container always sees the same constant path, so no
 * repository name, no branch name and no host layout is legible from inside a job.
 */
export const CONTAINER_SESSION_DIR = "/session";
export const CONTAINER_SESSION_FILE = `${CONTAINER_SESSION_DIR}/current.jsonl`;

/**
 * The job image's home, and the uid its `USER` directive runs as (issue #341, `DES-JOB-USER-INFERRED-READ-BACK-ON-
 * REQUEST`). A job run under `--user` needs `HOME=CONTAINER_HOME` beside it, because such a uid has no passwd entry in
 * the image: Docker gives it `HOME=/`, Podman `HOME=/workspace` (both measured). The builder does not pair them; a job
 * or sandbox path that passes a `user` must. `SHIPPED_IMAGE_UID` is the one uid that needs no `--user` at all, since
 * the image already runs as it; a test pins it against `image/Dockerfile`'s `useradd` so the two cannot drift.
 */
export const CONTAINER_HOME = "/home/pi";
export const SHIPPED_IMAGE_UID = 1001;

// "<uid>:<gid>", both non-zero decimal. A bare uid is refused because docker then takes the group from the image's
// passwd, which is gid 0 for a uid it has no entry for; a name is refused because the image decides what it means.
const JOB_USER_RE = /^[1-9]\d{0,9}:[1-9]\d{0,9}$/;

/**
 * The host path `docker run` writes the container's ID to (issue #345), or `null`. Absolute (a POSIX path, or a Windows
 * drive path for a worker on Windows), no `..` segment and no control byte, because it rides a single
 * `--cidfile=<path>` token (the CLI splits on the first `=`) and names a file the worker later reads and removes. The worker puts it BESIDE the job
 * directory, never inside the `/job:ro` mount.
 */
export function assertCidFile(cidFile) {
	if (cidFile === null || cidFile === undefined) return;
	const absolute = typeof cidFile === "string" && (cidFile.startsWith("/") || /^[A-Za-z]:[\\/]/.test(cidFile));
	if (!absolute || cidFile.split(/[\\/]/).includes("..") || /[\u0000-\u001f\u007f]/.test(cidFile)) {
		throw new Error(`docker run: refusing a cidfile that is not a plain absolute path: ${JSON.stringify(cidFile)}`);
	}
}

/** Throws unless `user` is null/undefined or a non-root "<uid>:<gid>" (`nonRoot`, issue #341). */
export function assertJobUser(user) {
	if (user === null || user === undefined) return;
	if (typeof user !== "string" || !JOB_USER_RE.test(user)) {
		throw new Error(`docker run: refusing a job user that is not "<uid>:<gid>" with both parts non-zero: ${JSON.stringify(user)}`);
	}
}

/**
 * The user-namespace modes a spec may ask for (issue #354): `null`, the runtime's default, or `"keep-id"`, which maps the
 * worker's own uid and gid to the SAME ids inside a rootless Podman container, so a job run as the worker's own
 * "<uid>:<gid>" owns its bind mounts exactly as the worker does. A CLOSED set, and refused rather than passed through,
 * because the value reaches an argv as one token and every other spelling Podman accepts (`host`, `auto`, `nomap`, a
 * path to another process's namespace) changes which uids a job can reach on the host.
 */
export const USERNS_MODES = Object.freeze(["keep-id"]);

/** Throws unless `userns` is null/undefined or a member of `USERNS_MODES` (issue #354). */
export function assertUserns(userns) {
	if (userns === null || userns === undefined) return;
	if (typeof userns !== "string" || !USERNS_MODES.includes(userns)) {
		throw new Error(`container spec: refusing a userns other than null or ${USERNS_MODES.map((m) => JSON.stringify(m)).join(", ")}: ${JSON.stringify(userns)}`);
	}
}

/**
 * WHAT the box is, with no Docker vocabulary in it.
 *
 * Split from the argv builder so the description of a container exists as a VALUE before it becomes one
 * runtime's flags. `buildDockerRunArgs` is unchanged in name, signature and output -- it is
 * `dockerArgsFromSpec(containerSpec(opts))` -- so every caller and every assertion is untouched, and the
 * only thing that is new is that the middle of that sentence can be read on its own.
 *
 * Mounts are structured (`{host, container, readOnly}`) rather than pre-flattened `host:container:ro`
 * strings, because the flattening IS the Docker part: a runtime that does not bind-mount has to be able to
 * see which host path becomes which container path, and what may be written.
 *
 * `dockerExtra` is named for what it is. It carries raw Docker flags (`-i -t --entrypoint bash`), so it is the one
 * field a non-Docker consumer must refuse rather than translate. The job user is NOT in it: it is `user`, a field.
 * Calling it `extraFlags` at the boundary would have hidden that.
 *
 * @param image      pinned job image tag/digest
 * @param env        the closed env map from buildContainerEnv -- passed as explicit -e NAME=VALUE
 * @param jobDir     host path to the /job inputs dir (contains prompt.md and pi/); mounted /job:ro
 * @param workspace  host path to the fresh clone / local folder (mounted /workspace:rw)
 * @param outboxDir  host path to the /outbox chain-request dir (local jobs only); mounted /outbox:rw
 * @param sessionDir host path to this job's OWN copy of its session transcript (REQ-RESUMABLE-SESSION);
 *                   mounted /session:rw. Per-job, like jobDir -- never the shared store.
 * @param globalPiDir host path to the operator's global pi overlay (REQ-GLOBAL-PI-OVERLAY); mounted /opt/pi-global:ro
 * @param name       container name (for `docker stop` at the timeout)
 * @param memory     e.g. "4g"; cpus e.g. "2"
 * @param network    the per-job egress network this container joins (REQ-EGRESS-ALLOWLIST); null = the
 *                   docker default bridge, which is what every job did before that requirement existed
 * @param user       "<uid>:<gid>" the job runs as (issue #341), or null for the image's own USER. Portable: it says WHO
 *                   runs the box, which a non-docker runtime must honour too.
 * @param userns     null (the runtime's own default) or "keep-id" (issue #354): how the job user's ids map to the host's.
 *                   Portable in meaning, but only one runtime spells it: `dockerArgsFromSpec` REFUSES a non-null one,
 *                   because the docker CLI rejects `--userns=keep-id` client-side (exit 125, measured in issue #345), and
 *                   dropping it instead would run the job under a uid mapping nobody asked for.
 * @param extraFlags raw docker flags for the few callers that need them (the sandbox's -i -t --entrypoint bash)
 * @param relabel    true where the daemon confines containers with SELinux (`relabelsPrivateMounts`, issue #355): the
 *                   worker's own per-job mounts then carry `relabel: "private"`. Portable: it says WHICH host paths the
 *                   runtime may re-own for this one container, which a non-docker runtime must honour or refuse.
 * @param workspaceOwned true when `workspace` is the worker's own per-job directory (a forge job's clone, a sandbox's
 *                   retained copy), false when it is the operator's folder. Read only when `relabel` is true.
 */
export function containerSpec({
	image,
	env,
	jobDir,
	workspace,
	outboxDir,
	sessionDir,
	globalPiDir,
	name,
	memory = "4g",
	cpus = "2",
	network = null,
	user = null,
	userns = null,
	cidFile = null,
	extraFlags = [],
	relabel = false,
	workspaceOwned = false,
}) {
	if (!image) throw new Error("docker run: image is required");
	assertJobUser(user);
	assertUserns(userns);
	assertCidFile(cidFile);
	if (!name) throw new Error("docker run: container name is required");
	if (!workspace) throw new Error("docker run: workspace mount is required");
	// Booleans, strictly: a truthy string from a caller that forwarded an option bag must not re-own host directories.
	if (typeof relabel !== "boolean") throw new Error(`docker run: relabel must be a boolean; got ${typeof relabel}`);
	if (typeof workspaceOwned !== "boolean") throw new Error(`docker run: workspaceOwned must be a boolean; got ${typeof workspaceOwned}`);

	// Issue #355. A SPREAD rather than a `relabel: null` field, so a spec built without it has mount objects byte-identical
	// to every one built before this feature existed. PRIVATE, never shared: each of these directories is made for this
	// one container, and the shared form (`:z`) would leave it readable by every other container on the host, which is
	// the job-to-job reach the per-job directory exists to deny.
	const own = relabel ? { relabel: "private" } : {};
	const mounts = [];
	// The WHOLE /job dir is read-only (INT-CONTAINER-JOB-INPUTS): it holds prompt.md and pi/, and
	// the agent cannot rewrite any of it. /workspace is the only writable mount.
	if (jobDir) mounts.push({ host: jobDir, container: "/job", readOnly: true, ...own });
	// A local job's /workspace IS the operator's folder, and `:Z` would re-own it for this one container: measured, a
	// second container mounting it afterwards is denied, and the label an operator chose is gone. So only a workspace the
	// worker made is relabelled; an operator's folder needs the `semanage fcontext` fix doctor names, and the runner
	// refuses one it cannot read before any spend.
	mounts.push({ host: workspace, container: "/workspace", readOnly: false, ...(workspaceOwned ? own : {}) });
	// Local jobs get a writable /outbox host bind, the same host-bind mechanism as /workspace
	// (DES-WORKER-ON-HOST). github jobs pass no outboxDir, so the request channel does not exist for
	// them -- an untrusted issue author cannot chain (INT-OUTBOX-CONTRACT).
	if (outboxDir) mounts.push({ host: outboxDir, container: "/outbox", readOnly: false, ...own });

	// This job's OWN copy of its session transcript (REQ-RESUMABLE-SESSION, INT-SESSION-STORE-CONTRACT).
	// Writable, because pi appends to it as the agent works -- and per-job, exactly like jobDir, which is
	// the whole reason CONST-ISOLATION-CONTAINER-PER-JOB's "none host-wide" clause still reads true. The
	// shared store under PI_SESSIONS_DIR is NEVER bind-mounted: one job here would otherwise be able to
	// read and rewrite every other branch's and every other repository's transcripts, which is not a
	// weakening of that constraint but its inversion. Absent unless the trigger armed run.resume AND a key
	// resolved, so an unarmed job's argv is byte-identical to one built before this feature existed.
	if (sessionDir) mounts.push({ host: sessionDir, container: CONTAINER_SESSION_DIR, readOnly: false, ...own });

	// The operator's global pi overlay (REQ-GLOBAL-PI-OVERLAY): custom models, global skills, a global
	// persona, layered UNDER each repo's own .pi/. Read-only -- it is operator-authored deploy-time config,
	// the same trust class as the baked floor, but the agent still must not rewrite it. Both job kinds.
	// NEVER relabelled (issue #355): every job mounts this one directory, so a private label would lock each job out of
	// it in turn, and a shared one would re-own an operator's directory on every run. It needs the operator's
	// `semanage fcontext` fix, which doctor names.
	if (globalPiDir) mounts.push({ host: globalPiDir, container: CONTAINER_GLOBAL_PI_DIR, readOnly: true });

	return {
		image,
		name,
		memory,
		cpus,
		network,
		user,
		// Issue #354. Always present and `null` by default (the parameter default turns an `undefined` into it, so a spec
		// has ONE spelling of "the runtime's default"), beside `user` because it qualifies it: the same "<uid>:<gid>" names
		// a different host identity under a different mapping.
		userns,
		// Issue #345: where the runtime writes the container ID once it creates one, so a CLI that exits as if nothing
		// started (a lost API connection) can be told apart from a container that runs on without it. null = absent.
		cidFile,
		// UNCONDITIONALLY true, and there is deliberately no parameter that can unset it. The boundary is
		// not a thing a caller opts into -- CONST-ISOLATION-CONTAINER-PER-JOB is why every other flag here
		// exists -- so the spec is simply unable to describe an unisolated container, and the builder in
		// docker-run.mjs refuses one it is handed. A field that could be false would be a way to ask for less.
		isolated: true,
		mounts,
		env,
		dockerExtra: extraFlags,
	};
}

/**
 * The mounts of a spec, rendered as TRANSFERS for a runtime that cannot bind-mount (issue #227).
 *
 * A bind mount is not a file copy, and the whole value of this function is that it refuses to pretend
 * otherwise. `DES-JOB-FILES-VIA-VOLUME-SUBPATH` already recorded the specific loss: `docker cp` "cannot
 * give `/job` a kernel-enforced read-only mount, which `INT-CONTAINER-JOB-INPUTS` depends on" -- and every
 * vendor upload API is `docker cp`-shaped. So `binds` says which kind of runtime is asking: a binding one
 * gets `readOnlyEnforcedBy: "kernel"`, a copying one gets `"convention"`, and the second is a DECLARED
 * DOWNGRADE rather than a neutral translation. That word is what a conformance suite reads, and what stops
 * "we upload the files" being mistaken for "the agent cannot rewrite its own instructions".
 *
 * `0444` file modes are the second and weaker line, named here so nobody mistakes them for the first: they
 * bind an agent that respects them and nothing else, whereas the kernel binds one that does not.
 *
 * DIRECTION FOLLOWS WRITABILITY, not a list of paths. An earlier draft hardcoded `/workspace` as the only
 * mount coming back, and that was wrong in a way that would have been silent: `/outbox` and `/session` are
 * writable too, and the HOST reads both after the container exits -- `collectChain` reads `jobDir/outbox`
 * for the chain requests the agent wrote (`INT-OUTBOX-CONTRACT`), and `promoteSession` reads
 * `jobDir/session` for the transcript pi appended to (`REQ-RESUMABLE-SESSION`). An adapter that brought
 * back only `/workspace` would never enqueue a chained child and would cold-start every resume, both
 * reporting success. So a mount the container may write is a mount the host may need back, and the rule is
 * exactly that.
 *
 * THE NESTING IS MODELLED, because it is the trap. `session/` nests inside `jobDir` for every job kind, and
 * `workspace/` and `outbox/` nest for their own kinds, so an adapter that uploads each mount independently
 * produces a container where `/job/workspace` also exists with a stale copy of the tree -- path-equivalent
 * to nothing the local backend ever produces, and silently divergent rather than broken. `contains` names,
 * for each entry, the other container paths whose host path lies inside this one, so an adapter can exclude
 * them from the upload instead of discovering the overlap in review.
 *
 * @param binds  true when the runtime bind-mounts (the local backend); false when it copies.
 */
export function transfersFromSpec(spec, { binds = true } = {}) {
	const mounts = spec?.mounts ?? [];
	return mounts.map((m) => ({
		host: m.host,
		container: m.container,
		readOnly: m.readOnly === true,
		// The distinction this function exists for. A bind is enforced by the kernel; a copy is enforced by
		// whatever the agent chooses to respect, which is not enforcement. `null` where nothing is claimed.
		readOnlyEnforcedBy: m.readOnly === true ? (binds ? "kernel" : "convention") : null,
		// Writable means the container may change it, which means the host may need it back. See the header:
		// `/outbox` and `/session` are both read after the run, and hardcoding `/workspace` missed them.
		direction: m.readOnly === true ? "in" : "in-out",
		// Other mounts whose HOST path is nested inside this one, by container path. Uploading this entry
		// without excluding these duplicates their trees under it.
		contains: mounts.filter((o) => isInside(m.host, o.host)).map((o) => o.container),
	}));
}

/**
 * Is `inner` a host path strictly beneath `outer`?
 *
 * SEPARATOR-AGNOSTIC, because host paths are built with `path.join` (`join(jobDir, "workspace")`) and this
 * worker runs on Windows -- where those are backslash-separated while an earlier draft compared against a
 * hardcoded `/`. That draft reported NO nesting at all on Windows, which is precisely the platform where a
 * silently divergent upload would be hardest to spot. The container paths above are always `/`-built and
 * are not the ones compared here.
 *
 * A trailing separator on either side is ignored, and equality is not containment.
 */
function isInside(outer, inner) {
	const strip = (v) => String(v ?? "").replace(/[\\/]+$/, "");
	const a = strip(outer);
	const b = strip(inner);
	if (a === "" || a === b) return false;
	const next = b.charAt(a.length);
	return b.startsWith(a) && (next === "/" || next === "\\");
}

/**
 * What an adapter LOSES by copying instead of bind-mounting, as `[{ container, was, becomes }]`.
 *
 * Empty for a runtime that binds. Non-empty is not a failure: it is the list an adapter must declare, and
 * the reason `readOnlyJobInputs` is a property in the backend table at all rather than an assumption. An
 * adapter that returns entries here and still declares `readOnlyJobInputs: enforced` is making exactly the
 * claim `CONST-EGRESS-POLICY-IN-THE-ARGV` calls worse than no claim.
 *
 * `backend-conformance.mjs` is the consumer, and it is what makes this a control rather than a contract: a
 * backend declaring `binds: false` and `readOnlyJobInputs: enforced` FAILS on the strength of this list.
 * A backend that declares no `binds` at all makes the harness abstain rather than pass, because a bundle
 * that has not said how it moves files has not earned the word.
 */
export function copyDowngrades(spec) {
	const bound = transfersFromSpec(spec, { binds: true });
	const copied = transfersFromSpec(spec, { binds: false });
	return bound
		.map((b, i) => ({ container: b.container, was: b.readOnlyEnforcedBy, becomes: copied[i].readOnlyEnforcedBy }))
		.filter((d) => d.was !== null && d.was !== d.becomes);
}
