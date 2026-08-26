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
 * from a triggers file at all: the provider credential's variable names come from `findEnvKeys(provider,
 * hostEnv)`, and `PI_FORWARD_ENV` is an operator env list. Those two are refused PRE-SPEND, in the
 * processor, where the resolved provider and the host env are both in hand. `MINTED_TOKEN_VARS` and
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
	"PI_OFFLINE",
	"PLAYWRIGHT_BROWSERS_PATH",
	"PLAYWRIGHT_MCP_BROWSER",
	"PLAYWRIGHT_MCP_SANDBOX",
]);
