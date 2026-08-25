/**
 * INT-CONTAINER-RUNTIME-CONTRACT. Construct the `docker run` argv for one job container.
 *
 * Every flag here is the enforcement surface of CONST-ISOLATION-CONTAINER-PER-JOB -- pi has no
 * permission system, so the container is the only real control. The argv is built as an explicit
 * array (never a shell string): no interpolation, no injection, and the env allowlist is passed
 * with explicit `-e NAME` where the value is read from the argv env map, never `--env-file` and
 * never a host pass-through.
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
 * The session mount and the file inside it, exported together and used by both the argv builder here and
 * the env builder in env-allowlist.mjs. Two literals in two modules is how a mount and the variable
 * naming a path inside it drift apart with both suites green -- the runner would then look for a
 * transcript at a path nothing mounted, find none, and cold-start every job without saying so.
 *
 * Nothing key-derived crosses the boundary: the container always sees the same constant path, so no
 * repository name, no branch name and no host layout is legible from inside a job.
 */
export const CONTAINER_SESSION_DIR = "/session";
export const CONTAINER_SESSION_FILE = `${CONTAINER_SESSION_DIR}/current.jsonl`;

/** The fixed isolation flags. Not configurable -- these ARE the boundary. */
export const ISOLATION_FLAGS = [
	// The image must ALREADY be on this host. `docker run` defaults to --pull=missing, so an unknown name is
	// a registry FETCH: a typo in the operator's image config would otherwise pull and execute a stranger's
	// image under a name that looks like theirs. Every other flag here bounds what a chosen image may DO;
	// this one bounds which image is chosen at all, which is why it leads. The same make-it-unreachable move
	// PI_OFFLINE=1 makes one layer up, and it costs nothing the documented flow was using: the README's
	// install step is an explicit `docker pull && docker tag`, and `pi-job:latest` is a local-only tag with
	// no registry behind it. A readable diagnosis is the preflight's job (image-preflight.mjs); this is the
	// part that cannot be raced.
	"--pull=never",
	"--rm", // ephemeral: gone after the run
	"--init", // reap zombies (Chromium spawns many); node is PID 1 and does not reap
	"--cap-drop=ALL", // pi would otherwise inherit the launching user's capabilities
	"--security-opt",
	"no-new-privileges",
	"--pids-limit=512", // bound a fork bomb (UNVERIFIED figure; measured headroom ~4.5x, see spec)
	"--shm-size=1g", // Chromium OOMs on the default 64MB /dev/shm; NOT --ipc=host (shares host ns)
];

/**
 * Build the full `docker run` argv (excluding the leading "docker").
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
export function buildDockerRunArgs({
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

	// `--network` sits HERE, beside --memory and --cpus, and deliberately NOT inside ISOLATION_FLAGS.
	// That array is the LITERAL, value-free, unconditional set, and two separate places assert every member
	// of it reaches the sandbox argv *against the imported array, not a copy* (CONST-ISOLATION-CONTAINER-PER-JOB
	// and INT-SANDBOX-CONTRACT). A conditional member makes "every member" false on any deployment running
	// without an egress policy, so the assertion would have to be weakened to "every member except this one"
	// -- which does not weaken a constraint so much as retire the assertion that was enforcing it. There is
	// no literal to put there anyway: the name carries a job id.
	//
	// null => the flag is ABSENT, so a job argv without an egress policy is byte-identical to one built
	// before this feature existed. Same shape as the sessionDir/outboxDir/globalPiDir mounts below.
	const args = ["run", `--name=${name}`, ...ISOLATION_FLAGS, `--memory=${memory}`, `--cpus=${cpus}`];
	if (network) args.push(`--network=${network}`);
	args.push(...extraFlags);

	// Explicit env allowlist. Each entry is `-e NAME=VALUE`, built from the closed map -- so a
	// stray host variable cannot ride along (no bare `-e NAME` inheriting from the host, no
	// --env-file). Undefined values are skipped, never passed as an empty string.
	for (const [k, v] of Object.entries(env ?? {})) {
		if (v === undefined || v === null) continue;
		args.push("-e", `${k}=${v}`);
	}

	// The WHOLE /job dir is read-only (INT-CONTAINER-JOB-INPUTS): it holds prompt.md and pi/, and
	// the agent cannot rewrite any of it. /workspace is the only writable mount.
	if (jobDir) args.push("-v", `${jobDir}:/job:ro`);
	args.push("-v", `${workspace}:/workspace`);
	// Local jobs get a writable /outbox host bind, the same host-bind mechanism as /workspace
	// (DES-WORKER-ON-HOST). github jobs pass no outboxDir, so the request channel does not exist for
	// them -- an untrusted issue author cannot chain (INT-OUTBOX-CONTRACT).
	if (outboxDir) args.push("-v", `${outboxDir}:/outbox`);

	// This job's OWN copy of its session transcript (REQ-RESUMABLE-SESSION, INT-SESSION-STORE-CONTRACT).
	// Writable, because pi appends to it as the agent works -- and per-job, exactly like jobDir, which is
	// the whole reason CONST-ISOLATION-CONTAINER-PER-JOB's "none host-wide" clause still reads true. The
	// shared store under PI_SESSIONS_DIR is NEVER bind-mounted: one job here would otherwise be able to
	// read and rewrite every other branch's and every other repository's transcripts, which is not a
	// weakening of that constraint but its inversion. Absent unless the trigger armed run.resume AND a key
	// resolved, so an unarmed job's argv is byte-identical to one built before this feature existed.
	if (sessionDir) args.push("-v", `${sessionDir}:${CONTAINER_SESSION_DIR}`);

	// The operator's global pi overlay (REQ-GLOBAL-PI-OVERLAY): custom models, global skills, a global
	// persona, layered UNDER each repo's own .pi/. Read-only -- it is operator-authored deploy-time config,
	// the same trust class as the baked floor, but the agent still must not rewrite it. Both job kinds.
	if (globalPiDir) args.push("-v", `${globalPiDir}:${CONTAINER_GLOBAL_PI_DIR}:ro`);

	args.push(image);
	return args;
}
