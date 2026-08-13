import { accessSync, constants, existsSync } from "node:fs";
import { dirname } from "node:path";
import { configError } from "./outcome.mjs";

/**
 * Parse and VALIDATE the runner's environment.
 *
 * Every failure here is a deterministic misconfiguration -- a forgotten or malformed env var
 * that a worker template bug ships to every job, not a transient fault. So each throws a
 * configError (exit 2, not retried); routing them through the queue's retry would pay to
 * rediscover the same typo forever. This is a pure function so the classification is testable
 * without a container or a real pi.
 */
export function parseRunnerEnv(env) {
	const provider = requireEnv(env, "PI_PROVIDER");
	const model = requireEnv(env, "PI_MODEL");
	const maxTurns = parsePositiveInt(env, "PI_MAX_TURNS");
	const maxTokens = parseOptionalPositiveInt(env, "PI_MAX_TOKENS");

	return {
		provider,
		model,
		maxTurns,
		maxTokens,
		// REQ-GLOBAL-PI-OVERLAY: does the global overlay's `extensions/` dir load? ON by default -- the
		// operator staged that dir themselves with `import-pi`, so an unset flag means "load the setup they
		// staged", not "there is nothing here". PI_GLOBAL_ALLOW_EXTENSIONS survives only as the opt-OUT.
		allowGlobalExtensions: parseAllowGlobalExtensions(env, "PI_GLOBAL_ALLOW_EXTENSIONS"),
		// INT-CONTAINER-JOB-INPUTS: the staged pi packages this job loads, as ABSOLUTE container paths under
		// /opt/pi-global/packages. Empty when nothing is staged, or when the trigger opted out.
		packages: parsePackagePaths(env, "PI_PACKAGES"),
		// INT-SESSION-STORE-CONTRACT: the persisted transcript this job runs on, as an ABSOLUTE container
		// path under the per-job /session mount. `null` when the trigger did not arm run.resume, which is
		// the default and is byte-identical to every job before the feature existed.
		sessionFile: parseSessionFile(env, "PI_SESSION_FILE"),
		// INT-CONTAINER-JOB-INPUTS (issue #189): the trigger's run.flow, structurally, so run-job can
		// compare it against the loaded skill names. `null` when the job carries no flow (a bare
		// run.task cron job), which skips the check entirely.
		flow: parseFlowName(env, "PI_FLOW"),
		retry: {
			maxRetries: parsePositiveInt(env, "PI_RETRY_MAX", 2),
			baseDelayMs: parsePositiveInt(env, "PI_RETRY_BASE_MS", 2000),
		},
	};
}

function requireEnv(env, name) {
	const value = env[name];
	if (!value) throw configError(`missing required env: ${name}`);
	return value;
}

function parsePositiveInt(env, name, fallback) {
	const raw = env[name];
	if (raw === undefined || raw === "") {
		if (fallback !== undefined) return fallback;
		throw configError(`missing required env: ${name}`);
	}
	const n = Number.parseInt(raw, 10);
	if (!Number.isInteger(n) || n < 1 || String(n) !== String(raw).trim()) {
		throw configError(`invalid ${name}: ${JSON.stringify(raw)} (want a positive integer)`);
	}
	return n;
}

/**
 * An OPTIONAL positive-int knob: an absent or empty var is `null` (the cap is disabled), not an
 * error. A present value is validated identically to parsePositiveInt -- a malformed cap is a
 * config error (exit 2), never a silently-ignored knob. This is the "unset means off" shape
 * parsePositiveInt cannot express, used by the optional PI_MAX_TOKENS budget.
 */
function parseOptionalPositiveInt(env, name) {
	const raw = env[name];
	if (raw === undefined || raw === "") return null;
	const n = Number.parseInt(raw, 10);
	if (!Number.isInteger(n) || n < 1 || String(n) !== String(raw).trim()) {
		throw configError(`invalid ${name}: ${JSON.stringify(raw)} (want a positive integer)`);
	}
	return n;
}

/**
 * Parse the overlay-extensions opt-OUT (REQ-GLOBAL-PI-OVERLAY). Unset, empty, and the legacy "1" all mean
 * LOAD; the exact string "0" is the only thing that disables. This mirrors the worker's
 * `globalExtensionsEnabled` exactly -- the two sides of the mount must read the same variable the same way,
 * and the runner cannot import from the worker (separate deployables), so the reading is duplicated here
 * the way parsePositiveInt already is.
 *
 * Any other value is a configError (exit 2, not retried) rather than a silent default. The worker only ever
 * emits "0" or nothing, so a third value here means a hand-run container or a worker-template regression --
 * precisely the case where guessing is worst. Guessing "load" would run extensions an operator believes
 * they disabled; guessing "disabled" would silently strip the setup a job's flow depends on and still exit
 * 0. Refusing is the only answer that cannot lie about which of the two happened.
 */
function parseAllowGlobalExtensions(env, name) {
	const raw = env[name];
	if (raw === undefined || raw === "" || raw === "1") return true;
	if (raw === "0") return false;
	throw configError(`invalid ${name}: ${JSON.stringify(raw)} (want "0" to disable the overlay's extensions, or leave it unset to load them)`);
}

/**
 * Parse a ":"-delimited list of staged pi package roots (INT-CONTAINER-JOB-INPUTS).
 *
 * Unset or empty is `[]` -- a deployment that staged no packages, or a trigger that opted out with
 * `run.packages: false`, is the normal state, not a misconfiguration. Every present entry must be an
 * ABSOLUTE path with no `..` segment, or it is a configError (exit 2, not retried).
 *
 * The validation lives HERE, before pi ever sees the value, because pi's own resolver gives no
 * second chance:
 *
 * - A local source that does not resolve is SKIPPED with no error and no diagnostic
 *   (package-manager resolveLocalExtensionSource: `if (!existsSync(resolved)) return;`). A typo
 *   therefore reads exactly like "this trigger staged nothing" -- clean exit 0, no tools.
 * - A RELATIVE entry is resolved against the process cwd, which is `/workspace` -- the adversarial
 *   clone. `PI_PACKAGES=packages/tools` would load an extension out of the checked-out branch, which
 *   is the entire trust boundary the runner exists to hold. Absolute-only closes that by construction,
 *   and rejecting `..` stops an entry from climbing out of the read-only staging mount.
 */
function parsePackagePaths(env, name) {
	const raw = env[name];
	if (raw === undefined || raw === "") return [];

	const paths = [];
	for (const entry of raw.split(":")) {
		// Empty segments are the shape a shell leaves behind ("a::b", a trailing ":"), not an error.
		if (entry === "") continue;
		if (!entry.startsWith("/")) {
			throw configError(`invalid ${name} entry: ${JSON.stringify(entry)} (want an absolute container path)`);
		}
		if (entry.split("/").includes("..")) {
			throw configError(`invalid ${name} entry: ${JSON.stringify(entry)} (must not contain a ".." segment)`);
		}
		paths.push(entry);
	}
	return paths;
}

/**
 * Parse the flow name the worker forwarded (issue #189). Unset or empty is `null` -- a job whose
 * trigger names no flow has nothing to verify, and that is the normal state for a bare run.task
 * cron job, not a misconfiguration.
 *
 * Deliberately NO charset validation here, unlike every sibling parser above. The value is used for
 * exactly two things -- name-equality against pi's loaded skill set and one log field -- and is
 * never interpolated into a path or a shell word, so a strange name cannot escape anything. Refusing
 * a shape the worker's own validator accepted (parseTriggers pins run.flow to a non-empty string,
 * nothing narrower) would mean an image upgrade starts failing jobs that ran yesterday, for a value
 * the operator's reviewed file has carried all along. The comparison simply misses and the miss is
 * reported, which is this variable's whole purpose.
 */
function parseFlowName(env, name) {
	const raw = env[name];
	if (raw === undefined || raw === "") return null;
	return raw;
}

/**
 * Parse the persisted-session path (INT-SESSION-STORE-CONTRACT).
 *
 * Unset or empty is `null` -- the trigger did not arm `run.resume`, which is the default. A present
 * value must be an ABSOLUTE container path with no `..` segment and must not live under `/workspace`,
 * or it is a configError (exit 2, not retried).
 *
 * The absolute-and-no-`..` rules are parsePackagePaths' rules for parsePackagePaths' reason: a relative
 * path resolves against the cwd, which is `/workspace` -- the adversarial clone.
 *
 * The `/workspace` exclusion is the one that is specific to this variable, and it is a narrowing rather
 * than a guard against anything we do today. The worker never points here; a worker-template bug that
 * did would put the transcript inside the worktree the agent commits from, one `git add -A` away from a
 * public pull request. Refusing the shape makes that unreachable rather than merely unlikely -- the same
 * move `--pull=never` makes one layer up.
 */
function parseSessionFile(env, name) {
	const raw = env[name];
	if (raw === undefined || raw === "") return null;
	if (!raw.startsWith("/")) {
		throw configError(`invalid ${name}: ${JSON.stringify(raw)} (want an absolute container path)`);
	}
	if (raw.split("/").includes("..")) {
		throw configError(`invalid ${name}: ${JSON.stringify(raw)} (must not contain a ".." segment)`);
	}
	if (raw === "/workspace" || raw.startsWith("/workspace/")) {
		throw configError(`invalid ${name}: ${JSON.stringify(raw)} (must not be under /workspace -- the transcript would land in the worktree the agent commits from)`);
	}
	return raw;
}

/**
 * Assert the /session mount actually landed, before any spend.
 *
 * Separate from parseRunnerEnv for assertPackagePathsExist's reason: parseRunnerEnv promises to be PURE.
 * Collaborators are injected so this is unit-testable without a container.
 *
 * The file MUST exist, and that is not a quirk -- the host stages it, always, as a 0-byte file even on a
 * cold start (INT-SESSION-STORE-CONTRACT). So absence does not mean "nothing to resume"; it means the
 * bind mount did not land. Distinguishing those two is the entire value of the check, and it is the same
 * inference assertPackagePathsExist makes about an unmounted package root.
 *
 * The writability probe earns its place separately. `createAgentSession` appends a thinking-level entry
 * BEFORE the first prompt, so a uid mismatch on the mount surfaces as an EACCES thrown from inside pi --
 * which classifyThrow files as exit 1, retryable, for a fault no retry can fix. Probing here turns that
 * into a readable pre-spend exit 2 naming the path.
 */
export function assertSessionMountReady(sessionFile, { fileExists = existsSync, checkWritable = defaultCheckWritable } = {}) {
	if (!sessionFile) return;
	if (!fileExists(sessionFile)) {
		throw configError(`session mount did not land: ${sessionFile} (PI_SESSION_FILE)`);
	}
	try {
		checkWritable(dirname(sessionFile));
	} catch (err) {
		throw configError(`session mount is not writable: ${dirname(sessionFile)} (PI_SESSION_FILE): ${err?.message}`);
	}
}

function defaultCheckWritable(dir) {
	accessSync(dir, constants.W_OK);
}

/**
 * Assert every staged package root is actually present on disk.
 *
 * Separate from parseRunnerEnv on purpose: parseRunnerEnv promises to be PURE, and this touches the
 * filesystem. `fileExists` is injected so the check is unit-testable without a container.
 *
 * This is the only thing that turns a mount failure into a visible failure. The SDK will not tell
 * you: pi skips an absent local package source silently (no error, no diagnostic), and the one error
 * it does raise lands in `extensionsResult.errors`, which nothing reads -- and which already carries
 * an entry for `/job/pi/extensions` on EVERY job, so it can never be surfaced wholesale. A job whose
 * packages never mounted would otherwise run to a clean exit 0 without the tools its flow was
 * written for, and report success for work it could not have done.
 */
export function assertPackagePathsExist(paths, { fileExists = existsSync } = {}) {
	for (const path of paths) {
		if (!fileExists(path)) {
			throw configError(`staged package path does not exist: ${path} (PI_PACKAGES)`);
		}
	}
}

/**
 * Force pi's offline mode on for this process (INT-SDK-SESSION-OPTIONS).
 *
 * Offline is a property of the RUNNER, not of its caller. The worker sets PI_OFFLINE=1 on every job
 * today, but a hand-run container, a debugging `docker run`, or a future worker regression must not
 * be able to re-arm pi's job-time-install path: with offline off, an unresolved package source is a
 * live `npm install` from inside the job, against a network the job's own input can influence, at
 * agent runtime. Setting it here means the guarantee cannot be dropped by whoever starts us.
 *
 * Idempotent, and only ever tightens: an env that already says exactly "1" is left untouched.
 * Anything else -- unset, "0", "true", "yes" -- is overwritten with "1". pi's own
 * isOfflineModeEnabled accepts "true"/"yes" too, but writing the canonical "1" keeps the value we
 * assert on and the value pi reads identical.
 */
export function enforceOfflineMode(env = process.env) {
	if (env.PI_OFFLINE === "1") return;
	env.PI_OFFLINE = "1";
}
