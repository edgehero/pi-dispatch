/**
 * Project secret bundles (issue #704, REQ-TRIGGER-SECRETS, DES-PROJECT-SECRET-BUNDLES): a project's whole
 * environment, read HOST-SIDE by ONE resolver call per job, before the container starts.
 *
 * `run.secrets` grants per trigger and per field, and its resolver runs once per reference. A bundle grants per
 * project and runs once per JOB: the triggers file's `secretBundles` binds a project to a bundle profile and a
 * reference, and the resolver prints every variable of that environment on stdout. A variable the operator adds
 * or removes in their manager (or file) reaches the next job with no edit to the reviewed file. That is the
 * asked-for trade, recorded where `DES-PER-TRIGGER-SECRET-PROFILE` once rejected it: the reviewed file no longer
 * lists the fields, so the review of WHAT a project holds moves to the manager.
 *
 * THE SEAM IS STILL A COMMAND. `secrets.mjs`' rule holds verbatim: the reference grammar belongs to the
 * operator's script, nothing here recognises a manager's notation, and the resolver's exit code is the runner's
 * (`INT-RUNNER-EXIT-CODE-PROTOCOL`): 0 carries the environment, 2 says the reference is wrong (refused, never
 * retried), anything else says the manager could not be reached (retried). `runResolver` is imported, not
 * copied, so the spawn, the stdio, the timeout, the abort and the kill escalation are the ones `run.secrets` has.
 *
 * WHAT IS DIFFERENT, and each for a reason:
 *   - the byte cap is the whole environment's, `MAX_BUNDLE_BYTES`, and every value still holds to
 *     `MAX_SECRET_BYTES`, so a bundle cannot carry a value a single reference could not;
 *   - the output is PARSED, by a declared format, strictly (`parseBundleOutput`);
 *   - a reserved name is a REFUSAL naming the variable, never a drop. A variable an operator added in their
 *     manager that silently never arrives is this project's worst outcome, and dropping is that;
 *   - errors and log lines name VARIABLES (and dotenv line numbers), never a value, a reference or a byte the
 *     resolver printed. A variable name is the operator's own choice from their own manager, the class
 *     `run.secrets` names freely in its logs; a line that failed to parse is not named even by its first word,
 *     because a malformed line can be the second half of a value.
 */

import { spawn } from "node:child_process";
import { providerKeyCandidates } from "./env-allowlist.mjs";
import { findDuplicateKey } from "./json-duplicates.mjs";
import { mergeSecretProfiles, withinRoots } from "./secret-profiles.mjs";
import { MAX_SECRET_BYTES, realExecutable, runResolver } from "./secrets.mjs";
import { ENV_NAME, RESERVED_ENV_NAMES, SECRET_BUNDLE_VARS_MAX } from "./triggers.mjs";

/**
 * The largest output a bundle resolver may print: 256 KiB. Four `MAX_SECRET_BYTES`, so a bundle holds a few PEM
 * chains and a service-account JSON beside its plain keys, and the whole of it sits in one worker's memory once
 * per job start (never per reference). On overflow the child is killed and the job refuses, NEVER truncated, the
 * rule `MAX_SECRET_BYTES` states: a cut environment is a variable silently missing.
 */
export const MAX_BUNDLE_BYTES = 256 * 1024;

/**
 * Names a BUNDLE may not carry, beyond the ones `run.secrets` may not bind (issue #704 review). A bundle's contents are
 * not reviewed: they are whatever the operator's manager holds at the job's start, written by whoever can write that
 * manager, so a variable that changes what CODE runs in the job, or how it trusts the network, is refused by name
 * rather than injected. Each one steers a loader or a tool the job image runs, whatever the agent does:
 *   - the dynamic loaders (`LD_*`, `DYLD_*`) and `PATH`, which choose the binaries and libraries every process loads;
 *   - Node's `NODE_OPTIONS` (the runner gives its children a metering preload through it, `image/runner/src/child-watch.mjs`,
 *     so a bundle value would also blind the child meter) and `NODE_PATH`, and TLS trust (`NODE_EXTRA_CA_CERTS`,
 *     `NODE_TLS_REJECT_UNAUTHORIZED`, `SSL_CERT_FILE`, `SSL_CERT_DIR`), which `provider-steering.mjs` deliberately leaves
 *     bindable by a REVIEWED trigger and which an unreviewed bundle must not set;
 *   - the shells' start-up hooks (`BASH_ENV`, `ENV`, `PROMPT_COMMAND`), run by every non-interactive shell the agent opens;
 *   - git's command and config hooks (`GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`, `GIT_EXEC_PATH`, `GIT_PROXY_COMMAND`,
 *     `SSH_ASKPASS`, and every `GIT_CONFIG*`, which can set `core.sshCommand` or a credential helper), which run on the
 *     push of the job's own branch with its forge token in hand;
 *   - the interpreters' start-up hooks (`PYTHONPATH`, `PYTHONHOME`, `PYTHONSTARTUP`, `PERL5OPT`, `PERL5LIB`, `RUBYOPT`,
 *     `RUBYLIB`, `JAVA_TOOL_OPTIONS`), git's template directory (`GIT_TEMPLATE_DIR`, hooks copied into every clone);
 *   - the other tools' TLS trust (`GIT_SSL_NO_VERIFY`, `GIT_SSL_CAINFO`, `GIT_SSL_CAPATH`, `REQUESTS_CA_BUNDLE`,
 *     `CURL_CA_BUNDLE`) and npm's whole configuration (`npm_config_*`, matched CASE-INSENSITIVELY because npm reads it
 *     so: a registry, a script shell, an `ignore-scripts` turned off).
 * The table is held to `docs/secrets.md`'s list between its markers by a test, both directions.
 * A REFUSAL naming the variable (`secret-name-reserved`), never a drop, the header's rule. `run.secrets` keeps its own
 * narrower set: a trigger is reviewed, and a deploy flow may legitimately bind, say, `PYTHONPATH`.
 */
export const BUNDLE_LOADER_NAMES = Object.freeze(["PATH", "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED", "SSL_CERT_FILE", "SSL_CERT_DIR", "BASH_ENV", "ENV", "PROMPT_COMMAND", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS", "GIT_EXEC_PATH", "GIT_PROXY_COMMAND", "GIT_TEMPLATE_DIR", "GIT_SSL_NO_VERIFY", "GIT_SSL_CAINFO", "GIT_SSL_CAPATH", "SSH_ASKPASS", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "PERL5OPT", "PERL5LIB", "RUBYOPT", "RUBYLIB", "JAVA_TOOL_OPTIONS"]);
/** Prefixes, exact case; and `npm_config_`, compared case-insensitively. */
export const BUNDLE_LOADER_PREFIXES = Object.freeze(["LD_", "DYLD_", "GIT_CONFIG"]);
export const BUNDLE_LOADER_PREFIXES_ANY_CASE = Object.freeze(["npm_config_"]);
const LOADER_NAME_SET = new Set(BUNDLE_LOADER_NAMES);

/** Whether a bundle may not carry `name` for the loader reason above. Exported for doctor and the docs' test. */
export function bundleLoaderName(name) {
	return LOADER_NAME_SET.has(name) || BUNDLE_LOADER_PREFIXES.some((prefix) => name.startsWith(prefix)) || BUNDLE_LOADER_PREFIXES_ANY_CASE.some((prefix) => name.toLowerCase().startsWith(prefix));
}

/**
 * Parse a bundle resolver's stdout by its DECLARED format. `{ vars }` (an object of own string properties, in the
 * resolver's order), or `{ failure, name?, line? }` with `failure` one of OUR words:
 *
 *   - `malformed`   a dotenv line that is not `NAME=value`, a blank or a `#` comment; JSON that is not one object;
 *   - `quoted`      a dotenv value that starts with a quote: no quoting is the grammar, and a manager that quotes
 *                   (or an operator who did) would otherwise hand the container the quotes as part of the value;
 *   - `not-string`  a JSON value that is not a string (a number, a nested object), named by its variable;
 *   - `bad-name`    a name that is not an environment variable name (ENV_NAME), or `__proto__`; not named;
 *   - `duplicate`   one name twice: which value wins would be the parser's choice, never the operator's;
 *   - `empty-value` an empty value: a set-but-empty variable is how a broken manager reads as configured;
 *   - `nul`         a value with a NUL, which `-e NAME=VALUE` would silently cut;
 *   - `value-too-large` a value over `MAX_SECRET_BYTES`;
 *   - `too-many`    over `SECRET_BUNDLE_VARS_MAX` variables;
 *   - `empty`       no variable at all: exit 0 that grants nothing is the silent-no-op class `runResolver` refuses
 *                   for a single value, and an operator who emptied an environment by accident must hear it.
 *
 * DOTENV IS STRICT: `NAME=value` per line, the value verbatim to the end of the line, no quoting, no `export `, no
 * spaces around `=`, no expansion, no continuation. Every dotenv dialect differs on exactly those, and a parser
 * that accepts one dialect's quotes silently mangles another's values. One trailing `\r` per line is removed, so a
 * resolver on Windows (CRLF) reads as it was written; a value that needs a `\r`, a newline or a leading quote goes
 * through `json`, which is what that format is for (PEMs and other multi-line values).
 */
export function parseBundleOutput(text, format) {
	const vars = {};
	const seen = new Set();
	const add = (name, value, line = null) => {
		if (typeof name !== "string" || !ENV_NAME.test(name) || name === "__proto__") return { failure: "bad-name", line };
		if (seen.has(name)) return { failure: "duplicate", name };
		if (typeof value !== "string") return { failure: "not-string", name };
		if (value === "") return { failure: "empty-value", name };
		if (value.includes("\u0000")) return { failure: "nul", name };
		if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) return { failure: "value-too-large", name };
		seen.add(name);
		if (seen.size > SECRET_BUNDLE_VARS_MAX) return { failure: "too-many" };
		// An own data property whatever the name (the charset is checked above, `__proto__` refused): never `vars[name] =`.
		Object.defineProperty(vars, name, { value, enumerable: true, writable: true, configurable: true });
		return null;
	};
	if (format === "json") {
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			return { failure: "malformed" };
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { failure: "malformed" };
		// A non-string value first, so a duplicate key INSIDE a nested object is reported as what it is (a value that is
		// not a string), never as a duplicate variable named after a key no variable has.
		const nested = Object.keys(parsed).find((name) => typeof parsed[name] !== "string");
		if (nested !== undefined) return ENV_NAME.test(nested) && nested !== "__proto__" ? { failure: "not-string", name: nested } : { failure: "bad-name" };
		// JSON keeps the LAST of two equal keys, so a duplicate would be a value silently won: the triggers file's rule.
		const duplicate = findDuplicateKey(text);
		if (duplicate) return ENV_NAME.test(duplicate.key) ? { failure: "duplicate", name: duplicate.key } : { failure: "bad-name" };
		for (const name of Object.keys(parsed)) {
			const bad = add(name, parsed[name]);
			if (bad) return bad.failure === "bad-name" ? { failure: "bad-name" } : bad;
		}
	} else if (format === "dotenv") {
		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const raw = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
			if (/^[ \t]*$/.test(raw) || /^[ \t]*#/.test(raw)) continue;
			const eq = raw.indexOf("=");
			if (eq <= 0) return { failure: "malformed", line: i + 1 };
			const name = raw.slice(0, eq);
			const value = raw.slice(eq + 1);
			if (!ENV_NAME.test(name)) return { failure: name.trim() !== name || name.startsWith("export ") ? "malformed" : "bad-name", line: i + 1 };
			if (value.startsWith('"') || value.startsWith("'")) return { failure: "quoted", name };
			// A carriage return left after the one a CRLF line ends with is part of no dotenv value anyone means to write;
			// a value that needs one goes through json.
			if (value.includes("\r")) return { failure: "malformed", line: i + 1 };
			const bad = add(name, value, i + 1);
			if (bad) return bad;
		}
	} else {
		// Unreachable through the declaration parsers, which refuse any other format at boot or overlay read.
		return { failure: "malformed" };
	}
	if (seen.size === 0) return { failure: "empty" };
	return { vars };
}

/**
 * Build the bundle seam the processor injects: `{ lookup, resolve }`.
 *
 *   - `lookup(profile, { overlayBundles })` answers, with no spawn, whether this host can serve the profile:
 *     `{ ok }`, `{ profileUnknown }` or `{ ambiguous }`. FREE, so the processor asks it before the mint, with the
 *     other free refusals (CONST-BUDGET-BEFORE-TOKENS); its rule is `makeSecretsResolver`'s lookup verbatim (own
 *     names only, the realpath probe, an overlay path bounded by PI_SECRET_RESOLVER_ROOTS, a name declared in both
 *     sources ambiguous).
 *   - `resolve(job, binding, { signal, overlayBundles })` runs the resolver ONCE for `binding.ref` and returns
 *     `{ ok, vars }`, `{ profileUnknown }`, `{ ambiguous }`, `{ reserved: name }`, `{ unresolved, failure, ... }`
 *     or `{ unreachable, failure, ... }`. `unresolved` and `unreachable` are `true`, never a name: one call holds
 *     every variable, so there is no single variable to blame for an exit code.
 *
 * `envBundles` is parsed at BOOT (config.mjs `secretBundleProfiles`), `overlayBundles` per job, `secretProfiles`'
 * split and its reason. NOTHING IS ZEROED, `makeSecretsResolver`'s honest half, and the same property holds: the
 * returned map is a local of `runJob`, never attached to the job, never logged, never in a result or a record
 * (the record carries names, rebuilt in run-history.mjs).
 */
export function makeBundleResolver({ envBundles = {}, roots = [], forwardEnv = [], timeoutMs = 10000, spawnFn = spawn, hostEnv = process.env, realExecutablePath = realExecutable, log = () => {} } = {}) {
	function lookup(profile, { overlayBundles = {} } = {}) {
		const merged = mergeSecretProfiles(envBundles, overlayBundles);
		if (merged.ambiguous) return { ambiguous: merged.ambiguous };
		const declared = Object.hasOwn(merged.profiles, profile) ? merged.profiles[profile] : undefined;
		if (declared === null || typeof declared !== "object" || typeof declared.path !== "string") return { profileUnknown: profile };
		let path;
		try {
			path = realExecutablePath(declared.path);
		} catch {
			path = null;
		}
		if (!path) return { profileUnknown: profile };
		// The bound on the REALPATH, in the worker, for env-declared profiles exempt: secrets.mjs gives the reasons.
		if (!Object.hasOwn(envBundles, profile) && !withinRoots(path, roots)) return { profileUnknown: profile };
		return { ok: true, path, format: declared.format };
	}

	async function resolve(job, binding, { signal, overlayBundles = {} } = {}) {
		const found = lookup(binding?.profile, { overlayBundles });
		if (!found.ok) return found;
		const outcome = await runResolver(spawnFn, found.path, binding.ref, { timeoutMs, hostEnv, signal, maxBytes: MAX_BUNDLE_BYTES });
		if (outcome.failure) {
			// The bundle ID, our own failure vocabulary, the script's small integer exit and a byte COUNT; never the
			// reference, the path, or the resolver's words.
			log("secret_bundle_resolve_failed", { bundle: binding.id ?? null, failure: outcome.failure, detail: outcome.detail, code: outcome.code ?? null, stderrBytes: outcome.stderrBytes });
			const shape = { failure: outcome.detail, code: outcome.code ?? null, stderrBytes: outcome.stderrBytes };
			return outcome.failure === "infra" ? { unreachable: true, ...shape } : { unresolved: true, ...shape };
		}
		const parsed = parseBundleOutput(outcome.value, found.format);
		if (parsed.failure) {
			log("secret_bundle_resolve_failed", { bundle: binding.id ?? null, failure: "policy", detail: parsed.failure, name: parsed.name ?? null, line: parsed.line ?? null });
			return { unresolved: true, failure: parsed.failure, name: parsed.name ?? null, line: parsed.line ?? null, code: 0, stderrBytes: outcome.stderrBytes };
		}
		// The reserved names, all three sets `run.secrets` is held to, asked of the WHOLE bundle: the statically
		// knowable set the triggers file refuses at load (it cannot see a bundle's names, which exist only once read),
		// this job's provider credential variables, and PI_FORWARD_ENV. A REFUSAL naming the first one in the
		// resolver's order, never a drop (see the header), and never resolved by ordering: buildContainerEnv writes
		// the provider credential BEFORE the secrets loop, so a bundle carrying ANTHROPIC_API_KEY would silently
		// replace the key every job of the project spends (secrets.mjs records the class).
		const reserved = new Set([...RESERVED_ENV_NAMES, ...providerKeyCandidates(job?.provider), ...forwardEnv]);
		const clash = Object.keys(parsed.vars).find((name) => reserved.has(name) || bundleLoaderName(name));
		if (clash !== undefined) return { reserved: clash };
		return { ok: true, vars: parsed.vars };
	}

	return { lookup, resolve };
}

/**
 * Merge a bundle's variables with the trigger's own `run.secrets` values (issue #704). `run.secrets` WINS a name
 * clash: it is the narrower grant, written for this one trigger in the reviewed file, and the bundle is the
 * project's default. The shadowed names are returned, sorted, for the record, so an override is visible rather
 * than inferred. Own properties throughout, so no name can reach a prototype.
 */
export function mergeBundleSecrets(bundleVars = {}, triggerSecrets = {}) {
	const merged = {};
	const define = (name, value) => Object.defineProperty(merged, name, { value, enumerable: true, writable: true, configurable: true });
	const shadowed = [];
	for (const [name, value] of Object.entries(bundleVars)) {
		if (Object.hasOwn(triggerSecrets, name)) shadowed.push(name);
		else define(name, value);
	}
	for (const [name, value] of Object.entries(triggerSecrets)) define(name, value);
	return { secrets: merged, shadowed: shadowed.sort() };
}
