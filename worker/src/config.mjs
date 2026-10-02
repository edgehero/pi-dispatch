/**
 * Worker configuration, from the environment. Validated and fail-loud: a misconfigured worker
 * should refuse to start with a clear message, not launch and fail per-job.
 *
 * Errors are tagged `piDispatchConfig` so the CLI/entry can print them cleanly and exit non-zero.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { delimiter, isAbsolute, posix } from "node:path";
import { DEFAULT_BACKEND, backendRefusals, parseBackendFloor, parseBackendList } from "./backends.mjs";
import { egressArmed, egressProxyName } from "./egress.mjs";
import { MINTED_TOKEN_VARS } from "./forges.mjs";
import { SWEEP_INTERVAL_HOURS, SWEEP_INTERVAL_MAX_HOURS } from "./retention-sweep.mjs";
import { parseSecretProfiles } from "./secret-profiles.mjs";
import { WAIT_AFTER_MAX_DEFAULT_MS, WAIT_INTERVAL_FLOOR_MS, parseWaitProfiles } from "./wait-for.mjs";
import { imageRefProblem } from "./image-ref.mjs";
import { CONTAINER_ENV_NAMES, KEYLESS_ENV_NAME } from "./reserved-env.mjs";
import { modelListProblem } from "./model-ref.mjs";
import { DOLLAR_ENV_NAMES, DOLLAR_WINDOW_KEYS, checkDollarInvariant, optionalUsdMicros } from "./money.mjs";

/**
 * The VALKEY_URL the worker uses when none is set. ONE constant (issue #503's review): doctor judges the model endpoints
 * file against this port too, and a doctor that read an unset VALKEY_URL as "no queue port" passed an endpoint on 6379
 * that the worker refuses. valkey-endpoint.mjs re-exports it.
 */
export const DEFAULT_VALKEY_URL = "redis://127.0.0.1:6379";

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

// The failure hook's command (issue #288). Unset/blank -> null (the feature is off). Set -> one
// ABSOLUTE path, verbatim; a relative path refuses at boot, because resolving it against a service
// manager's working directory would make the hook fire or vanish depending on who started the worker.
// `isAbsolute` is the PLATFORM's: on Windows it accepts `C:\...` where the posix one would refuse it,
// and that half is only testable on Windows itself -- the same only-runnable-there caveat this file
// already records for the drive-letter split below.
function parseOnFailure(raw) {
	if (raw === undefined || raw === "") return null;
	if (typeof raw !== "string" || !isAbsolute(raw)) {
		throw configError(`invalid PI_ON_FAILURE: ${JSON.stringify(raw)} (want an absolute path to one executable)`);
	}
	return raw;
}

// `max` is optional and defaults to no upper bound, which is the convention `optionalBoundedInt` below
// already documents -- so every existing caller is unchanged by its arrival.
function boundedInt(env, name, fallback, min, want, max = undefined) {
	const raw = env[name];
	if (raw === undefined || raw === "") {
		if (fallback !== undefined) return fallback;
		throw configError(`missing required env: ${name}`);
	}
	const n = Number.parseInt(raw, 10);
	if (!Number.isInteger(n) || n < min || (max !== undefined && n > max) || String(n) !== String(raw).trim()) {
		throw configError(`invalid ${name}: ${JSON.stringify(raw)} (want ${want})`);
	}
	return n;
}

export function positiveInt(env, name, fallback) {
	return boundedInt(env, name, fallback, 1, "a positive integer");
}

// min=0: accepts 0 (a sentinel, e.g. "keep forever" for log retention), still rejects negatives and non-integers.
function nonNegativeInt(env, name, fallback, max = undefined) {
	return boundedInt(env, name, fallback, 0, max === undefined ? "a non-negative integer" : `an integer 0-${max}`, max);
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
 * `VALKEY_PASSWORD` (issue #468) is the queue's password. Whoever holds it can read every queued job (its task text,
 * its repository), enqueue work this deployment's worker runs with its provider key and forge credentials, and delete
 * the queue: the very thing the password was added to keep from another account on the host, and so no more a job
 * container's than theirs.
 *
 * Kept separate from `MINTED_TOKEN_VARS`, which is defined as "every name any forge's mint can write"
 * and derived from the forge table. This is not that, and folding it in would make that definition a lie.
 */
export const WORKER_ONLY_SECRET_VARS = new Set(["GITHUB_APP_PRIVATE_KEY", "VALKEY_PASSWORD"]);

/** Why each of `WORKER_ONLY_SECRET_VARS` stays in the worker, for the refusal that names it. */
const WORKER_ONLY_WHY = Object.freeze({
	GITHUB_APP_PRIVATE_KEY: "the App's signing key mints tokens for every repository the App is installed on",
	VALKEY_PASSWORD: "the queue's password lets whoever holds it read, enqueue and delete this deployment's jobs",
});

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
			`PI_FORWARD_ENV must not forward ${workerOnly.join(", ")} -- ${workerOnly.map((n) => WORKER_ONLY_WHY[n]).join("; ")}, and a job container is the last place it belongs (CONST-TOKEN-SCOPED-PER-JOB)`,
		);
	}
	// Issue #503: the keyless marker is the worker's to set, and only for a job whose provider is served by keyless
	// endpoints alone. Forwarded, it would make any provider whose models.json key is `$PI_DISPATCH_KEYLESS` look
	// configured, so it is refused whatever the egress policy.
	if (names.includes(KEYLESS_ENV_NAME)) {
		throw configError(`PI_FORWARD_ENV must not forward ${KEYLESS_ENV_NAME} -- the worker sets it itself, only for a job whose provider has every model on a keyless model endpoint (model-endpoints.json)`);
	}
	// Issue #502 (PR #536's review): every name the worker writes into a job's container itself. The forward loop runs
	// AFTER that write, so a forwarded host value REPLACES the per-job one: `PI_MODEL` or `PI_PROVIDER` would run a model
	// the pre-spend gates never checked, `PI_ALLOWED_MODELS` would swap a trigger's narrower list for the deployment's,
	// `PI_MAX_TURNS` would lift the turn limit. One rule over the whole closed set rather than a list of the ones that
	// happen to matter today. HOME is the one exception, and an old one: forwarding it is supported, the job-user path
	// overrides it beside `--user` and says so at boot (`forward_env_home_overridden`).
	const owned = names.filter((n) => CONTAINER_ENV_NAMES.has(n) && n !== "HOME" && n !== KEYLESS_ENV_NAME);
	if (owned.length > 0) {
		throw configError(`PI_FORWARD_ENV must not forward ${owned.join(", ")} -- the worker writes ${owned.length === 1 ? "it" : "them"} into every job's container itself, and a forwarded host value would replace the per-job one (a forwarded PI_MODEL runs a model the pre-spend checks never saw)`);
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
 * PI_ALLOWED_MODELS (issue #502): the deployment's allowed-model list, comma-separated `provider/model`, the
 * grammar a trigger's `run.models` has (`modelListProblem`, model-ref.mjs), so a list means the same thing in
 * either place. A job's effective list is its trigger's, else this one, else none (unrestricted).
 *
 * ENV ONLY, and never a settings-overlay key, for the reason `run.image` resolves against env only: the overlay is
 * writable by a model-callable tool (`dispatch_set`), and a list a tool could widen is not a policy. Refused at boot
 * when malformed, like every other knob here. Unset or empty is unrestricted: an empty env var is how an `.env`
 * template says "not set", unlike an empty `run.models`, which a reviewed file only holds by mistake.
 *
 * NO WHITESPACE anywhere in the value (PR #536's lab review). The launchd and other non-systemd wrappers SOURCE the
 * `.env` with a shell, which reads `PI_ALLOWED_MODELS=a/b, c/d` as a one-off assignment followed by a command named
 * `c/d`: the variable is never set and every job runs unrestricted, with nothing failing. A worker that does see the
 * spaced value (systemd reads it whole) therefore refuses it rather than trimming it, so the same line cannot mean a
 * list on one host and no list on another. An empty segment between two commas is refused too, never skipped.
 */
export function allowedModelsFrom(env) {
	const raw = env.PI_ALLOWED_MODELS;
	if (raw === undefined || raw === "") return null;
	if (/\s/.test(raw)) throw configError("invalid PI_ALLOWED_MODELS: write the list with no spaces (a/b,c/d) -- a shell that sources .env cuts an unquoted value at the first space and leaves the variable unset, so jobs would run with no list");
	const list = raw.split(",");
	const problem = modelListProblem(list);
	if (problem !== null) throw configError(`invalid PI_ALLOWED_MODELS: the list ${problem}`);
	return list;
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

/**
 * PI_BACKENDS and PI_BACKEND_FLOOR (issue #227). Both parse in `backends.mjs` for `egressEnabled`'s reason
 * directly above: `doctor` reads the environment itself, and three copies of one grammar is two chances to
 * disagree about what an operator's floor says. Here they gain the `piDispatchConfig` tag only.
 *
 * ENV-ONLY, never the overlay and never the deployment pointer, on `secretResolverRoots`' rule: a bound
 * that can be widened from the surface it bounds is not a bound. The pointer needs no edit to enforce it --
 * `POINTER_ENV_ALLOWLIST` is an ALLOWLIST (of the path and URL variables `resolvePaths` reads), so a
 * name absent from it is refused by omission, and a capability grant is never added to it.
 */
function backendSet(env) {
	try {
		return parseBackendList(env.PI_BACKENDS);
	} catch (error) {
		throw configError(error.message);
	}
}

function backendFloorOf(env) {
	try {
		return parseBackendFloor(env.PI_BACKEND_FLOOR);
	} catch (error) {
		throw configError(error.message);
	}
}

/**
 * THE BOOT REFUSAL. A deployment whose configuration needs something its backends cannot provide is refused
 * here, named backend by named property, rather than discovering it per job.
 *
 * The RULES live in `backends.mjs` as a pure function over an explicit backend list; this only re-tags them
 * so the CLI prints them cleanly, which is `egressEnabled`'s arrangement. That split is not tidiness: a
 * rule reachable only through `loadConfig` can only be exercised with backend names `parseBackendList`
 * accepts, and there is exactly one today, so three of these rules survived a mutation pass unprotected
 * while living here.
 */
function refuseBackendShortfall(config) {
	const [first] = backendRefusals(config);
	if (first) throw configError(first);
}

/**
 * PI_JOB_IMAGE as the worker runs it (issue #471): unset or empty is pi-job:latest (`||`, so "" falls back), and any
 * other value is judged by the one image rule `run.image` is (`image-ref.mjs`). A refused value is a config error at
 * boot (exit 2), naming the key: before #471 a dash-leading value booted, and every job then handed the runtime a flag
 * where the image belongs, after its budget slot was reserved.
 */
export function jobImageFrom(env) {
	const image = env.PI_JOB_IMAGE || "pi-job:latest";
	const problem = imageRefProblem(image);
	if (problem) throw configError(`PI_JOB_IMAGE ${problem.reason} (got ${JSON.stringify(image)})`);
	return image;
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
	// #227. Hoisted above the object because `defaultBackend` INDEXES `backends`, and a property cannot read
	// a sibling of the literal it is in. (Calling the parser twice would be harmless -- `egressEnabled` is
	// called twice a few properties down for the same reason -- so this is about the index, not the throw.)
	const backends = backendSet(env);
	const backendFloor = backendFloorOf(env);
	const config = {
		valkeyUrl: env.VALKEY_URL ?? DEFAULT_VALKEY_URL,
		// Issue #57. What this machine calls itself: the key of its registry row, the `host` on every log
		// line and run record, and the BullMQ worker name. Always populated -- a deployment that declares
		// nothing still has an identity, which is what lets a fleet of two be TOLD APART before anyone has
		// configured anything. `workerNameDeclared` is kept separately because "the operator named this
		// machine" and "we read the hostname" are different facts, and a later slice gates a host-visible
		// side effect on the first rather than the second.
		workerName: workerName(env),
		workerNameDeclared: Boolean(env.PI_WORKER_NAME),
		concurrency: positiveInt(env, "PI_CONCURRENCY", 3), // DES-CONCURRENCY-3
		dailyCap: positiveInt(env, "PI_DAILY_CAP", 25), // bounds container STARTS per day (money)
		weeklyCap: optionalBoundedInt(env, "PI_WEEKLY_CAP", 1), // REQ-SPEND-CAPS-MULTI-WINDOW; null = weekly window disabled
		monthlyCap: optionalBoundedInt(env, "PI_MONTHLY_CAP", 1), // null = monthly window disabled
		softHoldPct: optionalBoundedInt(env, "PI_SOFT_HOLD_PCT", 1, 99), // null = soft-hold band disabled
		provider: env.PI_PROVIDER ?? "anthropic",
		model,
		maxTurns: positiveInt(env, "PI_MAX_TURNS", 30), // pi has no turn limit; we impose one
		allowedModels: allowedModelsFrom(env), // issue #502: the deployment's allowed-model list; null = unrestricted. ENV ONLY, never the settings overlay
		maxTokens: optionalBoundedInt(env, "PI_MAX_TOKENS", 1), // issue #25; null = per-job token budget disabled (lagging in-run backstop)
		dailyTokenCap: optionalBoundedInt(env, "PI_DAILY_TOKEN_CAP", 1), // issue #25; null = daily token counter disabled (check-AFTER, host-side)
		// Issue #501. The dollar settings, each an operator's decimal (`"2.50"`) kept AS WRITTEN once it parses, so
		// the overlay and env carry one kind of value and `effectiveJobOf` converts both to micro-dollars the same
		// way. Unset or empty is null: no per-job cap, no window. The cross-key rule and the windows' refusal are
		// below, after the object is built.
		maxCostUsd: usdSetting(env, "PI_MAX_COST_USD"),
		dailyCostUsd: usdSetting(env, "PI_DAILY_COST_USD"),
		weeklyCostUsd: usdSetting(env, "PI_WEEKLY_COST_USD"),
		monthlyCostUsd: usdSetting(env, "PI_MONTHLY_COST_USD"),
		jobImage: jobImageFrom(env), // || (not ??) so an empty string falls back; "" is falsy and would throw inside buildDockerRunArgs AFTER a budget slot was reserved
		globalPiDir: resolveGlobalPiDir(env, fileExists), // REQ-GLOBAL-PI-OVERLAY: operator's ~/.pi/agent subset, :ro-mounted; null = off
		allowGlobalExtensions: globalExtensionsEnabled(env), // REQ-GLOBAL-PI-OVERLAY: ON unless PI_GLOBAL_ALLOW_EXTENSIONS=0
		// REQ-EGRESS-ALLOWLIST. `egress` gates the whole feature; `egressProxy` names the component the
		// per-job network is built around. Read BEFORE forwardEnv below, because the forward list's refusal
		// of the proxy variables is conditional on it.
		egress: egressEnabled(env),
		// #227. The blessed set and the minimum every member of it must declare. The default set is the one
		// name every existing deployment is already running, so an operator who has never heard of either
		// variable gets exactly what they had.
		backends,
		backendFloor,
		// The FIRST blessed name, which is what a deployment means by "the one my jobs run on unless a
		// trigger says otherwise". `parseBackendList` never returns empty, so the fallback is belt-and-braces
		// against a future edit rather than a reachable branch today.
		defaultBackend: backends[0] ?? DEFAULT_BACKEND,
		egressProxy: egressProxyName(env), // one derivation, shared with the panel's sandbox (#277)
		forwardEnv: forwardEnvList(env.PI_FORWARD_ENV, egressEnabled(env)), // extra host var NAMES to forward (e.g. a custom provider's key); explicit allowlist, GitHub token names refused
		authFromPi: env.PI_AUTH_FROM_PI !== "0", // ON by default: use the key in ~/.pi/agent/auth.json when the env has none (api-key only). PI_AUTH_FROM_PI=0 forces env-only.
		jobsDir: jobsDirPath(env),
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
		pauseWindowsFile: pauseWindowsFilePath(env), // REQ-SCOPED-PAUSE-WINDOWS: per-folder/repo timed pause; null = no scoped pauses
		modelEndpointsFile: modelEndpointsFilePath(env), // issue #503: the declared model endpoints (INT-MODEL-ENDPOINTS-FILE-CONTRACT); null = model-endpoints.json in the deployment folder, and a missing default file declares none
		scopedLimitsFile: scopedLimitsFilePath(env), // issue #242: per-scope run caps + concurrency (INT-SCOPED-LIMITS-FILE-CONTRACT); null = none. The one-job-per-folder mutex for local jobs is code, not configuration, and holds regardless
		schedulerStallMax: positiveInt(env, "PI_SCHEDULER_STALL_MAX", 2), // CONST-RETRY-INFRA-ONLY: per-scheduler stall backstop; positiveInt rejects <1 so a 0 threshold fails closed
		logsDir: logsDirPath(env), // || (not ??) inside logsDirPath, so an empty string falls back to the default
		settingsFile: settingsFilePath(env), // || (not ??) inside settingsFilePath, so an empty string falls back; INT-CONFIG-OVERLAY-CONTRACT
		captureJobLogs: env.PI_CAPTURE_JOB_LOGS === "1", // no-pii-in-logs: raw job-log capture is opt-in; anything but "1" is off
		logRetentionDays: nonNegativeInt(env, "PI_LOG_RETENTION_DAYS", 30), // 0 = keep forever
		// issue #292, OQ-007: how often the three host-side retention sweeps re-run while the worker is up.
		// 0 = BOOT-ONLY, which is byte-identical to every version before this one -- start.mjs does not even
		// CONSTRUCT the sweep at 0, so no timer, no closer and no second invocation of any reaper is reachable.
		// The ceiling is enforced because setInterval clamps a delay past 2^31-1 ms to 1ms (see
		// SWEEP_INTERVAL_MAX_HOURS); a hot loop over the filesystem is a worse failure than a slow sweep.
		sweepIntervalHours: nonNegativeInt(env, "PI_SWEEP_INTERVAL_HOURS", SWEEP_INTERVAL_HOURS, SWEEP_INTERVAL_MAX_HOURS),
		// REQ-RESUMABLE-SESSION. NO DEFAULT AT ALL, deliberately unlike every sibling above: unset means the
		// feature is unavailable, and a trigger that armed run.resume then refuses PRE-SPEND rather than
		// running silently without persistence. A transcript is the most PII-bearing artifact this system
		// holds -- tool output, file contents, the agent's own reasoning -- and a DEFAULT would turn that
		// refusal into a silent success on a path nobody chose. That reasoning stands on its own and does
		// not rest on where the other stores default: issue #290 moved logs and settings to ~/.pi-dispatch
		// and this one still has no default, for the same reason it never did.
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
		waitAfterMaxMs: positiveInt(env, "PI_WAIT_AFTER_MAX_MS", WAIT_AFTER_MAX_DEFAULT_MS),
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
		// Issue #288, the operator's failure hook: ONE command, exec'd with id-only argv when a paid job
		// reaches a terminal failure. Unset = off, byte-identically. Set = must be an ABSOLUTE path,
		// refused at boot otherwise (parseWaitProfiles' fail-loud posture, and sharper here: a silently
		// dropped hook is a notification the operator believes is wired, discovered at the failure it was
		// wired for). Existence/executability are probed at FIRE time, not boot, so a script installed
		// mid-day works and one deleted mid-day logs `unresolvable` rather than pretending.
		onFailure: parseOnFailure(env.PI_ON_FAILURE),
		// Bounds a LEAKED CHILD after the job, not a pre-spend wait -- which is why this differs from its
		// two 10s twins in what it protects: nothing here holds a slot or delays a container.
		onFailureTimeoutMs: positiveInt(env, "PI_ON_FAILURE_TIMEOUT_MS", 10000),
		github: { ...loadGitHubAuth(env, fileExists), allowGhResume: env.PI_SESSIONS_ALLOW_GH_SOURCE === "1" },
		gitlab: loadGitLabAuth(env),
		forgejo: loadForgejoAuth(env),
		azure: loadAzureAuth(env),
	};

	// #227, and it runs AFTER the object is built rather than inside it: the refusal reads `egress` as well
	// as the two backend fields, and a check woven between properties would depend on key order.
	refuseBackendShortfall(config);
	// Issue #501, after the object for the same reason: both rules read more than one key.
	refuseDollarSettings(config);

	return config;
}

// An optional dollar amount from env (issue #501): unset or empty is null, anything else must parse as money
// (`parseUsdMicros`) and is kept as the string the operator wrote. The refusal names the variable, never the
// value, which is `parseUsdMicros`' own rule.
function usdSetting(env, name) {
	const raw = env[name];
	if (raw === undefined || raw === "") return null;
	optionalUsdMicros(raw, name);
	return raw;
}

// The env half of the dollar rules (issue #501). The overlay half runs on MERGED values per job (start.mjs);
// this one runs on env alone at boot, where an operator is present to read the refusal.
//
// 1. A window without a per-job cap: `checkDollarInvariant`, the rule that holds for good.
// 2. Any window at all, refused BY NAME until the dollar windows are enforced (a later change of #501 lifts
//    this). Accepting one now would be a cap the deployment does not keep while the file reads as kept, the
//    silent no-op this project refuses; a boot refusal is the loud answer an operator can act on.
function refuseDollarSettings(config) {
	const envName = DOLLAR_ENV_NAMES;
	const broken = checkDollarInvariant(config);
	if (broken) {
		const window = DOLLAR_WINDOW_KEYS.find((key) => config[key] !== null);
		throw configError(`${envName[window]} needs PI_MAX_COST_USD: a dollar window reserves each job's per-job cost cap before it starts, so it cannot be set without one`);
	}
	const window = DOLLAR_WINDOW_KEYS.find((key) => config[key] !== null);
	if (window !== undefined) {
		throw configError(`${envName[window]} is not supported yet: dollar windows are enforced from a later release, and a window this worker would not keep must not look kept. Unset it; PI_MAX_COST_USD (the per-job cap) works now`);
	}
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

// env-internal TMPDIR, TEMP: the OS temp dir, read to place the default job, sandbox and graph paths
// below -- and, only on a host with no home directory to name, as the last-resort fallback for the
// durable state root. Not a variable of this project's and not a deployment knob: PI_JOBS_DIR,
// PI_LOGS_DIR, PI_GRAPH_DIR and PI_SETTINGS_FILE are how an operator moves any of them, and
// .env.example says so.

/** This process's effective uid, the one its files are created as, or null where the platform has none (Windows). */
function currentUid() {
	return typeof process.geteuid === "function" ? process.geteuid() : null;
}

/**
 * The per-account root under the OS temp dir that the default jobs, sandbox and graph paths live in (issue #464):
 * `<tmp>/pi-dispatch-<uid>`, or `<tmp>/pi-dispatch` where the platform has no uid (Windows, whose TEMP is per user).
 *
 * Per ACCOUNT because the OS temp dir is shared by every account on a host. The old `<tmp>/pi-dispatch` was created by
 * whichever account ran a job first (mode 775 or 755 under that account), and every other account's jobs then failed
 * `EACCES` at `mkdtemp`, their worker service included, while doctor said ready (measured on Fedora 44 and Ubuntu
 * 24.04). Not `$XDG_RUNTIME_DIR`: that is a small tmpfs (10% of RAM by default) that a retained sandbox, a whole repo
 * clone, would fill, it is removed at the account's last logout without linger, and a shell reached through `sudo -iu`
 * has none, so the worker and doctor could disagree about where the jobs are. `ensureAccountTempRoot` creates this
 * directory 0700 and refuses one this account does not own, since anyone can create a name under a sticky /tmp first.
 */
export function accountTempRoot(env = process.env, uid = currentUid()) {
	const suffix = Number.isInteger(uid) && uid >= 0 ? `-${uid}` : "";
	return `${tempRoot(env)}/pi-dispatch${suffix}`;
}

function defaultJobsDir(env = process.env, uid = currentUid()) {
	// Under the OS temp dir by default, and it STAYS there (issue #290 moved only the two durable
	// stores). Holds only the read-only /job inputs (prompt + .pi/), rebuilt from scratch every job; the
	// workspace for a local job is the operator's own folder, not here.
	//
	// Takes `env` because its caller `defaultSandboxDir` advertises one and could not honour it while
	// this function read `process.env` directly -- an injected TMPDIR was silently ignored one frame in.
	return `${accountTempRoot(env, uid)}/jobs`;
}

/**
 * The per-job directory root, ONE derivation (issue #278). `doctor --live` builds its fixture here, and a probe that
 * derived the path on its own could disagree with the worker about `PI_JOBS_DIR=""` (kept as given, `??` not `||`,
 * as `loadConfig` always has) or an injected `TMPDIR`, and read back a directory no job uses. `loadConfig` read
 * `defaultJobsDir()` without its `env` before this, which ignored an injected TMPDIR exactly as `defaultSandboxDir`'s
 * comment below records for itself; identical on the real path, where env is process.env.
 */
export function jobsDirPath(env = process.env, uid = currentUid()) {
	return env.PI_JOBS_DIR ?? defaultJobsDir(env, uid);
}

/**
 * The jobs dir, made ready for this account's jobs, or a thrown Error saying why it cannot be (issue #464). A jobs dir
 * inside the per-account root (`accountTempRoot`, where the default lives) secures that root first; then the jobs dir
 * is created (0700 where it is new) and must be a directory this account owns. A `PI_JOBS_DIR` elsewhere that another
 * account owns is refused too: the owner of the directory holding a job's inputs can rename them and put its own in
 * their place. `fs` is a seam; with no uid (Windows) nothing is checked and the dir is created as before. A refusal is a
 * `configError` (determinate: the next try meets the same owner); a failed mkdir is thrown as the fs error it is.
 */
export function ensureJobsDir(jobsDir, { env = process.env, uid = currentUid(), fs = { mkdirSync, lstatSync, statSync, chmodSync } } = {}) {
	ensureUnderAccountRoot(jobsDir, { env, uid, fs });
	fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
	if (!Number.isInteger(uid)) return;
	const st = fs.statSync(jobsDir);
	if (!st.isDirectory()) throw configError(`the jobs dir ${jobsDir} is not a directory`);
	if (st.uid !== uid) throw configError(`the jobs dir ${jobsDir} is owned by uid ${st.uid}, not by this account (uid ${uid}), and that account could replace a job's inputs: ${jobsDirOwnerFix(jobsDir, false)}`);
}

/**
 * The sandbox dir (retained workspaces), checked at boot as the jobs dir is (issue #464, gate round 1): inside the
 * per-account root that root is secured first; a sandbox dir that exists must be a directory this account owns. Not
 * created here: the retention step makes it 0700 when it first keeps a run (`retainJobDir`), and asks the owner again
 * then. The owner of the directory holding a retained workspace can rename it and plant a manifest of its own in its
 * place, which `pi-dispatch sandbox` then lists and opens (measured: an explicit PI_SANDBOX_DIR another account made
 * 0777 was used, and that account swapped the entry). A `configError`, since a restart meets the same owner.
 */
export function ensureSandboxDir(sandboxDir, { env = process.env, uid = currentUid(), fs = { mkdirSync, lstatSync, statSync, chmodSync } } = {}) {
	ensureUnderAccountRoot(sandboxDir, { env, uid, fs });
	if (!Number.isInteger(uid)) return;
	let st;
	try {
		st = fs.statSync(sandboxDir);
	} catch (err) {
		if (err?.code === "ENOENT") return;
		throw configError(`the sandbox dir ${sandboxDir} could not be read (${err?.code ?? err?.message}): point PI_SANDBOX_DIR at a directory this account owns`);
	}
	if (!st.isDirectory()) throw configError(`the sandbox dir ${sandboxDir} is not a directory: point PI_SANDBOX_DIR at a directory this account owns`);
	if (st.uid !== uid) throw configError(`the sandbox dir ${sandboxDir} is owned by uid ${st.uid}, not by this account (uid ${uid}), and that account could swap a retained workspace for one of its own: ${sandboxDirOwnerFix(sandboxDir)}`);
}

/** The remedy for a sandbox dir another account owns, shared with doctor. */
export function sandboxDirOwnerFix(dir) {
	return `point PI_SANDBOX_DIR at a directory this account owns (or remove the line for the default), or chown ${dir} to this account`;
}

/**
 * Secure the per-account root (`ensureAccountTempRoot`) when `path` lies in it, else do nothing (issue #464). The one
 * rule for every default that can live there: the jobs, sandbox and graph dirs, and, on an account with no home, the
 * run history and the settings overlay (`defaultStateDir`). Returns whether it did.
 */
export function ensureUnderAccountRoot(path, { env = process.env, uid = currentUid(), fs = { mkdirSync, lstatSync, statSync, chmodSync } } = {}) {
	const root = accountTempRoot(env, uid);
	const p = String(path ?? "").replace(/\\/g, "/");
	if (p !== root && !p.startsWith(`${root}/`)) return false;
	ensureAccountTempRoot(root, { uid, fs });
	return true;
}

/** The remedy for a jobs dir (`inRoot` false) or a per-account root (`inRoot` true) another account owns, shared with doctor. */
export function jobsDirOwnerFix(dir, inRoot) {
	return inRoot
		? `another account created ${dir} before this one; remove it as its owner or as root (sudo rm -rf ${dir}), or set PI_JOBS_DIR in .env to a directory this account owns`
		: `point PI_JOBS_DIR at a directory this account owns, or chown ${dir} to this account`;
}

/**
 * Create `root` mode 0700 when it is absent, and refuse it unless it is a real directory (never a symlink, lstat) owned
 * by `uid`; one this account owns with group or other bits is tightened to 0700. Exported for the admin's graph dir,
 * which lives under the same root. Throws a `configError` naming the path and the remedy.
 *
 * lstat FIRST, never a recursive mkdir first (gate round 1, measured on Fedora 44): with fs.protected_symlinks on (the
 * default on Fedora and Ubuntu), following another account's symlink under the sticky /tmp fails EACCES, and the
 * recursive mkdir's own stat of the existing name did exactly that, so a symlink squat reached the worker as a raw
 * EACCES (exit 1, a systemd restart loop) and each job as a generic failure instead of this refusal. The root itself is
 * made with a plain mkdir, so a name another account creates between the lstat and the mkdir is EEXIST, judged again.
 */
export function ensureAccountTempRoot(root, { uid = currentUid(), fs = { mkdirSync, lstatSync, statSync, chmodSync } } = {}) {
	if (!Number.isInteger(uid)) {
		fs.mkdirSync(root, { recursive: true, mode: 0o700 });
		return;
	}
	const refuse = (why) => configError(`${root} ${why}: ${jobsDirOwnerFix(root, true)}`);
	const look = () => {
		try {
			return fs.lstatSync(root);
		} catch (err) {
			if (err?.code === "ENOENT") return null;
			throw refuse(`could not be read (${err?.code ?? err?.message})`);
		}
	};
	let st = look();
	if (st === null) {
		try {
			// The temp dir itself (a TMPDIR the operator named may not exist yet), then the root on its own.
			fs.mkdirSync(posix.dirname(root), { recursive: true });
			fs.mkdirSync(root, { mode: 0o700 });
		} catch (err) {
			if (err?.code !== "EEXIST") throw refuse(`could not be created (${err?.code ?? err?.message})`);
		}
		st = look();
		if (st === null) throw refuse("vanished as it was created");
	}
	if (st.isSymbolicLink() || !st.isDirectory()) throw refuse("is not a directory (a symlink or a file there is refused, since any account can create a name under the temp dir)");
	if (st.uid !== uid) throw refuse(`is owned by uid ${st.uid}, not by this account (uid ${uid})`);
	if ((st.mode & 0o077) !== 0) fs.chmodSync(root, 0o700);
}

export function defaultSandboxDir(env = process.env, uid = currentUid()) {
	// Beside the per-job dirs, because a retained directory IS a per-job dir -- `cleanup` renames it here
	// rather than copying, which only stays atomic while both live on one filesystem. Created mode 0700 by
	// the retention step, since the OS temp dir is 1777 on POSIX and a retained tree holds a repository
	// clone plus the run's prompt.md/event.json. Exported so the admin extension resolves the same default
	// without calling loadConfig, which throws on unrelated env problems.
	//
	// Under temp deliberately, and unmoved by issue #290: a retained workspace is bounded by
	// PI_SANDBOX_RETENTION_HOURS and is disposable by design, so a swept temp dir costs nothing that the
	// sweep was not already going to take.
	return `${jobsDirPath(env, uid)}/sandboxes`.replace(/\\/g, "/");
}

/**
 * The home directory, or "" when this host cannot name one.
 *
 * `homedir()` throws on a host with no passwd entry (a bare uid in a container) and returns "" when
 * HOME is set but empty -- both measured. This takes `defaultWorkerName`'s posture below: a path is
 * never worth refusing boot for, so an unanswerable home degrades to the temp fallback rather than
 * throwing, and `underOsTempDir` is what makes that degradation VISIBLE instead of silent.
 */
export function safeHomeDir() {
	try {
		return homeOrEmpty(homedir());
	} catch {
		return "";
	}
}

/**
 * Normalise anything offered as a home directory to a usable string, or "".
 *
 * Split out of `safeHomeDir` because `home` is also a SEAM (doctor injects one to exercise the no-home
 * case on a host that has one), and a seam that only the guarded path validates is a guard with a hole:
 * `defaultLogsDir({}, null)` threw a TypeError before this existed. Blank-but-present is "" for the same
 * reason `loadConfig` spells the durable paths with `||` -- an empty value can only mask a working
 * default, never express one.
 */
function homeOrEmpty(home) {
	return typeof home === "string" ? home.trim() : "";
}

/**
 * The root of the two DURABLE stores: the run history and the settings overlay (issue #290).
 *
 * Under the home directory, NOT the OS temp dir. Linux leaves TMPDIR unset so the old default was
 * literally `/tmp/pi-dispatch`, and on the distros where /tmp is tmpfs that is RAM: the run history
 * REQ-DURABLE-RUN-HISTORY promises and every cap the operator tuned from the panel were gone on the
 * next reboot, while the queue beside them survived on Valkey's AOF volume.
 *
 * `~/.pi-dispatch` rather than a per-platform state dir (XDG_STATE_HOME, ~/Library/Application
 * Support, LOCALAPPDATA), for four reasons. This project has exactly ONE home-dir pattern and it is
 * this shape (`PI_CODING_AGENT_DIR || ~/.pi/agent`). docs/sessions.md already teaches
 * `~/.pi-dispatch/sessions` as the place to put the session store, so these two land beside a
 * directory the docs already tell an operator to create, and docs/backup.md can name one target.
 * `~/Library/Application Support` contains a space, and doctor prints copy-pasteable fix lines. And a
 * per-platform trio would be three new ENV reads needing their own env-internal markers, where
 * `homedir()` is a node:os call that the env-docs scan does not see at all.
 *
 * WITH NO HOME, this falls back to a temp path, and that is load-bearing rather than a leak: the fallback
 * is exactly what `underOsTempDir` detects, so doctor prints one line naming the path that will not
 * survive a reboot. Since issue #464 that fallback is the PER-ACCOUNT root (`accountTempRoot`,
 * `<tmp>/pi-dispatch-<euid>`), secured by `ensureUnderAccountRoot` as the jobs dir is: the old shared
 * `<tmp>/pi-dispatch` was created by whichever homeless account wrote first, and every other account's
 * records then failed to write, or landed in a directory another account controls. `legacyTempStateDir`
 * still names that OLD shared address, for doctor's migration hint, and is spelled out on its own.
 *
 * The temp fallback reads a BLANK `TMPDIR`/`TEMP` as absent rather than using it.
 * The pre-#290 code spelled this `??`, so `TMPDIR=""` composed the bare `/pi-dispatch` -- a path at the
 * filesystem root that a non-root worker cannot create, and one `underOsTempDir` cannot recognise either,
 * because an empty root is not a prefix of anything. The detector would then have reported "survives a
 * reboot" over a directory that does not even exist. `||` in both places is what keeps the fallback and
 * the detector describing the same world; it is the same rule `loadConfig` applies to PI_LOGS_DIR itself.
 */
function defaultStateDir(env = process.env, home = safeHomeDir(), uid = currentUid()) {
	// Strip the home dir's own trailing separator BEFORE composing, not after: stripping the composed
	// string only reaches a slash at the END, and `${"/home/u/"}/.pi-dispatch` puts one in the MIDDLE.
	const h = homeOrEmpty(home);
	if (h !== "") return `${h.replace(/\\/g, "/").replace(/\/+$/, "")}/.pi-dispatch`;
	return accountTempRoot(env, uid);
}

/**
 * The OS temp dir as this project reads it, or "/tmp".
 *
 * TRIMMED and stripped of a trailing separator, which is not cosmetic on either count. A whitespace-only
 * `TMPDIR` composed a RELATIVE path ("   /pi-dispatch/logs") that would resolve against whatever cwd the
 * worker was started in, and macOS hands back a trailing slash that otherwise rides into the `//` doctor
 * prints in its copy-pasteable fix lines. Blank reads as absent for the reason `defaultStateDir` explains.
 */
function tempRoot(env = process.env) {
	for (const raw of [env.TMPDIR, env.TEMP]) {
		const v = typeof raw === "string" ? raw.trim() : "";
		if (v !== "") return v.replace(/\\/g, "/").replace(/(?!^)\/+$/, "");
	}
	return "/tmp";
}

/** The address the durable stores had before issue #290, so doctor's migration hint can name it. */
export function legacyTempStateDir(env = process.env) {
	// The SHARED address every account used before issues #290 and #464; not a path anything writes any more.
	return `${tempRoot(env)}/pi-dispatch`;
}

export function defaultLogsDir(env = process.env, home = safeHomeDir(), uid = currentUid()) {
	// Durable by default (issue #290, REQ-DURABLE-RUN-HISTORY): holds the per-run history sidecars and,
	// when PI_CAPTURE_JOB_LOGS=1, the raw logs. A worker-owned path that never enters the container env
	// allowlist (no-broad-env-into-container). Exported so the admin extension resolves the same default
	// without calling loadConfig, which throws on unrelated env problems -- and the admin resolving the
	// SAME answer is the whole point: a panel reading a different directory shows an empty history and
	// says nothing about why.
	return `${defaultStateDir(env, home, uid)}/logs`;
}

export function defaultSettingsFile(env = process.env, home = safeHomeDir(), uid = currentUid()) {
	// Durable by default, beside the run history (issue #290). Holds the runtime-tunable settings overlay
	// shared with the admin extension (INT-CONFIG-OVERLAY-CONTRACT); a worker-owned path that never
	// enters the container env allowlist (no-broad-env-into-container).
	//
	// Losing this file is not neutral: readOverlay treats a missing file as an EMPTY overlay, so a swept
	// settings.json silently restores the wider env cap. That is the same fail-open
	// DES-RUNTIME-SETTINGS-FILE-OVERLAY already refuses on a bad parse, arriving through the filesystem
	// instead of through the parser.
	return `${defaultStateDir(env, home, uid)}/settings.json`;
}

/**
 * The resolved run-history directory. ONE derivation, so loadConfig, the admin and doctor cannot drift.
 *
 * `home` is forwarded rather than resolved here: doctor injects a home seam (it has to, to exercise the
 * no-home case on a host that has one), and a helper that read the real homedir behind that seam's back
 * would answer a different question than the one doctor is asking. Passing `undefined` is what keeps the
 * ordinary caller on `safeHomeDir()`, since an undefined argument activates a default parameter.
 */
/**
 * The two boot files' paths, `??` and not `||`, EXPORTED so doctor asks the same question the worker does.
 *
 * The distinction is the whole reason these exist (issue #384). `??` keeps an empty string, so a blank
 * `PI_PAUSE_WINDOWS_FILE=` survives into the config, `start.mjs` loads it unconditionally and the boot
 * refuses; `logsDirPath` below uses `||` and falls back instead. Doctor had a copy of the `??` rule written
 * out by hand, which is how it came to warn about a deployment its own sibling check failed.
 */
export function pauseWindowsFilePath(env = process.env) {
	return env.PI_PAUSE_WINDOWS_FILE ?? null;
}

export function scopedLimitsFilePath(env = process.env) {
	return env.PI_SCOPED_LIMITS_FILE ?? null;
}

/** Issue #503. `??` like the two above, so an empty value is a value, which the loader refuses rather than reading the
 *  default file in its place. Unlike them, null does not turn anything off: it means the deployment folder's file. */
export function modelEndpointsFilePath(env = process.env) {
	return env.PI_MODEL_ENDPOINTS_FILE ?? null;
}

export function logsDirPath(env = process.env, home) {
	return env.PI_LOGS_DIR || defaultLogsDir(env, home);
}

/**
 * The resolved settings-overlay path. Lives HERE, beside `logsDirPath`, so the pair of durable stores has
 * one derivation each and `loadConfig` does not open-code either. `runtime-settings.mjs` re-exports it, so
 * `@edgehero/pi-dispatch/runtime-settings` stays the import path the admin and the probe fixture already
 * use; the alternative (config importing runtime-settings) would be a cycle, since that module reads
 * `defaultSettingsFile` from here.
 */
export function settingsFilePath(env = process.env, home) {
	return env.PI_SETTINGS_FILE || defaultSettingsFile(env, home);
}

/** One path in the slash alphabet these defaults are written in, with any trailing separators dropped. */
function slashy(p) {
	const s = posix.normalize(String(p).replace(/\\/g, "/")).replace(/\/+$/, "");
	return s === "" ? "/" : s;
}

/** A root's spellings: as written, plus its realpath when one resolves. Both count, for a root. */
function spellings(p, realpath) {
	const out = new Set([slashy(p)]);
	try {
		out.add(slashy(realpath(p)));
	} catch {
		// ENOENT is the NORMAL case, not an error: doctor asks this question before these directories
		// exist. The lexical spelling always remains, and the ROOT usually resolves even when the
		// candidate does not, which is what still catches macOS's /var -> /private/var on a fresh host.
	}
	return out;
}

/**
 * WHERE THE CANDIDATE'S BYTES ACTUALLY LAND, as one spelling.
 *
 * Deliberately not `spellings()`: unioning the written and resolved forms and accepting any match makes a
 * symlink that points OUT of the temp dir a false positive, and this check's stated posture is that a
 * false alarm on a durable path is the worse error. A resolved path is the honest answer to "will the OS
 * sweep this", so it wins whenever it exists. The dirname retry covers the ordinary case where the leaf
 * has not been created yet but its parent is a symlink; when neither resolves, the written form is all
 * there is, which is doctor's situation on a fresh host.
 */
function landingSpelling(p, realpath) {
	try {
		return slashy(realpath(p));
	} catch {
		// fall through to the parent
	}
	const written = slashy(p);
	const cut = written.lastIndexOf("/");
	if (cut > 0) {
		try {
			return `${slashy(realpath(written.slice(0, cut)))}${written.slice(cut)}`;
		} catch {
			// fall through to the written form
		}
	}
	return written;
}

/**
 * Directories a POSIX host clears without being asked, beyond whatever TMPDIR names.
 *
 * `/tmp` is here because it is what the pre-#290 default resolved to on Linux, where TMPDIR is unset,
 * and it is tmpfs on several distributions. The other three are the ones an operator most plausibly
 * reaches for while looking for somewhere fast: `/dev/shm` and `/run` are tmpfs by definition, so they
 * are RAM and do not survive a reboot at all (`/run` does not survive a service restart on some
 * layouts), and `/var/tmp` is swept by systemd-tmpfiles on a 30 day timer, which is the same order as
 * the run history's own retention window. Each of these would otherwise have been reported as durable.
 */
const POSIX_VOLATILE_ROOTS = Object.freeze(["/tmp", "/var/tmp", "/dev/shm", "/run"]);

/**
 * Does this path sit under a directory the OS is entitled to sweep (issue #290)?
 *
 * ADVISORY, and therefore FAILS OPEN -- the opposite posture from `withinRoots` in
 * secret-profiles.mjs and `folderUnderRoots` in the admin's read-model, which are boundaries and fail
 * closed. Nothing is gated on this answer; it decides whether doctor prints one warning. A false
 * alarm on a durable path is the worse error, because a warning an operator learns to skim is a
 * warning that stops working.
 *
 * It reuses `withinRoots`' ALGORITHM -- normalize, strip trailing separators, then `===` or
 * `startsWith(base + separator)` so a sibling like `<tmp>-notmine` cannot match -- but deliberately
 * does not call it. `withinRoots` compares in the NATIVE alphabet (path.sep), while every default in
 * this file is stored slash-normalized, so its Windows branch would be untestable anywhere but
 * Windows. Comparing in the alphabet the values are written in makes this checkable on every platform.
 *
 * Four cases it has to get right, all measured on this project's own hosts:
 *   - macOS TMPDIR carries a TRAILING SLASH, so the old default composed `<tmp>//pi-dispatch/logs`;
 *   - macOS /var/folders/... realpaths to /private/var/folders/..., so an operator's /private path
 *     is a FALSE NEGATIVE unless both sides are expanded;
 *   - `<tmp>-notmine/logs` is a FALSE POSITIVE for a bare prefix test;
 *   - realpathSync THROWS on a path that does not exist yet, which is doctor's ordinary situation.
 *
 * os.tmpdir() is checked beside TMPDIR/TEMP because it consults TMP internally, which covers a third
 * variable without naming one here. The literal "/tmp" is checked because it is what the pre-#290
 * default resolved to on Linux, where TMPDIR is unset.
 */
export function underOsTempDir(candidate, env = process.env, { realpath = realpathSync, osTmpDir = tmpdir, platform = process.platform } = {}) {
	if (typeof candidate !== "string" || candidate.trim() === "") return false;
	let tmp = "";
	try {
		tmp = osTmpDir();
	} catch {
		// A host that cannot name its own temp dir is not one to throw over from an advisory check.
	}
	const target = landingSpelling(candidate, realpath);
	// TEMP is consulted on WINDOWS ONLY. On POSIX it is not an OS temp variable, and plenty of shells
	// export one for a ported toolchain -- honouring it there turns an ordinary durable subtree into a
	// false "swept" verdict, which is the direction this check says it cares about most.
	const win = platform === "win32";
	for (const root of [env.TMPDIR, win ? env.TEMP : "", tmp, ...(win ? [] : POSIX_VOLATILE_ROOTS)]) {
		if (typeof root !== "string" || root.trim() === "") continue;
		for (const base of spellings(root, realpath)) {
			// `base` is "/" only when the root IS the filesystem root, where `${base}/` would be "//" and
			// match nothing. Everything absolute is under it, which is the honest answer for TMPDIR=/.
			if (target === base || target.startsWith(base === "/" ? "/" : `${base}/`)) return true;
		}
	}
	return false;
}

/**
 * What a worker may call itself (issue #57). The CHARACTER CLASS is `sanitizeJobId`'s
 * (`[A-Za-z0-9._-]`), reused rather than invented so this project has one name-safe alphabet -- but that
 * function is a REPLACER, not a validator, so the three rules around the class are NEW and are claimed
 * as new here rather than borrowed:
 *
 *   - a leading alphanumeric, which is what refuses `..` and a leading `-` that reads as a flag;
 *   - a 64-character ceiling, because the name is a Valkey key segment and a log field on every line;
 *   - no `.json`/`.log` tail, which is not decoration. The class contains the dot, so `prod.json` is
 *     otherwise a legal name -- and a later slice writes a per-host marker file into `PI_LOGS_DIR`,
 *     where `<something>.json` is parsed as a run record by the admin and DELETED by the log reaper.
 *     A name is refused here rather than escaped there, because the escape would have to be remembered
 *     at every site that ever composes a filename from this value.
 *
 * The class is `:`-free, `,`-free and `#`-free, which is what lets the name be a Valkey key segment
 * UNHASHED. That is the point of validating instead of hashing (`scopeKeyPrefix` does the opposite for
 * a folder path, which was never chosen for key-safety and cannot be refused): the whole value of a host
 * registry is that `HGETALL host:h:mac-mini-1` is readable by a human.
 */
export const WORKER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** True when the name would collide with the run-history filename namespace. See WORKER_NAME_RE. */
const RESERVED_NAME_TAIL = /\.(json|log)$/i;

/**
 * A hostname reduced to something `WORKER_NAME_RE` accepts, for use as a DEFAULT only.
 *
 * Lowercased because macOS reports `Robs-Mac-Mini.local` where Linux reports `mac-mini`: two spellings
 * of one machine would be two rows in the registry and two values in the run records. The `.local`
 * suffix is deliberately NOT stripped -- an OS-specific suffix rule is a rule someone has to remember,
 * and it costs nothing to keep.
 */
export function sanitizeWorkerName(raw) {
	const cleaned = String(raw ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9._-]/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, 64)
		.replace(/[-.]+$/, ""); // the slice can leave a trailing separator behind
	if (cleaned === "" || !WORKER_NAME_RE.test(cleaned)) return "worker";
	// The reserved tail is repaired by REPLACING the dot, never by appending: a suffix on a name already at
	// the 64-character ceiling would push it past, and a default that the validator would reject is a
	// second, weaker alphabet arriving by the back door. `host.json` becomes `host-json`, which is the same
	// length, still readable, and cannot match the tail again.
	return cleaned.replace(RESERVED_NAME_TAIL, (m) => `-${m.slice(1)}`);
}

/** This machine's name, sanitized. Exported so doctor and the admin resolve it without `loadConfig`. */
export function defaultWorkerName() {
	try {
		return sanitizeWorkerName(hostname());
	} catch {
		return "worker"; // hostname() can throw on a locked-down host; a name is never worth refusing boot for
	}
}

/**
 * THE ASYMMETRY IS THE DESIGN. A value the operator did not choose is repaired silently; a value they
 * typed is refused loudly and never quietly altered. Defaulting is a convenience, so it must not be able
 * to fail; declaring is a statement, so a typo in it must not become a different machine's name.
 */
function workerName(env) {
	const declared = env.PI_WORKER_NAME;
	if (declared === undefined || declared === "") return defaultWorkerName();
	if (!WORKER_NAME_RE.test(declared)) {
		throw configError(`PI_WORKER_NAME must match ${WORKER_NAME_RE.source} (letters, digits, dot, underscore, hyphen; first character alphanumeric; at most 64): ${JSON.stringify(declared)}`);
	}
	if (RESERVED_NAME_TAIL.test(declared)) {
		throw configError(`PI_WORKER_NAME must not end in .json or .log: ${JSON.stringify(declared)} would collide with the run-history filenames in PI_LOGS_DIR`);
	}
	return declared;
}

export function defaultGraphDir(env = process.env, uid = currentUid()) {
	// Under the OS temp dir by default, beside logs/ and jobs/ -- the admin's graph HTML artifact
	// (issue #54) is host-side display output on the defaultLogsDir doctrine, and deliberately NOT
	// inside logsDir: INT-RUN-HISTORY-FILE-CONTRACT names that directory's filename shape, and a
	// stray .html beside the sidecars would widen a contract for a file that is not a record.
	// Overridable with PI_GRAPH_DIR; exported so the admin resolves the same default without
	// loadConfig, like defaultSandboxDir above.
	// Issue #464: under the per-account root, for the jobs dir's reason: another account's `<tmp>/pi-dispatch` made
	// this one uncreatable.
	return `${accountTempRoot(env, uid)}/graph`;
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
