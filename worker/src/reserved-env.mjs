/**
 * Issue #503: the variable a keyless provider's `models.json` key names (`"apiKey": "$PI_DISPATCH_KEYLESS"`), so pi
 * composes the provider. `buildContainerEnv` writes it, with the fixed, non-secret value `keyless`, only when the
 * credential gate passed the job's provider keyless (env-allowlist.mjs, `resolveProviderCredential`): a provider pi does
 * not know, served by keyless model endpoints alone. Reserved in the set below, so neither `run.secrets` nor
 * `PI_FORWARD_ENV` can set it.
 */
export const KEYLESS_ENV_NAME = "PI_DISPATCH_KEYLESS";

/**
 * The environment variable names `buildContainerEnv` writes itself, spelled once (issue #225).
 *
 * This exists because `run.secrets` lets a trigger name env variables, and a trigger that names one the
 * closed map already owns would either be silently overwritten (the job runs without the value it asked
 * for, on a clean exit 0) or silently WIN (a trigger redirecting `PI_OFFLINE` or `PI_MAX_TURNS`). Both
 * are the inversion `env-allowlist.mjs`'s header exists to prevent, arriving through a new door.
 *
 * A SEPARATE MODULE, and it has no imports at all, on purpose. `triggers.mjs` is the shared validator:
 * it is pure and fs-free, the receiver loads it, and `admin/build.mjs` INLINES it into the published
 * console. Importing `env-allowlist.mjs` to reach these names would drag `node:fs`, `node:os` and pi's
 * compat shim into all three, to read a list of strings. So the list moves down here, where both can
 * have it for free.
 *
 * Only the STATIC names live here. The rest of the closed map is deployment state and cannot be known
 * from a triggers file at all: the provider's credential variable names come from `providerKeyCandidates`
 * once the job's provider is resolved, and `PI_FORWARD_ENV` is an operator env list. Those two are refused
 * PRE-SPEND, in the processor, where the resolved provider and the operator's forward list are in hand. `MINTED_TOKEN_VARS` and
 * `FORGE_HOST_VARS` (forges.mjs) and `EGRESS_ENV_VARS`/`WORKER_ONLY_SECRET_VARS` (config.mjs) stay in
 * their own modules and are imported by the validator beside this one, never copied into it.
 *
 * `worker/test/env-allowlist.test.mjs` pins this set against what `buildContainerEnv` actually emits, so
 * a variable added to the closed map and not to this list fails there rather than becoming a hole here.
 */
export const CONTAINER_ENV_NAMES = new Set([
	"PI_PROVIDER",
	"PI_MODEL",
	"PI_MAX_TURNS",
	"PI_MAX_TOKENS",
	"PI_JOB_ID",
	"PI_GLOBAL_ALLOW_EXTENSIONS",
	"PI_PACKAGES",
	"PI_SESSION_FILE",
	"PI_FLOW",
	"PI_COMMAND",
	"PI_EXCLUDE_TOOLS",
	// Issues #501, #502: the per-job dollar cap (written by the worker since #501, from the trigger's and the
	// deployment's caps) and the allowed-model list (reserved until #502 writes it). Neither can be bound through
	// `run.secrets`: a trigger setting its own cap, or its own list, would be the policy choosing itself.
	"PI_MAX_COST_MICROS",
	"PI_ALLOWED_MODELS",
	// Issue #545: tells the runner the exit line's key waits on stdin. A trigger setting it would block its own runner
	// on a stdin no one writes, or turn the signed line off.
	"PI_EXIT_AUTH",
	"PI_OFFLINE",
	"PLAYWRIGHT_BROWSERS_PATH",
	"PLAYWRIGHT_MCP_BROWSER",
	"PLAYWRIGHT_MCP_SANDBOX",
	// Issue #341: set beside `--user` so a uid with no passwd entry has a writable home. A new reservation, so a
	// triggers file binding a secret named HOME is now refused at parse (worker, receiver and admin alike).
	"HOME",
	// Issue #503: written only on the keyless branch of the credential gate (see KEYLESS_ENV_NAME at the top).
	KEYLESS_ENV_NAME,
]);

/**
 * Issue #500: the names the RUNNER sets in its own environment inside the container, for its descendants: the child
 * ledger directory and the runner's pid (image/runner/src/usage-meter.mjs, openChildLedger). The worker never writes
 * them, so they are not in the set above (which a test pins to what buildContainerEnv emits). They are reserved all the
 * same: a trigger binding one through `run.secrets`, or a host value forwarded through `PI_FORWARD_ENV`, would arrive in
 * the runner's environment before the runner sets its own, and a value the runner then failed to replace would point
 * every pi child's ledger at a directory the agent chose. Refused at load in both lists, and deleted by
 * buildContainerEnv after both loops as the backstop.
 */
export const RUNNER_ENV_NAMES = new Set(["PI_DISPATCH_CHILD_LEDGER", "PI_DISPATCH_RUNNER_PID"]);
