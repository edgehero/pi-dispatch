/**
 * INT-CONTAINER-RUNTIME-CONTRACT. Construct the `docker run` argv for one job container.
 *
 * Every flag here is the enforcement surface of CONST-ISOLATION-CONTAINER-PER-JOB -- pi has no
 * permission system, so the container is the only real control. The argv is built as an explicit
 * array (never a shell string): no interpolation, no injection, and the env allowlist is passed
 * with an explicit `-e` per entry of the closed map, never `--env-file` and never a host pass-through.
 * Since issue #1114 a credential's entry is a bare `-e NAME` whose value the runtime client reads from
 * the environment the worker spawns it with (`jobEnvArgs`, `jobClientEnv`), so no credential value is on
 * the client's argv; every other entry stays `-e NAME=VALUE`.
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
import { SIZE_LABEL_CPU, SIZE_LABEL_MEM, assertCidFile, assertJobUser, containerSpec } from "./container-spec.mjs";
import { LAYOUTS } from "./job-layout.mjs";
import { CGROUP_PARENT, CPU_SHARES_MAX, CPU_SHARES_MIN } from "./job-size.mjs";
import { EGRESS_ENV_KEYS, isNonSecretEnvKey } from "./redact-secrets.mjs";

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
	"--pids-limit=512", // bound a fork bomb (UNVERIFIED figure; measured headroom ~4.5x, see spec). FIXED, never per size
	// `--shm-size` LEFT this array in issue #596: it is now min(1g, memory/2) of the job's size, a value, and this array
	// is the literal, value-free set (see `--network` in `argsFromSpec`). It is emitted beside `--memory` instead, still
	// on every argv, and still NOT `--ipc=host` (Chromium OOMs on the default 64MB /dev/shm; host IPC shares the host ns).
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
	// Each of the six logical flags in ISOLATION_FLAGS, `--shm-size` (in that array until issue #596 made it a size),
	// and the argv member beside them that the worker's own machinery reads back. A flag missing from here is a flag the
	// array cannot defend.
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
	// The job's size (issue #596). Every flag that sets a CPU or memory bound, a weight or an OOM preference: a repeat
	// would win last and give one job another job's promise. `-c` is `--cpu-shares`' short form.
	"--cpu-shares",
	"-c",
	"--cpu-quota",
	"--cpu-period",
	"--cpu-rt-period",
	"--cpu-rt-runtime",
	"--cpuset-cpus",
	"--cpuset-mems",
	"--memory-reservation",
	"--memory-swappiness",
	"--kernel-memory",
	"--blkio-weight",
	"--blkio-weight-device",
	"--device-read-bps",
	"--device-write-bps",
	"--device-read-iops",
	"--device-write-iops",
	"--oom-score-adj",
	// Issue #596, phase 2: the size labels doctor holds the host budget against; a second `--label` would win last and
	// make a container read as another size.
	"--label",
	"-l",
	"--label-file",
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
	// Issue #596, phase 2: the parent every job shares, whose quota keeps the host's CPU reserve across all jobs. A second
	// `--cgroup-parent` would win last and run the job outside it, beyond the quota and back beside the proxy's weight.
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
	// Issue #683: the builder pins the working directory (see `--workdir=` in `argsFromSpec`). A repeat would start the
	// job outside its workspace, where a relative path the agent writes lands in the image's own tree.
	"--workdir",
	"-w",
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
 * container's defaults for them: `pidns` (PID), `ipcns` (IPC), `utsns` (UTS), `cgroupns` (cgroup), `env_host` and `http_proxy`. (dockerd's
 * daemon.json can default the cgroup and IPC modes too, and the docker argv pins neither: a gap older than this venue.) Measured on Podman 5.8.1 with a user containers.conf of `pidns = "host"` and `env_host = true`: an
 * unpinned job ran outside its own PID namespace and received the worker's environment (the provider key with it);
 * with these flags it got its own namespaces and nothing. `http_proxy` is on by default, which copies the worker's proxy
 * variables into every job. A job's network is pinned the same way where it has none of its own (`--network=private`,
 * Podman's word for the rootless default), or `netns = "host"` would put it on the host's. What cannot be pinned is
 * that network's OPTIONS: containers.conf `pasta_options` come before the command line's in pasta's argv, and a conf
 * `-T <port>` survives even `--network=pasta:--map-host-loopback,none` (measured), so no flag here could close it. It is
 * REFUSED instead, not left open: the venue refuses to run while the account's containers.conf sets `pasta_options`, `network_cmd_options`, `annotations`, `env`, `helper_binaries_dir`, `network_cmd_path`, `default_sysctls`, `default_ulimits`, `seccomp_profile`, `init_path`, `dns_servers`, `dns_options`, `dns_searches`, `base_hosts_file`, `oom_score_adj`, `privileged`, `label`, `cgroup_conf`, `host_containers_internal_ip`, `runtimes`, `conmon_path`, `cgroups` or `umask` at all, the list
 * `PODMAN_WIDENING_KEYS` in backends.mjs (`podmanConfWidening` in backend-podman.mjs, issues #428 and #450).
 */
export const PODMAN_PINNED_FLAGS = Object.freeze(["--pid=private", "--ipc=private", "--uts=private", "--cgroupns=private", "--env-host=false", "--http-proxy=false"]);

/**
 * Issue #1114: the names the runtime client ITSELF acts on, which never go bare. A bare `-e NAME` puts the job's value
 * in the docker or podman CLI's own environment, where the CLI, the children it starts (conmon, a wrapper script, a
 * credential helper) and the host's loader and shell read it before any container exists: a job's `DOCKER_HOST` would
 * pick the daemon, its `LD_PRELOAD` would load into the CLI, its `HTTPS_PROXY` would carry the CLI's own requests. So a
 * name here stays `-e NAME=VALUE`, and the client's environment keeps the worker's own value for it. That is also what
 * keeps the venue's endpoint observation true of the job's client (backends.mjs, "WHAT THE OBSERVATION CANNOT SEE"):
 * the observation runs under the worker's environment, and no `DOCKER_*`, `CONTAINER_*` or `CONTAINERS_*` name of a job
 * can change the client's.
 *
 * Matched WITHOUT REGARD TO CASE (`isClientEnvGuarded`): Windows is a supported host, its environment ignores case, and
 * a trigger may name a lower-case variable. `names` are whole names, `prefixes` cover a family. A BACKSTOP, not a
 * complete list: a CLI release can read a new variable. A credential whose name is here stays on the argv, and the job's
 * log line (`secret_env_on_argv`) and doctor name it.
 */
export const CLIENT_ENV_GUARD = Object.freeze({
	names: Object.freeze([
		// The process's identity and the paths every program resolves through.
		"HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
		// The proxy family Go's HTTP client (both CLIs) and curl read; REQUEST_METHOD turns Go's HTTP_PROXY off.
		"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "FTP_PROXY", "GRPC_PROXY", "REQUEST_METHOD",
		// Session plumbing and TLS trust.
		"DISPLAY", "SSL_CERT_FILE", "SSL_CERT_DIR", "DBUS_SESSION_BUS_ADDRESS", "NOTIFY_SOCKET",
		// Podman's storage and registry login.
		"STORAGE_DRIVER", "STORAGE_OPTS", "REGISTRY_AUTH_FILE",
		// What a shell reads at start, for a client that is a wrapper script (podman-docker's `docker`).
		"BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS", "IFS", "PS4", "CDPATH",
		// The Go runtime's own variables, read by both CLIs before main.
		"GODEBUG", "GOGC", "GOMAXPROCS", "GOMEMLIMIT", "GOTRACEBACK", "GORACE", "GOCOVERDIR",
		// Windows' system variables, which the CLI and its networking resolve through.
		"SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
		"PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMMONPROGRAMW6432",
		"ALLUSERSPROFILE", "PUBLIC", "HOMEDRIVE", "HOMEPATH", "USERNAME", "USERDOMAIN", "COMPUTERNAME", "OS",
		"PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "PSMODULEPATH", "DRIVERDATA",
	]),
	prefixes: Object.freeze(["DOCKER_", "CONTAINER_", "CONTAINERS_", "_CONTAINERS_", "PODMAN_", "XDG_", "SSH_", "LD_", "DYLD_", "BASH_FUNC_", "LISTEN_", "OTEL_"]),
});

/** Whether the runtime client acts on `name` itself (`CLIENT_ENV_GUARD`), compared upper-case. */
export function isClientEnvGuarded(name) {
	const upper = String(name).toUpperCase();
	return CLIENT_ENV_GUARD.names.includes(upper) || CLIENT_ENV_GUARD.prefixes.some((prefix) => upper.startsWith(prefix));
}

/**
 * A name that may go bare (issue #1114): one a shell can spell. Podman reads a bare `-e NAME*` as a glob over its own
 * environment, and a `=` would split where the CLI splits, so anything else stays `-e NAME=VALUE`. `ENV_NAME` in
 * triggers.mjs is the same pattern for `run.secrets` and bundles; `PI_FORWARD_ENV` names are not held to it, so a
 * forwarded name outside it is kept on the argv and said rather than refused.
 */
export const BARE_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The sandbox's terminal pair (sandbox.mjs): never a credential, and not in `NON_SECRET_ENV_KEYS`. */
const TERMINAL_ENV_NAMES = Object.freeze(["TERM", "TMOUT"]);

/**
 * THE ONE DECISION between `-e NAME=VALUE` and a bare `-e NAME` (issue #1114), for every entry of a container's closed
 * env map. `argsFromSpec` emits `args`; `jobClientEnv` puts `bare` in the client's environment; the pre-spawn check
 * (`assertJobEnvArgv`) and the tests read the same answer, so no two of them can disagree about a name.
 *
 * openshell's rule (`openshellExecArgs`) plus a guard. A name STAYS INLINE when it carries no secret (`isNonSecretEnvKey`,
 * redact-secrets.mjs), is one of the egress variables (`EGRESS_ENV_KEYS`), is `TERM` or `TMOUT`, has the empty value
 * (Windows cannot hold an empty variable, and it carries nothing), is a name the client acts on (`CLIENT_ENV_GUARD`),
 * is not a name a shell can spell (`BARE_ENV_NAME`), or matches another key of the same map without regard to case and
 * is not the one spelling of that group written entirely in upper case. EVERY OTHER NAME GOES BARE, an inverted rule
 * like the redactor's: a variable added to the container env later is kept off the argv until someone lists it as
 * structural.
 *
 * THE CASE TWINS. A Windows environment holds one of two keys that differ only by case, so two bare names of one fold
 * would leave the client one value for both. Yet keeping the whole group inline would let an operator's `github_token`
 * (a run secret or a forwarded name, which the loaders accept) put the minted `GITHUB_TOKEN` back on the argv. So the
 * upper-case spelling goes bare, as it would alone, and every other spelling stays `-e NAME=VALUE` and is `kept`: the
 * client's environment still holds exactly one key per folded name. Every name the worker writes itself (the minted
 * token's, the provider credential's, the structural ones) is upper case, so none of them is ever pushed onto the argv
 * by an operator's twin.
 *
 * `kept` names the entries that are secret by that rule and stayed inline anyway (the guard, the pattern, a case twin,
 * or an egress variable whose value is not the one the worker wrote for this job: `workerSet`, `secretValuesOf`'s
 * meaning), which the job's log line says, by name only. `workerSet` moves nothing on the argv.
 */
export function jobEnvArgs(env, { workerSet = {} } = {}) {
	const entries = Object.entries(env ?? {}).filter(([, v]) => v !== undefined && v !== null);
	const folded = new Map();
	for (const [name] of entries) folded.set(name.toUpperCase(), (folded.get(name.toUpperCase()) ?? 0) + 1);
	const args = [];
	const bare = [];
	const kept = [];
	for (const [name, raw] of entries) {
		const value = `${raw}`;
		const workerWrote = EGRESS_ENV_KEYS.includes(name) && Object.hasOwn(workerSet ?? {}, name) && workerSet[name] === value;
		if (isNonSecretEnvKey(name) || TERMINAL_ENV_NAMES.includes(name) || value === "" || workerWrote) {
			args.push("-e", `${name}=${value}`);
			continue;
		}
		if (EGRESS_ENV_KEYS.includes(name) || isClientEnvGuarded(name) || !BARE_ENV_NAME.test(name) || (folded.get(name.toUpperCase()) > 1 && name !== name.toUpperCase())) {
			args.push("-e", `${name}=${value}`);
			kept.push(name);
			continue;
		}
		args.push("-e", name);
		bare.push([name, value]);
	}
	// `fromEntries`, so a name like `__proto__` is an own key here rather than a prototype assignment that drops it.
	return { args, bare: Object.fromEntries(bare), kept };
}

/**
 * The runtime client's spawn environment for a job (issue #1114): the host's (`hostEnv`, by default this process's own,
 * which the client inherited whole before this), WITHOUT every host key whose upper-case form is a bare name's, PLUS the job's
 * value for each bare name. So the client sees what it always saw, and no host value can fill a bare name on any
 * platform: on Windows node keeps one of two keys that differ only by case and the docker CLI's lookup ignores case,
 * so a host `github_token` beside the job's `GITHUB_TOKEN` must go too. A guarded name is never bare, so the client's
 * `DOCKER_HOST`, `CONTAINER_HOST` and the rest are always the worker's.
 */
export function jobClientEnv(env, hostEnv = process.env) {
	const { bare } = jobEnvArgs(env);
	const names = new Set(Object.keys(bare).map((name) => name.toUpperCase()));
	return Object.fromEntries([...Object.entries(hostEnv ?? {}).filter(([key]) => !names.has(key.toUpperCase())), ...Object.entries(bare)]);
}

/**
 * The pre-spawn check (issue #1114), on the argv a venue's builder returned and the environment the client is about to
 * get: the argv's env flags must be EXACTLY `jobEnvArgs(env).args`, in order, and each bare name's value must be this
 * job's in `clientEnv`. So it refuses, by throwing, a credential's value on the argv, a credential dropped from it, an
 * entry the map does not hold, a wrong value, a flag the CLI reads as an env entry in a fused form (`-eNAME`, `-e=NAME`),
 * and a `-e` or `--env` with nothing after it but the image. It reads every token but the last, which is the image a job
 * argv ends with (a probe's own `-e` after its image is never handed to this check). It checks env flags only: a value
 * the builder put in another flag (a `--label=`) is a builder defect it does not look for. Names only in the message,
 * never a value.
 */
export function assertJobEnvArgv(args, env, clientEnv) {
	const expected = jobEnvArgs(env);
	const head = args.slice(0, -1);
	const entries = [];
	const nameOf = (entry) => (entry.includes("=") ? entry.slice(0, entry.indexOf("=")) : entry);
	const shown = (entry) => (entry === undefined ? "nothing" : entry.includes("=") ? `${nameOf(entry)} with a value` : `a bare ${entry}`);
	for (let i = 0; i < head.length; i++) {
		const token = head[i];
		if (token === "-e" || token === "--env") {
			if (i + 1 >= head.length) throw new Error(`docker run: refusing an argv whose last ${token} has no entry before the image (issue #1114)`);
			entries.push(String(head[++i]));
		} else if (typeof token === "string" && token.startsWith("--env=")) {
			entries.push(token.slice("--env=".length));
		} else if (typeof token === "string" && /^-e./.test(token)) {
			throw new Error(`docker run: refusing a fused env flag for ${nameOf(token.slice(2).replace(/^=/, ""))}: the CLI reads it as an env entry, and the builder passes -e and the entry as two tokens (issue #1114)`);
		}
	}
	const want = expected.args.filter((_, i) => i % 2 === 1);
	for (let k = 0; k < Math.max(entries.length, want.length); k++) {
		if (entries[k] === want[k]) continue;
		const got = entries[k];
		if (got !== undefined && got.includes("=") && Object.hasOwn(expected.bare, nameOf(got))) throw new Error(`docker run: refusing an argv that carries the value of ${nameOf(got)}, which travels as a bare -e ${nameOf(got)} (issue #1114)`);
		if (got !== undefined && !got.includes("=") && !Object.hasOwn(expected.bare, got)) throw new Error(`docker run: refusing a bare -e ${got} whose value is not this job's in the client's environment (issue #1114)`);
		if (got !== undefined && want[k] !== undefined && got.includes("=") && want[k].includes("=") && nameOf(got) === nameOf(want[k])) throw new Error(`docker run: refusing an argv whose env flags are not this job's: entry ${k + 1} gives ${nameOf(got)} a value other than the job's (issue #1114)`);
		throw new Error(`docker run: refusing an argv whose env flags are not this job's: entry ${k + 1} is ${shown(got)} where ${shown(want[k])} was due (issue #1114)`);
	}
	for (const [name, value] of Object.entries(expected.bare)) {
		if (clientEnv?.[name] !== value) throw new Error(`docker run: refusing a bare -e ${name} whose value is not this job's in the client's environment (issue #1114)`);
	}
}

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
	assertSizing(spec);
	// A hand-built spec may only name the one parent, or none (`undefined` is a spec from before the field: none).
	if (spec.cgroupParent !== undefined && spec.cgroupParent !== null && spec.cgroupParent !== CGROUP_PARENT) {
		throw new Error(`docker run: refusing a spec whose cgroup parent is not ${CGROUP_PARENT}: ${JSON.stringify(spec.cgroupParent)}`);
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
	// Issue #596: the job's size. `--memory-swap` equal to `--memory`, so no swap beyond it; `--cpus` the host ceiling,
	// absent when the runtime's CPU count is unknown (`hostCpuCeiling` says why that fails open); `--cpu-shares` the job's
	// weight; `--shm-size` min(1g, memory/2).
	const args = ["run", `--name=${spec.name}`, ...ISOLATION_FLAGS, `--memory=${spec.memory}`, `--memory-swap=${spec.memorySwap}`];
	if (spec.cpus !== null) args.push(`--cpus=${spec.cpus}`);
	args.push(`--cpu-shares=${spec.cpuShares}`, `--shm-size=${spec.shmSize}`);
	// THE AGGREGATE CPU RESERVE (issue #596, phase 2). `--cpus` above bounds ONE job; what keeps the host's reserve free
	// across ALL of them is the one parent cgroup every job container is started under, whose quota is the host's CPU
	// budget (`cpu-reserve.mjs` says who sets it per venue). Emitted on every container this builder makes, docker and
	// podman alike, quota or not: inside the parent a job's weight competes only with sibling jobs, so even an unset
	// quota keeps a large job from starving the egress proxy and Valkey, which are NOT built here and never carry it.
	// A missing parent is created silently by the runtime, so the flag never fails a run (measured on all five venues).
	// Absent only where the runtime cannot take one (`cgroupParentFor`), and then the spec's shares are capped instead.
	// `--cgroup-parent` is refused in `dockerExtra`, in both spellings, so nothing else can move a job out of it.
	if (spec.cgroupParent !== null && spec.cgroupParent !== undefined) args.push(`--cgroup-parent=${spec.cgroupParent}`);
	// Issue #596, phase 2: the size labels (`SIZE_LABEL_MEM`, `SIZE_LABEL_CPU`), integers from the validated size.
	for (const [key, value] of Object.entries(spec.labels ?? {})) args.push(`--label=${key}=${value}`);
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

	// Explicit env allowlist, built from the closed map and nothing else (no --env-file). Issue #1114: a credential is
	// a bare `-e NAME`, its value in the client's spawn environment (`jobClientEnv`), which holds no host value under a
	// bare name; everything else is `-e NAME=VALUE` as before. `jobEnvArgs` decides which, for the argv here, the spawn
	// env and the pre-spawn check alike. Undefined values are skipped, never passed as an empty string.
	args.push(...jobEnvArgs(spec.env).args);

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

	// Issue #683: the job starts in its workspace mount because the ARGV says so, not because the image's WORKDIR
	// happens to match. The shipped image's WORKDIR is now /sandbox (a copying venue's writable tree, image/Dockerfile),
	// so without this a binding venue's job would start in an empty /sandbox and every relative path the agent writes
	// would land outside the repository it was asked to change. A binding venue always uses the `mounts` layout. An
	// older image, whose WORKDIR was /workspace, starts exactly where it did.
	args.push(`--workdir=${LAYOUTS.mounts.workspace}`);
	args.push(spec.image);
	return args;
}

/**
 * The size fields of a spec, re-checked for a hand-built one (issue #596): `memory` and `shmSize` in the spelling
 * `formatMemory` writes, `memorySwap` EQUAL to `memory` (a spec that allows swap is refused, never repaired), `cpus` a
 * positive number of CPUs with at most two decimals (a CPU budget may be fractional, issue #596 phase 2) or null,
 * `cpuShares` an integer in the runtime's range, and `labels` absent or exactly the two size labels with integer values.
 * A spec from before these fields is refused rather than given `--memory-swap=undefined`.
 */
function labelsOk(labels) {
	if (labels === undefined) return true;
	if (labels === null || typeof labels !== "object") return false;
	const keys = Object.keys(labels);
	return keys.length === 2 && keys.includes(SIZE_LABEL_MEM) && keys.includes(SIZE_LABEL_CPU) && keys.every((k) => typeof labels[k] === "string" && /^[1-9]\d{0,8}$/.test(labels[k]));
}

function assertSizing(spec) {
	const memoryish = (v) => typeof v === "string" && /^[1-9]\d{0,6}[mg]$/.test(v);
	const ok = memoryish(spec.memory)
		&& spec.memorySwap === spec.memory
		&& memoryish(spec.shmSize)
		&& (spec.cpus === null || (typeof spec.cpus === "string" && /^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(spec.cpus) && Number(spec.cpus) > 0))
		&& labelsOk(spec.labels)
		&& Number.isSafeInteger(spec.cpuShares) && spec.cpuShares >= CPU_SHARES_MIN && spec.cpuShares <= CPU_SHARES_MAX;
	if (!ok) throw new Error(`docker run: refusing a spec whose size fields are not containerSpec's (memory, memorySwap equal to it, cpus, cpuShares, shmSize): ${JSON.stringify({ memory: spec.memory ?? null, memorySwap: spec.memorySwap ?? null, cpus: spec.cpus ?? null, cpuShares: spec.cpuShares ?? null, shmSize: spec.shmSize ?? null })}`);
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
