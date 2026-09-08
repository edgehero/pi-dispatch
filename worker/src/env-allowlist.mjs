/**
 * Build the EXACT environment a job container receives. Never a pass-through.
 *
 * `no-broad-env-into-container` is a BLOCKER, and for good reason: `ANTHROPIC_OAUTH_TOKEN`
 * silently outranks `ANTHROPIC_API_KEY`, so one stray host variable would redirect which
 * credential every job spends, with no error and no log line. So we forward a closed set.
 *
 * The provider key variable is DERIVED from pi's own table, not hardcoded. Deriving it means any of
 * pi's ~30 providers works with no code change here, and the list cannot drift when pi adds one, as a
 * hand-copied table would. `getApiKeyEnvVars` (that table) is intentionally NOT exported by pi, which
 * is why `providerKeyCandidates` below has to recover it a different way.
 *
 * **There was a second wrapper here, `providerKeyVars`, and it is GONE (issue #309).** It was a
 * one-line pass-through to `findEnvKeys(provider, hostEnv)`, which filters pi's list by PRESENCE and
 * returns a single `undefined` for both "no such provider" and "known provider, nothing set". Every
 * caller it ever had asked it the wrong question: `resolveProviderCredential` wanted the names and
 * read the values elsewhere (issue #311), and `secrets.mjs`'s reserved-name gate wanted what a trigger
 * may not NAME, which is a property of the provider and not of this host. The presence filter also
 * leaks: pi's `getProviderEnvValue` is `env?.[name] || process.env[name]`, so it reports names the
 * MACHINE carries as well. It is deleted rather than re-documented because an exported helper that
 * answers a subtly wrong question does not stay uncalled; both defects in this cluster were somebody
 * reaching for it. pi's own behaviour is still pinned, against `findEnvKeys` directly, in
 * `worker/test/env-allowlist.test.mjs`.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findEnvKeys } from "@earendil-works/pi-ai/compat";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { egressEnv } from "./egress.mjs";
import { forgeSpec } from "./forges.mjs";
import { apiKeyVariable } from "./provider-key.mjs";

function configError(message) {
	const error = new Error(message);
	error.piDispatchConfig = true;
	return error;
}

/**
 * An environment in which EVERY variable is set, used only to interrogate pi.
 *
 * `findEnvKeys(provider, env)` filters pi's own candidate list by PRESENCE, so against an env where
 * nothing is absent the filter is the identity and the return value IS pi's table for that provider,
 * in pi's own precedence order. That is how `providerKeyCandidates` recovers a list pi deliberately
 * does not export (`getApiKeyEnvVars` is module-private). It is a dependency on pi filtering rather
 * than short-circuiting, which is stated here rather than discovered later: it holds at the pin, it is
 * round-tripped for every provider by env-allowlist.test.mjs, and CONST-PI-VERSION-PINNED is what
 * makes that test the upgrade gate.
 *
 * A Proxy rather than a literal, and the second reason is the load-bearing one:
 *   - the candidate NAMES are the thing being asked for, so they cannot be enumerated in advance;
 *   - `getProviderEnvValue` (pi-ai/dist/utils/provider-env.js) falls back to the REAL `process.env`
 *     for any name the injected env has no value for. A plain `{}` therefore answers with whatever the
 *     machine happens to export -- a doctor run on a laptop would disagree with the server it is
 *     diagnosing, and every test injecting a fake env would be non-hermetic. A trap that always returns
 *     a non-empty string short-circuits that `||` before the fallback is reached.
 * Strings only: a symbol read (Symbol.toPrimitive and friends) answering with a string would make this
 * object lie about being one.
 */
const EVERY_VAR_SET = new Proxy({}, { get: (_target, name) => (typeof name === "string" ? "set" : undefined) });

/**
 * Every variable pi reads this provider's key from, in pi's precedence order, set or not. `[]` means pi
 * reads no API-key variable for this id -- either there is no such provider, or it authenticates some
 * other way. `piProviders` is what tells those two apart.
 *
 * This is the ONLY question this module asks pi about variable names, and that is the point (#286, #311,
 * #309). Asking `findEnvKeys(provider, hostEnv)` instead answers "what does this HOST have", conflates
 * "unknown provider" with "known provider, nothing set" in one `undefined`, and decides presence partly
 * from the real `process.env`. Three callers wanted three different things from it and all three were
 * better served by the candidate list plus a presence test of their own: `doctor` NAMES a variable an
 * operator should set, `resolveProviderCredential` reads values out of the env it was handed, and
 * `secrets.mjs` reserves what a trigger may not name.
 */
export function providerKeyCandidates(provider) {
	// The string filter is on the RESULT, not just on the trap. pi looks its provider up in a plain object
	// literal, so `__proto__` and `constructor` resolve up the prototype chain and hand back a non-string
	// "variable name"; against a real environment that candidate reads as undefined and pi drops it, but
	// an environment where everything is present keeps it, and doctor would print `set [object Object] in
	// .env`. pricing.mjs guards pi's other generated lookups the same way and for the same reason.
	return (findEnvKeys(provider, EVERY_VAR_SET) ?? []).filter((name) => typeof name === "string");
}

/**
 * pi's provider catalog, through the same side-effect-free specifier `pricing.mjs` uses -- never
 * `getProviders` from "/compat", which is a @deprecated alias for this exact function and reaching it
 * means loading compat's module-scope provider registration.
 *
 * Only ever consulted AFTER `providerKeyCandidates` comes back empty, and the order is load-bearing:
 * the catalog is NOT a superset of the ids `findEnvKeys` answers for. `radius` is a purely dynamic
 * provider with a real key variable (PI_GATEWAY_API_KEY) and no catalog entry, so asking this first
 * would call a working configuration unknown.
 */
export function piProviders() {
	return getBuiltinProviders();
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
export function resolveProviderCredential({ provider, hostEnv, authFromPi = false, agentDir, readFile = readFileSync, forwardEnv = [] }) {
	// The NAMES come from pi, the VALUES from `hostEnv`, and this asks each question of the thing that can
	// answer it (issue #311). It used to be one `providerKeyVars(provider, hostEnv)` call, which conflates
	// them: that is `findEnvKeys`, whose presence test falls back to the REAL `process.env` for any name the
	// given env lacks, so a name could be "present" on the strength of the machine and then be read out of
	// an env that does not carry it, yielding `{ NAME: undefined }` -- a credential-shaped answer with no
	// credential in it, and no fall through to the auth.json login that would have worked.
	//
	// `providerKeyCandidates` is the hermetic half of the same oracle, so the leaky question is not asked at
	// all rather than asked and corrected. The result is identical by construction: a name truthy in
	// `hostEnv` is always one `findEnvKeys` would have returned, and pi's precedence order is preserved.
	// Truthiness matches pi's own filter, so a name kept here is a name pi would read.
	//
	// Unreachable in the shipped worker, where `hostEnv` IS `process.env` and the two agree by identity. It
	// is the DI seam that was dishonest, which is worth fixing where the seam is the whole test surface.
	// ONE read per name, checked and returned, for the same reason: two reads could decide on one value and
	// ship another.
	const held = providerKeyCandidates(provider)
		.map((name) => [name, hostEnv[name]])
		.filter(([, value]) => value);
	if (held.length > 0) {
		return Object.fromEntries(held);
	}
	if (authFromPi) {
		const { name, value } = credentialFromPiAuth(provider, agentDir ?? defaultAgentDir(hostEnv), readFile, { hostEnv, forwardEnv });
		return { [name]: value };
	}
	throw configError(`provider ${provider} has no configured credential in the worker environment`);
}

function defaultAgentDir(hostEnv) {
	// pi's getAgentDir() default, resolved without importing the whole pi SDK into the worker.
	return hostEnv.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function credentialFromPiAuth(provider, agentDir, readFile, { hostEnv = {}, forwardEnv = [] } = {}) {
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
	// `typeof`, not truthiness. A hand-edited auth.json can hold a number, an array or an object here (pi
	// parses the file and validates no schema), and the old `!cred.key` guard passed all three: an object
	// became `-e ANTHROPIC_API_KEY=[object Object]` in a paid container. Issue #311 made this reachable for
	// twelve more providers, so it is guarded here rather than left to the coercion.
	if (typeof cred.key !== "string") throw configError(`the pi login for "${provider}" in ${path} does not hold a string API key — run \`pi login\` again, or set the key in .env`);
	// **The worker forwards this value; pi RESOLVES it.** `auth-storage.js` reads the stored key through
	// `resolveConfigValue(cred.key, cred.env)`, a grammar where a leading "!" runs the rest as a SHELL
	// COMMAND and takes stdout, "$VAR"/"${VAR}" interpolate from the environment, and "$$"/"$!" escape. An
	// environment variable is read raw, through no such grammar, so a login stored in any of those forms
	// arrives in the container as its own source text and every job spends a container to fail auth, with
	// `doctor` green because the field is a non-empty string.
	//
	// This REFUSES rather than resolving. Running the command host-side is not on the table (it would
	// execute operator shell out of a credential file, per job, in the worker); interpolating "$VAR" would
	// be reimplementing a grammar pi does not export, which is `no-reimplementing-pi` and the same trap
	// #311 is about. The test is deliberately a superset of pi's parse: any "$" at all, not a parse of one.
	// A key that pi would have passed through unchanged contains neither character, and over-refusing
	// pre-spend costs nothing, which is exactly the trade `CONST-BUDGET-BEFORE-TOKENS` asks for.
	if (cred.key.startsWith("!") || cred.key.includes("$")) {
		throw configError(
			`the pi login for "${provider}" in ${path} is a command or a variable reference, not a literal key. pi resolves that form itself; this service forwards the value to a container, where it is read as-is. Resolve it and set the key in .env instead.`,
		);
	}
	// The credential's companion config (`cred.env`), which is NOT a variable-name hint -- it is a
	// `Record<string, string>` of provider settings, and for both Cloudflare providers pi returns NO auth at
	// all without `CLOUDFLARE_ACCOUNT_ID` (and `CLOUDFLARE_GATEWAY_ID` for the gateway). The container env
	// is a closed set, so these names do not ride along with the key; pi does fall back to the ambient
	// environment for them, which makes `PI_FORWARD_ENV` a real answer rather than a shrug. Refuse only for
	// the names that will NOT arrive, so a deployment that already forwards them is untouched.
	const missing = Object.keys(cred.env ?? {}).filter((n) => !(forwardEnv.includes(n) && hostEnv?.[n]));
	if (missing.length > 0) {
		throw configError(
			`the pi login for "${provider}" carries provider settings the container will not receive (${missing.join(", ")}). The job env is a closed set. Set ${missing.join(" and ")} in the worker environment and list ${missing.length > 1 ? "them" : "it"} in PI_FORWARD_ENV.`,
		);
	}
	const name = resolveEnvName(provider);
	if (!name) {
		// Two different facts, and they need different fixes -- the same split `doctor` makes, in the same
		// order (candidates first, catalog second: `radius` has a key variable and no catalog entry, so
		// asking membership first would call a working configuration unknown). The old message said "set it
		// in the worker environment manually" for BOTH, which for the first is advice `doctor` correctly
		// calls impossible: there is no variable to set.
		if (piProviders().includes(provider)) {
			throw configError(
				`pi authenticates "${provider}" without an API-key environment variable (an AWS profile or an OAuth login), and the container env is a closed set of variables, so it has no way in. Configure a provider whose credential is a single environment variable.`,
			);
		}
		throw configError(`could not determine the environment variable pi expects for provider "${provider}" — pi has no such provider, so check PI_PROVIDER against pi's own ids`);
	}
	return { name, value: cred.key };
}

/**
 * The env var name to write this provider's `auth.json` api key under. `null` when pi reads no key
 * variable for the provider at all, which `credentialFromPiAuth` turns into a refusal.
 *
 * The oracle instinct in the old version of this comment was right and its execution was not, which is
 * worth recording rather than deleting (issue #311). It asked pi's own `findEnvKeys` rather than keeping a
 * provider→var table, but the CANDIDATES it asked with were hand-generated: the credential's `env` field
 * plus a conventional `<PROVIDER>_API_KEY`/`_KEY`. That convention is the part that drifts, and it was
 * wrong for 13 of the 34 provider ids that have a key variable at the pin -- `google` is
 * `GEMINI_API_KEY`, `huggingface` is `HF_TOKEN`, `moonshotai` is `MOONSHOT_API_KEY`, `github-copilot` is
 * `COPILOT_GITHUB_TOKEN`, `radius` is `PI_GATEWAY_API_KEY` -- so for those pi recognized nothing and a
 * valid `pi login` refused every job. The convention happening to be right for the other 21 is what let
 * this survive: `anthropic` and `openai` are both in that set.
 *
 * The `env` candidate was dead on arrival besides: at the pin `ApiKeyCredential.env` is a
 * `Record<string, string>` of provider config (Cloudflare account and gateway ids), never a variable
 * name, so the string filter dropped it on every call.
 *
 * `providerKeyCandidates` is pi's whole list, so there is nothing left to guess, and it asks against an
 * environment where every name is present -- which also closes a hermeticity hole the synthetic object
 * had: pi's `getProviderEnvValue` falls back to the real `process.env`, so on a host that exported
 * `ANTHROPIC_OAUTH_TOKEN` the old code resolved to THAT name. `apiKeyVariable` then picks the same
 * variable `doctor` names, from the same module, so the two cannot diverge again.
 */
function resolveEnvName(provider) {
	return apiKeyVariable(providerKeyCandidates(provider));
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
	const credEnv = resolveProviderCredential({ provider, hostEnv, authFromPi, agentDir, readFile, forwardEnv });

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
	// on the host is skipped, never forwarded as empty. That second half was a claim rather than a check
	// until issue #311: the guard tested `!== undefined`, so a name set to "" WAS forwarded, and since this
	// loop runs after the credential assign above, `PI_FORWARD_ENV=<the provider's key variable>` with a
	// blank value in the host env blanked a working auth.json credential and the job spent a container to
	// fail auth. Same emptiness rule as the secrets loop below, which had it right.
	for (const name of forwardEnv) {
		const value = hostEnv[name];
		if (value !== undefined && value !== "") env[name] = value;
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
