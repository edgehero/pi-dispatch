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
import { isAbsolute, relative } from "node:path";
import { assertCidFile, assertJobUser, containerSpec } from "./container-spec.mjs";

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
 * HOW Docker spells it, and the local backend's translation step. Since issue #354 `podmanArgsFromSpec` below is the
 * second, and it shares this function's body rather than copying it.
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
 * and a release can add another way in. So it NARROWS the gap rather than closing it; since issue #341 the
 * allow-list below closes it, and the backend table's `isolation` and `ephemeral` words rest on both plus the
 * callers passing fixed literals.
 *
 * Without this the two standing assertions that "every member of ISOLATION_FLAGS reaches the argv" would
 * still pass on an argv with no boundary left, because membership is not effectiveness. Nothing passes any
 * of these today -- `sandbox.mjs` sends `-i -t --entrypoint bash` plus loopback-bound `-p` flags, all of
 * which stay allowed -- so this closes a hole rather than changing a behaviour, and it makes "the builder
 * CANNOT DECLINE the boundary" true of the whole argv instead of of one boolean field.
 *
 * `--user` and `-u` ARE here (issue #341), because the builder owns the job user now: `containerSpec`'s `user` field,
 * validated non-root and emitted before `dockerExtra`. A second `--user` in `dockerExtra` would win last and could
 * name uid 0, which is `nonRoot` gone. An earlier version of this comment called `--user` "a documented, tested
 * feature" and left it allowed; nothing documented it and nothing passed it, which is how every job on a native
 * Linux daemon whose worker uid is not 1001 came to run as a uid that cannot read its own inputs.
 *
 * ONE SHORT FLAG PER TOKEN, and that is a separate rule below the list: docker parses `-u0` as `-u 0`, `-iu0` as
 * `-i -u 0`, `-v/:/h` as a mount and `-m1g` as a memory bound, and a list compared on the text before `=` sees none
 * of those. A single-dash token longer than two characters is refused outright; every caller passes separate tokens.
 *
 * AND AN ALLOW-LIST CLOSES WHAT THE DENY-LIST ONLY NARROWED (issue #341, found by an adversarial pass): a bare
 * positional token or `--` becomes the IMAGE, with every `-e` and `-v` after it passed to that image as arguments;
 * `--annotation run.oci.keep_original_groups=1` keeps the worker's groups on Podman; `--uidmap`/`--gidmap` remap
 * the user on podman-docker; `--use-api-socket` mounts the daemon socket on a recent CLI. None was listed, and the
 * next release adds another. So after the refusals above, a token must be one of what the callers actually pass,
 * `DOCKER_EXTRA_ALLOWED`, or it is refused. The deny-list stays for its named reasons and its tests.
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
	// Issue #345: the run's cidfile is how a container that outlived its `docker run` is found; a second `--cidfile`
	// would win last and write the ID where the worker does not look.
	"--cidfile",
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
	// The job user is a spec field (issue #341). Here so a repeat cannot override it with uid 0.
	"--user",
	"-u",
];

/**
 * Everything a `dockerExtra` may say. Bare flags stand alone; a valued flag takes the NEXT token, and that token must
 * match its pattern: an entrypoint is a command name, never a flag, and a published port is bound to loopback
 * (`parsePublish` never builds anything else). The sandbox passes `-i -t --entrypoint bash -p 127.0.0.1:<h>:<c>`;
 * the live probes pass `-d --entrypoint sleep` and `-d`.
 */
export const DOCKER_EXTRA_ALLOWED = Object.freeze({
	bare: Object.freeze(["-i", "-t", "-d"]),
	valued: Object.freeze({ "--entrypoint": /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/, "-p": /^127\.0\.0\.1:\d{1,5}:\d{1,5}$/ }),
});

export function dockerArgsFromSpec(spec) {
	// Issue #354. REFUSED, never dropped: the docker CLI rejects `--userns=keep-id` client-side (exit 125, measured in
	// issue #345), and silently omitting it would run the job under the daemon's own mapping, where the "<uid>:<gid>"
	// the caller chose for bind-mount ownership names a different host identity. `undefined` is a hand-built spec that
	// predates the field, which asked for nothing.
	if (spec?.userns !== null && spec?.userns !== undefined) {
		throw new Error(`docker run: refusing a spec with userns ${JSON.stringify(spec.userns)}: the docker CLI has no --userns=keep-id, and only a podman venue builds one`);
	}
	return argsFromSpec(spec, { userns: null });
}

/**
 * HOW rootless Podman spells the same box (issue #354): `dockerArgsFromSpec`'s argv with `--userns=keep-id` immediately
 * after `--user=`, from ONE private builder, so the boundary flags, the `dockerExtra` allow-list and the mount rendering
 * cannot drift between the two runtimes. Podman accepts every other token here as docker does (`--pull=never`,
 * `--cidfile`, `-v host:ctr:ro,Z`: measured on 5.8.1).
 *
 * `keep-id` is REQUIRED, and so is a user. Without keep-id a rootless container's uid N is the host's subordinate uid, so
 * a job run as the worker's uid cannot read `/job`. With keep-id and NO `--user`, the container runs as the IMAGE's user
 * with the worker's gid only as a supplementary group, and `/job` is unreadable again (both measured on Fedora 44,
 * Podman 5.8.1). Either argv would start, spend its slot and fail inside the container, so both are refused here.
 */
export function podmanArgsFromSpec(spec) {
	if (spec?.userns !== "keep-id") {
		throw new Error(`podman run: refusing a spec whose userns is not "keep-id": ${JSON.stringify(spec?.userns ?? null)} (a rootless job without it cannot read its own mounts)`);
	}
	if (spec.user === null || spec.user === undefined) {
		throw new Error("podman run: refusing a keep-id spec with no job user: the image's own user would run with /job unreadable");
	}
	return argsFromSpec(spec, { userns: "keep-id" });
}

/**
 * The namespaces and inheritances a rootless Podman argv pins, because the account's own containers.conf can set every
 * container's defaults for them: `pidns`, `ipcns`, `utsns`, `cgroupns`, `env_host` and `http_proxy`. (dockerd's
 * daemon.json can default the cgroup and IPC modes too, and the docker argv pins neither: a gap older than this venue.) Measured on Podman 5.8.1 with a user containers.conf of `pidns = "host"` and `env_host = true`: an
 * unpinned job ran outside its own PID namespace and received the worker's environment (the provider key with it);
 * with these flags it got its own namespaces and nothing. `http_proxy` is on by default, which copies the worker's proxy
 * variables into every job. A job's network is pinned the same way where it has none of its own (`--network=private`,
 * Podman's word for the rootless default), or `netns = "host"` would put it on the host's. What cannot be pinned is
 * that network's OPTIONS: containers.conf `pasta_options` are appended to the command line's, so one that maps host
 * loopback reaches such a job (measured), a named residual (issue #428).
 */
export const PODMAN_PINNED_FLAGS = Object.freeze(["--pid=private", "--ipc=private", "--uts=private", "--cgroupns=private", "--env-host=false", "--http-proxy=false"]);

/**
 * The shared body of both builders. `userns` is the caller's, never the spec's: each public builder has already decided
 * what its runtime may say, and reading the spec here would let a docker argv carry a flag its CLI refuses.
 */
function argsFromSpec(spec, { userns }) {
	// The builder CANNOT DECLINE the boundary. `containerSpec` cannot produce anything but `true`, so this
	// only ever fires on a hand-built spec -- and a hand-built spec that forgot the field is exactly the
	// case that must fail loudly rather than quietly emit a container with no isolation flags at all.
	if (spec?.isolated !== true) throw new Error("docker run: refusing to build an argv for a spec that is not isolated");

	// Same refusal, one level down. `dockerExtra` is raw Docker flags by design, and it lands after the
	// boundary where a repeat supersedes it -- so the escape hatch is bounded by what it may not say.
	// Split on `=` so `--network=foo` is caught alongside `--network foo`.
	const extra = spec.dockerExtra ?? [];
	for (let i = 0; i < extra.length; i++) {
		const flag = extra[i];
		// REFUSED, not skipped. Skipping a non-string still PUSHED it into the argv below, so
		// `new String("--privileged")` and `{ toString: () => "--privileged" }` walked past the check and
		// then reached docker as the flag they stringify to.
		if (typeof flag !== "string") {
			throw new Error(`docker run: dockerExtra must contain only strings; got ${typeof flag}`);
		}
		if (DOCKER_EXTRA_FORBIDDEN.includes(flag.split("=", 1)[0])) {
			throw new Error(`docker run: refusing a dockerExtra flag that would supersede the isolation boundary: ${flag}`);
		}
		// Fused short flags (see the list's header). After the list check, so a listed flag keeps its own refusal.
		if (/^-[^-]/.test(flag) && flag.length > 2) {
			throw new Error(`docker run: refusing a dockerExtra flag that would supersede the isolation boundary: ${flag} (one short flag per token)`);
		}
		if (DOCKER_EXTRA_ALLOWED.bare.includes(flag)) continue;
		const valuePattern = Object.hasOwn(DOCKER_EXTRA_ALLOWED.valued, flag) ? DOCKER_EXTRA_ALLOWED.valued[flag] : null;
		if (valuePattern && typeof extra[i + 1] === "string" && valuePattern.test(extra[i + 1])) {
			i++;
			continue;
		}
		throw new Error(`docker run: refusing a dockerExtra token outside what the builder's callers pass (-i, -t, -d, --entrypoint <command>, -p 127.0.0.1:<host>:<container>): ${JSON.stringify(flag)}`);
	}
	// Re-checked here for a hand-built spec, the same reason `isolated` is.
	assertJobUser(spec.user);
	assertCidFile(spec.cidFile);

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
	else if (userns) args.push("--network=private");
	// null => ABSENT, so a job the image's own USER runs has an argv byte-identical to one built before issue #341.
	if (spec.user) args.push(`--user=${spec.user}`);
	// Issue #354: IMMEDIATELY after `--user=`, which it qualifies, and before `dockerExtra`, where `--userns` is refused.
	if (userns) args.push(`--userns=${userns}`, ...PODMAN_PINNED_FLAGS);
	// null => ABSENT, so every argv but a job's is byte-identical to one built before issue #345. BEFORE `dockerExtra`, and
	// `--cidfile` is refused there, so no later token can move where the ID lands and turn the detached check off.
	if (spec.cidFile) args.push(`--cidfile=${spec.cidFile}`);
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
	//
	// The option list after the container path is `ro`, `Z`, or `ro,Z` (issue #355): one list, comma-joined, which is
	// how both the docker CLI and Podman read it. `Z` only for a mount the spec marks `relabel: "private"`, so a spec
	// without that field renders exactly the strings it always did. Anything else in that field is refused rather than
	// dropped, because a mount that silently lost its label fails in the container with nothing pointing back here.
	for (const m of spec.mounts ?? []) {
		if (m.relabel !== undefined && m.relabel !== "private") throw new Error(`docker run: refusing a mount relabel other than "private": ${JSON.stringify(m.relabel)}`);
		const options = [...(m.readOnly ? ["ro"] : []), ...(m.relabel === "private" ? ["Z"] : [])];
		args.push("-v", `${m.host}:${m.container}${options.length > 0 ? `:${options.join(",")}` : ""}`);
	}

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

/**
 * The `podman run` argv (excluding the leading "podman"), issue #354. `userns` is not the caller's to choose: a podman
 * job runs keep-id or not at all (see `podmanArgsFromSpec`), so an opts bag carrying another value is overridden rather
 * than read. A null `user` is refused by the builder, before anything spawns.
 */
export function buildPodmanRunArgs(opts) {
	return podmanArgsFromSpec(containerSpec({ ...opts, userns: "keep-id" }));
}

/**
 * Whether `inner` is strictly inside `outer` (issue #355). The one containment rule that decides a workspace is the
 * worker's own and may carry a private SELinux label: the job path (run-container) and a reopened sandbox both ask it, here beside the builder that renders the label,
 * and it fails CLOSED, on an empty or non-string path, on `outer` itself and on anything that climbs out of it.
 */
export function insideDir(outer, inner) {
	if (typeof outer !== "string" || typeof inner !== "string" || outer === "" || inner === "") return false;
	const rel = relative(outer, inner);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
