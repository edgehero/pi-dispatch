/**
 * Worker configuration, from the environment. Validated and fail-loud: a misconfigured worker
 * should refuse to start with a clear message, not launch and fail per-job.
 *
 * Errors are tagged `piDispatchConfig` so the CLI/entry can print them cleanly and exit non-zero.
 */

import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { DEFAULT_EGRESS_PROXY, egressArmed } from "./egress.mjs";
import { MINTED_TOKEN_VARS } from "./forges.mjs";
import { parseSecretProfiles } from "./secret-profiles.mjs";
import { WAIT_INTERVAL_FLOOR_MS, parseWaitProfiles } from "./wait-for.mjs";

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

/**
 * Names the WORKER holds that must never reach a job container, for a different reason than the minted
 * ones above: nothing overrides them, they simply do not belong in there.
 *
 * `GITHUB_APP_PRIVATE_KEY` is the App's signing key. It mints installation tokens for every repository
 * the App is installed on, with no expiry of its own -- so forwarding it hands an agent that is reading
 * adversarial issue text something strictly worse than the per-job token the whole of
 * `CONST-TOKEN-SCOPED-PER-JOB` exists to bound. This became reachable the moment the key could be an
 * environment value at all (issue #208); before that, `PI_FORWARD_ENV` could only have carried the PATH.
 *
 * `GITHUB_APP_PRIVATE_KEY_PATH` is deliberately NOT here: a path string with no mount behind it is inert
 * inside a container, and refusing harmless things is how a refusal stops being read.
 *
 * Kept separate from `MINTED_TOKEN_VARS`, which is defined as "every name any forge's mint can write"
 * and derived from the forge table. This is not that, and folding it in would make that definition a lie.
 */
export const WORKER_ONLY_SECRET_VARS = new Set(["GITHUB_APP_PRIVATE_KEY"]);

/**
 * The proxy variables the egress policy writes into the closed container env (REQ-EGRESS-ALLOWLIST).
 * Refused in `PI_FORWARD_ENV` only WHILE THE POLICY IS ARMED, and the conditionality is the point: with
 * no policy these are an ordinary operator escape hatch, and `docs/egress.md` still documents the manual
 * form that uses them. With a policy, a forwarded value would point every job at an operator's own proxy
 * instead of the one the worker attached to the network -- and it would read exactly like the control
 * working, which is the failure class this file already refuses for the minted token.
 */
export const EGRESS_ENV_VARS = new Set(["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY"]);

function forwardEnvList(raw, egressArmed = false) {
	const names = commaList(raw);
	const minted = names.filter((n) => MINTED_TOKEN_VARS.has(n));
	if (minted.length > 0) {
		throw configError(
			`PI_FORWARD_ENV must not forward ${minted.join(", ")} -- the worker mints a per-job token (CONST-TOKEN-SCOPED-PER-JOB) and a forwarded operator token would silently override it`,
		);
	}
	const workerOnly = names.filter((n) => WORKER_ONLY_SECRET_VARS.has(n));
	if (workerOnly.length > 0) {
		throw configError(
			`PI_FORWARD_ENV must not forward ${workerOnly.join(", ")} -- the App's signing key mints tokens for every repository the App is installed on, and a job container is the last place it belongs (CONST-TOKEN-SCOPED-PER-JOB)`,
		);
	}
	const egress = egressArmed ? names.filter((n) => EGRESS_ENV_VARS.has(n)) : [];
	if (egress.length > 0) {
		throw configError(
			`PI_FORWARD_ENV must not forward ${egress.join(", ")} while the egress policy is armed -- it sets them itself, pointing at the proxy on this job's network, and a forwarded value would silently redirect every job while looking like the control working (REQ-EGRESS-ALLOWLIST). Set PI_EGRESS=0 to use your own proxy: docs/egress.md`,
		);
	}
	return names;
}

/**
 * PI_EGRESS (REQ-EGRESS-ALLOWLIST). The parse itself lives in egress.mjs, because `doctor` and `up` read
 * the environment directly and three copies of one default is two chances to flip it in the wrong number
 * of places. Here it only gains the `piDispatchConfig` tag, so a bad value prints as a config error and
 * the worker refuses to boot rather than guessing a security posture.
 */
function egressEnabled(env) {
	try {
		return egressArmed(env);
	} catch (error) {
		throw configError(error.message);
	}
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
		// REQ-EGRESS-ALLOWLIST. `egress` gates the whole feature; `egressProxy` names the component the
		// per-job network is built around. Read BEFORE forwardEnv below, because the forward list's refusal
		// of the proxy variables is conditional on it.
		egress: egressEnabled(env),
		egressProxy: env.PI_EGRESS_PROXY || DEFAULT_EGRESS_PROXY, // || (not ??) so an empty string falls back
		forwardEnv: forwardEnvList(env.PI_FORWARD_ENV, egressEnabled(env)), // extra host var NAMES to forward (e.g. a custom provider's key); explicit allowlist, GitHub token names refused
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
		scopedLimitsFile: env.PI_SCOPED_LIMITS_FILE ?? null, // issue #242: per-scope run caps + concurrency (INT-SCOPED-LIMITS-FILE-CONTRACT); null = none. The one-job-per-folder mutex for local jobs is code, not configuration, and holds regardless
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
		// How old the CONVERSATION may be, which is a different clock from sessionsTtlDays above and not a
		// finer setting of it: the TTL reads the transcript's mtime, which the PROMOTE rename refreshes (the
		// resolve copy does not, measured -- copyFileSync stamps the destination), so it measures time since
		// the last COMPLETED run on this key. A key whose runs keep completing never expires however old its
		// first turn is. This one reads the session header's own timestamp.
		// OFF by default (0) rather than defaulted to a number: an age an operator did not choose is an
		// opinion about their lineages that this project has no basis for.
		sessionMaxAgeDays: nonNegativeInt(env, "PI_SESSION_MAX_AGE_DAYS", 0), // 0 = no age bound
		// How many times in a row one key may be resumed before the next job starts fresh. The bound a long
		// lineage actually needs: age and size both grow slowly while a chain grows once per run.
		sessionMaxResumeChain: nonNegativeInt(env, "PI_SESSION_MAX_RESUME_CHAIN", 0), // 0 = no chain bound
		// How full the saved context may be before a resume is refused, as a percentage of the model's own
		// window. A PERCENTAGE, so `optionalBoundedInt` on softHoldPct's precedent rather than the 0 = off
		// sentinel its two neighbours use: 0% would mean "never resume anything", which is a different
		// request from "no bound", and 101 is a typo rather than a ceiling.
		sessionMaxContextPct: optionalBoundedInt(env, "PI_SESSION_MAX_CONTEXT_PCT", 1, 100), // null = no context bound
		chainDepthMax: nonNegativeInt(env, "PI_CHAIN_DEPTH_MAX", CHAIN_DEPTH_MAX_DEFAULT), // DES-JOB-OUTBOX-CHAINING; 0 = chaining kill-switch (fail-closed)
		chainMaxPerJob: nonNegativeInt(env, "PI_CHAIN_MAX_PER_JOB", CHAIN_MAX_PER_JOB_DEFAULT), // INT-OUTBOX-CONTRACT: max request-<n>.json collected per parent
		dispatchRunPerHour: nonNegativeInt(env, "PI_DISPATCH_RUN_PER_HOUR", 3), // DES-ADMIN-VIA-PI-EXTENSION; 0 = disable dispatch_run
		dispatchRunRoots: delimitedList(env.PI_DISPATCH_RUN_ROOTS), // DES-AI-TRIGGER-FLOW-GATE: default [] fails closed — no folder passes, dispatch_run refuses everything
		// REQ-TRIGGER-SECRETS. The operator's declared resolvers, `name:absolute-path` pairs, comma separated.
		// Each entry splits on its FIRST colon so a Windows `C:\...` path survives -- the same drive-letter
		// hazard `delimitedList` above exists for, arriving from the other side. Unset = the feature is off and
		// any trigger naming secrets refuses pre-spend, which is why there is no default profile to fall into.
		secretProfiles: parseSecretProfiles(env.PI_SECRET_PROFILES),
		// The directories a resolver may live in. Default [] FAILS CLOSED exactly as dispatchRunRoots does, and
		// for a sharper version of its reason: this bounds paths that can arrive from the settings overlay,
		// which is not the reviewed artifact `triggers.json` is. Unset means the panel can declare no profile
		// at all and only PI_SECRET_PROFILES above is honoured. Env-only, never the overlay and never the
		// deployment pointer: `deployment-pointer.mjs` already refuses to carry PI_DISPATCH_RUN_ROOTS
		// "because a pointer that could widen the AI-run folder allowlist would be a second, unreviewed door",
		// and a bound that can be widened from the surface it bounds is not a bound.
		secretResolverRoots: delimitedList(env.PI_SECRET_RESOLVER_ROOTS),
		// Per-reference ceiling. Tighter than doctor's 30s on purpose: this runs before a paid container, is
		// multiplied by the reference count, and holds a PI_CONCURRENCY slot while it waits.
		secretResolveTimeoutMs: positiveInt(env, "PI_SECRET_RESOLVE_TIMEOUT_MS", 10000),
		// Issue #230, `run.waitFor`. The operator's declared wait checks, same `name:absolute-path` grammar as
		// the resolvers above and deliberately a SEPARATE variable: the two answer different questions (one
		// fetches a value, one says whether to go), they will grow different bounds, and one list would make a
		// resolver reachable as a gate and a gate reachable as a resolver. Unset = the feature is off and any
		// trigger naming a profile refuses pre-spend. There is no `PI_WAIT_RESOLVER_ROOTS` twin because there
		// is no overlay half to bound: the wait gate runs ABOVE the per-job settings read, so a wait profile
		// can only ever be declared here, beside the forge tokens.
		waitProfiles: parseWaitProfiles(env.PI_WAIT_PROFILES),
		// Per-check ceiling, `secretResolveTimeoutMs`' twin and for its reason: this runs before a paid
		// container and holds a PI_CONCURRENCY slot while it waits.
		waitCheckTimeoutMs: positiveInt(env, "PI_WAIT_CHECK_TIMEOUT_MS", 10000),
		// The base re-check cadence, clamped UP to the floor rather than refused (wait-for.mjs states why, and
		// what the clamp does not cover). The backoff derives from elapsed time, so this is a base, not a period.
		waitIntervalMs: Math.max(WAIT_INTERVAL_FLOOR_MS, positiveInt(env, "PI_WAIT_INTERVAL_MS", 60_000)),
		// How long a PROFILE hold may last before it terminates with a named reason. A dependency, unlike a
		// pause window, is not self-terminating by construction, so this is the bound that makes it one.
		waitMaxMs: positiveInt(env, "PI_WAIT_MAX_MS", 24 * 3600 * 1000),
		// The separate, far larger ceiling on an `after` instant. Deliberately NOT waitMaxMs: an `after` is a
		// scheduled instant, not a poll -- one exact moveToDelayed, self-terminating, costing nothing while it
		// waits -- so bounding it by the polling budget would refuse "hold this until the maintenance window
		// next month" for a reason that is about subprocesses it never runs.
		waitAfterMaxMs: positiveInt(env, "PI_WAIT_AFTER_MAX_MS", 30 * 24 * 3600 * 1000),
		// How many wait checks may run AT ONCE in this worker process. One by default, and the ceiling it
		// really pins is duty cycle: slots x timeout is the most wall-clock a worker can spend answering
		// questions instead of running paid jobs. Clamped below PI_CONCURRENCY at the gate so a check can
		// never take the last free slot.
		waitCheckSlots: positiveInt(env, "PI_WAIT_CHECK_SLOTS", 1),
		// Two bounds on ONE job's checks, both logged on overflow. The count bound is SECRETS_MAX's argument
		// applied over time rather than over a map, and it matters because nothing in the money system sees a
		// check at all: CONST-BUDGET-BEFORE-TOKENS counts container starts. The fault bound is what makes a
		// broken check loud in minutes instead of silent for a day (OQ-027: most CLIs exit 1 for everything).
		waitMaxChecks: positiveInt(env, "PI_WAIT_MAX_CHECKS", 96),
		waitMaxFaults: positiveInt(env, "PI_WAIT_MAX_FAULTS", 5),
		github: { ...loadGitHubAuth(env, fileExists), allowGhResume: env.PI_SESSIONS_ALLOW_GH_SOURCE === "1" },
		gitlab: loadGitLabAuth(env),
		forgejo: loadForgejoAuth(env),
		azure: loadAzureAuth(env),
	};
}

/**
 * Normalise an inline App private key, or refuse it. Returns `null` for absent/blank (an empty
 * `GITHUB_APP_PRIVATE_KEY=` line in a scaffolded .env means "unset", never "a key that is empty").
 *
 * ONE normalisation rule, and it is unambiguous rather than lenient: a PEM contains no backslash, so a
 * value carrying literal `\n` escapes and no real newline can only be a flattened key -- which is what a
 * .env line and most secrets-manager UIs produce, since neither can hold a multi-line value. Anything
 * else is passed through untouched.
 *
 * Then the shape is CHECKED, because the alternative is a deployment that boots clean and dies at its
 * first mint with a crypto error naming nothing. A truncated paste fails here instead.
 *
 * The value NEVER appears in a refusal message. That is the whole reason this is a function rather than
 * three lines inline: one place to get that right, and one place to test it.
 */
export function normalizeAppPrivateKey(raw) {
	const value = typeof raw === "string" ? raw.trim() : "";
	if (value === "") return null;
	const pem = value.includes("\\n") && !value.includes("\n") ? value.replace(/\\n/g, "\n") : value;
	const begins = /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(pem);
	const ends = /-----END [A-Z0-9 ]*PRIVATE KEY-----$/.test(pem.trimEnd());
	if (!begins || !ends) {
		throw configError(
			"GITHUB_APP_PRIVATE_KEY is not a PEM private key -- expected it to begin `-----BEGIN ... PRIVATE KEY-----` and end `-----END ... PRIVATE KEY-----` (the value itself is deliberately not shown; check for a truncated paste, or use GITHUB_APP_PRIVATE_KEY_PATH)",
		);
	}
	return pem;
}

/**
 * Parse and validate the GitHub auth block consumed verbatim by `makeGitHubAuth(cfg)` in
 * get-token.mjs. Shape is fixed: `{ source, patVar, appId, installationId, privateKeyPath, privateKey }`.
 * Fails loud at load time so a misconfigured worker refuses to boot rather than failing per-job.
 *
 * `privateKey` carries KEY MATERIAL when the operator supplied it inline, so nothing may serialise this
 * block: its three consumers (start.mjs, cli.mjs, sandbox-cli.mjs) pass it along and never print it, and
 * that is a property to keep rather than a coincidence to rely on.
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
	// Blank counts as unset on BOTH, so a scaffolded `.env` full of empty keys never shadows the one an
	// operator actually set.
	const inlineKey = (env.GITHUB_APP_PRIVATE_KEY ?? "").trim();
	const keyPathSet = (privateKeyPath ?? "").trim() !== "";
	let privateKey = null;

	if (source === "pat") {
		const pat = (env[patVar] ?? "").trim();
		if (!pat) {
			throw configError(`GITHUB_AUTH_SOURCE=pat requires a non-empty ${patVar}`);
		}
	}

	if (source === "app") {
		// Both set is a REFUSAL, not a precedence rule. A precedence rule means two places hold the App's
		// signing key, they disagree eventually, and the deployment keeps working with whichever one this
		// function happened to prefer -- which is exactly the class of surprise every other credential
		// decision in this file forecloses.
		if (inlineKey !== "" && keyPathSet) {
			throw configError(
				"GITHUB_APP_PRIVATE_KEY and GITHUB_APP_PRIVATE_KEY_PATH are both set -- supply the App key exactly once (the inline value for a secrets manager, the path for a key on disk)",
			);
		}
		const missing = [];
		if (!appId) missing.push("GITHUB_APP_ID");
		if (!installationId) missing.push("GITHUB_APP_INSTALLATION_ID");
		if (inlineKey === "" && !keyPathSet) missing.push("GITHUB_APP_PRIVATE_KEY_PATH (or GITHUB_APP_PRIVATE_KEY)");
		if (missing.length > 0) {
			throw configError(`GITHUB_AUTH_SOURCE=app requires ${missing.join(", ")}`);
		}
		if (inlineKey !== "") {
			privateKey = normalizeAppPrivateKey(inlineKey);
		} else if (!fileExists(privateKeyPath)) {
			// Only when the PATH is the chosen source: an inline deployment has no key file to check, which
			// is the entire point of the variable (docs/secrets.md).
			throw configError(`GITHUB_APP_PRIVATE_KEY_PATH does not exist: ${privateKeyPath}`);
		}
	}

	return { source, patVar, appId, installationId, privateKeyPath, privateKey };
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

export function defaultGraphDir(env = process.env) {
	// Under the OS temp dir by default, beside logs/ and jobs/ -- the admin's graph HTML artifact
	// (issue #54) is host-side display output on the defaultLogsDir doctrine, and deliberately NOT
	// inside logsDir: INT-RUN-HISTORY-FILE-CONTRACT names that directory's filename shape, and a
	// stray .html beside the sidecars would widen a contract for a file that is not a record.
	// Overridable with PI_GRAPH_DIR; exported so the admin resolves the same default without
	// loadConfig, like defaultSandboxDir above.
	return `${env.TMPDIR ?? env.TEMP ?? "/tmp"}/pi-dispatch/graph`.replace(/\\/g, "/");
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
