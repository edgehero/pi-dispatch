import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isJobNamespace, jobContainerName, JOB_NAME_PREFIX, reaperExec } from "./backend-local.mjs";
import { FORGES } from "./forges.mjs";
import { NON_SECRET_ENV_KEYS } from "./redact-secrets.mjs";
import { BACKENDS, OPENSHELL_BACKEND, OPENSHELL_BIND_BACKEND, OPENSHELL_BIND_LINGERING } from "./backends.mjs";
import { containerSpec, SHIPPED_IMAGE_UID, SIZE_LABEL_CPU, SIZE_LABEL_MEM, transfersFromSpec } from "./container-spec.mjs";
import { makeImagePreflight, normalizeImageId, resolveJobImage } from "./image-preflight.mjs";
import { LAYOUTS } from "./job-layout.mjs";
import { DAEMON_FACTS_MAX_BUFFER, DAEMON_FACTS_TIMEOUT_MS } from "./daemon-facts.mjs";
import { JOB_USER_FACTS_MAX_AGE_MS, decideJobUser, makeDaemonFactsReader, relabelsPrivateMounts, resolveImageUser } from "./job-user.mjs";
import { networkPolicyFor } from "./openshell-policy.mjs";
import { bindProbeArgs, driverConfigFor, judgeBindAnswer, judgeGatewayStatus, OPENSHELL_TESTED_VERSION } from "./openshell-cli.mjs";
import { DEFAULT_JOB_SIZE } from "./job-size.mjs";
import { makeRunContainer } from "./run-container.mjs";

/**
 * The `openshell` venue (issue #683, `DES-OPENSHELL-VENUE`): one NVIDIA OpenShell sandbox per job, on a gateway this
 * deployment runs on its own host, driven through the real `openshell` CLI with `-o json` (`DES-WORKER-ON-HOST`'s
 * reasoning: the CLI owns its config and its endpoint, so the worker shells out rather than reimplementing either).
 *
 * THE SHAPE, and why it reuses `makeRunContainer` rather than copying it. Everything that makes a run trustworthy is
 * already there and venue-blind: the per-attempt exit key on stdin, the signed exit line read off the child's stdout,
 * the abort flag, the result's shape. What differs is what surrounds the child, so the venue hands three steps to it
 * (`stageRun`, `collectRun`, `teardownRun`) and an argv builder whose child is `openshell sandbox exec`:
 *   1. create the sandbox, sized and labelled, under a filesystem policy this worker generates, and READ IT BACK;
 *   2. upload the job's inputs under the image's WORKDIR (`/sandbox`, the `sandbox` layout, job-layout.mjs);
 *   3. exec the image's entrypoint through `/opt/pi-dispatch/pi-landlock`, which confines the runner's writes to the
 *      paths named here, AFTER the upload: the only way an uploaded `/job` is read-only on this venue (measured, see
 *      `DES-OPENSHELL-VENUE`'s #683 correction);
 *   4. download the writable outputs (workspace, session) back into the host paths the processor reads;
 *   5. delete the sandbox, on every path.
 *
 * Measured on OpenShell 0.1.4, Docker driver, ubuntu-24.04 (Linux 6.17), 2026-10-19 (the issue #683 lab).
 *
 * BLESSABLE SINCE ISSUE #684: the sandbox's network policy is generated per job (openshell-policy.mjs) and the job's
 * credentials live in a per-job provider, placeholders in the agent (`CONST-VENUE-EGRESS-LAYER`); only names the
 * redactor treats as not secret reach the exec's `--env`.
 *
 * THE LIVE TRANSCRIPT (issue #686): the session file is in the sandbox until the download, so no host tail can read it.
 * The runner mirrors its lines over the exec's STDERR as records signed with the exit key (transcript-mirror.mjs), and
 * makeRunContainer, told `transcript: "stdio"`, verifies them and feeds the same publisher (stderr-transcript.mjs), so
 * the live transcript, run progress and the status comment are served here.
 *
 * STEERING (issue #686, part 2): there is no `/inbox` mount a later file could reach, so a steer-armed job on an image
 * declaring `steerStdin` takes its messages as MAC'd frames on the exec's stdin, the key frame first
 * (INT-STEER-INBOX-CONTRACT's second transport): makeRunContainer, handed the relay opener and told this venue copies
 * (`binds: false`), writes them, and the acks come back over the stderr transcript above. An image without `steerStdin`
 * runs unsteered, `steerSkipped: "venue-copies"`. Recovery is not served here: `run.recover` is refused before spend.
 *
 * BIND MODE (issue #686 part 3, the `openshell-bind` venue): the same factory with `mode: "bind"`, rather than a second
 * adapter, because everything that makes the venue trustworthy is shared and must stay one copy: the image read by ID,
 * the per-job network policy and its read-back, the credential provider and its placeholders, the gateway checks, the
 * stop, the teardown, the reaper. What differs is exactly the transport of the job's files, and with it four answers:
 *   - no upload and no download: the container spec's mounts are handed to the compute driver as `--driver-config-json`
 *     binds (read-only unless the spec mounts them writable), at the `mounts` layout's own paths, which OpenShell admits
 *     (none is `/sandbox` or under its own trees);
 *   - the policy lists every bind target, read-only ones under `read_only` and writable ones under `read_write`
 *     (measured: the read-back is unchanged), and runs as the job user (`decideOpenshellBindUser`), since a bind is
 *     written as the sandbox's uid;
 *   - the runner reads the `mounts` layout, so `/inbox` file steering, the host tail of the session file and folder jobs
 *     work as on `local` (`binds: true`, `transcript: "file"`), and `run.recover` is served by the host workspace's
 *     salvage and exit snapshots (no pause verb: live checkpoints stay off);
 *   - no pi-landlock: `/job` is a read-only bind (measured: EROFS) and a `read_only` policy path (measured: denied), the
 *     kernel control `local`'s `:ro` is, so the helper would add nothing for it and would tie the venue to the
 *     `sandboxLayout` capability for no guarantee.
 * Bind mounts need the gateway's own settings (`OPENSHELL_BIND_SETTINGS`), which no read reveals, so the preflight asks a
 * create that can only be refused (`bindProbeArgs`) and caches the answer per gateway (`bindGate` below).
 */


/** The label every sandbox this worker makes carries, which `list` selects on: a name alone is a substring world. */
export const OPENSHELL_OWNER_LABEL = "pi.dispatch.owner";
export const OPENSHELL_OWNER = "pi-dispatch";
/**
 * The label a BIND-mode sandbox carries (issue #686 part 3), value `bind`, so each mode's listing, its gone-check and the
 * host budget's leftovers count only its own sandboxes. A copy-mode sandbox carries none, so its create is unchanged and
 * every sandbox made before bind mode existed reads as copy mode's. The boot sweep reaps both modes' (one owner label):
 * it runs before this process has started any job, and either mode's leftover from a crash is the same orphan.
 */
export const OPENSHELL_MODE_LABEL = "pi.dispatch.openshell-mode";
/** The two modes, `copy` the default (`DES-OPENSHELL-VENUE`). */
export const OPENSHELL_MODES = Object.freeze(["copy", "bind"]);
/** The marker beside a bind-mode job dir (`<jobDir>.openshell-bind`): a sandbox may write it (review round 2 of #714). */
export const OPENSHELL_BIND_MARKER = ".openshell-bind";
/** A bind-mode sandbox's job directory, by its name (`job-...`), so a salvage can end that sandbox first (#714). */
export const OPENSHELL_JOB_DIR_LABEL = "pi.dispatch.job-dir";

/** The entrypoint and the confinement it is started through, both baked into the job image (image/Dockerfile). */
export const OPENSHELL_ENTRYPOINT = "/entrypoint.sh";
export const PI_LANDLOCK = "/opt/pi-dispatch/pi-landlock";

// Re-exported: the adapter is where a reader looks for them, and doctor imports the leaf alone.
export { judgeGatewayStatus, OPENSHELL_TESTED_VERSION };

const SANDBOX = LAYOUTS.sandbox;

/**
 * A sandbox's name for a job's container name. OpenShell refuses a sandbox name longer than 19 characters (measured:
 * "name exceeds maximum length (34 > 19)"), and a job's container name is `pi-job-<the queue's job id>`, routinely
 * longer, so the sandbox is named by a hash of it: `pi-job-s` and 11 hex digits, 19 exactly, still inside the job
 * namespace every sweep matches. A name already of that shape is its own sandbox name, so what `list` returned (a
 * leftover the host budget seeded by its sandbox name) maps to itself, and every step, the stop and the gone-check
 * included, goes through this one function.
 */
export const SANDBOX_NAME = /^pi-job-s[0-9a-f]{11}$/;
export function sandboxNameOf(containerName) {
	if (SANDBOX_NAME.test(containerName)) return containerName;
	return `${JOB_NAME_PREFIX}s${createHash("sha256").update(String(containerName)).digest("hex").slice(0, 11)}`;
}

/**
 * The paths the runner's process tree may WRITE (pi-landlock's `--rw`): the job's workspace and session, the scratch
 * and home every tool writes, `/dev/null`, and `/proc`, where the in-image supervisor raises the runner tree's
 * `oom_score_adj` (measured: refused without it, so the supervisor would lose the OOM race it exists to win). Never
 * `/sandbox/job` or the overlay: that is the point.
 */
export const OPENSHELL_WRITABLE = Object.freeze([SANDBOX.workspace, SANDBOX.session, "/tmp", "/home/pi", "/dev/null", "/proc"]);

/**
 * The sandbox's filesystem policy, generated per job and read back before the exec (`CONST-VENUE-EGRESS-LAYER`'s second
 * condition). A policy with a `filesystem_policy` grants nothing it does not list (measured: `/opt` and `/sys/fs/cgroup`
 * were unreadable under the default one), so the image's own trees are listed read-only, the cgroup files the
 * supervisor reads at a kill among them, and the WORKDIR is writable through `include_workdir`. `hard_requirement`, so a
 * kernel that cannot apply it fails the create instead of running the job without it. Its `network_policies` are the
 * job's own (`networkPolicyFor`, issue #684), spread in beside it by the stage; none is deny-all. `run_as_user` is the image's own uid, so OpenShell's refusal of root and this
 * worker's non-root uid are the same fact.
 */
export function sandboxPolicy({ uid = SHIPPED_IMAGE_UID, gid = SHIPPED_IMAGE_UID, binds = [] } = {}) {
	// Issue #686 part 3: a bind-mode sandbox lists every bind target, each where its mount puts it (a policy path the
	// filesystem section does not list is unreadable, measured for `/opt`), after the base lists so copy mode's body is
	// byte-identical. `/opt/pi-global` is already beneath `/opt`; listed anyway, so the list says every bind.
	const ro = binds.filter((b) => b.readOnly === true).map((b) => b.target);
	const rw = binds.filter((b) => b.readOnly !== true).map((b) => b.target);
	return {
		version: 1,
		filesystem_policy: {
			include_workdir: true,
			read_only: ["/usr", "/lib", "/lib64", "/etc", "/bin", "/sbin", "/opt", "/app", "/ms-playwright", "/sys/fs/cgroup", "/dev/urandom", OPENSHELL_ENTRYPOINT, ...ro],
			read_write: ["/tmp", "/dev/null", "/home/pi", "/proc", ...rw],
		},
		landlock: { compatibility: "hard_requirement" },
		process: { run_as_user: String(uid), run_as_group: String(gid) },
	};
}

/** The image label naming the binaries that may need the network (image/Dockerfile, issue #683). */
export const NET_BINARIES_LABEL = "dev.pi-dispatch.net-binaries";

/**
 * The policy OpenShell reads back for one the worker wrote (issue #684, measured on OpenShell 0.1.4): with at least one
 * network rule it adds its baseline paths that exist and the policy does not list, and of those this policy lists all
 * but `/var/log` (read-only). Nothing else is added to the base. Provider rules arrive as their own `_provider_*` layers,
 * which issue #684 part 2 accounts for.
 */
export const BASELINE_ADDED_READ_ONLY = Object.freeze(["/var/log"]);
export function expectedPolicy(policy) {
	const rules = policy?.network_policies;
	if (!rules || Object.keys(rules).length === 0) return policy;
	const fsPolicy = policy.filesystem_policy;
	const listed = new Set([...(fsPolicy.read_only ?? []), ...(fsPolicy.read_write ?? [])]);
	const added = BASELINE_ADDED_READ_ONLY.filter((p) => !listed.has(p));
	return { ...policy, filesystem_policy: { ...fsPolicy, read_only: [...fsPolicy.read_only, ...added] } };
}
/**
 * The read-backs that count as the policy written: with the baseline addition, or without it, since OpenShell adds a
 * baseline path only where the image HAS it (an operator-built image without `/var/log` reads back as written).
 * Nothing else: any other difference never starts the job.
 */
export function expectedPolicies(policy, { provider = null } = {}) {
	const withBaseline = expectedPolicy(policy);
	const bodies = withBaseline === policy ? [policy] : [withBaseline, policy];
	if (provider === null) return bodies;
	// Issue #684: an attached provider adds one layer of its own to the full read-back (measured: a rule named
	// `_provider_<name, its dashes as underscores>` holding only its name, for an endpointless profile).
	const key = `_provider_${provider.replace(/-/g, "_")}`;
	return bodies.map((b) => ({ ...b, network_policies: { ...b.network_policies, [key]: { name: key } } }));
}

/** How often, and how far apart, a provider's delete is asked again while its sandbox's cleanup finishes. */
const PROVIDER_DELETE_TRIES = 10;
const PROVIDER_DELETE_WAIT_MS = 2_000;

/**
 * Rewrite a staged job's `mcp.json` for the `sandbox` layout (issue #684): every stdio server's `command` and `args`
 * that name the overlay at `/opt/pi-global/` are moved to `/sandbox/pi-global/`, where this venue uploads it. Nothing
 * else changes, and a job without the file is left alone. A document this cannot parse is left as written: the runner
 * refuses it before any spend (`mcp-config-invalid`), which is the honest answer, not a guess here.
 */
export function rewriteMcpForSandbox(path, fs) {
	let text;
	try {
		text = fs.readFileSync(path, "utf8");
	} catch {
		return false;
	}
	let doc;
	try {
		doc = JSON.parse(text);
	} catch {
		return false;
	}
	const from = `${LAYOUTS.mounts.global}/`;
	const to = `${LAYOUTS.sandbox.global}/`;
	// A path at the start of a value, or after `=` (`--root=/opt/pi-global/x`, `NODE_PATH=/opt/pi-global/lib`).
	const move = (v) => (typeof v === "string" ? v.replace(/(^|=)\/opt\/pi-global\//g, (_m, lead) => `${lead}${to}`) : v);
	if (from !== "/opt/pi-global/") throw new Error("rewriteMcpForSandbox: the mounts overlay moved; update the pattern");
	let changed = false;
	for (const server of Object.values(doc?.servers ?? {})) {
		if (!server || typeof server !== "object") continue;
		const before = JSON.stringify(server);
		server.command = move(server.command);
		if (Array.isArray(server.args)) server.args = server.args.map(move);
		if (server.env && typeof server.env === "object") for (const [k, v] of Object.entries(server.env)) server.env[k] = move(v);
		if (JSON.stringify(server) !== before) changed = true;
	}
	if (changed) {
		// The staged copy is 0444 as the preparer wrote it, so it is replaced rather than opened for writing.
		fs.rmSync(path, { force: true });
		fs.writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o444 });
	}
	return changed;
}

/**
 * The names of a job's env that carry a credential (issue #684): every key the redactor treats as secret
 * (`NON_SECRET_ENV_KEYS`, redact-secrets.mjs, is the one list of what is NOT), with a value. On this venue none of them
 * reaches the sandbox as a value: each goes into the job's provider, and the agent sees OpenShell's placeholder.
 */
export function secretNamesOf(env = {}) {
	return Object.entries(env ?? {})
		.filter(([key, value]) => !NON_SECRET_ENV_KEYS.has(key) && typeof value === "string" && value !== "" && PROVIDER_ENV_NAME.test(key))
		.map(([key]) => key);
}

/** What a provider credential's env var may be called: a shell name, 128 at most (the CLI reads `$NAME`). */
const PROVIDER_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * The secret names a provider cannot carry (issue #684, review): a `run.secrets` key or a `PI_FORWARD_ENV` name that is
 * no shell name, or longer than 128. Never a value on the exec's argv instead: such a name reaches the sandbox not at
 * all, and the stage logs it by name (`openshell_secret_unbindable`), so the job runs without it and says which.
 */
export function unbindableSecretNamesOf(env = {}) {
	return Object.entries(env ?? {})
		.filter(([key, value]) => !NON_SECRET_ENV_KEYS.has(key) && typeof value === "string" && value !== "" && !PROVIDER_ENV_NAME.test(key))
		.map(([key]) => key);
}

/**
 * The per-job endpointless provider profile (issue #684, measured on OpenShell 0.1.4): one credential per secret name,
 * no endpoints and no binaries of its own, so the credentials resolve only where the job's own policy binds them
 * (`credential_binding.provider`). Named by the sandbox, so the reaper finds a crashed job's.
 */
export function providerProfileFor(name, secretNames) {
	return {
		id: name,
		display_name: name,
		description: "pi-dispatch per-job credentials",
		category: "other",
		credentials: secretNames.map((env, i) => ({ name: `c${i}`, env_vars: [env], required: true })),
	};
}

/**
 * The git credential helper a forge job's exec gets on this venue (issue #684), as `GIT_CONFIG_COUNT`, `_KEY_0` and
 * `_VALUE_0`: it prints the forge token's PLACEHOLDER as the password, and OpenShell's supervisor rewrites it into the
 * real token in the Basic header (measured), at any host the policy admits, as every credential of the provider is bound
 * to every endpoint (squid's reach, not narrower). git sends a token only through a helper, and
 * the clone's remote is tokenless (prepare-github.mjs), so without it a push would never authenticate. Null for a job
 * whose forge token is not in its env.
 */
export function gitCredentialEnv(env = {}) {
	// The forge is the one whose token variable the env carries: the worker writes a minted token into its own forge's
	// names only (env-allowlist.mjs), so at most one forge matches.
	const kind = Object.keys(FORGES).find((k) => (FORGES[k].tokenVars ?? []).some((v) => typeof env[v] === "string" && env[v] !== ""));
	if (!kind) return null;
	const tokenVar = FORGES[kind].tokenVars.find((v) => typeof env[v] === "string" && env[v] !== "");
	const user = kind === "github" ? "x-access-token" : kind === "gitlab" ? "oauth2" : "pi-dispatch";
	return {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "credential.helper",
		GIT_CONFIG_VALUE_0: `!f() { test "$1" = get || exit 0; echo username=${user}; echo "password=$${tokenVar}"; }; f`,
	};
}

/**
 * The targets OpenShell refuses for a bind (measured on 0.1.4: `/sandbox` "is reserved for the OpenShell workspace", and
 * nothing may overlap its own trees). A `mounts`-layout path never is one; checked anyway, so a layout change is a
 * refusal at the stage, never a create the gateway refuses with words this adapter does not read.
 */
export const BIND_RESERVED_TARGETS = Object.freeze(["/sandbox", "/opt/openshell", "/etc/openshell", "/run/openshell"]);
const overlaps = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/**
 * A bind-mode job's binds (issue #686 part 3), from the container spec's mounts: each host path at its `mounts`-layout
 * target, read-only exactly where the spec mounts it read-only (`/job`, `/inbox`, the overlay), writable where it does
 * (`/workspace`, `/session`, `/outbox`). The same list `local` hands docker, so a job sees the same tree on both. THROWS
 * on a target OpenShell reserves (`BIND_RESERVED_TARGETS`) or a relative one.
 */
export function bindMountsOf(spec) {
	return (spec?.mounts ?? []).map((m) => {
		const target = String(m.container ?? "");
		if (!target.startsWith("/") || target === "/" || BIND_RESERVED_TARGETS.some((r) => overlaps(target, r))) throw new Error(`openshell: ${JSON.stringify(target)} is not a target OpenShell admits for a bind`);
		// Review round 1 (#714): the spec's private relabel (`:Z`) is the driver's `selinux_label: "private"` (upstream's
		// schema: "shared" for :z, "private" for :Z), never dropped. Only the worker's own per-job directories carry it.
		return { source: m.host, target, readOnly: m.readOnly === true, ...(m.relabel === "private" ? { selinuxLabel: "private" } : {}) };
	});
}

/**
 * Who a bind-mode job runs as (issue #686 part 3), by `local`'s job-user rule (issue #341, `decideJobUser` then
 * `resolveImageUser`) and for its reason: a bind is read and written as the sandbox's uid (measured: files owned by the
 * image's 1001), so on a host whose worker is another uid the sandbox could neither read the worker's 0700 job dir nor
 * leave files the worker can remove. OpenShell's policy sets the uid (`process.run_as_user`/`run_as_group`), so the job
 * runs as the worker's own `<euid>:<egid>` where that is not 1001, which the image must declare it can (`anyUid`).
 *
 * REVIEW ROUND 1 (#714): decided from the gateway's ENGINE as well as the ids, `daemon` being its `docker info` read
 * (`makeDaemonFactsReader`): a rootless or userns-remapped Docker behind the gateway maps every uid away from the
 * worker's, so no uid could read the job dir, and `local`'s rows refuse that before spend (`rootless`, `userns-remap`,
 * `desktop-linux-userns`, `job-user-unmappable`) rather than after it. The engine is on this host (the gateway is
 * observed local, and the bind sources are this host's paths), so its endpoint counts as local. darwin and win32 run
 * the image's own user (`desktop-platform`, a VM's file sharing maps ownership; UNMEASURED for OpenShell); a root worker
 * and a primary group of 0 are refused; an unanswered read is `unavailable`, retried. Returns `resolveImageUser`'s answer.
 * Measured: the Docker driver keeps uids across a bind (no user namespace), and `run_as_user` 2000 ran as uid 2000,
 * wrote a bind as 2000, and found the image's /home/pi 0777.
 */
export function decideOpenshellBindUser({ platform = process.platform, euid, egid, capabilities = [], daemon = null } = {}) {
	const decision = decideJobUser({ platform, euid, egid, endpoint: { local: true }, daemon: daemon ?? { answered: false, reason: "no-daemon-facts", transient: true } });
	// `socket: null`, deliberately (review round 2): `local`'s socket rows judge the DOCKER CLI's own unix socket, which
	// the worker never talks to on this venue (the gateway does), and `docker-group` refuses a job user whose primary
	// group is that socket's because `--user` would hand the container the docker group. Here the gid reaches only the
	// policy's `run_as_group`, inside a sandbox OpenShell builds without the socket, so that refusal has nothing to guard.
	// A rootless engine is still caught, by `docker info`'s own `name=rootless`, which the socket row only backs up.
	const chosen = resolveImageUser(decision, { capabilities, euid, egid });
	// The relabel rule is `local`'s too: true only for a Podman daemon reporting SELinux, which bind mode (Docker only)
	// never reads, so this stays false there; kept so the two cannot disagree.
	return chosen.user !== undefined && relabelsPrivateMounts(daemon?.answered ? daemon.facts : null, { local: true }, platform) ? { ...chosen, relabel: true } : chosen;
}

/** The policy's uid and gid for a job user (`"<uid>:<gid>"`, or null for the image's own). */
function policyIds(user) {
	const m = /^([1-9]\d{0,9}):([1-9]\d{0,9})$/.exec(String(user ?? ""));
	return m ? { uid: Number(m[1]), gid: Number(m[2]) } : { uid: SHIPPED_IMAGE_UID, gid: SHIPPED_IMAGE_UID };
}

/** The sandbox-layout path a `mounts`-layout container path is copied to, or null for one the layout does not name. */
export function sandboxPathOf(container) {
	const key = Object.keys(LAYOUTS.mounts).find((k) => LAYOUTS.mounts[k] === container);
	return key === undefined ? null : SANDBOX[key];
}

/** The CLI's global flags: the gateway, when the deployment names one, on every call so no step reaches another. */
function gatewayArgs(gateway) {
	return typeof gateway === "string" && gateway !== "" ? ["--gateway", gateway] : [];
}

/**
 * The exec argv (excluding the leading `openshell`): the job's env as `--env K=V`, the runner started in its workspace
 * through pi-landlock. `--timeout 0` because the worker owns the job's timeout (a gateway timeout exits 124, which no
 * classification here would read), `--no-tty` and `--no-login-shell` so the child is the command and nothing a login
 * profile adds. HOME is the image's home whoever the env says: OpenShell runs the image's own uid, and a tool's cache
 * must land there.
 */
export function openshellExecArgs({ name, env = {}, gateway = null, mode = "copy" }) {
	// Issue #684: no credential value on this argv, ever. ONLY the names the redactor treats as not secret
	// (`NON_SECRET_ENV_KEYS`) travel here, an allowlist rather than "every name but the provider's": a secret the provider
	// could not carry (a name no shell can spell) would otherwise fall through to this argv as a value (review H1). Every
	// other name is the provider's, its placeholder in the sandbox's env already; the git helper names the forge token's
	// placeholder, never its value.
	const envArgs = [];
	const carried = Object.fromEntries(Object.entries(env ?? {}).filter(([key]) => NON_SECRET_ENV_KEYS.has(key)));
	for (const [key, value] of Object.entries({ ...carried, ...(gitCredentialEnv(env) ?? {}), HOME: "/home/pi" })) {
		if (value === undefined || value === null) continue;
		envArgs.push("--env", `${key}=${value}`);
	}
	const head = [...gatewayArgs(gateway), "sandbox", "exec", "--name", name, "--no-login-shell", "--no-tty", "--timeout", "0"];
	// Issue #686 part 3: bind mode runs the entrypoint itself, in `/workspace`: `/job` is a read-only bind already.
	if (mode === "bind") return [...head, "--workdir", LAYOUTS.mounts.workspace, ...envArgs, "--", OPENSHELL_ENTRYPOINT];
	const rw = OPENSHELL_WRITABLE.flatMap((path) => ["--rw", path]);
	return [...head, "--workdir", SANDBOX.workspace, ...envArgs, "--", PI_LANDLOCK, ...rw, "--", OPENSHELL_ENTRYPOINT];
}

/** `--cpu` in the CLI's spelling (whole or fractional CPUs) and `--memory` in MiB, from the job's size. */
function sizeArgs(size) {
	const cpus = size.cpuCenti % 100 === 0 ? String(size.cpuCenti / 100) : (size.cpuCenti / 100).toFixed(2).replace(/0$/, "");
	return ["--cpu", cpus, "--memory", `${size.memMiB}Mi`];
}

/** JSON with every object's keys sorted, so a read-back that only reorders keys is not a difference. */
function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
	return value;
}

/** Parse a CLI answer as JSON, or throw a plain Error naming the step: the caller decides the class. */
function parseJson(stdout, step) {
	try {
		return JSON.parse(String(stdout ?? ""));
	} catch {
		throw new Error(`openshell ${step}: the answer was not JSON`);
	}
}

/**
 * Phases a sandbox holds nothing in (the host budget's "gone"): it ran and ended, or never could. `Deleting` is NOT
 * here: its containers may still be running down, so the budget keeps its hold until the gateway stops listing it.
 */
export const SANDBOX_GONE_PHASES = Object.freeze(new Set(["Stopped", "Completed", "Error"]));
/** Phases a sandbox has not started its workload in: deleted, then gone, as `created` is on docker. */
export const SANDBOX_UNSTARTED_PHASES = Object.freeze(new Set(["Provisioning", "Starting", "Unspecified"]));

/** Whether a listed sandbox is a bind-mode one (issue #686 part 3): its mode label, and nothing else, says so. */
const isBindSandbox = (s) => s?.labels?.[OPENSHELL_MODE_LABEL] === "bind";
/** Whether a listed sandbox belongs to `mode`'s bundle: a copy-mode one carries no mode label. */
const ofMode = (mode) => (s) => (mode === "bind") === isBindSandbox(s);

/** Every sandbox the gateway lists with this worker's owner label, page by page. THROWS when it does not answer. */
async function listOwned(run, stepOpts) {
	const out = [];
	let token = "";
	for (let page = 0; page < 1000; page++) {
		const args = ["sandbox", "list", "--selector", `${OPENSHELL_OWNER_LABEL}=${OPENSHELL_OWNER}`, "--page-size", "100", ...(token ? ["--page-token", token] : []), "-o", "json"];
		const doc = parseJson((await (stepOpts ? run(args, stepOpts) : run(args))).stdout, "sandbox list");
		if (!doc || !Array.isArray(doc.sandboxes)) throw new Error("openshell sandbox list: no sandboxes array");
		out.push(...doc.sandboxes.filter((s) => s && typeof s.name === "string"));
		token = typeof doc.next_page_token === "string" ? doc.next_page_token : "";
		if (token === "") return out;
	}
	throw new Error("openshell sandbox list: more than 1000 pages");
}

/** A label value as a positive integer, or null (the host budget's own rule for a size label). */
const intLabel = (v) => (/^[1-9][0-9]{0,8}$/.test(String(v ?? "")) ? Number(v) : null);


/**
 * A provider's delete, asked again for a bounded while: OpenShell refuses it while a sandbox still has it attached, and
 * the sandbox's delete is asynchronous (measured). Its profile goes after it; a profile still named by a provider is
 * refused, and the reaper's next sweep finds both again.
 */
function providerDeleter(run, { log, delay }) {
	return async (provider) => {
		for (let i = 0; i < PROVIDER_DELETE_TRIES; i++) {
			try {
				await run(["provider", "delete", provider]);
				break;
			} catch {
				if (i === PROVIDER_DELETE_TRIES - 1) log("openshell_provider_delete_failed", { provider });
				else await delay(PROVIDER_DELETE_WAIT_MS);
			}
		}
		try {
			await run(["provider", "profile", "delete", provider]);
		} catch {}
	};
}

/** The sweep: every owned sandbox in the job namespace, then every owned provider (and its profile) named like one. */
function reapWith(run, deleteProvider, log) {
	return async () => {
		try {
			const owned = (await listOwned(run)).filter((s) => isJobNamespace(s.name));
			for (const s of owned) await run(["sandbox", "delete", s.name]);
			if (owned.length > 0) log("reaped_sandboxes", { count: owned.length });
			// Issue #684: a crashed job's provider and profile, by the owner label and the job namespace.
			const providers = parseJson((await run(["provider", "list", "--label-selector", `${OPENSHELL_OWNER_LABEL}=${OPENSHELL_OWNER}`, "-o", "json"])).stdout, "provider list");
			for (const p of (providers?.providers ?? []).filter((x) => typeof x?.name === "string" && SANDBOX_NAME.test(x.name))) await deleteProvider(p.name);
			return { reaped: true };
		} catch {
			return { reaped: false };
		}
	};
}

/**
 * The venue's reaper on its own (issue #684), for the boot sweep, which runs before the bundle can be built (it needs the
 * log sink and the package resolver); the bundle is then handed this same function as `reap`, podman's pattern.
 */
export function makeOpenshellReaper({ gateway = null, exec = reaperExec(), log = () => {}, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
	const run = (args, stepOpts) => exec("openshell", [...gatewayArgs(gateway), ...args], stepOpts);
	return reapWith(run, providerDeleter(run, { log, delay }), log);
}

/**
 * The boot's version judgement (issue #684, the half #683 left to the blessing): the CLI and, when it answers, the
 * gateway must be `OPENSHELL_TESTED_VERSION`, since the venue drives interfaces OpenShell marks experimental and another
 * release is untested until the conformance run passes on it. `{ refusal, transient }` or `{ gatewayDown }` or `{}`:
 *
 *   - a CLI that does not answer is transient (exit 1, restarted): an install mid-way or a PATH the unit has not
 *     picked up yet, which a restart can meet fixed;
 *   - a CLI or a gateway at another release is the deployment's (a configError, exit 2, not restarted into it);
 *   - a gateway that does not answer refuses nothing here: every job's preflight reads it again and retries, so a
 *     gateway started after the worker is not a boot loop. Said as `gatewayDown` for the boot's log.
 */
export async function openshellBootVersions({ gateway = null, exec = reaperExec() } = {}) {
	const run = (args) => exec("openshell", [...gatewayArgs(gateway), ...args]);
	let cli;
	try {
		cli = /openshell (\S+)/.exec(String((await run(["--version"])).stdout ?? ""))?.[1] ?? null;
	} catch {
		cli = null;
	}
	if (cli === null) return { refusal: "PI_BACKENDS blesses openshell, and the openshell CLI did not answer `openshell --version`: install OpenShell " + OPENSHELL_TESTED_VERSION + " on this host's PATH (pi-dispatch doctor --openshell)", transient: true };
	if (cli !== OPENSHELL_TESTED_VERSION) return { refusal: `PI_BACKENDS blesses openshell, and the openshell CLI is ${cli}, not ${OPENSHELL_TESTED_VERSION}, the release this venue was measured on: install ${OPENSHELL_TESTED_VERSION}, or remove openshell from PI_BACKENDS`, transient: false };
	let status;
	try {
		status = judgeGatewayStatus(JSON.parse(String((await run(["status", "-o", "json"])).stdout ?? "")));
	} catch {
		return { gatewayDown: true };
	}
	if (!status.connected) return { gatewayDown: true };
	if (status.version !== OPENSHELL_TESTED_VERSION) return { refusal: `PI_BACKENDS blesses openshell, and its gateway runs ${status.version ?? "an unknown release"}, not ${OPENSHELL_TESTED_VERSION}, the release this venue was measured on: run the gateway of ${OPENSHELL_TESTED_VERSION}`, transient: false };
	return {};
}

/**
 * The pi providers that READ their credential's value inside the job (issue #684 review, read at the pinned pi-ai), where
 * this venue's placeholder cannot stand in for it: Bedrock signs each request with the secret (SigV4), Vertex reads a
 * credentials FILE, Codex decodes its key as a JWT for the account id, and Copilot exchanges its token for another.
 * Refused before spend by name. Anthropic is judged by the VALUE, as pi judges it (`isOAuthToken`, a substring test for
 * `sk-ant-oat`): an OAuth token picks other headers. A provider not listed here sends its key as it is, in a header the
 * supervisor rewrites; one that does otherwise fails with its own provider error, never silently (`OQ-047`).
 */
export const VALUE_READING_PROVIDERS = Object.freeze(["amazon-bedrock", "google-vertex", "openai-codex", "github-copilot"]);

/** Whether a job's provider credential, as the worker's environment holds it, is one pi reads by value. */
// env-internal ANTHROPIC_OAUTH_TOKEN: pi's own variable, read from the worker's environment only to refuse a job whose
// credential the venue's placeholder cannot stand in for; documented with the provider keys pi reads.
export function credentialReadsValue(provider, hostEnv = {}) {
	if (VALUE_READING_PROVIDERS.includes(provider)) return true;
	if (provider !== "anthropic") return false;
	if (typeof hostEnv?.ANTHROPIC_OAUTH_TOKEN === "string" && hostEnv.ANTHROPIC_OAUTH_TOKEN !== "") return true;
	return typeof hostEnv?.ANTHROPIC_API_KEY === "string" && hostEnv.ANTHROPIC_API_KEY.includes("sk-ant-oat");
}

/**
 * The fixed comments of this venue's own refusals, by reason. Fixed text, so nothing the gateway said reaches a forge
 * comment; the evidence goes to the operator's log.
 */
export const OPENSHELL_REFUSALS = Object.freeze({
	"openshell-gateway-not-local": "Refused: this job's venue is an OpenShell gateway that is not observed on this host, and the venue holds the job's credentials in that gateway, so it runs only on a gateway this deployment runs itself. Not run.",
	"openshell-global-policy": "Refused: the OpenShell gateway has a gateway-wide policy in force, which would replace the policy the worker generates for this job. Not run.",
	"openshell-landlock-missing": "Refused: this host's kernel does not offer Landlock, which the OpenShell venue needs to confine the job's sandbox and to keep its inputs read-only. Not run.",
	"openshell-recover-unsupported": "Refused: this trigger asks for runs that continue after a lost worker, which the OpenShell venue cannot checkpoint yet. Run it on another venue, or without run.recover. Not run.",
	"openshell-credential-reads-value": "Refused: this job's model provider reads its credential's value inside the job (to sign requests, pick an auth scheme or decode it), and on the OpenShell venue the job sees only a placeholder for it. Run it on another venue, or with a provider whose key is sent as it is. Not run.",
	"openshell-gateway-untested": "Refused: the OpenShell gateway runs another release than the one this venue was measured on. Not run.",
	"openshell-egress-untranslatable": "Refused: this deployment's egress settings hold an entry the OpenShell venue cannot turn into its network policy without widening it, so the operator must change it before jobs run there. Not run.",
	// Issue #686 part 3, review round 2 of #714: the bind venue's named result for a sandbox not confirmed gone (backends.mjs).
	[OPENSHELL_BIND_LINGERING.reason]: OPENSHELL_BIND_LINGERING.comment,
	// Issue #686 part 3, bind mode only. The setting goes to the operator's log (`openshell_bind_mounts_disabled`).
	"openshell-bind-mounts-disabled": "Refused: this job's venue mounts its files into an OpenShell sandbox, and the OpenShell gateway is not configured to allow that (its gateway.toml must allow driver config and bind mounts, and turn resource admission off), so the operator must change it before jobs run there. Not run.",
});

/**
 * How long a bind-settings answer is kept (issue #686 part 3), per bundle and so per gateway: an admitting one ten
 * minutes, a refusing one a minute, so an operator who fixes gateway.toml and restarts the gateway is read again soon
 * without a probe per job. A create refused with a settings sentence after a probe admitted (the probe's reading of the
 * settings and the create's disagreeing) is held the full ten minutes, so the probe cannot re-admit a job into the same
 * refusal: at most one attempt is retried as infrastructure, every later one refused before spend. The probe's order of
 * checks is measured, so that disagreement means a gateway reconfigured within the admitting answer's ten minutes.
 */
export const BIND_GATE_ADMITTED_MS = 10 * 60_000;
export const BIND_GATE_REFUSED_MS = 60_000;
/**
 * Review round 1 (#714): how long a bind-mode attempt waits for its sandbox to be GONE before its run returns. A bind is
 * the host's own tree, so a process the agent left running in the sandbox (`setsid ... &`) keeps writing the workspace,
 * the folder, the session and the outbox after the exec ends, and a sandbox's delete is asynchronous (measured in #684).
 * So the sandbox is deleted and the listing polled until it no longer names it; past this bound the result is marked
 * `lingering` (`openshell_bind_sandbox_lingering` in the log), its exit code UNCHANGED (review round 2), and the processor
 * decides: no exit checkpoint; the named result `openshell-bind-sandbox-lingering` for a completed run or a folder job;
 * infrastructure as before for any other forge exit; exit 2 and a stop as they are.
 */
export const BIND_SETTLE_MS = 60_000;
const BIND_SETTLE_POLL_MS = 1_000;

const OPENSHELL_BACKEND_OPTIONS = Object.freeze(["mode", "euid", "egid", "now", "jobsDir", "readDaemonFacts", "image", "gateway", "engine", "readAllowlist", "readEndpoints", "hostEnv", "openJobLog", "openLiveTranscript", "openInboxRelay", "onOutput", "globalPiDir", "allowGlobalExtensions", "packagePaths", "forwardEnv", "authFromPi", "forgeHosts", "log", "spawnFn", "exec", "fs", "readLsm", "platform", "delay", "reap", "makeRunContainer"]);

/**
 * Build the `openshell` bundle. `engine` is the gateway's compute driver, `docker` or `podman` (the only two in v1),
 * whose CLI the image preflight reads the job image's labels through: the gateway pulls from that engine's store, so a
 * label read anywhere else describes another image (`OQ-012`). `gateway` names a registered gateway, or none for the
 * CLI's active one.
 */
export function makeOpenshellBackend(opts = {}) {
	// Issue #686 part 3: `copy` (the `openshell` venue, the default) or `bind` (`openshell-bind`).
	const mode = opts?.mode ?? "copy";
	if (!OPENSHELL_MODES.includes(mode)) throw new Error(`backend "${OPENSHELL_BACKEND}": mode must be "copy" or "bind", got ${JSON.stringify(mode)}`);
	const binding = mode === "bind";
	const venue = binding ? OPENSHELL_BIND_BACKEND : OPENSHELL_BACKEND;
	for (const key of Object.keys(opts ?? {})) {
		if (!OPENSHELL_BACKEND_OPTIONS.includes(key)) throw new Error(`backend "${venue}": unknown option ${JSON.stringify(key)} (takes ${OPENSHELL_BACKEND_OPTIONS.join(", ")})`);
	}
	const {
		image,
		gateway = null,
		engine = "docker",
		// Issue #684: the deployment's egress-allowlist.conf entries and model-endpoints.json endpoints, read per job as
		// the MCP preflight reads them (start.mjs), so the venue's policy is built from the sources the squid venues
		// read. Each a function; an unreadable source throws there, which a job reads as infrastructure.
		readAllowlist = () => [],
		readEndpoints = () => [],
		hostEnv = process.env,
		openJobLog,
		// Issue #686: the live transcript publisher's opener (start.mjs's, shared with every venue), fed from the exec's
		// stderr records. Absent, no job here publishes a transcript or progress, as before.
		openLiveTranscript = null,
		// Issue #686: the steer inbox relay's opener (start.mjs's, shared with every venue), whose relay writes frames on
		// the exec's stdin here. Absent, a steer job here runs unsteered (`steerSkipped: "no-transcript"`).
		openInboxRelay = null,
		onOutput,
		globalPiDir = null,
		allowGlobalExtensions = true,
		packagePaths = [],
		forwardEnv = [],
		authFromPi = false,
		forgeHosts = {},
		log = () => {},
		spawnFn = spawn,
		exec = reaperExec(),
		fs = { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync },
		// Issue #686 part 3: the worker's own ids, which a bind-mode job runs as (`decideOpenshellBindUser`), and the clock
		// the bind gate's cache reads.
		euid = typeof process.geteuid === "function" ? process.geteuid() : null,
		egid = typeof process.getegid === "function" ? process.getegid() : null,
		now = () => Date.now(),
		// Review round 1 (#714): where the bind probe's empty source directory is made, the jobs dir (a path the gateway's
		// engine sees as the job dirs it binds), and the engine's `docker info` read the job user is decided from.
		jobsDir = null,
		readDaemonFacts = null,
		readLsm = () => readFileSync("/sys/kernel/security/lsm", "utf8"),
		delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		platform = process.platform,
		// The boot-built reaper (`makeOpenshellReaper`), so the sweep and the registry hold the same function; none builds
		// this bundle's own.
		reap: reapFn = null,
		makeRunContainer: makeRunContainerFn = makeRunContainer,
	} = opts ?? {};
	if (engine !== "docker" && engine !== "podman") throw new Error(`backend "${venue}": engine must be "docker" or "podman" (the compute drivers v1 admits), got ${JSON.stringify(engine)}`);
	if (gateway !== null && (typeof gateway !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(gateway))) throw new Error(`backend "${venue}": gateway must be a registered gateway's name`);
	const run = (args, stepOpts) => exec("openshell", [...gatewayArgs(gateway), ...args], stepOpts);

	// Per attempt, keyed by THAT attempt's own build options (the one object all three hooks are handed), so two
	// attempts of one job that overlap in this process (a stop that did not take, then a retry) never read each other's
	// record. `live` holds the sandbox names an attempt is between its create and its delete, so the host budget's
	// gone-check never deletes a live attempt's sandbox as an orphan; `stopping` holds the names a stop was sent for
	// before the sandbox existed, so a stage still running notices and stops.
	const attempts = new WeakMap();
	const live = new Map();
	const stopping = new Set();

	// Issue #684: the job's network policy, generated from the deployment's sources and the image's network binaries.
	// `{ network_policies }`, or `{ refused, entry? }` when a source cannot be translated without guessing.
	const networkFor = (job, endpoints, binaries) =>
		networkPolicyFor({ allowlist: readAllowlist(), endpoints: endpoints ?? readEndpoints(), kind: job?.kind ?? null, repo: job?.repo ?? null, binaries, onSkipped: (what) => log("openshell_policy_skipped", what) });

	// Issue #686 part 3: the bind settings' verdict for this bundle's gateway, `{ until, setting | null, pinned }`, and the
	// probe in flight, so jobs picked up together share one create.
	let bindVerdict = null;
	let bindProbing = null;
	const holdBindRefusal = (setting, at) => {
		bindVerdict = { until: now() + BIND_GATE_ADMITTED_MS, setting, pinned: true };
		log("openshell_bind_mounts_disabled", { setting, at });
	};
	// `{ admitted: true }`, `{ setting }`, or `{ unknown: reason }` when the probe's answer is none of the known ones.
	// THE PROBE LEAVES A SANDBOX when the settings admit binds (measured, 0.1.4: the reserved-target refusal comes at
	// provisioning, "sandbox entered error phase while provisioning: ContainerCreateFailed: mount target '/sandbox' is
	// reserved ...", and the sandbox stays listed in phase `Error`), so it is deleted on EVERY answer. A settings refusal
	// creates nothing (measured, 50 to 90 ms), and its delete is a no-op. Should the worker die between the two, the
	// sandbox is the boot reaper's: it carries the owner label, and its name (`sandboxNameOf`, `pi-job-s` and 11 hex
	// digits) is in the job namespace `isJobNamespace` sweeps.
	const probeBind = async (imageId) => {
		const name = sandboxNameOf(`pi-job-bind-probe-${process.pid}-${now()}`);
		let source = null;
		try {
			// Under the jobs dir, the tree the engine binds job dirs from (not `job-*`, so the orphan sweep leaves it alone).
			source = fs.mkdtempSync(join(jobsDir ?? tmpdir(), "bind-probe-"));
			await exec("openshell", bindProbeArgs({ name, image: imageId, source, engine, ownerLabel: OPENSHELL_OWNER_LABEL, owner: OPENSHELL_OWNER, modeLabel: OPENSHELL_MODE_LABEL, gateway }), { timeoutMs: 60_000 });
			// Created and not refused at all: the gateway took the binds, so its settings admit them.
			log("openshell_bind_probe_created", { container: name });
			log("openshell_bind_probed", { answer: "admitted" });
			return { admitted: true };
		} catch (err) {
			const judged = judgeBindAnswer(`${err?.stderr ?? ""} ${err?.stdout ?? ""}`);
			// Said once per probe, by answer: the lane reads it to tell a probe that ran from a gate that skipped one.
			log("openshell_bind_probed", { answer: judged.setting ?? (judged.admitted ? "admitted" : "unread") });
			if (judged.setting || judged.admitted) return judged;
			return { unknown: "probe-unread" };
		} finally {
			await run(["sandbox", "delete", name]).catch(() => {});
			if (source !== null) {
				try {
					fs.rmSync(source, { recursive: true, force: true });
				} catch {}
			}
		}
	};
	// The gate itself: `{ refused: setting }`, `{ ok: true }`, or `{ unavailable: reason }` (retried as infrastructure).
	const bindGate = async (job) => {
		if (bindVerdict !== null && now() < bindVerdict.until) return bindVerdict.setting ? { refused: bindVerdict.setting } : { ok: true };
		// By ID, as the create is: a NAME the engine lacks would be pulled by the gateway (measured). An image the engine does
		// not hold is the image preflight's refusal, next; the gate decides nothing for this job then.
		let imageId = null;
		try {
			imageId = normalizeImageId(String((await exec(engine, ["image", "inspect", "--format", "{{.Id}}", resolveJobImage(job ?? {}, image)])).stdout ?? "").trim());
		} catch {
			imageId = null;
		}
		if (!/^sha256:[0-9a-f]{64}$/.test(imageId ?? "")) return { ok: true, unprobed: true };
		bindProbing ??= probeBind(imageId).finally(() => {
			bindProbing = null;
		});
		const answer = await bindProbing;
		if (answer.unknown) return { unavailable: answer.unknown };
		// A refusal seen at a create since this probe began is not overturned by it.
		if (bindVerdict?.pinned && now() < bindVerdict.until) return { refused: bindVerdict.setting };
		bindVerdict = answer.setting ? { until: now() + BIND_GATE_REFUSED_MS, setting: answer.setting, pinned: false } : { until: now() + BIND_GATE_ADMITTED_MS, setting: null, pinned: false };
		if (answer.setting) log("openshell_bind_mounts_disabled", { setting: answer.setting, at: "probe" });
		return answer.setting ? { refused: answer.setting } : { ok: true };
	};

	// Review round 1 (#714), M1: delete a bind-mode sandbox and wait until the listing no longer names it, so nothing in it
	// can still write the host tree. `true` once gone, `false` past `BIND_SETTLE_MS` or when the listing cannot be read.
	// Review round 2: every listing is bounded by what is left of the deadline (a gateway that does not answer cannot hold
	// the slot past it), and an aborted run (a timeout, a shutdown) is asked once and not waited for: its stop already sent
	// the delete, and a shutdown must not sit out the bound.
	const settleSandboxes = async (names, { signal = null } = {}) => {
		for (const name of names) await run(["sandbox", "delete", name]).catch(() => {});
		const deadline = now() + BIND_SETTLE_MS;
		for (;;) {
			let listed;
			try {
				listed = new Set((await listOwned(run, { timeoutMs: Math.max(1, deadline - now()) })).map((s) => s.name));
			} catch {
				listed = null;
			}
			if (listed !== null && names.every((n) => !listed.has(n))) return true;
			if (now() >= deadline || signal?.aborted === true) return false;
			await delay(BIND_SETTLE_POLL_MS);
		}
	};
	// The attempt's settle, once: the run-container hook below, else the teardown. `settleTried` keeps the teardown from
	// waiting the bound a second time after a settle that timed out (review round 2).
	const settleAttempt = async (built, { signal = null } = {}) => {
		const at = attempts.get(built);
		const name = sandboxNameOf(built.name);
		if (at) at.settleTried = true;
		const gone = await settleSandboxes([name], { signal });
		if (at) at.settled = gone;
		if (!gone) log("openshell_bind_sandbox_lingering", { container: name });
		return gone;
	};

	const stageRun = async ({ opts: built, signal = null, job = null, modelEndpoints = null }) => {
		const { jobDir, size = DEFAULT_JOB_SIZE } = built;
		const name = sandboxNameOf(built.name);
		const at = { name, jobDir, policyFile: `${jobDir}.openshell-policy.json`, profileFile: `${jobDir}.openshell-profile.json`, uploadDir: `${jobDir}.openshell-up`, downloadDir: `${jobDir}.openshell-down`, transfers: [], provider: null };
		attempts.set(built, at);
		at.signal = signal;
		live.set(name, (live.get(name) ?? 0) + 1);
		// Review round 2: a marker BESIDE the job dir saying a bind sandbox may write it, so a salvage of a crashed attempt
		// settles that sandbox first, and only then (recovery-queue.mjs, `BESIDE_JOB_DIR`). Removed at teardown once the
		// sandbox is confirmed gone; left (with the job dir) when it is not, or when the worker dies.
		if (binding) {
			at.markerFile = `${jobDir}${OPENSHELL_BIND_MARKER}`;
			fs.writeFileSync(at.markerFile, "", { mode: 0o600 });
		}
		// Asked after every step that waits: a stop is the job's answer, and run-container ends the run as stopped.
		const stopped = () => signal?.aborted === true || stopping.has(name);
		// Bind mode passes the relabel decision on (review round 1: SELinux `private` on the worker's own directories).
		const spec = containerSpec({ image: built.image, name: built.name, jobDir, workspace: built.workspace, outboxDir: built.outboxDir, sessionDir: built.sessionDir, steerInboxDir: binding ? built.steerInboxDir : undefined, globalPiDir: built.globalPiDir, ...(binding ? { relabel: built.relabel === true, workspaceOwned: built.workspaceOwned === true } : {}) });
		// Issue #686 part 3: bind mode hands the spec's mounts to the driver and copies nothing.
		const binds = binding ? bindMountsOf(spec) : [];
		if (!binding) {
			at.transfers = transfersFromSpec(spec, { binds: false }).map((t) => ({ ...t, sandbox: sandboxPathOf(t.container) }));
			const unmapped = at.transfers.find((t) => t.sandbox === null);
			if (unmapped) throw new Error(`openshell: the sandbox layout has no place for ${unmapped.container}`);
		}

		// The image BY ID, read now from the gateway's own engine: the gateway's driver pulls a NAME it does not hold
		// (`if_not_present`, measured: a missing tag was fetched from Docker Hub), and no registry serves a local image's
		// ID, so `--from <id>` is this venue's `--pull=never`. It also pins the run to the image the preflight just read,
		// not to whatever the tag points at when the gateway gets to it.
		// The network binaries ride the same read (issue #684): the policy's rules name them, and the image declares them.
		const inspected = await exec(engine, ["image", "inspect", "--format", `{{.Id}}|{{index .Config.Labels "${NET_BINARIES_LABEL}"}}`, built.image]);
		if (stopped()) return;
		const [rawId, rawBinaries = ""] = String(inspected.stdout ?? "").trim().split("|");
		const imageId = normalizeImageId(rawId);
		if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) throw new Error(`openshell: ${engine} gave no image ID for the job image`);
		const binaries = rawBinaries === "" || rawBinaries === "<no value>" ? [] : rawBinaries.split(",");

		// The checks a job is refused for before spend ran in `observationPreflight` (the same function, the same
		// sources). The image's label cannot refuse here: the runner's node is always first, and a bad entry is skipped
		// and logged, so only a source edited between the preflight and now can, and that retries into the preflight's
		// own refusal.
		const network = networkFor(job, modelEndpoints?.endpoints ?? null, binaries);
		if (network.refused) {
			log("openshell_policy_untranslatable", { container: name, refused: network.refused });
			throw new Error(`openshell: the job's network policy could not be built (${network.refused})`);
		}
		// No rule at all (no allowlist, no endpoint) leaves the key out: the body is then exactly #683's, deny-all, which
		// OpenShell reads back as written.
		// Issue #686 part 3: a bind-mode policy lists the binds and runs as the job user (copy mode's is the image's uid).
		const base = binding ? sandboxPolicy({ ...policyIds(built.user), binds }) : sandboxPolicy();
		const policy = Object.keys(network.network_policies).length > 0 ? { ...base, ...network } : base;
		// BESIDE the job directory, never inside what is uploaded: the policy is the box, not an input the agent reads.
		// Issue #684: the job's credentials, into a per-job provider (CONST-VENUE-EGRESS-LAYER, OQ-028 closed here): an
		// endpointless profile naming every secret of the env, a provider of it whose values travel in the CLI's own
		// ENVIRONMENT (`--credential NAME` reads `$NAME`, measured), never its argv, and every endpoint of the policy
		// bound to it, so a placeholder resolves only in a request to a host the policy admits. With no rule the job
		// reaches nothing, so no provider is made and the secrets go nowhere.
		const secrets = secretNamesOf(built.env ?? {});
		const unbindable = unbindableSecretNamesOf(built.env ?? {});
		if (unbindable.length > 0) log("openshell_secret_unbindable", { container: name, names: unbindable });
		const rules = policy.network_policies ?? {};
		if (secrets.length > 0 && Object.keys(rules).length > 0) {
			// Named by the sandbox, so every attempt of one job uses the same name: an earlier attempt's leftover (a delete
			// refused while its sandbox lingered, a crash between import and create) is removed first, once, or this create
			// would collide with it until the next boot's reap (review M2).
			await run(["provider", "delete", name]).catch(() => {});
			await run(["provider", "profile", "delete", name]).catch(() => {});
			fs.writeFileSync(at.profileFile, `${JSON.stringify(providerProfileFor(name, secrets))}\n`, { mode: 0o600 });
			await run(["provider", "profile", "import", "-f", at.profileFile]);
			at.profile = name;
			// The CLI child's environment is the worker's own, as on every other step (so it reaches the same gateway with
			// the same settings), plus the values; never its argv.
			const valueEnv = { ...process.env, ...Object.fromEntries(secrets.map((k) => [k, built.env[k]])) };
			await run(["provider", "create", "--name", name, "--type", name, ...secrets.flatMap((k) => ["--credential", k]), "--label", `${OPENSHELL_OWNER_LABEL}=${OPENSHELL_OWNER}`], { env: valueEnv });
			at.provider = name;
			for (const rule of Object.values(rules)) for (const endpoint of rule.endpoints) endpoint.credential_binding = { provider: name };
		} else if (secrets.length > 0) {
			log("openshell_secrets_unbound", { container: name, n: secrets.length });
		}
		if (stopped()) return;
		fs.writeFileSync(at.policyFile, `${JSON.stringify(policy)}\n`, { mode: 0o600 });
		// Issue #686 part 3: the mode label and the binds, bind mode only, so copy mode's create is unchanged.
		// The job dir's name as a label too (review round 1, M1), so a salvage of a lost attempt's tree can find and end the
		// sandbox that bound it before reading it (`settleJobDir`).
		const bindArgs = binding ? ["--label", `${OPENSHELL_MODE_LABEL}=bind`, "--label", `${OPENSHELL_JOB_DIR_LABEL}=${basename(jobDir)}`, "--driver-config-json", driverConfigFor(engine, binds)] : [];
		let createdOut;
		try {
			createdOut = await run(["sandbox", "create", "--detach", "--name", name, "--from", imageId, "--label", `${OPENSHELL_OWNER_LABEL}=${OPENSHELL_OWNER}`, "--label", `${SIZE_LABEL_MEM}=${size.memMiB}`, "--label", `${SIZE_LABEL_CPU}=${size.cpuCenti}`, ...bindArgs, ...sizeArgs(size), "--policy", at.policyFile, ...(at.provider ? ["--provider", at.provider] : []), "--no-auto-providers", "-o", "json"], { timeoutMs: 360_000 });
		} catch (err) {
			// The backstop for a probe that admitted: the gateway refused the binds at the create, with one of its settings
			// sentences. This attempt is infrastructure (nothing ran, refunded), and the verdict is held so the next attempt's
			// preflight refuses it before spend instead of retrying into the same refusal.
			if (binding) {
				const judged = judgeBindAnswer(`${err?.stderr ?? ""} ${err?.stdout ?? ""}`);
				if (judged.setting) holdBindRefusal(judged.setting, "create");
			}
			throw err;
		}
		const created = parseJson(createdOut.stdout, "sandbox create");
		if (created?.phase !== "Ready") throw new Error(`openshell sandbox create: phase ${JSON.stringify(created?.phase ?? null)}, not Ready`);
		if (stopped()) return;
		// READ BACK (`CONST-VENUE-EGRESS-LAYER`'s second condition): the policy in force is the one written, from this
		// sandbox, or the job does not run. With a network rule OpenShell adds its baseline paths (measured: `/var/log`
		// read-only, the one baseline path this policy does not list), so the read-back is held to the written body
		// plus exactly that (`expectedPolicy`), never to "close enough".
		const effective = parseJson((await run(["policy", "get", name, "--full", "-o", "json"])).stdout, "policy get");
		const readBack = JSON.stringify(canonical(effective?.policy));
		if (effective?.policy_source !== "sandbox" || !expectedPolicies(policy, { provider: at.provider }).some((p) => JSON.stringify(canonical(p)) === readBack)) {
			log("openshell_policy_mismatch", { container: name, source: typeof effective?.policy_source === "string" ? effective.policy_source : null });
			throw new Error("openshell: the sandbox's policy read back differs from the one the worker wrote");
		}
		// Bind mode: the driver mounted the job's directories; there is nothing to upload.
		if (binding) return;
		// The inputs, each to its place under /sandbox. A directory keeps its basename on upload and merges into the
		// destination (measured), so one whose basename is not its place's, or one with another mount nested inside (the
		// job directory holds the workspace and the session), is staged under the right name first, the nested ones left
		// out. `--no-git-ignore`: a bind shows the agent the whole tree, so a copy must not drop what .gitignore names.
		for (const t of at.transfers) {
			const place = basename(t.sandbox);
			let source = t.host;
			if (basename(t.host) !== place || t.contains.length > 0) {
				const nested = at.transfers.filter((o) => t.contains.includes(o.container)).map((o) => o.host);
				source = join(at.uploadDir, place);
				fs.rmSync(source, { recursive: true, force: true });
				fs.mkdirSync(at.uploadDir, { recursive: true, mode: 0o700 });
				fs.cpSync(t.host, source, { recursive: true, verbatimSymlinks: true, filter: (src) => !nested.some((n) => src === n || src.startsWith(`${n}/`)) });
				// Issue #684: the job's MCP document names its stdio commands by the `mounts` layout's paths; on this venue
				// the overlay sits at /sandbox/pi-global, so the staged copy is rewritten (the host's file is untouched).
				if (t.container === LAYOUTS.mounts.job) rewriteMcpForSandbox(join(source, "mcp.json"), fs);
			}
			await run(["sandbox", "upload", name, source, dirname(t.sandbox), "--no-git-ignore"], { timeoutMs: 600_000 });
			if (stopped()) return;
		}
	};

	const collectRun = async (result, { opts: built }) => {
		const at = attempts.get(built);
		// Bind mode: the writable outputs are the host's own directories, and the sandbox was already ended before the
		// transcript's final read (`settleRun`, review rounds 1 and 2). A sandbox not confirmed gone rides the result as
		// `lingering`, its exit code UNCHANGED (CONST-RETRY-INFRA-ONLY: a timeout never rewrites a determinate exit into a
		// retry); the processor decides from it.
		if (binding) return result;
		// A stopped run's sandbox is already being deleted, and its outputs are not read: the abort is the answer.
		if (result?.aborted === true) return result;
		if (!at) throw new Error("openshell: no staged attempt to bring the outputs of back");
		// Each writable output into a fresh directory first, then swapped for the host's, so the host tree is exactly the
		// sandbox's: a merge into the old one would keep every file the agent deleted.
		//
		// A download that FAILS after the job ran never throws: the run's own result (its verified tokens and usage) is
		// returned, so the processor records what the provider was paid. What changes is the classification: the
		// workspace and the session the processor would read are the stale upload, so a run that did not end on a
		// determinate refusal is reported as the runner's infrastructure exit, 1, retried with its reservation kept (the
		// safe direction); exit 2, a determinate refusal, stays exit 2 and is not paid for twice.
		for (const t of at.transfers.filter((x) => x.direction === "in-out")) {
			const fresh = join(at.downloadDir, basename(t.sandbox));
			try {
				fs.rmSync(fresh, { recursive: true, force: true });
				fs.mkdirSync(fresh, { recursive: true, mode: 0o700 });
				await run(["sandbox", "download", at.name, t.sandbox, fresh], { timeoutMs: 600_000 });
				fs.rmSync(t.host, { recursive: true, force: true });
				fs.renameSync(fresh, t.host);
			} catch {
				log("openshell_download_failed", { container: at.name, path: t.sandbox, code: result?.code ?? null });
				return result?.code === 2 ? result : { ...result, code: 1, exitReason: null };
			}
		}
		return result;
	};

	const deleteProvider = providerDeleter(run, { log, delay });

	const teardownRun = async ({ opts: built }) => {
		const name = sandboxNameOf(built.name);
		const at = attempts.get(built);
		attempts.delete(built);
		// Deleted even when the stage never recorded the attempt: a create that answered nothing may still have made one.
		// Bind mode waits for it to be gone on every path collectRun did not (a throw, a spawn error), for M1's reason.
		if (binding) {
			if (at?.settleTried !== true) await settleAttempt(built, { signal: at?.signal ?? null });
			if (at?.markerFile && at.settled === true) {
				try {
					fs.rmSync(at.markerFile, { force: true });
				} catch {}
			}
		} else {
			try {
				await run(["sandbox", "delete", name]);
			} catch {
				log("openshell_delete_failed", { container: name });
			}
		}
		// Issue #684: the provider and its profile, after the sandbox. A provider still attached is refused (measured:
		// "is attached to sandbox(es)"), and a sandbox delete is accepted before its cleanup ends, so the provider's
		// delete is asked again for a bounded while; what is left, the reaper deletes by the owner label.
		if (at?.provider) await deleteProvider(at.provider);
		else if (at?.profile) await run(["provider", "profile", "delete", at.profile]).catch(() => {});
		for (const path of at ? [at.policyFile, at.profileFile, at.uploadDir, at.downloadDir] : []) {
			try {
				fs.rmSync(path, { recursive: true, force: true });
			} catch {}
		}
		if (at) {
			const left = (live.get(name) ?? 1) - 1;
			if (left > 0) live.set(name, left);
			else live.delete(name);
		}
		stopping.delete(name);
	};

	const runContainer = makeRunContainerFn({
		image,
		hostEnv,
		...(openJobLog ? { openJobLog } : {}),
		...(onOutput ? { onOutput } : {}),
		globalPiDir,
		allowGlobalExtensions,
		packagePaths,
		forwardEnv,
		authFromPi,
		forgeHosts,
		// No egress variables: the layer's policy is the egress control, and the runner must not dial a proxy that does
		// not exist (image/runner/src/env-proxy.mjs installs one only on NODE_USE_ENV_PROXY=1).
		egress: false,
		// Never-started is decided by the step that failed (`stageRun` throws `container-never-started`), not by a code:
		// OpenShell's CLI failures exit 1, the runner's own infrastructure code (measured).
		neverStartedExits: [],
		bin: "openshell",
		// The sandbox's own name; PI_JOB_ID in the env stays the container name, which the exit line and its MAC carry.
		buildArgs: (built) => openshellExecArgs({ name: sandboxNameOf(built.name), env: built.env, gateway, mode }),
		memoryLimitOf: (_args, built) => (built.size?.memMiB ?? DEFAULT_JOB_SIZE.memMiB) * 1024 * 1024,
		// Copy mode: no recovery staging, since the session file is in the sandbox until the download, so a tail on the host
		// reads nothing. The live transcript comes over the exec's stderr instead, and steering over its stdin (issue #686).
		// Bind mode (part 3): the `mounts` layout and the host file, tailed as on `local`, the recovery staging included
		// (makeRunContainer's own defaults), and steering through the `/inbox` bind.
		...(binding ? { layout: "mounts", transcript: "file", settleRun: ({ opts: built }) => settleAttempt(built, { signal: attempts.get(built)?.signal ?? null }) } : { layout: "sandbox", stageLive: null, transcript: "stdio" }),
		...(typeof openLiveTranscript === "function" ? { openLiveTranscript } : {}),
		...(typeof openInboxRelay === "function" ? { openInboxRelay } : {}),
		stageRun,
		collectRun,
		teardownRun,
		log,
		spawnFn,
	});

	// The per-job, pre-spend venue checks (`CONST-VENUE-EGRESS-LAYER`'s third and fourth conditions): free reads, each
	// refusing by name. A gateway that does not answer is infrastructure (retried); one that answers wrong is policy.
	const observationPreflight = async (job) => {
		// Issue #684: `run.recover` needs a checkpoint of the running session, which this venue cannot take until its
		// transcript comes back over stdio (#686): refused by name, before anything is read, never run unarmed.
		// A `kind: local` job runs unarmed on every venue (`recoverSkipped: "local"`), so it is not refused here either.
		// Issue #686 part 3: bind mode serves it (the host workspace is salvaged and snapshotted at exit, as on `local`).
		if (!binding && job?.recover === true && job?.kind !== "local") return { venueRefused: { reason: "openshell-recover-unsupported", comment: OPENSHELL_REFUSALS["openshell-recover-unsupported"] } };
		if (credentialReadsValue(job?.provider, hostEnv)) {
			log("openshell_credential_reads_value", { provider: typeof job?.provider === "string" ? job.provider : null });
			return { venueRefused: { reason: "openshell-credential-reads-value", comment: OPENSHELL_REFUSALS["openshell-credential-reads-value"] } };
		}
		let status;
		try {
			status = judgeGatewayStatus(parseJson((await run(["status", "-o", "json"])).stdout, "status"));
		} catch {
			// No `message`: the processor reads one as a host FILE that could not be read. Its venue-neutral sentence is the
			// right one, and the reason is logged here, without the CLI's own words.
			log("openshell_unavailable", { reason: "cli-no-answer" });
			return { unavailable: true };
		}
		if (!status.connected) {
			log("openshell_unavailable", { reason: "gateway-not-connected" });
			return { unavailable: true };
		}
		// Per job as well as at boot (review M4): a gateway down at boot and started later at another release is read here.
		if (status.local && status.version !== OPENSHELL_TESTED_VERSION) {
			log("openshell_gateway_untested", { version: status.version });
			return { venueRefused: { reason: "openshell-gateway-untested", comment: OPENSHELL_REFUSALS["openshell-gateway-untested"] }, observations: { openshellGatewayLocal: true } };
		}
		if (!status.local) return { venueRefused: { reason: "openshell-gateway-not-local", comment: OPENSHELL_REFUSALS["openshell-gateway-not-local"] }, observations: { openshellGatewayLocal: false } };
		// A gateway-wide policy replaces every sandbox's. With none set the CLI exits 1 with this sentence (measured, the
		// one non-JSON answer this adapter reads); any other failure is not knowing, which is infrastructure.
		try {
			await run(["policy", "get", "--global", "-o", "json"]);
			return { venueRefused: { reason: "openshell-global-policy", comment: OPENSHELL_REFUSALS["openshell-global-policy"] }, observations: { openshellGatewayLocal: true } };
		} catch (err) {
			// The CLI wraps its error box to the terminal's width (measured: the sentence broke across two lines behind a
			// `│`), so the text is unwrapped before it is read.
			const said = String(err?.stderr ?? "").replace(/[│\s]+/g, " ");
			if (!/no global policy revision found/.test(said)) {
				log("openshell_unavailable", { reason: "global-policy-unread" });
				return { unavailable: true };
			}
		}
		// The gateway is on this host, so this host's kernel is the sandbox's on Linux. Elsewhere (Docker Desktop's VM)
		// it cannot be read from here: said, and left to the create, which fails closed (`hard_requirement`).
		if (platform === "linux") {
			let lsm = null;
			try {
				lsm = String(readLsm());
			} catch {
				lsm = null;
			}
			if (lsm === null) log("openshell_landlock_unknown", { reason: "lsm-unreadable" });
			else if (!lsm.split(",").map((s) => s.trim()).includes("landlock")) return { venueRefused: { reason: "openshell-landlock-missing", comment: OPENSHELL_REFUSALS["openshell-landlock-missing"] }, observations: { openshellGatewayLocal: true } };
		} else {
			log("openshell_landlock_unknown", { reason: "not-linux" });
		}
		// Issue #684: a source this venue cannot translate (a top-level wildcard, a loopback endpoint, a repository path
		// a push rule cannot name) refuses the job here, before spend, with the entry in the log only. Checked with the
		// runner's path standing in for the image's binaries, which only the stage's inspect reads.
		let network;
		try {
			network = networkFor(job, null, []);
		} catch {
			log("openshell_unavailable", { reason: "egress-sources-unread" });
			return { unavailable: true };
		}
		if (network.refused) {
			log("openshell_policy_untranslatable", { refused: network.refused, ...(network.entry ? { entry: network.entry } : {}) });
			return { venueRefused: { reason: "openshell-egress-untranslatable", comment: OPENSHELL_REFUSALS["openshell-egress-untranslatable"] }, observations: { openshellGatewayLocal: true } };
		}
		// Issue #686 part 3: bind mode's gateway settings, last (the one check that asks a create, which never runs a job).
		if (binding) {
			const gate = await bindGate(job);
			if (gate.refused) return { venueRefused: { reason: "openshell-bind-mounts-disabled", comment: OPENSHELL_REFUSALS["openshell-bind-mounts-disabled"] }, observations: { openshellGatewayLocal: true } };
			if (gate.unavailable) {
				log("openshell_unavailable", { reason: `bind-${gate.unavailable}` });
				return { unavailable: true };
			}
		}
		return { observations: { openshellGatewayLocal: true } };
	};

	// Issue #686 part 3: who a bind-mode job runs as, after the image probe (its `anyUid`). Copy mode carries none, so the
	// registry's default (the image's own user) stands, exactly as before.
	// Review round 1 (#714), M2: the engine's `docker info`, read through this bundle's exec, cached like `local`'s (an
	// answered read for `JOB_USER_FACTS_MAX_AGE_MS`; an unanswered one never), so a rootless or remapped Docker behind
	// the gateway refuses before spend.
	const engineFacts =
		readDaemonFacts ??
		makeDaemonFactsReader({
			run: async (args) => {
				try {
					return { code: 0, stdout: String((await exec(engine, args, { timeoutMs: DAEMON_FACTS_TIMEOUT_MS, maxBuffer: DAEMON_FACTS_MAX_BUFFER })).stdout ?? "") };
				} catch (error) {
					return { code: typeof error?.code === "number" ? error.code : null, stdout: "", error };
				}
			},
		});
	let factsCache = null;
	const cachedFacts = async () => {
		if (factsCache !== null && now() - factsCache.at < JOB_USER_FACTS_MAX_AGE_MS) return factsCache.daemon;
		const daemon = await engineFacts();
		if (daemon?.answered === true) factsCache = { at: now(), daemon };
		return daemon;
	};
	let jobUserSaid = null;
	const jobUserPreflight = async (_job, { capabilities = [] } = {}) => {
		const daemon = platform === "darwin" || platform === "win32" ? null : await cachedFacts();
		const chosen = decideOpenshellBindUser({ platform, euid, egid, capabilities, daemon });
		const said = JSON.stringify(chosen);
		if (said !== jobUserSaid) {
			jobUserSaid = said;
			log("job_user", { backend: OPENSHELL_BIND_BACKEND, user: chosen.user ?? null, refused: chosen.refused ?? null, cause: chosen.cause ?? null, reason: chosen.reason ?? null });
		}
		return chosen;
	};

	// Review round 1 (#714), M1: before a salvage reads a lost attempt's job directory, the sandbox that bound it (found
	// by its job-dir label) is deleted and confirmed gone. `true` when none is left, `false` when one lingers or the
	// listing cannot be read, and the salvage then reads nothing.
	const settleJobDir = async (jobDirName) => {
		try {
			const named = (await listOwned(run)).filter((s) => isBindSandbox(s) && s.labels?.[OPENSHELL_JOB_DIR_LABEL] === jobDirName).map((s) => s.name);
			if (named.length === 0) return true;
			const gone = await settleSandboxes(named);
			if (!gone) log("openshell_bind_sandbox_lingering", { jobDir: jobDirName, code: null });
			return gone;
		} catch {
			return false;
		}
	};

	return {
		name: venue,
		declares: BACKENDS[venue].declares,
		neverStartedExits: [],
		containerName: jobContainerName,
		namePrefix: JOB_NAME_PREFIX,
		// Copy mode copies, so the registry arms no file steer channel there (stdin frames instead) and the conformance
		// harness holds `readOnlyJobInputs` to `asserted`; bind mode binds, so `/inbox` steering is armed as on `local`.
		binds: binding,
		runContainer,
		// The gateway's own engine, and in copy mode `copies`, which arms the `sandboxLayout` capability row on every job.
		imagePreflight: makeImagePreflight({ image, bin: engine, copies: !binding, spawnFn }),
		...(binding ? { jobUserPreflight, settleJobDir } : {}),
		// The layer's policy is the egress control; there is no proxy to look for.
		egressPreflight: async () => ({}),
		// Marked first, so a stage still creating or uploading under this name stops at its next step (the delete below
		// finds nothing to delete before the create has answered).
		stopContainer: async (name) => {
			stopping.add(sandboxNameOf(name));
			return run(["sandbox", "delete", sandboxNameOf(name)]);
		},
		reap: reapFn ?? reapWith(run, deleteProvider, log),
		// This mode's sandboxes only (issue #686 part 3), so a host blessing both modes counts each leftover once.
		listJobContainers: async () =>
			(await listOwned(run))
				.filter((s) => isJobNamespace(s.name) && ofMode(mode)(s) && !SANDBOX_GONE_PHASES.has(s.phase))
				.map((s) => ({ name: s.name, memMiB: intLabel(s.labels?.[SIZE_LABEL_MEM]), cpuCenti: intLabel(s.labels?.[SIZE_LABEL_CPU]) })),
		containerGone: async (name) => {
			if (typeof name !== "string" || !isJobNamespace(name)) return null;
			const sandbox = sandboxNameOf(name);
			// A sandbox an attempt in this process is between its create and its delete is not gone, whatever name the
			// question came under (the host budget seeds a crash's leftover by its sandbox name, a live job by its container
			// name; both map here). Never deleted as an orphan.
			if (live.has(sandbox)) return false;
			try {
				const s = (await listOwned(run)).find((x) => x.name === sandbox);
				if (!s || SANDBOX_GONE_PHASES.has(s.phase)) {
					// Issue #684 (review M3): the gone sandbox's provider goes too, so a teardown that could not delete it does
					// not leave the job's credentials in the gateway until the next boot's reap. Once, not awaited: the
					// budget's question is about the sandbox, and the boot reap is the backstop.
					run(["provider", "delete", sandbox])
						.then(() => run(["provider", "profile", "delete", sandbox]))
						.catch(() => {});
					return true;
				}
				if (!SANDBOX_UNSTARTED_PHASES.has(s.phase)) return false;
				// Issue #686 part 3: the other mode's sandbox is the other bundle's to delete; its live attempts are in its own
				// `live`, which this one cannot see. Not gone, so the hold stays.
				if (!ofMode(mode)(s)) return false;
				await run(["sandbox", "delete", sandbox]);
				return true;
			} catch {
				return null;
			}
		},
		observationPreflight,
	};
}
