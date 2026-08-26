import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findEnvKeys } from "@earendil-works/pi-ai/compat";
import { egressEnv } from "./egress.mjs";
import { forgeSpec } from "./forges.mjs";

function configError(message) {
	const error = new Error(message);
	error.piDispatchConfig = true;
	return error;
}

/**
 * Build the EXACT environment a job container receives. Never a pass-through.
 *
 * `no-broad-env-into-container` is a BLOCKER, and for good reason: `ANTHROPIC_OAUTH_TOKEN`
 * silently outranks `ANTHROPIC_API_KEY`, so one stray host variable would redirect which
 * credential every job spends, with no error and no log line. So we forward a closed set.
 *
 * The provider key variable is DERIVED from pi's own table, not hardcoded. `findEnvKeys(provider,
 * env)` returns the provider's key variable names that are actually PRESENT in `env`, in
 * precedence order (OAuth before API key). Deriving it means:
 *   - any of pi's ~30 providers works with no code change here;
 *   - the list cannot drift when pi adds a provider (a hand-copied table would);
 *   - `undefined` return === "this provider is not configured on this host" === refuse the job
 *     BEFORE spending, rather than launch a container that will fail auth on the first call.
 *
 * `getApiKeyEnvVars` (the full candidate list) is intentionally NOT exported by pi; `findEnvKeys`
 * against our own process.env is the right tool anyway, because we only ever forward keys we have.
 */
export function providerKeyVars(provider, hostEnv) {
	return findEnvKeys(provider, hostEnv);
}

/**
 * Resolve the provider credential(s) to inject, as `{ VAR_NAME: value }`.
 *
 * Primary source: the worker's own environment, by pi's expected variable name(s) (`findEnvKeys`).
 * Fallback (ON by default; `PI_AUTH_FROM_PI=0` forces env-only): when the env has none, read the credential
 * from the host's pi `auth.json`. This is a HOST-SIDE read of a host-held secret, injected via env exactly
 * like the env path — never a credential file mounted into the container (`CONST-TOKEN-SCOPED-PER-JOB`).
 * API-key credentials only; an OAuth/subscription login is refused (it expires, the container cannot refresh
 * it, and it is not the credential for an unattended service). Throws a config-tagged error (pre-spend
 * refusal) when neither source yields a credential.
 */
export function resolveProviderCredential({ provider, hostEnv, authFromPi = false, agentDir, readFile = readFileSync }) {
	const envNames = providerKeyVars(provider, hostEnv);
	if (envNames && envNames.length > 0) {
		return Object.fromEntries(envNames.map((name) => [name, hostEnv[name]]));
	}
	if (authFromPi) {
		const { name, value } = credentialFromPiAuth(provider, agentDir ?? defaultAgentDir(hostEnv), readFile);
		return { [name]: value };
	}
	throw configError(`provider ${provider} has no configured credential in the worker environment`);
}

function defaultAgentDir(hostEnv) {
	// pi's getAgentDir() default, resolved without importing the whole pi SDK into the worker.
	return hostEnv.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function credentialFromPiAuth(provider, agentDir, readFile) {
	const path = join(agentDir, "auth.json");
	let auth;
	try {
		auth = JSON.parse(readFile(path, "utf8"));
	} catch {
		throw configError(`no credential for provider "${provider}": not in the worker environment, and no pi login at ${path} — set the key in .env, or run \`pi login\``);
	}
	const cred = auth?.[provider];
	if (!cred) throw configError(`no credential for provider "${provider}": not in the worker environment, and ${path} has no "${provider}" login — set the key in .env, or run \`pi login\``);
	if (cred.type === "oauth") {
		throw configError(
			`the pi login for "${provider}" is an OAuth/subscription token, which cannot power an unattended service (it expires and the container cannot refresh it). Configure an API key — with a provider-side spend limit — instead.`,
		);
	}
	if (cred.type !== "api_key" || !cred.key) throw configError(`unsupported pi credential for "${provider}" in ${path} — set an API key in .env`);
	const name = resolveEnvName(provider, cred);
	if (!name) {
		throw configError(`could not determine the environment variable pi expects for provider "${provider}" — set it in the worker environment manually`);
	}
	return { name, value: cred.key };
}

/**
 * The env var name pi reads this provider's key from. Discovered through pi's OWN `findEnvKeys` (the
 * oracle) rather than a hand-maintained provider→var table that would drift: try the credential's own
 * `env` hint plus the conventional `<PROVIDER>_API_KEY`/`_KEY`, and forward the one pi recognizes.
 */
function resolveEnvName(provider, cred) {
	const upper = provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
	const candidates = [cred.env, `${upper}_API_KEY`, `${upper}_KEY`].filter((s) => typeof s === "string" && s.length > 0);
	const synthetic = Object.fromEntries(candidates.map((name) => [name, cred.key]));
	const recognized = findEnvKeys(provider, synthetic);
	return recognized?.[0] ?? null;
}

/**
 * Assemble the container env. `hostEnv` is the worker's process.env; `job` carries the resolved
 * config and the per-job scoped token (GitHub-backed jobs, and local cron jobs that opted in via
 * run.github).
 *
 * Throws if the provider is not configured -- a deterministic misconfiguration the caller maps to
 * a pre-spend refusal, never a launched-then-failed container.
 *
 * `packagePaths` is the operator-staged pi package set for THIS job: already-resolved absolute
 * CONTAINER paths under the :ro overlay, empty for a job whose trigger opted OUT (or when nothing is staged).
 *
 * `allowGlobalExtensions` defaults to TRUE here, matching loadConfig's default (REQ-GLOBAL-PI-OVERLAY): a
 * caller that says nothing gets the operator's staged setup, and only an explicit `false` withholds it.
 */
export function buildContainerEnv({ provider, model, maxTurns, maxTokens, jobId, githubToken, forgeKind, forgeHosts = {}, hostEnv, allowGlobalExtensions = true, packagePaths = [], forwardEnv = [], secrets = {}, sessionFile = null, flow = null, command = null, authFromPi = false, egress = false, egressProxy, agentDir, readFile = readFileSync }) {
	// The provider credential(s), by pi's expected variable name(s) -- from the worker env, or (when
	// PI_AUTH_FROM_PI is set and the env has none) host-side from pi's auth.json. Throws (config) if
	// neither source yields one, which the processor turns into a pre-spend refusal.
	const credEnv = resolveProviderCredential({ provider, hostEnv, authFromPi, agentDir, readFile });

	const env = {
		PI_PROVIDER: provider,
		PI_MODEL: model,
		PI_MAX_TURNS: String(maxTurns),
		// The optional per-job token budget (issue #25). Absent/null => variable omitted (docker-run skips
		// undefined), so the runner attaches a pure meter with no cap. Never an empty string.
		PI_MAX_TOKENS: maxTokens === null || maxTokens === undefined ? undefined : String(maxTokens),
		PI_JOB_ID: jobId,
		// Baked into the image, but harmless to restate; kept here so the container contract is
		// visible in one place. INT-CONTAINER-RUNTIME-CONTRACT.
		PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
		PLAYWRIGHT_MCP_BROWSER: "chromium",
		PLAYWRIGHT_MCP_SANDBOX: "false",
		// The overlay's extensions load in the runner unless the operator opted out (REQ-GLOBAL-PI-OVERLAY).
		// ABSENT means LOAD on both sides of the mount, so this variable is emitted ONLY to carry the explicit
		// "0" opt-out -- the one reading a container must never have to infer. Both halves agree on the same
		// canonical string, so the container env is legible against the operator's own .env line.
		PI_GLOBAL_ALLOW_EXTENSIONS: allowGlobalExtensions ? undefined : "0",
		// ":"-delimited ABSOLUTE CONTAINER paths of the operator-staged pi packages (REQ-GLOBAL-PI-OVERLAY).
		// The caller has already applied the per-trigger opt-out, so an empty list here means "this job loads
		// none" -- either nothing is staged, or its trigger set run.packages:false. Empty emits no -e at all,
		// never PI_PACKAGES=. The delimiter is ":" because these are CONTAINER (POSIX) paths -- never the
		// host's path.delimiter, which is ";" on Windows.
		PI_PACKAGES: packagePaths.length > 0 ? packagePaths.join(":") : undefined,
		// The persisted transcript inside the /session mount (REQ-RESUMABLE-SESSION). Emitted ONLY when
		// this job actually has one -- absent means the runner builds pi's ephemeral in-memory session,
		// which is every job before this feature and every job whose trigger did not arm run.resume. Never
		// an empty string, for PI_PACKAGES' reason: an empty value is a third state neither side reads the
		// same way, and the one reading a container must not have to infer which was meant.
		PI_SESSION_FILE: sessionFile || undefined,
		// The trigger's run.flow, STRUCTURALLY (issue #189). The flow already reaches the container as
		// prompt prose ("Use the X skill"), but pi never matches prose against loaded skill names, so a
		// flow that resolves in no tier runs to a clean exit 0 -- the silent no-op this repo brands the
		// worst outcome available. This variable is what lets the runner compare the name against what
		// actually loaded. It rides env and NOT event.json because an execution knob is not a fact about
		// the delivery (see prepare-github.mjs on replicas). Absent means "no flow to verify" (a bare
		// run.task cron job), never an empty string, for PI_PACKAGES' reason.
		PI_FLOW: flow || undefined,
		// The trigger's run.command, STRUCTURALLY (issue #189) -- PI_FLOW's twin: the runner compares it
		// against the commands that actually registered and refuses an unregistered one before any spend,
		// where the prompt's bare `/name` would otherwise read as prose and run to a clean exit 0. It
		// rides env and NOT event.json for the same reason PI_FLOW does. Absent means "not a command
		// job", never an empty string, for PI_PACKAGES' reason. PI_FLOW and PI_COMMAND are mutually
		// exclusive by parse (command XOR flow); that is deliberately NOT re-enforced here -- a second
		// validator is a second place to disagree with the first.
		PI_COMMAND: command || undefined,
		// Kill switch for job-time package installation, UNCONDITIONAL for every job. pi's resolver shells out
		// to a REAL `npm install` for any npm:/git: source unless offline mode is on, and `~/.pi/agent` IS
		// writable in the container. We emit only local paths, so nothing should reach that branch -- this
		// makes it UNREACHABLE rather than merely unused. It is a narrowing, never a capability, which is why
		// it is not gated on the opt-in.
		PI_OFFLINE: "1",
	};

	// The provider credential(s), under pi's expected variable name(s), so pi's own auth resolution finds them.
	Object.assign(env, credEnv);

	// Operator-declared extra vars (PI_FORWARD_ENV), forwarded by EXACT name -- the allowlist
	// no-broad-env-into-container prescribes, not a host pass-through. This is how a CUSTOM provider's
	// key (one pi's findEnvKeys table does not know) reaches the container. A name whose value is unset
	// on the host is skipped, never forwarded as empty.
	for (const name of forwardEnv) {
		if (hostEnv[name] !== undefined) env[name] = hostEnv[name];
	}

	// The trigger's own secrets (REQ-TRIGGER-SECRETS), resolved HOST-SIDE by the processor before anything
	// spent and injected exactly the way the provider credential is -- never a vault credential handed to the
	// container to fetch them itself. `docs/secrets.md`'s rule survives intact: what crosses the boundary is a
	// value, and the thing that can FETCH values stays on the host.
	//
	// AFTER the PI_FORWARD_ENV loop, for that loop's own stated reason: a name on the operator's blanket host
	// list must not silently outrank the specific reference this trigger declared.
	//
	// BEFORE the egress assign, and that direction is deliberate rather than incidental. A secret named
	// HTTPS_PROXY that WON would point this job away from the proxy its --internal network was built around,
	// while reading exactly like the control working -- an OUTAGE dressed as a policy. config.mjs refuses
	// those names in PI_FORWARD_ENV outright while the policy is armed, for the same reason.
	//
	// BEFORE the mint below too, so the per-job scoped token still wins. A vault-supplied GITHUB_TOKEN overwriting
	// the mint would hand every container a long-lived operator credential: CONST-TOKEN-SCOPED-PER-JOB
	// defeated by a config line, which is the inversion forwardEnvList refuses at boot.
	//
	// Ordering is the BACKSTOP, not the gate. parseTriggers refuses every statically knowable one of these
	// names at load, and the processor refuses the provider's own credential variables and the PI_FORWARD_ENV
	// names pre-spend, where the resolved provider and the host env are in hand. This is the same division of
	// labour the minted token already keeps ("and loadConfig refuses those names at load anyway").
	//
	// A LOOP rather than Object.assign, so a non-string or empty value becomes an ABSENT variable rather than
	// `NAME=`: docker-run skips `undefined` but not `""`, and "never an empty string" is the rule PI_PACKAGES,
	// PI_SESSION_FILE and PI_FLOW already keep. The resolver guarantees non-empty; this is the defense in
	// depth at the DI seam that the empty-token guard keeps for the mint.
	for (const [name, value] of Object.entries(secrets ?? {})) {
		if (typeof value === "string" && value !== "") env[name] = value;
	}

	// The shipped egress policy's variables (REQ-EGRESS-ALLOWLIST), AFTER the PI_FORWARD_ENV loop so a
	// forwarded name can never override them -- the same ordering, for the same reason, as the minted token
	// below (and loadConfig refuses those names outright while the policy is armed anyway).
	//
	// Empty object when no policy is armed, so `-e` emits nothing and the container env is byte-identical
	// to one built before this feature existed.
	//
	// NODE_USE_ENV_PROXY is the one that matters and the one the hand-written recipe omits. The two proxy
	// variables alone steer git, gh, npm and Chromium but NOT the runner's provider call, because the
	// Anthropic SDK resolves globalThis.fetch and nothing installs a proxy-aware dispatcher without this
	// flag. Behind an internal network that is not a leak, it is an outage: every job dies at its first
	// turn. It rides the closed map, never PI_FORWARD_ENV, so arming the policy cannot half-work.
	Object.assign(env, egressEnv({ proxy: egressProxy, armed: egress }));

	// Forge-backed jobs, and local cron jobs that opted in via run.github. Other local-folder jobs have
	// no token (CONST-TOKEN-SCOPED-PER-JOB). The mint goes into BOTH of its forge's variables because
	// each CLI has its own preference -- gh prefers GH_TOKEN over GITHUB_TOKEN, glab prefers GITLAB_TOKEN
	// -- and mirroring forecloses any precedence surprise inside the container.
	//
	// The token goes ONLY into its own forge's names. A GitLab credential exported as GITHUB_TOKEN would
	// be sent by `gh` to github.com on the agent's first tab-complete: a working credential handed to the
	// wrong host, which is how a scoped token stops being scoped.
	//
	// This assignment deliberately sits AFTER the PI_FORWARD_ENV loop so a forwarded name can never
	// override the mint (and loadConfig refuses those names at load anyway).
	// Absent token => absent variable, never an empty one.
	//
	// The forge is looked UP, never fallen back to. This was an `if gitlab / else github`, and the `else`
	// was the whole hazard: a job of any kind the table did not name -- a new forge wired up everywhere but
	// here, a typo that survived validation -- got its credential exported as GITHUB_TOKEN and GH_TOKEN,
	// which is precisely the "working credential handed to the wrong host" the paragraph above describes.
	// A local cron job that opted in via run.github has kind "local" and genuinely wants GitHub's names, so
	// it is mapped explicitly rather than inheriting them from a default.
	if (githubToken) {
		const spec = forgeSpec(forgeKind === "local" ? "github" : forgeKind);
		if (!spec) {
			throw configError(`buildContainerEnv: no token variable names for job kind ${JSON.stringify(forgeKind)} -- add it to FORGES in worker/src/forges.mjs rather than letting it inherit another forge's`);
		}
		for (const name of spec.tokenVars) env[name] = githubToken;
		const host = forgeHosts?.[forgeKind];
		if (spec.hostVar && host) env[spec.hostVar] = host;
	}

	return env;
}
