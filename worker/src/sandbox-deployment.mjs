/** An explicit deployment handoff is stronger than a generic deployment pointer: it loads sandbox authority only. */
import * as nodeFs from "node:fs";
import { isAbsolute, join, win32 } from "node:path";
import { homedir } from "node:os";
import { deploymentServiceEnv } from "./service-env.mjs";
import { workerName } from "./config.mjs";

export const SANDBOX_DEPLOYMENT_KEYS = Object.freeze([
	"PI_WORKER_NAME", "PI_SANDBOX_DIR", "PI_JOBS_DIR", "PI_SANDBOX_RETENTION_HOURS", "PI_SANDBOX_PIN_DAYS", "PI_SANDBOX_IDLE_MINUTES",
	"PI_BACKENDS", "PI_BACKEND_FLOOR", "PI_EGRESS", "PI_EGRESS_PROXY", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH",
	"VALKEY_URL", "VALKEY_PASSWORD", "PI_VALKEY_SHARED", "PATH", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "CONTAINERS_STORAGE_CONF", "CONTAINERS_CONF", "CONTAINERS_CONF_OVERRIDE", "CONTAINERS_REGISTRIES_CONF", "CONTAINER_HOST", "CONTAINER_CONNECTION",
]);
const OS_KEYS = Object.freeze(["HOME", "USERPROFILE", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR", "TERM", "LANG", "LC_ALL", "PATH"]);
export function sandboxDeploymentEnv({ dir, env = process.env, expectedHost = null, fs = nodeFs, platform = process.platform, uid = process.geteuid?.(), home = homedir(), read = deploymentServiceEnv } = {}) {
	const refuse = (message) => ({ refused: "sandbox-deployment", message });
	if (typeof dir !== "string" || !isAbsolute(dir) || /[\x00-\x1f\x7f]/.test(dir)) return refuse("--deployment must name an absolute deployment directory");
	// One descriptor-backed read. Ambient values are compared afterwards, never used as defaults for authority.
	const resolved = read({ dir, env: {}, keys: SANDBOX_DEPLOYMENT_KEYS, platform, fs, uid });
	if (resolved.unreadable || resolved.untrusted || resolved.hazard) return refuse("the deployment .env cannot be trusted or read as its service reads it; run pi-dispatch doctor");
	if (!resolved.path || (resolved.fromFile && Object.keys(resolved.fromFile).length === 0 && resolved.env && !fs.existsSync(resolved.path))) return refuse("the deployment .env is missing; point --deployment at the installed deployment");
	if (resolved.unread?.length || resolved.hazardSkipped?.length) return refuse("a sandbox setting cannot be read the way the deployment service reads it; run pi-dispatch doctor");
	const clean = { ...resolved.env };
	for (const key of SANDBOX_DEPLOYMENT_KEYS) {
		if (typeof env[key] !== "string") continue;
		// SSH's PATH routinely lacks the service's Docker/Podman directory. A reviewed deployment PATH wins;
		// when absent, PATH alone keeps the ordinary OS fallback (it grants no sandbox policy or runtime endpoint).
		if (key === "PATH") continue;
		if (typeof clean[key] === "string") {
			if (clean[key] !== env[key]) return refuse(`the shell disagrees with the deployment for ${key}; unset that variable before opening`);
			continue;
		}
		// PAM supplies the account's standard runtime directory on an SSH login, as a user service does. Admit it
		// only after identity/ownership validation; a non-default rootless store remains deployment authority.
		if (key === "XDG_RUNTIME_DIR" && platform === "linux" && Number.isInteger(uid) && env[key] === `/run/user/${uid}`) {
			try { const stat = fs.lstatSync(env[key]); if (stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid && !(stat.mode & 0o077)) { clean[key] = env[key]; continue; } } catch {}
		}
		if (key === "XDG_DATA_HOME" && env[key] === join(home, ".local", "share")) { clean[key] = env[key]; continue; }
		if (key === "XDG_CONFIG_HOME" && env[key] === join(home, ".config")) { clean[key] = env[key]; continue; }
		return refuse(`the shell sets sandbox authority absent from the deployment: ${key}; unset that variable before opening`);
	}
	const result = {};
	for (const key of OS_KEYS) if (typeof env[key] === "string") result[key] = env[key];
	// env-internal HOME: compare the launching account's home to the OS identity before opening a rootless store.
	if (platform !== "win32" && env.HOME && env.HOME !== home) return refuse("HOME is not this account's home; open the sandbox as the worker's account");
	for (const key of SANDBOX_DEPLOYMENT_KEYS) if (typeof clean[key] === "string") result[key] = clean[key];
	if (typeof result.PATH === "string" && (/[\x00-\x1f\x7f]/.test(result.PATH) || result.PATH.split(platform === "win32" ? ";" : ":").some((part) => !part || !(platform === "win32" ? win32.isAbsolute(part) : isAbsolute(part))))) return refuse("the sandbox runtime PATH must contain only absolute tool directories; correct PATH in the deployment .env");
	try {
		if (expectedHost !== null && workerName(result) !== expectedHost) return refuse("the deployment worker name does not match the opener host; check Fleet and the local opener configuration");
	} catch { return refuse("the deployment worker name is invalid; run pi-dispatch doctor"); }
	return { env: result };
}
