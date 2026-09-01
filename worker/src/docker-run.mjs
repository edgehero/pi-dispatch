/**
 * INT-CONTAINER-RUNTIME-CONTRACT. Construct the `docker run` argv for one job container.
 *
 * Every flag here is the enforcement surface of CONST-ISOLATION-CONTAINER-PER-JOB -- pi has no
 * permission system, so the container is the only real control. The argv is built as an explicit
 * array (never a shell string): no interpolation, no injection, and the env allowlist is passed
 * with explicit `-e NAME` where the value is read from the argv env map, never `--env-file` and
 * never a host pass-through.
 *
 * HOW Docker spells a container. WHAT a container IS moved to `container-spec.mjs` (issue #227), which is
 * the move #261 deferred to "the PR that adds a second consumer" -- the backend seam is that consumer, since
 * a backend that is not the local Docker daemon consumes a spec and never produces an argv. The constants
 * and `containerSpec` are RE-EXPORTED below, so every existing import of this module still resolves and
 * every assertion in the suite is untouched. This file is now the LOCAL backend's half of that contract.
 */

// The portable half. Re-exported rather than moved out of reach: `run-container.mjs` reads
// CONTAINER_SESSION_FILE beside `buildDockerRunArgs` and is Docker-bound anyway, and `containerSpec` is
// imported from this module by the suite. `CONST-EGRESS-POLICY-IN-THE-ARGV`'s Code evidence names
// `buildDockerRunArgs`, which never moved; the entry that names `containerSpec` is design.md's 2026-08-31
// row, and this move is recorded in its own row rather than by leaving that pointer to rot.
export { containerSpec, CONTAINER_GLOBAL_PI_DIR, CONTAINER_SESSION_DIR, CONTAINER_SESSION_FILE } from "./container-spec.mjs";
import { containerSpec } from "./container-spec.mjs";

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
 * HOW Docker spells it. The only consumer of a spec today, and the local backend's translation step:
 * a second backend implements this function's job against its own runtime and shares everything above it.
 */
/**
 * Flags a `dockerExtra` may not carry, because docker resolves a repeated option LAST-WINS and this array
 * is appended AFTER `ISOLATION_FLAGS`. `--privileged` supersedes `--cap-drop=ALL`; `--network` supersedes
 * the per-job one; `--pull` supersedes `--pull=never`; `--rm=false` supersedes `--rm` (verified against
 * docker 27.4.0, not assumed); a second `-v` adds a mount the spec never declared; a second `--name` wins
 * and leaves a container outside both reapers' filter and beyond `docker stop`.
 *
 * The list covers every member of `ISOLATION_FLAGS`, the container name, and the near-synonyms that reach
 * the same effect without repeating a listed flag (`--volumes-from` for a mount, `--memory-swap` for the
 * memory bound). It is a DENY-list and therefore only as good as its coverage: docker's surface is large
 * and a release can add another way in. So it NARROWS the gap rather than closing it, and the backend
 * table's `isolation` and `ephemeral` words rest on this plus the single production caller passing fixed
 * literals, never on this alone.
 *
 * Without this the two standing assertions that "every member of ISOLATION_FLAGS reaches the argv" would
 * still pass on an argv with no boundary left, because membership is not effectiveness. Nothing passes any
 * of these today -- `sandbox.mjs` sends `-i -t --entrypoint bash` plus loopback-bound `-p` flags, all of
 * which stay allowed -- so this closes a hole rather than changing a behaviour, and it makes "the builder
 * CANNOT DECLINE the boundary" true of the whole argv instead of of one boolean field.
 *
 * `--user` is DELIBERATELY NOT HERE, and it is the one that looks like it belongs. It is a documented,
 * tested feature -- the Linux-only `uid:gid` on a bind-mounted local folder, so files the agent writes into
 * an operator's own directory come back owned by the operator rather than by root. It also does not touch
 * this boundary: it changes which uid runs, not what that uid may do, and `--cap-drop=ALL` plus
 * `no-new-privileges` hold either way. What it does bear on is `nonRoot`, which the backend table already
 * declares `asserted` for the separate reason that the image's `USER pi` is what provides it. Denying it
 * here would break local-folder jobs to make a word honest that is already honest.
 */
export const DOCKER_EXTRA_FORBIDDEN = [
	// Each of the seven logical flags in ISOLATION_FLAGS, and the argv member beside them that the worker's
	// own machinery reads back. A flag missing from here is a flag the array cannot defend.
	"--rm", // `--rm=false` leaves the container behind; verified against docker 27.4.0. `ephemeral` rests on it.
	"--init",
	"--shm-size",
	// The container NAME is not an isolation flag and is the sharpest entry on this list: both boot reapers
	// match `pi-job-` as a substring and the abort path is `docker stop <name>`, so a second `--name` wins
	// last and leaves a container no sweep finds and no timeout can stop. `ephemeral` and `abortable` both
	// rest on it.
	"--name",
	"--privileged",
	"--cap-add",
	"--security-opt",
	"--pids-limit",
	"--memory",
	"-m",
	"--cpus",
	"--network",
	"--net",
	"--pull",
	// Add a mount, which is what `-v`/`--volume`/`--mount` are blocked for; `mountSet` rests on all five.
	"--volumes-from",
	"--tmpfs",
	// Relax the memory bound without repeating `--memory`.
	"--memory-swap",
	"--oom-kill-disable",
	// Widen what the process may do without repeating a flag already listed.
	"--ulimit",
	"--sysctl",
	"--group-add",
	"--cgroup-parent",
	"--device-cgroup-rule",
	"--gpus",
	"--runtime",
	"-v",
	"--volume",
	"--mount",
	"--device",
	"--pid",
	"--ipc",
	"--uts",
	"--userns",
	"--cgroupns",
];

export function dockerArgsFromSpec(spec) {
	// The builder CANNOT DECLINE the boundary. `containerSpec` cannot produce anything but `true`, so this
	// only ever fires on a hand-built spec -- and a hand-built spec that forgot the field is exactly the
	// case that must fail loudly rather than quietly emit a container with no isolation flags at all.
	if (spec?.isolated !== true) throw new Error("docker run: refusing to build an argv for a spec that is not isolated");

	// Same refusal, one level down. `dockerExtra` is raw Docker flags by design, and it lands after the
	// boundary where a repeat supersedes it -- so the escape hatch is bounded by what it may not say.
	// Split on `=` so `--network=foo` is caught alongside `--network foo`.
	for (const flag of spec.dockerExtra ?? []) {
		// REFUSED, not skipped. Skipping a non-string still PUSHED it into the argv below, so
		// `new String("--privileged")` and `{ toString: () => "--privileged" }` walked past the check and
		// then reached docker as the flag they stringify to.
		if (typeof flag !== "string") {
			throw new Error(`docker run: dockerExtra must contain only strings; got ${typeof flag}`);
		}
		if (DOCKER_EXTRA_FORBIDDEN.includes(flag.split("=", 1)[0])) {
			throw new Error(`docker run: refusing a dockerExtra flag that would supersede the isolation boundary: ${flag}`);
		}
	}

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
	const args = ["run", `--name=${spec.name}`, ...ISOLATION_FLAGS, `--memory=${spec.memory}`, `--cpus=${spec.cpus}`];
	if (spec.network) args.push(`--network=${spec.network}`);
	args.push(...(spec.dockerExtra ?? []));

	// Explicit env allowlist. Each entry is `-e NAME=VALUE`, built from the closed map -- so a
	// stray host variable cannot ride along (no bare `-e NAME` inheriting from the host, no
	// --env-file). Undefined values are skipped, never passed as an empty string.
	for (const [k, v] of Object.entries(spec.env ?? {})) {
		if (v === undefined || v === null) continue;
		args.push("-e", `${k}=${v}`);
	}

	// `-v` and its value stay TWO argv elements rather than one `--volume=` token. Not cosmetic: the mount
	// assertions across this suite extract mounts by adjacency (`args[i - 1] === "-v"`), so collapsing the
	// pair would make those filters return nothing and turn several exact-array checks vacuously green.
	for (const m of spec.mounts ?? []) args.push("-v", `${m.host}:${m.container}${m.readOnly ? ":ro" : ""}`);

	args.push(spec.image);
	return args;
}

/**
 * Build the full `docker run` argv (excluding the leading "docker").
 *
 * The public entry point, unchanged: same name, same parameters, same argv byte for byte. Kept as the
 * name rather than replaced by `dockerArgsFromSpec` because `CONST-EGRESS-POLICY-IN-THE-ARGV` cites this
 * symbol in its Code evidence, and because a rename would churn every call site and assertion for nothing.
 */
export function buildDockerRunArgs(opts) {
	return dockerArgsFromSpec(containerSpec(opts));
}
