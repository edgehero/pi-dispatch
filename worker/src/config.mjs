/**
 * Worker configuration, from the environment. Validated and fail-loud: a misconfigured worker
 * should refuse to start with a clear message, not launch and fail per-job.
 *
 * Errors are tagged `piDispatchConfig` so the CLI/entry can print them cleanly and exit non-zero.
 */

import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { MINTED_TOKEN_VARS } from "./forges.mjs";

export function configError(message) {
	const error = new Error(message);
	error.piDispatchConfig = true;
	return error;
}

// The chain caps' DEFAULTS, exported (issue #54) so the admin's read-model can state them without a
// second literal to drift and without calling loadConfig, whose GitHub-auth validation throws on
// problems unrelated to a path read (the documented reason resolvePaths never calls it). The env
// OVERRIDES stay right here in loadConfig; only the defaults are shared.
export const CHAIN_DEPTH_MAX_DEFAULT = 1; // DES-JOB-OUTBOX-CHAINING; 0 = chaining kill-switch (fail-closed)
export const CHAIN_MAX_PER_JOB_DEFAULT = 2; // INT-OUTBOX-CONTRACT: max request-<n>.json collected per parent

function boundedInt(env, name, fallback, min, want) {
	const raw = env[name];
	if (raw === undefined || raw === "") {
		if (fallback !== undefined) return fallback;
		throw configError(`missing required env: ${name}`);
	}
	const n = Number.parseInt(raw, 10);
	if (!Number.isInteger(n) || n < min || String(n) !== String(raw).trim()) {
		throw configError(`invalid ${name}: ${JSON.stringify(raw)} (want ${want})`);
	}
	return n;
}

export function positiveInt(env, name, fallback) {
	return boundedInt(env, name, fallback, 1, "a positive integer");
}

// min=0: accepts 0 (a sentinel, e.g. "keep forever" for log retention), still rejects negatives and non-integers.
function nonNegativeInt(env, name, fallback) {
	return boundedInt(env, name, fallback, 0, "a non-negative integer");
}

// An OPTIONAL bounded int: an unset or empty var is `null` (the feature it gates is disabled), a present
// one is validated in `[min, max]` (max undefined = no upper bound) and otherwise a config error. Unlike
// `boundedInt`, absence is a first-class "off", not a fallback default -- used by the optional week/month
// spend ceilings and the soft-hold band, which default to disabled rather than to a number.
function optionalBoundedInt(env, name, min, max) {
	const raw = env[name];
	if (raw === undefined || raw === "") return null;
	const n = Number.parseInt(raw, 10);
	const inRange = Number.isInteger(n) && n >= min && (max === undefined || n <= max) && String(n) === String(raw).trim();
	if (!inRange) {
		const want = max === undefined ? `an integer >= ${min}` : `an integer ${min}-${max}`;
		throw configError(`invalid ${name}: ${JSON.stringify(raw)} (want ${want})`);
	}
	return n;
}

// Split a PATH-style list on the OS path delimiter (`;` on Windows, `:` elsewhere) so a Windows
// drive-letter colon is not mistaken for a separator. Trims, drops empties. Entries are stored
// verbatim; downstream (task 3.1) realpaths them, so no posix normalisation happens here.
function delimitedList(raw) {
	return (raw ?? "")
		.split(delimiter)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

// A comma-separated list of NAMES (env var names cannot contain commas, so unlike a path list this
// splits on ",", not the OS path delimiter). Used by PI_FORWARD_ENV.
function commaList(raw) {
	return (raw ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

// PI_FORWARD_ENV, with the token names the worker itself owns refused at boot. env-allowlist.mjs sets
// them from the per-job mint; forwarding one from the host would silently swap which credential every job
// spends, so this fails loud here rather than per-job.
//
// Derived from the forge table rather than written out, because this list and the mint that writes those
// names have to agree and used to be two hand-maintained lists twenty lines apart in different files. A
// forge added to the mint but missed here is not refused -- so an operator could forward a long-lived host
// token under that name into every container of every forge, with nothing failing and nothing logged.
// `forges.mjs` derives both from one row, and `env-allowlist.test.mjs` binds them.

function forwardEnvList(raw) {
	const names = commaList(raw);
	const minted = names.filter((n) => MINTED_TOKEN_VARS.has(n));
	if (minted.length > 0) {
		throw configError(
			`PI_FORWARD_ENV must not forward ${minted.join(", ")} -- the worker mints a per-job token (CONST-TOKEN-SCOPED-PER-JOB) and a forwarded operator token would silently override it`,
		);
	}
	return names;
}

// The operator's global pi overlay dir (REQ-GLOBAL-PI-OVERLAY). Unset/empty = feature off. When set it
// must EXIST at boot -- a typo pointing at nothing would silently drop the operator's whole setup on
// every job, so fail loud like every other config error rather than degrade to nothing.
function resolveGlobalPiDir(env, fileExists) {
	const dir = env.PI_GLOBAL_PI_DIR;
	if (dir === undefined || dir === "") return null;
	if (!fileExists(dir)) throw configError(`PI_GLOBAL_PI_DIR does not exist: ${dir}`);
	return dir;
}

/**
 * Does the overlay's `extensions/` dir load in job containers (REQ-GLOBAL-PI-OVERLAY)?
 *
 * ON by default. The operator vetted this code twice already -- once by having it in their own `~/.pi/agent`,
 * once by staging it into the overlay with `import-pi` -- so a third gate is friction, not safety, and the
 * setup they staged is the setup a job should get. `PI_GLOBAL_ALLOW_EXTENSIONS` survives only as the
 * opt-OUT: the exact string "0" disables them. Unset, empty, and the legacy "1" all mean LOAD, so an .env
 * that still carries the old arming flag keeps working and says the same thing it always did.
 *
 * Any OTHER value is a config error, not a default in either direction. The strict-parse discipline is
 * unchanged, but the thing it now defends against has flipped: under the old fail-closed reading a typo
 * degraded to "dormant", which was merely disappointing; now the damaging misreading is "the operator
 * believes they turned extensions off and they are still loading into every adversarial-input container".
 * `PI_GLOBAL_ALLOW_EXTENSIONS=false` must therefore refuse to boot rather than be quietly ignored. "0" is
 * the canonical opt-out because it is the exact inverse of the "1" already written in existing .env files
 * and matches the single-character discipline of PI_AUTH_FROM_PI=0 / PI_CAPTURE_JOB_LOGS=1.
 *
 * Exported so `doctor` reports the same reading the worker will boot with (it deliberately re-reads env
 * defaults rather than calling loadConfig, which throws on unrelated GitHub-auth problems).
 */
export function globalExtensionsEnabled(env) {
	const raw = env.PI_GLOBAL_ALLOW_EXTENSIONS;
	if (raw === undefined || raw === "" || raw === "1") return true;
	if (raw === "0") return false;
	throw configError(
		`invalid PI_GLOBAL_ALLOW_EXTENSIONS: ${JSON.stringify(raw)} (want "0" to disable the overlay's extensions, or leave it unset to load them)`,
	);
}

/**
 * Parse the worker's config from `env` (default process.env). Every MONEY default is conservative:
 * spend controls (`PI_DAILY_CAP`, `PI_MAX_TURNS`) exist to bound money, so they default low, and a
 * cap of 0 would fail closed (budget.mjs refuses every job) rather than mean "unlimited". The optional
 * week/month ceilings and the soft-hold band default to disabled (`null`) -- the mandatory daily cap is
 * always the primary money bound; the others are additive ceilings an operator opts into.
 *
 * The operator's OWN staged setup is the deliberate exception: `allowGlobalExtensions` defaults to ON
 * (REQ-GLOBAL-PI-OVERLAY). Staging is itself the vetting step, so the overlay an operator built is the
 * overlay their jobs get, and the knob is an opt-out. That relaxation stops there -- it never touches the
 * spend caps above, the per-job token scoping, or the admin-extension recursion block.
 */
export function loadConfig(env = process.env, { fileExists = existsSync } = {}) {
	const model = env.PI_MODEL ?? "claude-sonnet-4-5-20250929"; // dated snapshot; deterministic per CONST-PI-VERSION-PINNED
	return {
		valkeyUrl: env.VALKEY_URL ?? "redis://127.0.0.1:6379",
		concurrency: positiveInt(env, "PI_CONCURRENCY", 3), // DES-CONCURRENCY-3
		dailyCap: positiveInt(env, "PI_DAILY_CAP", 25), // bounds container STARTS per day (money)
		weeklyCap: optionalBoundedInt(env, "PI_WEEKLY_CAP", 1), // REQ-SPEND-CAPS-MULTI-WINDOW; null = weekly window disabled
		monthlyCap: optionalBoundedInt(env, "PI_MONTHLY_CAP", 1), // null = monthly window disabled
		softHoldPct: optionalBoundedInt(env, "PI_SOFT_HOLD_PCT", 1, 99), // null = soft-hold band disabled
		provider: env.PI_PROVIDER ?? "anthropic",
		model,
		maxTurns: positiveInt(env, "PI_MAX_TURNS", 30), // pi has no turn limit; we impose one
		maxTokens: optionalBoundedInt(env, "PI_MAX_TOKENS", 1), // issue #25; null = per-job token budget disabled (lagging in-run backstop)
		dailyTokenCap: optionalBoundedInt(env, "PI_DAILY_TOKEN_CAP", 1), // issue #25; null = daily token counter disabled (check-AFTER, host-side)
		jobImage: env.PI_JOB_IMAGE || "pi-job:latest", // || (not ??) so an empty string falls back; "" is falsy and would throw inside buildDockerRunArgs AFTER a budget slot was reserved
		globalPiDir: resolveGlobalPiDir(env, fileExists), // REQ-GLOBAL-PI-OVERLAY: operator's ~/.pi/agent subset, :ro-mounted; null = off
		allowGlobalExtensions: globalExtensionsEnabled(env), // REQ-GLOBAL-PI-OVERLAY: ON unless PI_GLOBAL_ALLOW_EXTENSIONS=0
		forwardEnv: forwardEnvList(env.PI_FORWARD_ENV), // extra host var NAMES to forward (e.g. a custom provider's key); explicit allowlist, GitHub token names refused
		authFromPi: env.PI_AUTH_FROM_PI !== "0", // ON by default: use the key in ~/.pi/agent/auth.json when the env has none (api-key only). PI_AUTH_FROM_PI=0 forces env-only.
		jobsDir: env.PI_JOBS_DIR ?? defaultJobsDir(),
		// REQ-RESURRECTABLE-SANDBOX. `||` (not `??`) so an empty string falls back, matching logsDir.
		sandboxDir: env.PI_SANDBOX_DIR || defaultSandboxDir(env),
		// Hours a finished run's directory stays re-openable. NOTE THE SENTINEL, which is the OPPOSITE of
		// logRetentionDays' and sessionsTtlDays': 0 means the feature is OFF (nothing is retained, cleanup
		// is the `rm` it always was), NOT keep-forever. There is deliberately no keep-forever value -- a
		// full repository clone per run with no ceiling is a disk bomb, and `--pin` exists for the one run
		// worth keeping longer, bounded by sandboxPinDays.
		sandboxRetentionHours: nonNegativeInt(env, "PI_SANDBOX_RETENTION_HOURS", 24),
		sandboxPinDays: nonNegativeInt(env, "PI_SANDBOX_PIN_DAYS", 7), // `--pin` extends to now + this, never to forever
		sandboxIdleMinutes: nonNegativeInt(env, "PI_SANDBOX_IDLE_MINUTES", 30), // bash's own TMOUT inside a sandbox; 0 = no idle logout
		triggersFile: env.PI_TRIGGERS_FILE ?? null, // DES-CRON-VIA-BULLMQ-SCHEDULER: unified triggers file; null = cron disabled for the worker (it selects on.type:"cron")
		pauseWindowsFile: env.PI_PAUSE_WINDOWS_FILE ?? null, // REQ-SCOPED-PAUSE-WINDOWS: per-folder/repo timed pause; null = no scoped pauses
		schedulerStallMax: positiveInt(env, "PI_SCHEDULER_STALL_MAX", 2), // CONST-RETRY-INFRA-ONLY: per-scheduler stall backstop; positiveInt rejects <1 so a 0 threshold fails closed
		logsDir: env.PI_LOGS_DIR || defaultLogsDir(), // || (not ??) so an empty string falls back to the default
		settingsFile: env.PI_SETTINGS_FILE || defaultSettingsFile(), // || (not ??) so an empty string falls back; INT-CONFIG-OVERLAY-CONTRACT
		captureJobLogs: env.PI_CAPTURE_JOB_LOGS === "1", // no-pii-in-logs: raw job-log capture is opt-in; anything but "1" is off
		logRetentionDays: nonNegativeInt(env, "PI_LOG_RETENTION_DAYS", 30), // 0 = keep forever
		// REQ-RESUMABLE-SESSION. NO DEFAULT, deliberately unlike logsDir/jobsDir: unset means the feature
		// is unavailable, and a trigger that armed run.resume then refuses PRE-SPEND rather than running
		// silently without persistence. A transcript is the most PII-bearing artifact this system holds --
		// tool output, file contents, the agent's own reasoning -- and defaulting it into <OS temp>, which
		// is mode 1777 on POSIX, is not a place to put that by accident.
		sessionsDir: env.PI_SESSIONS_DIR || null,
		sessionsTtlDays: nonNegativeInt(env, "PI_SESSIONS_TTL_DAYS", 14), // 0 = keep forever
		// A bound on how large a transcript may be before it stops being resumed. Not disk hygiene: an
		// oversized transcript is a prefill an operator never sized PI_MAX_TOKENS for.
		sessionMaxBytes: nonNegativeInt(env, "PI_SESSION_MAX_BYTES", 8 * 1024 * 1024), // 0 = no cap
		chainDepthMax: nonNegativeInt(env, "PI_CHAIN_DEPTH_MAX", CHAIN_DEPTH_MAX_DEFAULT), // DES-JOB-OUTBOX-CHAINING; 0 = chaining kill-switch (fail-closed)
		chainMaxPerJob: nonNegativeInt(env, "PI_CHAIN_MAX_PER_JOB", CHAIN_MAX_PER_JOB_DEFAULT), // INT-OUTBOX-CONTRACT: max request-<n>.json collected per parent
		dispatchRunPerHour: nonNegativeInt(env, "PI_DISPATCH_RUN_PER_HOUR", 3), // DES-ADMIN-VIA-PI-EXTENSION; 0 = disable dispatch_run
		dispatchRunRoots: delimitedList(env.PI_DISPATCH_RUN_ROOTS), // DES-AI-TRIGGER-FLOW-GATE: default [] fails closed — no folder passes, dispatch_run refuses everything
		github: { ...loadGitHubAuth(env, fileExists), allowGhResume: env.PI_SESSIONS_ALLOW_GH_SOURCE === "1" },
		gitlab: loadGitLabAuth(env),
		forgejo: loadForgejoAuth(env),
		azure: loadAzureAuth(env),
	};
}

/**
 * Parse and validate the GitHub auth block consumed verbatim by `makeGitHubAuth(cfg)` in
 * get-token.mjs. Shape is fixed: `{ source, patVar, appId, installationId, privateKeyPath }`.
 * Fails loud at load time so a misconfigured worker refuses to boot rather than failing per-job.
 */
export function loadGitHubAuth(env, fileExists) {
	const source = env.GITHUB_AUTH_SOURCE ?? "gh";
	if (source !== "pat" && source !== "gh" && source !== "app") {
		throw configError(`invalid GITHUB_AUTH_SOURCE: ${source} (expected pat|gh|app)`);
	}

	const patVar = env.GITHUB_PAT_VAR ?? "GITHUB_PAT";
	const appId = env.GITHUB_APP_ID;
	const installationId = env.GITHUB_APP_INSTALLATION_ID;
	const privateKeyPath = env.GITHUB_APP_PRIVATE_KEY_PATH;

	if (source === "pat") {
		const pat = (env[patVar] ?? "").trim();
		if (!pat) {
			throw configError(`GITHUB_AUTH_SOURCE=pat requires a non-empty ${patVar}`);
		}
	}

	if (source === "app") {
		const missing = [];
		if (!appId) missing.push("GITHUB_APP_ID");
		if (!installationId) missing.push("GITHUB_APP_INSTALLATION_ID");
		if (!privateKeyPath) missing.push("GITHUB_APP_PRIVATE_KEY_PATH");
		if (missing.length > 0) {
			throw configError(`GITHUB_AUTH_SOURCE=app requires ${missing.join(", ")}`);
		}
		if (!fileExists(privateKeyPath)) {
			throw configError(`GITHUB_APP_PRIVATE_KEY_PATH does not exist: ${privateKeyPath}`);
		}
	}

	return { source, patVar, appId, installationId, privateKeyPath };
}

function defaultJobsDir() {
	// Under the OS temp dir by default. Holds only the read-only /job inputs (prompt + .pi/); the
	// workspace for a local job is the operator's own folder, not here.
	return `${process.env.TMPDIR ?? process.env.TEMP ?? "/tmp"}/pi-dispatch/jobs`.replace(/\\/g, "/");
}

export function defaultSandboxDir(env = process.env) {
	// Beside the per-job dirs, because a retained directory IS a per-job dir -- `cleanup` renames it here
	// rather than copying, which only stays atomic while both live on one filesystem. Created mode 0700 by
	// the retention step, since the OS temp dir is 1777 on POSIX and a retained tree holds a repository
	// clone plus the run's prompt.md/event.json. Exported so the admin extension resolves the same default
	// without calling loadConfig, which throws on unrelated env problems.
	return `${env.PI_JOBS_DIR ?? defaultJobsDir()}/sandboxes`.replace(/\\/g, "/");
}

export function defaultLogsDir() {
	// Under the OS temp dir by default. Holds durable per-run history/log artifacts written host-side;
	// a worker-owned path that never enters the container env allowlist (no-broad-env-into-container).
	return `${process.env.TMPDIR ?? process.env.TEMP ?? "/tmp"}/pi-dispatch/logs`.replace(/\\/g, "/");
}

export function defaultSettingsFile() {
	// Under the OS temp dir by default. Holds the runtime-tunable settings overlay shared with the admin
	// extension (INT-CONFIG-OVERLAY-CONTRACT); a worker-owned path that never enters the container env
	// allowlist (no-broad-env-into-container). Exported so the admin extension resolves the same default
	// without calling loadConfig, which throws on unrelated env problems.
	return `${process.env.TMPDIR ?? process.env.TEMP ?? "/tmp"}/pi-dispatch/settings.json`.replace(/\\/g, "/");
}

/**
 * The worker's Azure DevOps auth config, or `null` when none is configured -- same presence rule as the
 * other two optional forges.
 */
export function loadAzureAuth(env) {
	const token = env.AZURE_TOKEN;
	if (typeof token !== "string" || token.trim() === "") return null;
	const source = env.AZURE_AUTH_SOURCE ?? "pat";
	if (source !== "pat") {
		throw configError(`AZURE_AUTH_SOURCE must be "pat" (got ${JSON.stringify(source)}) -- Azure DevOps has no App or installation-token equivalent, so there is no other source`);
	}
	const orgUrl = env.AZURE_ORG_URL;
	if (typeof orgUrl !== "string" || orgUrl.trim() === "") {
		throw configError("AZURE_ORG_URL is required when AZURE_TOKEN is set (e.g. https://dev.azure.com/your-org)");
	}
	return { source, orgUrl: orgUrl.trim().replace(/\/+$/, ""), tokenVar: "AZURE_TOKEN" };
}

/**
 * The worker's Forgejo auth config, or `null` when none is configured -- same presence rule as GitLab's.
 *
 * `FORGEJO_BOT_ID` rides here because a repository-scoped Forgejo token cannot call `GET /user`, so the
 * identity the bot-loop guard needs may have to be supplied rather than asked for (forgejo-identity.mjs).
 */
export function loadForgejoAuth(env) {
	const token = env.FORGEJO_TOKEN;
	if (typeof token !== "string" || token.trim() === "") return null;
	const source = env.FORGEJO_AUTH_SOURCE ?? "pat";
	if (source !== "pat") {
		throw configError(`FORGEJO_AUTH_SOURCE must be "pat" (got ${JSON.stringify(source)}) -- Forgejo has no App or installation-token equivalent, so there is no other source`);
	}
	const apiUrl = env.FORGEJO_URL;
	// No default instance, deliberately: Forgejo is self-hosted by nature and there is no forgejo.com to
	// fall back to. Guessing one would send an operator's token to a host they never named.
	if (typeof apiUrl !== "string" || apiUrl.trim() === "") {
		throw configError("FORGEJO_URL is required when FORGEJO_TOKEN is set -- there is no default Forgejo instance to fall back to");
	}
	return { source, apiUrl: apiUrl.trim(), tokenVar: "FORGEJO_TOKEN", botId: env.FORGEJO_BOT_ID ?? null };
}

/**
 * The worker's GitLab auth config, or `null` when no GitLab is configured -- in which case the forge is
 * simply absent from the map and a gitlab job refuses at mint time with a message naming what is missing.
 *
 * Only `pat` exists, and deliberately so: GitLab has no App equivalent, so there is no stronger source to
 * offer and no choice to make. The variable is still named `GITLAB_AUTH_SOURCE` for symmetry with
 * `GITHUB_AUTH_SOURCE`, so an operator reading .env.example finds the same shape on both sides.
 */
export function loadGitLabAuth(env) {
	const token = env.GITLAB_TOKEN;
	if (typeof token !== "string" || token.trim() === "") return null;
	const source = env.GITLAB_AUTH_SOURCE ?? "pat";
	if (source !== "pat") {
		throw configError(`GITLAB_AUTH_SOURCE must be "pat" (got ${JSON.stringify(source)}) -- GitLab has no App equivalent, so there is no other source`);
	}
	return { source, apiUrl: env.GITLAB_URL ?? "https://gitlab.com", tokenVar: "GITLAB_TOKEN" };
}
