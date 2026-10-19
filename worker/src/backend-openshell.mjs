import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isJobNamespace, jobContainerName, JOB_NAME_PREFIX, reaperExec } from "./backend-local.mjs";
import { BACKENDS, OPENSHELL_BACKEND } from "./backends.mjs";
import { containerSpec, SHIPPED_IMAGE_UID, SIZE_LABEL_CPU, SIZE_LABEL_MEM, transfersFromSpec } from "./container-spec.mjs";
import { makeImagePreflight, normalizeImageId } from "./image-preflight.mjs";
import { LAYOUTS } from "./job-layout.mjs";
import { judgeGatewayStatus, OPENSHELL_TESTED_VERSION } from "./openshell-cli.mjs";
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
 * NOT BLESSABLE YET (`NOT_YET_BLESSABLE` in backends.mjs): until issue #684 the job's environment, its provider key
 * included, goes on the exec's `--env` (the CLI's own argv, as `-e` is docker's, `OQ-028`), the sandbox's network
 * policy is empty (deny-all), and a job's MCP servers, live transcript and steering are not served here (#684, #686).
 */


/** The label every sandbox this worker makes carries, which `list` selects on: a name alone is a substring world. */
export const OPENSHELL_OWNER_LABEL = "pi.dispatch.owner";
export const OPENSHELL_OWNER = "pi-dispatch";

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
 * kernel that cannot apply it fails the create instead of running the job without it. No `network_policies`: deny-all,
 * until issue #684 generates them. `run_as_user` is the image's own uid, so OpenShell's refusal of root and this
 * worker's non-root uid are the same fact.
 */
export function sandboxPolicy({ uid = SHIPPED_IMAGE_UID, gid = SHIPPED_IMAGE_UID } = {}) {
	return {
		version: 1,
		filesystem_policy: {
			include_workdir: true,
			read_only: ["/usr", "/lib", "/lib64", "/etc", "/bin", "/sbin", "/opt", "/app", "/ms-playwright", "/sys/fs/cgroup", "/dev/urandom", OPENSHELL_ENTRYPOINT],
			read_write: ["/tmp", "/dev/null", "/home/pi", "/proc"],
		},
		landlock: { compatibility: "hard_requirement" },
		process: { run_as_user: String(uid), run_as_group: String(gid) },
	};
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
export function openshellExecArgs({ name, env = {}, gateway = null }) {
	const envArgs = [];
	for (const [key, value] of Object.entries({ ...env, HOME: "/home/pi" })) {
		if (value === undefined || value === null) continue;
		envArgs.push("--env", `${key}=${value}`);
	}
	const rw = OPENSHELL_WRITABLE.flatMap((path) => ["--rw", path]);
	return [...gatewayArgs(gateway), "sandbox", "exec", "--name", name, "--no-login-shell", "--no-tty", "--timeout", "0", "--workdir", SANDBOX.workspace, ...envArgs, "--", PI_LANDLOCK, ...rw, "--", OPENSHELL_ENTRYPOINT];
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

/** Every sandbox the gateway lists with this worker's owner label, page by page. THROWS when it does not answer. */
async function listOwned(run) {
	const out = [];
	let token = "";
	for (let page = 0; page < 1000; page++) {
		const args = ["sandbox", "list", "--selector", `${OPENSHELL_OWNER_LABEL}=${OPENSHELL_OWNER}`, "--page-size", "100", ...(token ? ["--page-token", token] : []), "-o", "json"];
		const doc = parseJson((await run(args)).stdout, "sandbox list");
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
 * The fixed comments of this venue's own refusals, by reason. Fixed text, so nothing the gateway said reaches a forge
 * comment; the evidence goes to the operator's log.
 */
export const OPENSHELL_REFUSALS = Object.freeze({
	"openshell-gateway-not-local": "Refused: this job's venue is an OpenShell gateway that is not observed on this host, and the venue holds the job's credentials in that gateway, so it runs only on a gateway this deployment runs itself. Not run.",
	"openshell-global-policy": "Refused: the OpenShell gateway has a gateway-wide policy in force, which would replace the policy the worker generates for this job. Not run.",
	"openshell-landlock-missing": "Refused: this host's kernel does not offer Landlock, which the OpenShell venue needs to confine the job's sandbox and to keep its inputs read-only. Not run.",
});

const OPENSHELL_BACKEND_OPTIONS = Object.freeze(["image", "gateway", "engine", "hostEnv", "openJobLog", "onOutput", "globalPiDir", "allowGlobalExtensions", "packagePaths", "forwardEnv", "authFromPi", "forgeHosts", "log", "spawnFn", "exec", "fs", "readLsm", "platform", "makeRunContainer"]);

/**
 * Build the `openshell` bundle. `engine` is the gateway's compute driver, `docker` or `podman` (the only two in v1),
 * whose CLI the image preflight reads the job image's labels through: the gateway pulls from that engine's store, so a
 * label read anywhere else describes another image (`OQ-012`). `gateway` names a registered gateway, or none for the
 * CLI's active one.
 */
export function makeOpenshellBackend(opts = {}) {
	for (const key of Object.keys(opts ?? {})) {
		if (!OPENSHELL_BACKEND_OPTIONS.includes(key)) throw new Error(`backend "${OPENSHELL_BACKEND}": unknown option ${JSON.stringify(key)} (takes ${OPENSHELL_BACKEND_OPTIONS.join(", ")})`);
	}
	const {
		image,
		gateway = null,
		engine = "docker",
		hostEnv = process.env,
		openJobLog,
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
		fs = { cpSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync },
		readLsm = () => readFileSync("/sys/kernel/security/lsm", "utf8"),
		platform = process.platform,
		makeRunContainer: makeRunContainerFn = makeRunContainer,
	} = opts ?? {};
	if (engine !== "docker" && engine !== "podman") throw new Error(`backend "${OPENSHELL_BACKEND}": engine must be "docker" or "podman" (the compute drivers v1 admits), got ${JSON.stringify(engine)}`);
	if (gateway !== null && (typeof gateway !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(gateway))) throw new Error(`backend "${OPENSHELL_BACKEND}": gateway must be a registered gateway's name`);
	const run = (args, stepOpts) => exec("openshell", [...gatewayArgs(gateway), ...args], stepOpts);

	// Per attempt, keyed by THAT attempt's own build options (the one object all three hooks are handed), so two
	// attempts of one job that overlap in this process (a stop that did not take, then a retry) never read each other's
	// record. `live` holds the sandbox names an attempt is between its create and its delete, so the host budget's
	// gone-check never deletes a live attempt's sandbox as an orphan; `stopping` holds the names a stop was sent for
	// before the sandbox existed, so a stage still running notices and stops.
	const attempts = new WeakMap();
	const live = new Map();
	const stopping = new Set();

	const stageRun = async ({ opts: built, signal = null }) => {
		const { jobDir, size = DEFAULT_JOB_SIZE } = built;
		const name = sandboxNameOf(built.name);
		const at = { name, jobDir, policyFile: `${jobDir}.openshell-policy.json`, uploadDir: `${jobDir}.openshell-up`, downloadDir: `${jobDir}.openshell-down`, transfers: [] };
		attempts.set(built, at);
		live.set(name, (live.get(name) ?? 0) + 1);
		// Asked after every step that waits: a stop is the job's answer, and run-container ends the run as stopped.
		const stopped = () => signal?.aborted === true || stopping.has(name);
		const spec = containerSpec({ image: built.image, name: built.name, jobDir, workspace: built.workspace, outboxDir: built.outboxDir, sessionDir: built.sessionDir, globalPiDir: built.globalPiDir });
		at.transfers = transfersFromSpec(spec, { binds: false }).map((t) => ({ ...t, sandbox: sandboxPathOf(t.container) }));
		const unmapped = at.transfers.find((t) => t.sandbox === null);
		if (unmapped) throw new Error(`openshell: the sandbox layout has no place for ${unmapped.container}`);

		// The image BY ID, read now from the gateway's own engine: the gateway's driver pulls a NAME it does not hold
		// (`if_not_present`, measured: a missing tag was fetched from Docker Hub), and no registry serves a local image's
		// ID, so `--from <id>` is this venue's `--pull=never`. It also pins the run to the image the preflight just read,
		// not to whatever the tag points at when the gateway gets to it.
		const inspected = await exec(engine, ["image", "inspect", "--format", "{{.Id}}", built.image]);
		if (stopped()) return;
		const imageId = normalizeImageId(String(inspected.stdout ?? "").trim());
		if (!/^sha256:[0-9a-f]{64}$/.test(imageId)) throw new Error(`openshell: ${engine} gave no image ID for the job image`);

		const policy = sandboxPolicy();
		// BESIDE the job directory, never inside what is uploaded: the policy is the box, not an input the agent reads.
		fs.writeFileSync(at.policyFile, `${JSON.stringify(policy)}\n`, { mode: 0o600 });
		const created = parseJson(
			(await run(["sandbox", "create", "--detach", "--name", name, "--from", imageId, "--label", `${OPENSHELL_OWNER_LABEL}=${OPENSHELL_OWNER}`, "--label", `${SIZE_LABEL_MEM}=${size.memMiB}`, "--label", `${SIZE_LABEL_CPU}=${size.cpuCenti}`, ...sizeArgs(size), "--policy", at.policyFile, "--no-auto-providers", "-o", "json"], { timeoutMs: 360_000 })).stdout,
			"sandbox create",
		);
		if (created?.phase !== "Ready") throw new Error(`openshell sandbox create: phase ${JSON.stringify(created?.phase ?? null)}, not Ready`);
		if (stopped()) return;
		// READ BACK (`CONST-VENUE-EGRESS-LAYER`'s second condition): the policy in force is the one written, from this
		// sandbox, or the job does not run. Measured: `--full` returns the body as given.
		const effective = parseJson((await run(["policy", "get", name, "--full", "-o", "json"])).stdout, "policy get");
		if (effective?.policy_source !== "sandbox" || JSON.stringify(canonical(effective?.policy)) !== JSON.stringify(canonical(policy))) {
			log("openshell_policy_mismatch", { container: name, source: typeof effective?.policy_source === "string" ? effective.policy_source : null });
			throw new Error("openshell: the sandbox's policy read back differs from the one the worker wrote");
		}
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
			}
			await run(["sandbox", "upload", name, source, dirname(t.sandbox), "--no-git-ignore"], { timeoutMs: 600_000 });
			if (stopped()) return;
		}
	};

	const collectRun = async (result, { opts: built }) => {
		const at = attempts.get(built);
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

	const teardownRun = async ({ opts: built }) => {
		const name = sandboxNameOf(built.name);
		const at = attempts.get(built);
		attempts.delete(built);
		// Deleted even when the stage never recorded the attempt: a create that answered nothing may still have made one.
		try {
			await run(["sandbox", "delete", name]);
		} catch {
			log("openshell_delete_failed", { container: name });
		}
		for (const path of at ? [at.policyFile, at.uploadDir, at.downloadDir] : []) {
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
		buildArgs: (built) => openshellExecArgs({ name: sandboxNameOf(built.name), env: built.env, gateway }),
		layout: "sandbox",
		memoryLimitOf: (_args, built) => (built.size?.memMiB ?? DEFAULT_JOB_SIZE.memMiB) * 1024 * 1024,
		// No live transcript, steering or recovery staging here yet: the session file is in the sandbox until the
		// download, so a tail on the host reads nothing (stdio transcripts are issue #686).
		stageLive: null,
		stageRun,
		collectRun,
		teardownRun,
		log,
		spawnFn,
	});

	// The per-job, pre-spend venue checks (`CONST-VENUE-EGRESS-LAYER`'s third and fourth conditions): free reads, each
	// refusing by name. A gateway that does not answer is infrastructure (retried); one that answers wrong is policy.
	const observationPreflight = async () => {
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
		return { observations: { openshellGatewayLocal: true } };
	};

	return {
		name: OPENSHELL_BACKEND,
		declares: BACKENDS[OPENSHELL_BACKEND].declares,
		neverStartedExits: [],
		containerName: jobContainerName,
		namePrefix: JOB_NAME_PREFIX,
		// Copies, so the registry arms no steer channel here (`steerSkipped: "venue-copies"`) and the conformance harness
		// holds `readOnlyJobInputs` to `asserted`.
		binds: false,
		runContainer,
		// The gateway's own engine, and `copies`, which arms the `sandboxLayout` capability row on every job.
		imagePreflight: makeImagePreflight({ image, bin: engine, copies: true, spawnFn }),
		// The layer's policy is the egress control; there is no proxy to look for.
		egressPreflight: async () => ({}),
		// Marked first, so a stage still creating or uploading under this name stops at its next step (the delete below
		// finds nothing to delete before the create has answered).
		stopContainer: async (name) => {
			stopping.add(sandboxNameOf(name));
			return run(["sandbox", "delete", sandboxNameOf(name)]);
		},
		reap: async () => {
			try {
				const owned = (await listOwned(run)).filter((s) => isJobNamespace(s.name));
				for (const s of owned) await run(["sandbox", "delete", s.name]);
				if (owned.length > 0) log("reaped_sandboxes", { count: owned.length });
				return { reaped: true };
			} catch {
				return { reaped: false };
			}
		},
		listJobContainers: async () =>
			(await listOwned(run))
				.filter((s) => isJobNamespace(s.name) && !SANDBOX_GONE_PHASES.has(s.phase))
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
				if (!s || SANDBOX_GONE_PHASES.has(s.phase)) return true;
				if (!SANDBOX_UNSTARTED_PHASES.has(s.phase)) return false;
				await run(["sandbox", "delete", sandbox]);
				return true;
			} catch {
				return null;
			}
		},
		observationPreflight,
	};
}
