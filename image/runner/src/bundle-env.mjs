import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LAYOUT } from "./layout.mjs";
import { configError } from "./outcome.mjs";

/**
 * A project secret bundle's PLAIN variables on a venue that copies or binds the job's files from a gateway (issue #704
 * part 3, the `bundleEnvFile` capability): the worker writes them as one JSON object to `bundle-env.json` in the job's
 * own directory (`/sandbox/job` on the copy venue, the read-only `/job` bind on the bind venue) and sets
 * PI_BUNDLE_ENV=1; this runner reads the file before pi's runtime exists and puts each variable into its OWN
 * environment, which is pi's (pi runs in this process) and every tool pi starts inherits, exactly what `-e NAME=VALUE`
 * gives a job on `local` and `podman`.
 *
 * WHY A FILE, AND NOT THE EXEC'S `--env`. OpenShell 0.1.4's exec takes env only as `KEY=VALUE` on the CLI's argv, and
 * the gateway puts those pairs at the head of the remote command and logs its first 120 characters at INFO
 * (openshell-server/src/grpc/sandbox.rs `build_remote_exec_command`, `stream_exec_over_relay`), so a value there lands
 * on the host's argv AND in the gateway's journal. The file is in the job directory the worker already hands over, and
 * the agent may read it: these values are the ones the operator hands the agent as values on every venue.
 *
 * STRICT, like every runner input: the flag is `1` or absent; the file is one object of non-empty strings of at most
 * `BUNDLE_ENV_MAX_BYTES`; a name is an environment variable name, never PI_* or OPENSHELL_*, never one of
 * `BUNDLE_ENV_PROTECTED` (what the worker, the sandbox or this runner sets: HOME, USER, SHELL, TERM, PATH, the
 * sandbox's CA and proxy variables, the git helper's), and never one whose current value is an OpenShell placeholder
 * (`openshell:resolve:env:`, a provider key: the model key, the forge token, a run.secrets or endpoint value); no value
 * carries a NUL (an environment cannot hold one). Any OTHER name already set (an `ENV` the job image bakes in) is
 * REPLACED, as `-e NAME=VALUE` replaces an image's ENV on `local` and `podman` (final review round: refusing every set
 * name failed a job after spend for a name the worker had admitted). A closed list rather than "anything set" for that
 * reason; the worker's own gate (backend-openshell.mjs `OPENSHELL_SET_ENV_NAMES`, held to be a subset of this list by
 * its test) refuses the same names before spend, so this is the backstop, never the first answer. The worker refused every reserved
 * name before spend; this is the line that holds if that refusal is ever bypassed. Anything else is a config failure
 * (exit 2, never retried) before anything is spent, never a job run without a variable it was given. JSON carries a
 * newline as `\n`, so a PEM or any multi-line value arrives intact.
 */
export const BUNDLE_ENV_FLAG = "PI_BUNDLE_ENV";
export const BUNDLE_ENV_FILE = "bundle-env.json";
/** The bundle's own output cap (worker/src/secret-bundles.mjs, 256 KiB) with room for JSON escaping. */
export const BUNDLE_ENV_MAX_BYTES = 1024 * 1024;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** The names a bundle variable may never replace here (above). */
export const BUNDLE_ENV_PROTECTED = Object.freeze(["HOME", "USER", "SHELL", "TERM", "LOGNAME", "PATH", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "NODE_EXTRA_CA_CERTS", "DENO_CERT", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "all_proxy", "http_proxy", "https_proxy", "no_proxy", "grpc_proxy", "NODE_USE_ENV_PROXY", "NODE_OPTIONS"]);
const PLACEHOLDER = "openshell:resolve:env:";

/**
 * Read the plain bundle variables into `env` (this process's own by default). Returns the count applied (0 when the
 * worker set no flag). The flag leaves the environment either way, so no child sees it.
 */
export function applyBundleEnv({ env = process.env, path = join(LAYOUT.job, BUNDLE_ENV_FILE), read = readFileSync } = {}) {
	// env-internal PI_BUNDLE_ENV: written by the worker on the container's closed env map, refused as a forwarded name.
	const flag = env.PI_BUNDLE_ENV;
	delete env.PI_BUNDLE_ENV;
	if (flag === undefined) return 0;
	if (flag !== "1") throw configError(`invalid ${BUNDLE_ENV_FLAG}: ${JSON.stringify(flag)} (want 1)`);
	let text;
	try {
		text = read(path);
	} catch {
		throw configError(`${BUNDLE_ENV_FLAG}=1 but the job's ${BUNDLE_ENV_FILE} could not be read`);
	}
	if (text.length > BUNDLE_ENV_MAX_BYTES) throw configError(`the job's ${BUNDLE_ENV_FILE} is over ${BUNDLE_ENV_MAX_BYTES} bytes`);
	let doc;
	try {
		doc = JSON.parse(String(text));
	} catch {
		throw configError(`the job's ${BUNDLE_ENV_FILE} is not JSON`);
	}
	if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw configError(`the job's ${BUNDLE_ENV_FILE} is not one object`);
	const entries = Object.entries(doc);
	// Judged whole before any variable is set, so a refused file leaves the environment as it was.
	for (const [name, value] of entries) {
		// The NAME only, never a value: the exit line and the job log are read by the operator, not the agent alone.
		if (!ENV_NAME.test(name) || name.startsWith("PI_") || name.startsWith("OPENSHELL_")) throw configError(`the job's ${BUNDLE_ENV_FILE} names ${JSON.stringify(name)}, which a bundle may not set`);
		if (BUNDLE_ENV_PROTECTED.includes(name) || (typeof env[name] === "string" && env[name].startsWith(PLACEHOLDER))) throw configError(`the job's ${BUNDLE_ENV_FILE} names ${name}, which this job's runtime or its credential provider already sets`);
		if (typeof value !== "string" || value === "" || value.includes("\0")) throw configError(`the job's ${BUNDLE_ENV_FILE} has an unusable value for ${name}`);
	}
	for (const [name, value] of entries) env[name] = value;
	return entries.length;
}
