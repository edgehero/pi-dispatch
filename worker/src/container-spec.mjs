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
 * `dockerExtra` is named for what it is. It carries raw Docker flags (`-i -t --entrypoint bash`, a
 * Linux-only `--user`), so it is the one field a non-Docker consumer must refuse rather than translate.
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
 * @param extraFlags escape hatch for a Linux-only --user uid:gid on a bind-mounted local folder
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
	extraFlags = [],
}) {
	if (!image) throw new Error("docker run: image is required");
	if (!name) throw new Error("docker run: container name is required");
	if (!workspace) throw new Error("docker run: workspace mount is required");

	const mounts = [];
	// The WHOLE /job dir is read-only (INT-CONTAINER-JOB-INPUTS): it holds prompt.md and pi/, and
	// the agent cannot rewrite any of it. /workspace is the only writable mount.
	if (jobDir) mounts.push({ host: jobDir, container: "/job", readOnly: true });
	mounts.push({ host: workspace, container: "/workspace", readOnly: false });
	// Local jobs get a writable /outbox host bind, the same host-bind mechanism as /workspace
	// (DES-WORKER-ON-HOST). github jobs pass no outboxDir, so the request channel does not exist for
	// them -- an untrusted issue author cannot chain (INT-OUTBOX-CONTRACT).
	if (outboxDir) mounts.push({ host: outboxDir, container: "/outbox", readOnly: false });

	// This job's OWN copy of its session transcript (REQ-RESUMABLE-SESSION, INT-SESSION-STORE-CONTRACT).
	// Writable, because pi appends to it as the agent works -- and per-job, exactly like jobDir, which is
	// the whole reason CONST-ISOLATION-CONTAINER-PER-JOB's "none host-wide" clause still reads true. The
	// shared store under PI_SESSIONS_DIR is NEVER bind-mounted: one job here would otherwise be able to
	// read and rewrite every other branch's and every other repository's transcripts, which is not a
	// weakening of that constraint but its inversion. Absent unless the trigger armed run.resume AND a key
	// resolved, so an unarmed job's argv is byte-identical to one built before this feature existed.
	if (sessionDir) mounts.push({ host: sessionDir, container: CONTAINER_SESSION_DIR, readOnly: false });

	// The operator's global pi overlay (REQ-GLOBAL-PI-OVERLAY): custom models, global skills, a global
	// persona, layered UNDER each repo's own .pi/. Read-only -- it is operator-authored deploy-time config,
	// the same trust class as the baked floor, but the agent still must not rewrite it. Both job kinds.
	if (globalPiDir) mounts.push({ host: globalPiDir, container: CONTAINER_GLOBAL_PI_DIR, readOnly: true });

	return {
		image,
		name,
		memory,
		cpus,
		network,
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
