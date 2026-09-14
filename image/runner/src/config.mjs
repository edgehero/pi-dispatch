import { accessSync, constants, existsSync, readFileSync } from "node:fs";
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
// env-internal PI_FLOW, PI_COMMAND, PI_PACKAGES, PI_SESSION_FILE: the worker's own per-job inputs
// (INT-CONTAINER-RUNTIME-CONTRACT). The container environment is BUILT rather than inherited, so a value in
// a host .env never arrives here to be overridden, and each of these four is present only when the job
// actually has one. A trigger naming one in `run.secrets` is refused at load, for the same reason.
// env-internal PI_RETRY_MAX, PI_RETRY_BASE_MS: this runner's own provider retry bounds, and the one pair
// here that the worker does NOT write. Nothing puts them on a container by default, so a bare .env line
// sets them on the host and changes nothing in here; PI_FORWARD_ENV is what carries a host value in.
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
		// INT-CONTAINER-JOB-INPUTS (issue #189): the trigger's run.command -- the registered extension
		// command this job dispatches instead of a prompt. `null` (the overwhelmingly common state)
		// means a prompt job, byte-identical to every job before the feature.
		command: parseCommand(env, "PI_COMMAND"),
		// INT-CONTAINER-JOB-INPUTS (issue #291): the trigger's run.excludeTools -- the pi tool names to
		// withhold from createAgentSession. `[]` (the overwhelmingly common state) means the full pinned
		// default set, byte-identical to every job before the feature.
		excludeTools: parseExcludeTools(env, "PI_EXCLUDE_TOOLS"),
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
 * Parse the command a run.command trigger dispatches (issue #189). Unset or empty is `null` -- a
 * prompt job, the default. Unlike PI_FLOW this one IS validated, strictly, because the value is not
 * merely compared: run-job rebuilds the prompt as `/<value>` and hands it to session.prompt(), whose
 * dispatch grammar at the pin reads the command NAME up to the first space and passes EVERYTHING
 * after it -- including a newline and whatever follows -- as args. So:
 *   - a leading "/" is refused: the runner adds the slash, and accepting one here would make
 *     "//name" -- a prompt, silently, since no command named "/name" can register;
 *   - surrounding whitespace is refused rather than trimmed: a trailing space changes the args a
 *     handler receives, and normalizing here would make the container disagree with the reviewed
 *     file about what runs;
 *   - control characters are refused outright: a newline would smuggle a second line into what the
 *     operator reviewed as one command line.
 * All deterministic misconfigurations: configError, exit 2, never retried.
 */
function parseCommand(env, name) {
	const raw = env[name];
	if (raw === undefined || raw === "") return null;
	if (raw.startsWith("/")) {
		throw configError(`invalid ${name}: ${JSON.stringify(raw)} (no leading "/" -- the runner adds it)`);
	}
	if (raw !== raw.trim()) {
		throw configError(`invalid ${name}: ${JSON.stringify(raw)} (no surrounding whitespace)`);
	}
	// Every C0 control plus DEL, written as escapes so the source itself carries no control byte.
	if (/[\u0000-\u001f\u007f]/.test(raw)) {
		throw configError(`invalid ${name}: contains a control character (a newline or tab would change what dispatches)`);
	}
	return raw;
}

/**
 * Parse the tool denylist a run.excludeTools trigger carries (issue #291). Unset or empty is `[]` --
 * the full pinned default set, the default for every job.
 *
 * Shape only, deliberately: entries are returned VERBATIM (no trim, no membership check), because this
 * function promises purity and pi-freedom, and membership is the one check that needs the pinned
 * artifact -- it runs in run-job's pre-spend assert (tools.mjs), where a padded or misspelled entry
 * fails with the entry shown verbatim. One validator owns the grammar; a second normalizing pass here
 * would be a second place to disagree with the first (PI_COMMAND's own rule, one parser up).
 * Empty segments are skipped for parsePackagePaths' reason: they are the shape a shell leaves behind.
 */
// env-internal PI_EXCLUDE_TOOLS: the worker's own per-job input (INT-CONTAINER-JOB-INPUTS). The container
// env is BUILT, never inherited, and a trigger naming it in `run.secrets` is refused at load.
function parseExcludeTools(env, name) {
	const raw = env[name];
	if (raw === undefined || raw === "") return [];
	return raw.split(",").filter((entry) => entry !== "");
}

/**
 * The command NAME inside a run.command string -- pi's own parse, verbatim (text to the first space,
 * dist/core/agent-session.js _tryExecuteExtensionCommand). Exported so run-job's pre-prompt
 * getCommand() verification and the tests read the string the same way pi will.
 */
export function commandName(command) {
	const spaceIndex = command.indexOf(" ");
	return spaceIndex === -1 ? command : command.slice(0, spaceIndex);
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
export function assertSessionMountReady(sessionFile, { fileExists = existsSync, checkWritable = defaultCheckWritable, accessCode = defaultAccessCode, uid = process.getuid?.() } = {}) {
	if (!sessionFile) return;
	// `existsSync` answers false for a file it may not LOOK at, so a 0700 /session owned by another uid would
	// read as "did not land" and send the operator hunting for a mount that is there (issue #341). Asked first,
	// by the directory's own access code, so the two faults name themselves.
	if (DENIED.has(accessCode(dirname(sessionFile), constants.X_OK))) {
		throw configError(`session mount is not accessible to the job user (uid ${uid}): ${dirname(sessionFile)} (PI_SESSION_FILE)`);
	}
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

/** The error code `access(2)` answers for `path` and `mode`, or null when allowed. Never throws. */
function defaultAccessCode(path, mode) {
	try {
		accessSync(path, mode);
		return null;
	} catch (err) {
		return err?.code ?? "UNKNOWN";
	}
}

// The two codes that mean "this uid may not", as opposed to "not there". Nothing else refuses: an ENOENT is the
// caller's own concern, and an unexpected code is left to the read that follows, which fails loudly on its own.
const DENIED = new Set(["EACCES", "EPERM"]);

/**
 * Assert the job user can read its own inputs, before any spend (issue #341, INT-RUNNER-EXIT-CODE-PROTOCOL).
 *
 * On a daemon that enforces bind-mount ownership, the host's per-job dir is a 0700 `mkdtemp` owned by the
 * worker, so a job user with any other uid cannot even traverse `/job`. Without this check that surfaces three
 * different ways, none of them honest: a prompt job reports "missing job input" (existsSync answers false for a
 * file it may not look at), a COMMAND job never reads prompt.md at all, and the loader existsSync-gates
 * `/job/trigger-skills`, so the job's own skills silently vanish and the job spends anyway.
 *
 * Every job runs it, prompt or command, over `/job` and the operator's overlay at `/opt/pi-global` (the loader
 * existsSync-gates the overlay too, so an untraversable one would drop the operator's models and skills without a
 * word). An absent dir is not this check's business: `/job`'s absence is the prompt read's fault to name, and an
 * absent overlay is simply not configured, which also keeps the image's own "missing job input" contract steps
 * meaningful.
 */
export function assertJobInputsReadable(dirs, { accessCode = defaultAccessCode, uid = process.getuid?.() } = {}) {
	for (const dir of [dirs].flat()) {
		if (DENIED.has(accessCode(dir, constants.R_OK | constants.X_OK))) {
			throw configError(`job inputs are not readable by the job user (uid ${uid}): ${dir}`, "job-inputs-unreadable");
		}
	}
}

/**
 * Read the prompt, naming WHY it could not be read.
 *
 * A missing prompt file is a worker bug (it failed to write /job inputs), not infra -- the same job would fail
 * identically on retry, so it is config, exit 2. An unreadable one is the uid fault `assertJobInputsReadable`
 * exists for, reached here when the directory is traversable but the file is not; it carries the same reason.
 */
export function readPrompt(path, { readFile = (p) => readFileSync(p, "utf8"), uid = process.getuid?.() } = {}) {
	try {
		return readFile(path);
	} catch (err) {
		if (err?.code === "ENOENT") throw configError(`missing job input: ${path}`);
		if (DENIED.has(err?.code)) {
			throw configError(`job inputs are not readable by the job user (uid ${uid}): ${path}`, "job-inputs-unreadable");
		}
		throw err;
	}
}

// Mount roots a HOME must never sit under: pi writes auth.json and every CLI writes its caches into HOME, and a
// HOME inside a mount lands them in the operator's folder, the job inputs or the transcript store.
export const HOME_FORBIDDEN_ROOTS = Object.freeze(["/workspace", "/job", "/outbox", "/session"]);

/**
 * The advisory lines a job's mounts earn, as `[event, fields]` pairs for the caller to log (issue #341).
 *
 * ADVISORY, never an exit: each describes a job that runs today and may be doing exactly what its trigger wants
 * (a read-only review of a folder the job user cannot write is a legitimate job). What they buy is that the
 * reason a write later fails is already in the log, instead of an EACCES from deep inside a tool.
 *
 *   - `workspace_not_writable` / `outbox_not_writable`: the mount exists and this uid may not write it.
 *   - `home_not_writable` / `agent_dir_not_writable`: pi swallows the auth-lock failure (measured: a job with HOME=/
 *     still reaches "no configured auth"), so an unwritable HOME or `~/.pi/agent` otherwise shows up only as a
 *     playwright, npm or gh failure later, or a credential that is never saved.
 *   - `home_under_mount`: HOME inside a mount root. Podman gives a `--user` with no passwd entry HOME=/workspace
 *     (measured), which would put auth.json into the operator's repository as an untracked file.
 *
 * Fields carry paths and the uid only, never content.
 */
export function mountAdvisories({ env = process.env, uid = process.getuid?.(), accessCode = defaultAccessCode } = {}) {
	// The env, not a `home` default: a default parameter cannot express "HOME is unset", which is a case this names.
	// env-internal HOME: the container's own home, set by the image's passwd entry or on the command line beside `--user`;
	// read here only to report whether it is usable, never chosen.
	const home = env.HOME;
	const out = [];
	for (const [path, event] of [["/workspace", "workspace_not_writable"], ["/outbox", "outbox_not_writable"]]) {
		const code = accessCode(path, constants.W_OK);
		if (code !== null && code !== "ENOENT") out.push([event, { path, uid, code }]);
	}
	if (typeof home === "string" && home !== "") {
		if (HOME_FORBIDDEN_ROOTS.some((root) => home === root || home.startsWith(`${root}/`))) {
			out.push(["home_under_mount", { home, uid }]);
		}
		const code = accessCode(home, constants.W_OK);
		if (code !== null) out.push(["home_not_writable", { home, uid, code }]);
		// The one dir pi writes its credentials into. A writable HOME with a root-owned agent dir under it is the exact
		// case pi's swallowed lock failure hides; absent is fine, pi creates it.
		const agentDir = `${home.replace(/\/+$/, "")}/.pi/agent`;
		const agentCode = accessCode(agentDir, constants.W_OK);
		if (agentCode !== null && agentCode !== "ENOENT") out.push(["agent_dir_not_writable", { path: agentDir, uid, code: agentCode }]);
	} else {
		out.push(["home_not_writable", { home: home ?? null, uid, code: "UNSET" }]);
	}
	return out;
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
export function assertPackagePathsExist(paths, { fileExists = existsSync, accessCode = defaultAccessCode, uid = process.getuid?.() } = {}) {
	for (const path of paths) {
		// Asked before existence, for the same reason as the session assert: `existsSync` answers false for a path
		// this uid may not look at, which would name a mounted package as never mounted (issue #341).
		if (DENIED.has(accessCode(path, constants.X_OK))) {
			throw configError(`staged package path is not readable by the job user (uid ${uid}): ${path} (PI_PACKAGES)`, "job-inputs-unreadable");
		}
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
// env-internal PI_OFFLINE: the worker sets it on the container and this function then forces it, so it
// states what the sandbox already is rather than choosing it. Reserved by name, so `run.secrets` cannot bind it.
export function enforceOfflineMode(env = process.env) {
	if (env.PI_OFFLINE === "1") return;
	env.PI_OFFLINE = "1";
}
