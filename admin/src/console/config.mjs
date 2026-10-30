/**
 * The console's configuration (issue #640): which deployment, its environment, and the validated settings the server
 * runs with. Every problem is a refusal sentence; nothing here throws for bad input and nothing falls back silently to
 * a default the operator did not ask for (a bound out of range is refused, not clamped, because a clamped idle timeout
 * is a session living longer than the operator configured).
 *
 * WHICH DEPLOYMENT: `--deployment <dir>`, else the deployment pointer's folder (the one the setup wizard wrote, read
 * through `readPointer`), else the current directory. Its `.env` is read with the worker's `deploymentServiceEnv`, the
 * resolver the panel uses (`panelEnv`, read-model.mjs): one descriptor, nothing taken from a file another account can
 * write, an export in this shell outranking the file. Only the keys below are taken from it.
 */
import * as nodeFs from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { logsDirPath } from "@edgehero/pi-dispatch/config";
import { deploymentServiceEnv } from "@edgehero/pi-dispatch/service-env";
import { pointerPath, readPointer } from "../deployment-pointer.mjs";
import { GATEWAY_HOSTS, hostnameOf } from "./guards.mjs";
import { parseListen } from "./listen.mjs";

/** The keys the console reads from the deployment's `.env`. */
export const CONSOLE_ENV_KEYS = Object.freeze([
  "PI_SANDBOX_HOSTS_FILE",
  "PI_CONSOLE_LISTEN",
  "PI_CONSOLE_TOKENS_FILE",
  "PI_CONSOLE_ALLOWED_HOSTS",
  "PI_CONSOLE_READ_ONLY",
  "PI_CONSOLE_BIND_PUBLIC",
  "PI_CONSOLE_IDLE_MINUTES",
  "PI_CONSOLE_MAX_HOURS",
  "PI_CONSOLE_MAX_STREAMS",
  "PI_LOGS_DIR",
  "VALKEY_URL",
  "PI_PAUSE_WINDOWS_FILE",
]);

// Path-valued keys a `.env` may write relative; resolved against the deployment folder, as panelEnv does.
const PATH_KEYS = new Set(["PI_SANDBOX_HOSTS_FILE", "PI_CONSOLE_TOKENS_FILE", "PI_LOGS_DIR", "PI_PAUSE_WINDOWS_FILE"]);

export const DEFAULT_LISTEN = "127.0.0.1:4790";

/**
 * The deployment folder: the flag, else the pointer's, else `cwd`. Returns `{dir, source, notice}`; `notice` names an
 * ignored pointer (never fatal: a broken pointer leaves the console where it would be without one, as for the panel).
 */
export function deploymentDirOf({ arg = null, env = process.env, fs = nodeFs, cwd = process.cwd() } = {}) {
  if (typeof arg === "string" && arg !== "") return { dir: resolvePath(cwd, arg), source: "--deployment", notice: undefined };
  const res = readPointer({ path: pointerPath(env), fs });
  if (res.pointer) return { dir: res.pointer.deploymentDir, source: "pointer", notice: undefined };
  const notice = res.ignored ? `the deployment pointer was ignored (${res.ignored}), so the current directory is used` : undefined;
  return { dir: cwd, source: "cwd", notice };
}

/**
 * This shell's environment with the deployment `.env` filled in for `CONSOLE_ENV_KEYS`. Returns `{env, notice}`;
 * `notice` names keys and files, never a value (a VALKEY_URL may carry a password).
 */
export function consoleEnv({ env = process.env, dir, fs = nodeFs, platform = process.platform, uid = process.geteuid?.() }) {
  const res = deploymentServiceEnv({ env, dir, keys: CONSOLE_ENV_KEYS, platform, fs, uid });
  const out = res.env;
  for (const [key, value] of Object.entries(res.fromFile)) {
    if (PATH_KEYS.has(key) && value !== "" && !isAbsolute(value)) out[key] = resolvePath(dir, value);
  }
  const said = [];
  if (res.unreadable) said.push(`${res.path} could not be read (${res.unreadable}), so only this shell's environment is used`);
  if (res.untrusted) said.push(`${res.path} ${res.untrusted}, so nothing was taken from it`);
  if (res.hazardSkipped.length > 0) said.push(`${res.path} line ${res.hazard.line} ${res.hazard.what}, so none of ${res.hazardSkipped.join(", ")} was read from it`);
  if (res.unread.length > 0) said.push(`${res.path} assigns ${res.unread.map((u) => u.key).join(", ")} in a form the service's loader may read differently, so those values were not used`);
  if (res.disagreements.length > 0) said.push(`this shell and ${res.path} set ${res.disagreements.map((d) => d.key).join(", ")} differently; the shell's value is used`);
  return { env: out, notice: said.length > 0 ? said.join("; ") : undefined };
}

/** A whole number in [min, max] from `raw`, else `fallback` when unset, else a refusal naming the key. */
function boundedInt(raw, name, fallback, min, max) {
  if (raw === undefined || raw === "") return { value: fallback };
  const text = String(raw).trim();
  if (!/^[0-9]{1,6}$/.test(text) || Number(text) < min || Number(text) > max) {
    return { refusal: `${name} must be a whole number from ${min} to ${max} (got ${JSON.stringify(String(raw).slice(0, 20))})` };
  }
  return { value: Number(text) };
}

/** `1` turns a switch on; unset or empty is off; anything else is refused rather than guessed at. */
function flag(raw, name) {
  if (raw === undefined || raw === "" || raw === "0") return { value: false };
  if (raw === "1") return { value: true };
  return { refusal: `${name} must be 1 or unset (got ${JSON.stringify(String(raw).slice(0, 20))})` };
}

/**
 * The validated console settings for `env` (already layered by `consoleEnv`) in deployment folder `dir`. Returns the
 * config object or `{refusal}`.
 *
 * `tokensPath` follows `tokensFilePath` in worker/src/console-tokens.mjs (PI_CONSOLE_TOKENS_FILE, else
 * `console-tokens.json`, resolved against the deployment folder); the CLI passes that function in as `tokensFilePath`
 * so the rule has one home, and the fallback here exists only so this module loads without it.
 */
export function consoleConfig({ env, dir, platform = process.platform, tokensFilePath = null }) {
  const bindPublic = flag(env.PI_CONSOLE_BIND_PUBLIC, "PI_CONSOLE_BIND_PUBLIC");
  if (bindPublic.refusal) return bindPublic;
  const readOnly = flag(env.PI_CONSOLE_READ_ONLY, "PI_CONSOLE_READ_ONLY");
  if (readOnly.refusal) return readOnly;
  const listen = parseListen(String(env.PI_CONSOLE_LISTEN ?? "").trim() || DEFAULT_LISTEN, { bindPublic: bindPublic.value, platform });
  if (listen.refusal) return listen;

  const allowedHosts = [];
  for (const entry of String(env.PI_CONSOLE_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "")) {
    const name = hostnameOf(entry);
    if (name === null || (entry.includes(":") && !entry.startsWith("["))) {
      return { refusal: `PI_CONSOLE_ALLOWED_HOSTS entry ${JSON.stringify(entry.slice(0, 64))} is not a hostname; list bare names, comma separated, without a port or scheme` };
    }
    if (GATEWAY_HOSTS.includes(name)) {
      return { refusal: `PI_CONSOLE_ALLOWED_HOSTS lists ${name}, a container gateway name; a job container reaches the host by that name, so the console never answers it. Remove it` };
    }
    allowedHosts.push(name);
  }

  const idle = boundedInt(env.PI_CONSOLE_IDLE_MINUTES, "PI_CONSOLE_IDLE_MINUTES", 60, 5, 1440);
  if (idle.refusal) return idle;
  const maxHours = boundedInt(env.PI_CONSOLE_MAX_HOURS, "PI_CONSOLE_MAX_HOURS", 12, 1, 168);
  if (maxHours.refusal) return maxHours;
  const streams = boundedInt(env.PI_CONSOLE_MAX_STREAMS, "PI_CONSOLE_MAX_STREAMS", 4, 1, 32);
  if (streams.refusal) return streams;

  const inDir = (p) => (isAbsolute(p) ? p : resolvePath(dir, p));
  const tokensPath = typeof tokensFilePath === "function" ? tokensFilePath(env, dir) : inDir(env.PI_CONSOLE_TOKENS_FILE || "console-tokens.json");
  return {
    dir,
    listen,
    tokensPath,
    allowedHosts,
    readOnly: readOnly.value,
    bindPublic: bindPublic.value,
    idleMs: idle.value * 60_000,
    maxMs: maxHours.value * 3_600_000,
    maxStreams: streams.value,
    logsDir: inDir(logsDirPath(env)),
    valkeyUrl: env.VALKEY_URL || "redis://127.0.0.1:6379",
    // The panel's default (resolvePaths): the deployment folder's pause-windows.json, which `init` scaffolds.
    pauseWindowsPath: inDir(env.PI_PAUSE_WINDOWS_FILE || "pause-windows.json"),
    sandboxHostsFile: inDir(env.PI_SANDBOX_HOSTS_FILE || "sandbox-hosts.json"),
  };
}
