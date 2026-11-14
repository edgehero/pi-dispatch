/**
 * `pi-dispatch-console`, the operator console's command (issue #640). Bundled to `admin/dist/console.mjs`.
 *
 *   serve                                   run the console (prints its URL and an ssh -L hint, never a token)
 *   token add --name N --role operator|viewer
 *   token list | token revoke --name N | token rotate --name N
 *   sessions end-all                        sign every browser out (bumps the tokens file's generation)
 *   link [--name N] [--port P]              a one-time sign-in link for token N, valid 60 seconds, and a code to
 *                                           type, valid 5 minutes (P: an ssh -L tunnel's local port, which the
 *                                           console cannot know); N may be left out when there is exactly one operator
 *   open [--name N] [--port P]              sign in the person at this terminal: opens the browser here, or waits for
 *                                           their tunnel over SSH (`open-command.mjs`)
 *   audit verify                            walk the audit log's hash chain
 *
 * Every subcommand takes `--deployment <dir>`. Exit codes: 0 done, 2 refused (a configuration or input problem, with a
 * sentence saying what to change), 1 unexpected.
 *
 * ONLY `token add` AND `token rotate` PRINT A TOKEN, on one line of its own, so a terminal log or a pasted transcript
 * holds a token only where the operator asked for one. `link` prints a one-time code inside a URL, which is its
 * purpose; the code is not the token and dies in 60 seconds or at first use. Since issue #882 it prints a short code to
 * type as well, on stderr beside the words that say how to use it (stdout stays the link alone), which dies in 5
 * minutes or at first use. `open` prints a link only where there is no local browser to hand it to, or when the person
 * presses Enter for one.
 *
 * The real collaborators (tokens, sessions, codes, tickets, audit, the pause-windows writer, for #641 the server
 * with its pages, the fleet reader, the insights assembler and its pricing, and the live hub, and for #642 the write
 * planners and the action deps) are loaded here and nowhere else, by `loadModules`; `runCli` takes them injected, so its tests run on fakes, and `--help` loads none.
 */
import * as nodeFs from "node:fs";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import { basename, isAbsolute, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { deploymentServiceEnv } from "@edgehero/pi-dispatch/service-env";
import { sandboxHostsPath } from "@edgehero/pi-dispatch/sandbox-hosts";
import { CONSOLE_ENV_KEYS, consoleConfig, consoleEnv, deploymentDirOf } from "./config.mjs";
import { makeLoginLimiter } from "./guards.mjs";
import { CONSOLE_HOSTNAME, isLoopbackAddress, listenOn, listenUrl } from "./listen.mjs";
import { acquireConsoleLock } from "./lock.mjs";
import { codePending, keptTokenLinkRefusal, operatorNames, showShortCode, soleOperatorName } from "./login-codes.mjs";
import { enterReader, runOpenCommand } from "./open-command.mjs";
import { openLinkViaFile } from "./open-link.mjs";
import { envProblemOf, makeRestartWatch, thrownProblem } from "./restart-notice.mjs";
import { isLocalBrowserSession, openBrowser } from "@edgehero/pi-dispatch/open-browser";
import { shellWord } from "./link.mjs";
import { makeAnswererService } from "../answerer-data.mjs";
import { readAgentWritesToday } from "../agent-write-count.mjs";
import { readSandboxGateways } from "../sandbox-gateways.mjs";
import { makeGatewayBroker } from "./gateway-broker.mjs";

export const USAGE = `usage: pi-dispatch-console <command> [--deployment <dir>]

  serve                                    run the console on PI_CONSOLE_LISTEN (default 127.0.0.1:4790)
  token add --name <name> --role <role>    add a token (operator, viewer or agent); prints it once
  token list                               names and roles, never a token
  token revoke --name <name>               remove a token; its sessions end at their next request
  token rotate --name <name>               a new secret for a name; prints it once
  sessions end-all                         sign every browser out, remembered devices included
  device list                              the browsers that stay signed in, by id, never a secret
  device revoke --id <id> | --name <name>  stop remembering one browser, or every browser of a token
  open [--name <name>] [--port <n>] [--next /setup]  sign in here: opens your browser, or waits for your ssh tunnel
  link [--name <name>] [--port <n>] [--next /setup]  a one-time sign-in link (60 seconds) and a code to type (5 minutes)
  serve --host-setup                       explicitly allow local person-only setup actions
  audit verify                             check the audit log's hash chain

The deployment is --deployment, else the one the setup wizard recorded, else the current directory.`;

/** The CLI's audit actor: whoever holds the deployment account's shell. */
const SHELL = Object.freeze({ name: "shell", role: "shell", session: null });

class Refusal extends Error {}

/** Load the real collaborators. Dynamic so `--help` and the tests never need them; static strings so esbuild inlines them. */
export async function loadModules() {
  const [updatesView, updates, tokens, audit, sessions, loginCodes, confirm, readModel, connection, server, live, pages, insights, pricing, serviceEnv, forges, writePlans, jobData, workerConfig, modelEndpoints, modelCatalog, whatif, sandboxVerdict, triggerList, triggerCheck, scheduleZones, secretsView, connectionsView, projectView, zeroTouchData, sandboxData, hostLoadsView, modelsView, modelRolePlans, triggerEnvironmentPlans, setupActions, setupHostClient, consoleActions] = await Promise.all([
    import("../updates-view.mjs"),
    import("@edgehero/pi-dispatch/updates"),
    import("@edgehero/pi-dispatch/console-tokens"),
    import("@edgehero/pi-dispatch/console-audit"),
    import("./sessions.mjs"),
    import("./login-codes.mjs"),
    import("./confirm.mjs"),
    import("../read-model.mjs"),
    import("@edgehero/pi-dispatch/connection"),
    import("./server.mjs"),
    import("./live.mjs"),
    import("./pages.mjs"),
    import("../insights-assembly.mjs"),
    import("@edgehero/pi-dispatch/pricing"),
    import("@edgehero/pi-dispatch/service-env"),
    import("@edgehero/pi-dispatch/forges"),
    import("../write-plans.mjs"),
    import("./job-data.mjs"),
    import("@edgehero/pi-dispatch/config"),
    import("@edgehero/pi-dispatch/model-endpoints"),
    import("@edgehero/pi-dispatch/model-catalog"),
    import("./whatif.mjs"),
    import("../sandbox-verdict.mjs"),
    import("../trigger-list.mjs"),
    import("../trigger-check.mjs"),
    import("../trigger-schedule-zones.mjs"),
    import("../secrets-view.mjs"),
    import("../connections-view.mjs"),
    import("../project-view.mjs"),
    import("../zero-touch-data.mjs"),
    import("../sandbox-data.mjs"),
    import("../host-loads-view.mjs"),
    import("../models-view.mjs"),
    import("../model-role-plans.mjs"),
    import("../trigger-environment-plans.mjs"),
    import("../setup-actions.mjs"),
    import("../setup-host-client.mjs"),
    import("./actions.mjs"),
  ]);
  const deviceTrust = await import("./device-trust.mjs");
  return { deviceTrust, updatesView, updates, tokens, audit, sessions, loginCodes, confirm, readModel, connection, server, live, pages, insights, pricing, serviceEnv, forges, writePlans, jobData, workerConfig, modelEndpoints, modelCatalog, whatif, sandboxVerdict, triggerList, triggerCheck, scheduleZones, secretsView, connectionsView, projectView, zeroTouchData, sandboxData, hostLoadsView, modelsView, modelRolePlans, triggerEnvironmentPlans, setupActions, setupHostClient, consoleActions };
}

/** How long one insights assembly is reused per window: it walks every run record, far too much for each request. */
export const INSIGHTS_CACHE_MS = 30_000;

/** How long one command of the console's own Valkey client may wait for its answer, as the fleet reader's raw client does. */
const READS_COMMAND_TIMEOUT_MS = 5_000;

/**
 * How long one audit-chain verification is reused (issue #737). `verifyConsoleAudit` re-hashes every row of every
 * month the log keeps, which is far too much for each load of the audit page; the page says when it was checked.
 */
export const AUDIT_VERIFY_CACHE_MS = 30_000;

/**
 * `fn(window, opts)` memoised per key for `ttlMs` on `now`; a rejection is not kept, so the next call tries again. The
 * key includes view, window, project, role and path permission. An operator's reasons and full paths must never
 * reach a viewer's request. Project ids are user-selected, so the cache drops its oldest entry past 128 keys.
 */
export function cachedPerWindow(fn, { now = () => Date.now(), ttlMs = INSIGHTS_CACHE_MS } = {}) {
  const held = new Map();
  return (window, opts) => {
    const fullPaths = opts?.fullPaths === true;
    const key = JSON.stringify([String(window), opts?.view ?? "spend", opts?.project ?? null, opts?.role === "operator" ? "operator" : opts?.role === "agent" ? "agent" : "viewer", fullPaths]);
    const t = now();
    const hit = held.get(key);
    if (hit && t >= hit.at && t - hit.at < ttlMs) return hit.promise;
    const promise = Promise.resolve().then(() => (opts ? fn(window, { ...opts, fullPaths }) : fn(window)));
    held.delete(key);
    held.set(key, { at: t, promise });
    while (held.size > 128) held.delete(held.keys().next().value);
    promise.catch(() => {
      if (held.get(key)?.promise === promise) held.delete(key);
    });
    return promise;
  };
}

/**
 * `fn()` memoised for `ttlMs` on `now`: `cachedPerWindow`'s rule for a call with no key. A rejection is not kept (the
 * next call tries again, rather than serving a failure for 30 s), and a clock that went backwards is a miss.
 */
export function cachedFor(fn, { now = () => Date.now(), ttlMs } = {}) {
  let held = null;
  return () => {
    const t = now();
    if (held && t >= held.at && t - held.at < ttlMs) return held.promise;
    const entry = { at: t, promise: Promise.resolve().then(() => fn()) };
    held = entry;
    entry.promise.catch(() => {
      if (held === entry) held = null;
    });
    return entry.promise;
  };
}

/** `fn()` computed once, on first use (the priced catalog is the pinned pi-ai's and cannot change while serving). */
function memoOnce(fn) {
  let held = null;
  return () => (held ??= fn());
}

/** The most active jobs one console snapshot reads (issue #641); the TUI's reader keeps its own default. */
export const CONSOLE_ACTIVE_LIMIT = 50;

// The path fields `resolvePaths` hands back that a deployment's `.env` (or its default) may leave relative: relative to
// the deployment folder, the service's working directory, never to wherever this command was started.
const RELATIVE_PATH_FIELDS = Object.freeze(["logsDir", "settingsFile", "triggersPath", "pauseWindowsPath", "scopedLimitsPath", "projectsPath", "projectsFile", "envelopeFile", "subscriptionsPath", "globalPiDir"]);

/** The env keys a reserve estimate reads beyond the panel's own (issue #642): `estimateReserve`'s and the endpoint loader's. */
export const RESERVE_ENV_KEYS = Object.freeze(["PI_ALLOWED_MODELS", "PI_PROVIDER", "PI_MODEL", "PI_MAX_COST_USD", "PI_MODEL_ENDPOINTS_FILE"]);

/** Safe metadata follows the child's host-wired source precedence, without loading provider SDKs. */
export function setupProviderOf({ m, env, dir, fs = nodeFs, platform = process.platform, uid = process.geteuid?.() }) {
  try {
    const keys = ["PI_PROVIDER", "PI_SETTINGS_FILE"];
    const declared = m.serviceEnv.deploymentServiceEnv({ env: {}, dir, keys, fs, platform, uid });
    if (declared.untrusted || declared.unreadable || declared.hazardSkipped?.length || declared.unread?.length) return null;
    const configured = { ...Object.fromEntries(keys.filter(key => typeof env?.[key] === "string").map(key => [key, env[key]])), ...declared.env };
    const settingsFile = resolvePath(dir, m.workerConfig.settingsFilePath(configured));
    const loaded = m.readModel.readSettingsView({ settingsFile, fs });
    if (loaded.invalid) return null;
    return loaded.overlay?.provider ?? m.workerConfig.providerFrom(configured);
  } catch { return null; }
}

/** A start preview cannot price fresh host configuration with a console's stale reserve inputs. */
export function makeSetupExposureReader({ initial, readSide, readExposure, keys = RESERVE_ENV_KEYS }) {
  const signature = side => JSON.stringify({ env: [...new Set(keys)].sort().map(key => [key, side.env?.[key] ?? null]), paths: Object.entries(side.paths ?? {}).sort(([a], [b]) => a.localeCompare(b)) });
  const expected = signature(initial);
  return async () => {
    try {
      if (signature(readSide()) !== expected) return { complete: false, reason: "configuration-drift" };
      return await readExposure();
    } catch { return { complete: false }; }
  };
}

/**
 * The model-endpoint snapshot a reserve estimate is judged against (issue #642), read the way the worker reads it at
 * each pickup (`start.mjs`/`index.mjs`): the declared endpoints (`loadModelEndpoints`, PI_MODEL_ENDPOINTS_FILE or
 * `model-endpoints.json` in the deployment folder, the worker's working directory) and, only when one is declared, the
 * overlay's `models.json` (`readOverlayModels`). Returns `() => { endpoints, models }`, or null when the loader is not
 * loaded. A declaration that does not load throws (the estimate then judges without one: never zero-rated, the larger
 * figure); an overlay that cannot be read is `models: null`, the worker's own fail-open, which also judges not zero-rated.
 */
export function endpointSnapshotFn({ m, env, paths, dir, fs }) {
  const me = m.modelEndpoints;
  if (!me || typeof me.loadModelEndpoints !== "function") return null;
  return () => {
    const modelEndpointsFile = typeof m.workerConfig?.modelEndpointsFilePath === "function" ? m.workerConfig.modelEndpointsFilePath(env) : (env.PI_MODEL_ENDPOINTS_FILE ?? null);
    const endpoints = me.loadModelEndpoints({ modelEndpointsFile, valkeyUrl: paths.valkeyUrl }, { readFileSync: fs.readFileSync, existsSync: fs.existsSync, cwd: dir });
    if (endpoints.length === 0) return { endpoints, models: null };
    let models = null;
    try {
      models = me.readOverlayModels(paths.globalPiDir ?? null, { readFileSync: fs.readFileSync, lstatSync: fs.lstatSync });
    } catch {
      models = null;
    }
    return { endpoints, models };
  };
}

/**
 * The keys `readSideOf` takes from the deployment's `.env` beside the panel's own (`PANEL_SERVICE_KEYS`, through
 * `panelEnv`). The deployment's own forge URL variables (GITLAB_URL, FORGEJO_URL, AZURE_ORG_URL) are what a `.env` sets;
 * the job-container names after them only exist where the worker derived them. Issue #642: the keys a reserve estimate
 * reads as the worker does (the allowed-model list, the default provider and model, and where the model-endpoint
 * declaration lives), so a console preview judges a job by the service's settings. One list, so the restart watch
 * (issue #845) compares exactly the keys the read side read.
 */
function readSideExtraKeys(m) {
  return [...Object.values(m.readModel.FORGE_HOST_ENV ?? {}).flat(), ...(m.forges?.FORGE_HOST_VARS ?? []), "PI_SESSIONS_DIR", ...RESERVE_ENV_KEYS];
}

/**
 * Every key the console takes from the deployment's `.env` at start and keeps for its life (issue #845): its own
 * (`CONSOLE_ENV_KEYS`, `consoleEnv`) and the read side's (`PANEL_SERVICE_KEYS` and `readSideExtraKeys`, `readSideOf`).
 * VALKEY_PASSWORD is in none of them: the console's clients read it again at each connect.
 */
export function restartKeysOf(m) {
  return [...new Set([...CONSOLE_ENV_KEYS, ...(m.readModel.PANEL_SERVICE_KEYS ?? []), ...readSideExtraKeys(m)])].sort();
}

/**
 * The keys whose `.env` lines the restart watch judges for a problem (issue #845): every key it compares, and the keys a
 * Valkey client's context reads (`VALKEY_CONTEXT_KEYS`, from the connection module, VALKEY_PASSWORD among them). Those
 * are never compared, since the clients read them again at each connect, but a line for one that cannot be read now keeps
 * the clients on what they had while a restart would start without it, so it is said.
 */
export function restartProblemKeysOf(m) {
  return [...new Set([...restartKeysOf(m), ...(m.connection?.VALKEY_CONTEXT_KEYS ?? [])])].sort();
}

/** A key that names a file or a folder, by the deployment's own naming (`PI_LOGS_DIR`, `PI_SANDBOX_HOSTS_FILE`). */
const PATH_KEY_RE = /_(?:FILE|DIR)$/;

/**
 * The path keys every console reader of which takes a blank line as no line (review of PR #878), so a blank one is
 * compared as unset: `resolvePaths` reads PI_LOGS_DIR, PI_SETTINGS_FILE, PI_GLOBAL_PI_DIR and PI_SANDBOX_DIR with `||`;
 * `consoleConfig` reads PI_SANDBOX_GATEWAYS_FILE with `||`; `tokensFilePath` trims PI_CONSOLE_TOKENS_FILE and
 * `readSideOf` PI_SESSIONS_DIR, which a run page's `readForkPoints` reads for whether it is set; PI_AUTH_CONNECTIONS_FILE and PI_AUTH_STORE_DIR are read for whether they are set. Every
 * other path key keeps a blank as its own value, since some reader of it does: `resolvePaths` reads PI_TRIGGERS_FILE,
 * PI_PAUSE_WINDOWS_FILE, PI_SCOPED_LIMITS_FILE, PI_PROJECTS_FILE and PI_ENVELOPE_FILE with `??`, so `PI_TRIGGERS_FILE=`
 * names no triggers file where no line names `triggers.json`, and `loadModelEndpoints` refuses an empty
 * PI_MODEL_ENDPOINTS_FILE. Held to those readers, key by key, by `admin/test/console-restart-notice.test.mjs`, which
 * fails for a path key it has no reader for, so a new one is judged before it is compared. `.env.example` ships several
 * of these as blank lines, which an operator uncommenting one must not see as a change.
 */
export const RESTART_BLANK_IS_UNSET = Object.freeze(["PI_AUTH_CONNECTIONS_FILE", "PI_AUTH_STORE_DIR", "PI_CONSOLE_TOKENS_FILE", "PI_GLOBAL_PI_DIR", "PI_LOGS_DIR", "PI_SANDBOX_DIR", "PI_SANDBOX_GATEWAYS_FILE", "PI_SESSIONS_DIR", "PI_SETTINGS_FILE"]);

/**
 * What the restart watch compares (issue #845, `restart-notice.mjs`): each key of `restartKeysOf` as the console's own
 * read (`consoleEnv`'s `env`) and the read side's (`readSideOf`'s `env`) have it, as one comparable string per key. A
 * value is only ever compared, never said. A path-named key is compared by what it names in `dir`: some reach this raw
 * (the read side's extra keys), and `models.json` becoming `./models.json` changes no file the console reads. A blank
 * one is unset for `RESTART_BLANK_IS_UNSET` and its own value for every other. PI_SANDBOX_HOSTS_FILE reaches the console
 * raw to be read by `sandboxHostsPath`, which trims it, takes a blank as unset and names a default, so it is compared by
 * that function's answer.
 */
export function restartValuesOf(m, consoleValues, sideValues, dir) {
  const effective = (key, value) => {
    if (typeof dir !== "string" || !PATH_KEY_RE.test(key)) return value ?? null;
    if (key === "PI_SANDBOX_HOSTS_FILE") return sandboxHostsPath({ PI_SANDBOX_HOSTS_FILE: value }, dir);
    if (typeof value !== "string") return value ?? null;
    if (RESTART_BLANK_IS_UNSET.includes(key)) return value.trim() === "" ? null : resolvePath(dir, value);
    return value === "" ? "" : resolvePath(dir, value);
  };
  const values = {};
  for (const key of restartKeysOf(m)) values[key] = JSON.stringify([effective(key, consoleValues?.[key]), effective(key, sideValues?.[key])]);
  return values;
}

/**
 * The console's reading of its deployment as it would be now, for the restart watch: the same reads serve made at start
 * (`consoleEnv`, `readSideOf`) with the same shell environment, and what keeps the `.env` from being read
 * (`envProblemOf` over the service's own reader, for every key in `restartProblemKeysOf`). Synchronous file reads only.
 */
export function restartReadingOf({ m, env, dir, fs, platform, uid }) {
  const layered = consoleEnv({ env, dir, fs, platform, uid });
  const side = readSideOf({ m, env, dir, fs, platform, uid });
  return { values: restartValuesOf(m, layered.env, side.env, dir), problem: envProblemOf(deploymentServiceEnv({ env, dir, keys: restartProblemKeysOf(m), platform, fs, uid })) };
}

/**
 * The environment and paths the read side runs on (issue #641): this shell's environment with the deployment `.env`
 * filling the panel's keys (`panelEnv`, the TUI's own resolver, so the console reads the queue, logs and files the
 * service does), plus the forge host variables `forgeLinkOf` builds links from and `PI_SESSIONS_DIR`, which turns on
 * the parked runs' chain counts. Returns `{env, paths, notice}`.
 *
 * Precedence, the TUI's own (`panelEnv`): a key this shell's environment sets WINS over the deployment `.env`, which
 * only fills what the shell leaves unset; the forge host variables and `PI_SESSIONS_DIR` follow the same rule. A panel
 * key the two set differently is named in `notice` (never its value), so the operator who started the console from a
 * shell exporting another deployment's VALKEY_URL or PI_LOGS_DIR is told the console reads the shell's, not the
 * service's.
 */
export function readSideOf({ m, env, dir, fs, platform, uid }) {
  const panel = m.readModel.panelEnv({ env, pointerDir: dir, owned: [], fs, platform, uid });
  const extraKeys = readSideExtraKeys(m);
  const extra = m.serviceEnv ? m.serviceEnv.deploymentServiceEnv({ env, dir, keys: extraKeys, platform, fs, uid }).env : {};
  const merged = { ...panel.env };
  for (const key of extraKeys) if (extra?.[key] !== undefined && merged[key] === undefined) merged[key] = extra[key];
  const paths = { ...m.readModel.resolvePaths(merged) };
  for (const field of RELATIVE_PATH_FIELDS) {
    if (typeof paths[field] === "string" && paths[field] !== "" && !isAbsolute(paths[field])) paths[field] = resolvePath(dir, paths[field]);
  }
  const sessions = typeof merged.PI_SESSIONS_DIR === "string" ? merged.PI_SESSIONS_DIR.trim() : "";
  if (sessions !== "") paths.sessionsDir = isAbsolute(sessions) ? sessions : resolvePath(dir, sessions);
  return { env: merged, paths, notice: panel.notice };
}

/**
 * The deployment the pages name (issue #737: the first run's steps), from the folder serve was given: its last folder
 * alone, never the path, since every page (a viewer's too) is drawn from the same data and a page carries no host path.
 */
export function deploymentOf(dir) {
  return { folder: basename(dir) };
}

/** The pricing facade `assembleInsights` takes, from the worker's pricing module. */
function pricingOf(pricing) {
  const { listPricedModels, getPricedModel, isZeroRated, reprice, piAiVersion } = pricing;
  return { listPricedModels, getPricedModel, isZeroRated, reprice, piAiVersion };
}

function parse(argv) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: { deployment: { type: "string" }, id: { type: "string" }, name: { type: "string" }, role: { type: "string" }, port: { type: "string" }, next: { type: "string" }, "host-setup": { type: "boolean" }, help: { type: "boolean", short: "h" } },
    });
  } catch (e) {
    throw new Refusal(`${e?.message ?? "the arguments could not be read"}; run pi-dispatch-console --help`);
  }
}

function needName(values) {
  if (typeof values.name !== "string" || values.name === "") throw new Refusal("this command needs --name <name>");
  return values.name;
}

/**
 * `link --port`'s value as a port number, refused unless it is 1 to 5 digits from 1 to 65535. The console cannot know
 * the local end of an operator's `ssh -L` tunnel (a unix socket has no port at all, and a tunnel may map 4790 to any
 * free one), so the operator says it and the link is printed for `pi-dispatch.localhost` there (`CONSOLE_HOSTNAME`), a
 * loopback name the tunnel's local end answers on, as `localhost` is (issue #882).
 */
function linkPortOf(text) {
  if (typeof text !== "string" || !/^[0-9]{1,5}$/.test(text) || Number(text) < 1 || Number(text) > 65535) {
    throw new Refusal("--port must be a port number (1 to 65535): the local port of your ssh -L tunnel");
  }
  return Number(text);
}

/** Wait for SIGINT or SIGTERM: how `serve` is stopped when no test hands it a promise. */
function untilSignal() {
  return new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

/**
 * Run one command. `io`: `{env, cwd, fs, now, random, uid, platform, out(line), err(line), modules, until}`; every
 * field defaults to the process's own. Resolves the exit code.
 */
export async function runCli(argv, io = {}) {
  const out = io.out ?? ((line) => process.stdout.write(`${line}\n`));
  const err = io.err ?? ((line) => process.stderr.write(`${line}\n`));
  try {
    return await run(argv, { ...io, out, err });
  } catch (e) {
    if (e instanceof Refusal) {
      err(`pi-dispatch-console: ${e.message}`);
      return 2;
    }
    err(`pi-dispatch-console: unexpected failure (${e?.code ?? e?.name ?? "error"}): ${e?.message ?? String(e)}`);
    return 1;
  }
}

async function run(argv, io) {
  const { values, positionals } = parse(argv);
  if (values.help || positionals[0] === "help") {
    io.out(USAGE);
    return 0;
  }
  if (positionals.length === 0) throw new Refusal(`no command given\n${USAGE}`);
  const env = io.env ?? process.env;
  const fs = io.fs ?? nodeFs;
  const cwd = io.cwd ?? process.cwd();
  const now = io.now ?? (() => Date.now());
  const uid = "uid" in io ? io.uid : process.geteuid?.();
  const platform = io.platform ?? process.platform;
  const command = positionals.join(" ");
  const known = ["serve", "token add", "token list", "token revoke", "token rotate", "sessions end-all", "device list", "device revoke", "link", "open", "audit verify"];
  if (!known.includes(command)) throw new Refusal(`unknown command "${command.slice(0, 40)}"; run pi-dispatch-console --help`);
  // Refused before anything is read or written, so a `--port` that would be silently ignored never runs its command.
  if (values.port !== undefined && command !== "link" && command !== "open") throw new Refusal("--port is for link and open only");
  if (values.next !== undefined && ((command !== "link" && command !== "open") || values.next !== "/setup")) throw new Refusal("--next is for link and open only and must be /setup");
  if (values["host-setup"] && command !== "serve") throw new Refusal("--host-setup is an explicit serve grant only");

  const m = io.modules ?? (await loadModules());
  const where = deploymentDirOf({ arg: values.deployment ?? null, env, fs, cwd });
  if (where.notice) io.err(`pi-dispatch-console: ${where.notice}`);
  const layered = consoleEnv({ env, dir: where.dir, fs, platform, uid });
  if (layered.notice) io.err(`pi-dispatch-console: ${layered.notice}`);
  const config = { ...consoleConfig({ env: layered.env, dir: where.dir, platform, tokensFilePath: m.tokens.tokensFilePath }), hostSetup: values["host-setup"] === true };
  if (config.refusal) throw new Refusal(config.refusal);
  const random = io.random;
  const withRandom = (args) => (random ? { ...args, random } : args);
  const audit = m.audit.makeConsoleAudit({ logsDir: config.logsDir, fs, now });

  // A CLI change has already happened when its row is appended; a failed append is said loudly and exits 1.
  const record = (row) => {
    try {
      audit.append({ actor: SHELL, outcome: "ok", ...row });
      return true;
    } catch (e) {
      io.err(`pi-dispatch-console: the change was made, but its audit row could not be written (${e?.code ?? "error"}: ${e?.message ?? ""}); run pi-dispatch-console audit verify`);
      return false;
    }
  };
  const invalid = (res) => {
    if (res?.invalid) throw new Refusal(res.invalid);
  };

  /**
   * The console's enrolled origin, or null (issue #882, review): where `sandbox-gateways.json` enrolls one, the write guard accepts that exact
   * Origin alone, so every address this command prints is that one. Read when it is needed, as `serve` reads it, never cached.
   */
  const enrolledOrigin = () => {
    if (!config.sandboxGatewaysFile) return null;
    const read = readSandboxGateways(config.sandboxGatewaysFile, { fs, uid, platform: io.platform ?? process.platform });
    return typeof read.config?.consoleOrigin === "string" ? read.config.consoleOrigin : null;
  };

  /** What to type for a command of this deployment: its own binary when one is installed here, because a local install puts nothing on PATH. */
  const localCommand = (name) => {
    const local = `node_modules/.bin/${name}`;
    try {
      if (!fs.existsSync(resolvePath(config.dir, local))) return name;
      return resolvePath(cwd) === resolvePath(config.dir) ? `./${local}` : shellWord(resolvePath(config.dir, local));
    } catch { return name; }
  };

  /**
   * The token a sign-in link is for: `--name`, or the only operator. Refuses a name this console cannot sign in, before
   * any code exists, because a kept entry's code would be refused at sign-in (issue #761).
   */
  const signInName = () => {
    const read = m.tokens.readTokensFile({ path: config.tokensPath, fs, uid });
    if (read.refusal) throw new Refusal(read.refusal);
    if (values.name === "") throw new Refusal("--name needs a name");
    if (values.name === undefined) {
      const sole = soleOperatorName(read.file);
      if (sole !== null) return sole;
      const operators = operatorNames(read.file);
      throw new Refusal(operators.length === 0 ? `there is no operator token yet; run ${localCommand("pi-dispatch")} up --console, or ${localCommand("pi-dispatch-console")} token add --name <name> --role operator` : `there are ${operators.length} operator tokens, so name one with --name <name>; see ${localCommand("pi-dispatch-console")} token list`);
    }
    const name = values.name;
    if (read.file.tokens.some((t) => t.name === name)) return name;
    const kept = m.tokens.keptTokens(read.file).find((t) => t.name === name);
    if (kept) throw new Refusal(keptTokenLinkRefusal(kept));
    throw new Refusal(`there is no token named "${name}"; see ${localCommand("pi-dispatch-console")} token list`);
  };

  /**
   * Audit, then mint, then build the URL: `{url, code, base}`, and with `short` (issue #882) the short code to type as well (`short`), or `{exit}`
   * once the failure has been said. Refusals throw. One row for what one command made, its `kind` saying a short code was made beside the link.
   */
  const mintSignIn = (name, port, { short = false } = {}) => {
    // Bootstrap composes this command, so its audit intent must exist before a code file can be created.
    const row = { actor: SHELL, action: "login-code", ...(short ? { kind: "link-and-short-code" } : {}), target: name, ticket: (random ?? randomBytes)(6).toString("hex") };
    try { audit.append({ ...row, outcome: "ok" }); }
    catch (e) { io.err(`pi-dispatch-console: no sign-in code was minted because its audit row could not be written (${e?.code ?? "error"}); check PI_LOGS_DIR and run audit verify`); return { exit: 1 }; }
    const failed = () => {
      try { audit.append({ ...row, outcome: "failed", reason: "login-code-mint-failed" }); }
      catch (e) { io.err(`pi-dispatch-console: the sign-in code was not minted, but its failed audit row could not be written (${e?.code ?? "error"}); run audit verify`); }
    };
    let minted;
    try { minted = m.loginCodes.mintLoginCode(withRandom({ dir: m.loginCodes.loginCodesDir(config.tokensPath), name, fs, now, short })); }
    catch (e) { failed(); throw e; }
    if (minted.refusal) { failed(); throw new Refusal(minted.refusal); }
    // `--port` is the person's own tunnel; else the enrolled origin, the one a sign-in is accepted from; else the listen address.
    const origin = port === null ? enrolledOrigin() : null;
    const base = port !== null ? `http://${CONSOLE_HOSTNAME}:${port}/` : origin !== null ? `${origin}/` : (listenUrl(config.listen) ?? `http://${CONSOLE_HOSTNAME}:<the local port of your ssh -L tunnel>/`);
    return { url: `${base}login/code#${minted.code}${values.next === "/setup" ? "&next=/setup" : ""}`, code: minted.code, base, ...(short ? { short: minted.short } : {}) };
  };

  /** The device store, for the commands that act on it. Real path, as `serve` uses it, so both name one cookie. */
  const deviceTrustOf = () => {
    const tokensReal = (() => { try { return realpathSync(config.tokensPath); } catch { return config.tokensPath; } })();
    return m.deviceTrust.makeDeviceTrust(withRandom({ tokensPath: tokensReal, fs, uid, now, log: (line) => io.err(line), platform }));
  };

  switch (command) {
    case "token add": {
      const name = needName(values);
      const role = values.role ?? "";
      if (!m.tokens.TOKEN_ROLES.includes(role)) throw new Refusal(`--role must be one of ${m.tokens.TOKEN_ROLES.join(", ")}`);
      const res = m.tokens.addToken(withRandom({ path: config.tokensPath, name, role, fs, now, uid }));
      invalid(res);
      io.err(`added ${role} token "${name}" to ${config.tokensPath}. It is shown once, on the next line; store it now.`);
      io.out(res.token);
      return record({ action: "token-added", target: name }) ? 0 : 1;
    }
    case "token rotate": {
      const name = needName(values);
      const res = m.tokens.rotateToken(withRandom({ path: config.tokensPath, name, fs, now, uid }));
      invalid(res);
      io.err(`rotated token "${name}"; its old secret no longer works and its sessions end. The new one is on the next line, shown once.`);
      io.out(res.token);
      return record({ action: "token-rotated", target: name }) ? 0 : 1;
    }
    case "token revoke": {
      const name = needName(values);
      invalid(m.tokens.revokeToken(withRandom({ path: config.tokensPath, name, fs, uid })));
      io.out(`revoked token "${name}"; its sessions end at their next request`);
      return record({ action: "token-revoked", target: name }) ? 0 : 1;
    }
    case "token list": {
      const read = m.tokens.readTokensFile({ path: config.tokensPath, fs, uid });
      if (read.refusal) throw new Refusal(read.refusal);
      // Issue #761: an entry a newer release wrote for a role this one does not know is kept in the file and listed, so
      // it can be revoked, and said to sign in nowhere here.
      const kept = m.tokens.keptTokens(read.file);
      if (read.file.tokens.length === 0 && kept.length === 0) io.out(`no tokens in ${config.tokensPath}; add one with pi-dispatch-console token add --name <name> --role operator`);
      for (const t of read.file.tokens) io.out(`${t.name}\t${t.role}\t${t.createdAt}`);
      for (const t of kept) io.out(`${t.name}\t${t.role} (not known to this pi-dispatch-console: signs in nowhere here)\t${t.createdAt}`);
      return 0;
    }
    case "sessions end-all": {
      const res = m.tokens.endAllSessions(withRandom({ path: config.tokensPath, fs, uid }));
      invalid(res);
      io.out("every console session ends at its next request");
      return record({ action: "sessions-ended" }) ? 0 : 1;
    }
    case "device list": {
      const listed = deviceTrustOf().list();
      if (listed.problem) throw new Refusal(listed.problem);
      for (const d of listed.devices) io.out(`${d.id}  ${d.name}  ${d.role}  ${d.label}  remembered ${d.createdAt}  last used ${d.lastUsedAt}${d.ended ? `  ended (${d.ended.reason})` : ""}`);
      if (listed.devices.length === 0) io.err("no device is remembered");
      if (listed.unreadable > 0) io.err(`${listed.unreadable} record${listed.unreadable === 1 ? "" : "s"} could not be read: run pi-dispatch doctor`);
      return 0;
    }
    case "device revoke": {
      const trust = deviceTrustOf();
      if ((values.id === undefined) === (values.name === undefined)) throw new Refusal("device revoke needs exactly one of --id <id> or --name <name>");
      const listed = trust.list();
      if (listed.problem) throw new Refusal(listed.problem);
      const live = listed.devices.filter((d) => d.ended === undefined && (values.id !== undefined ? d.id === values.id : d.name === values.name));
      if (live.length === 0) throw new Refusal(values.id !== undefined ? `no remembered device has the id "${values.id}"; see pi-dispatch-console device list` : `no device is remembered for "${values.name}"; see pi-dispatch-console device list`);
      let failed = 0;
      for (const d of live) {
        const done = trust.end(d.hash, "removed");
        if (done.unerased) failed += 1;
        if (!record({ action: "device-ended", target: d.id, ...(done.unerased ? { outcome: "failed", reason: "the store could not be written" } : {}) })) return 1;
      }
      if (failed > 0) throw new Refusal(`${failed} device${failed === 1 ? "" : "s"} could not be ended: the remembered-device store could not be written; run pi-dispatch doctor`);
      io.out(`stopped remembering ${live.length} device${live.length === 1 ? "" : "s"}; ${live.length === 1 ? "it signs" : "they sign"} out at the next request`);
      return 0;
    }
    case "link": {
      // Judged before the code is minted, so a mistyped port costs no code and no audit row.
      const port = values.port === undefined ? null : linkPortOf(values.port);
      const made = mintSignIn(signInName(), port, { short: true });
      if (made.exit !== undefined) return made.exit;
      // The link alone on stdout, as it always was, for whatever reads it; the code is for the person, beside the words that say how to use it.
      io.out(made.url);
      io.err("open it within 60 seconds; it works once");
      io.err(`or type this sign-in code at ${made.base}login${values.next === "/setup" ? "?next=/setup" : ""} within 5 minutes; it works once too: ${showShortCode(made.short)}`);
      return 0;
    }
    case "open": {
      const listen = config.listen;
      // A unix socket has no port of its own: 4790 is the local end of the tunnel the line below sets up.
      const port = values.port !== undefined ? linkPortOf(values.port) : listen.kind === "unix" ? 4790 : null;
      const say = (text) => io.err(`pi-dispatch-console: ${text}`);
      const windows = platform === "win32";
      // Windows opens the page and mints nothing, so it needs no name. Judged first here for the refusal, and again at each mint below.
      if (!windows) signInName();
      const isTTY = io.isTTY ?? (Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY));
      const enter = isTTY && !windows ? (io.enter ?? (await enterReader(process.stdin))) : null;
      const bracketed = listen.host?.includes(":") ? `[${listen.host}]` : listen.host;
      const tunnelLine = listen.kind === "unix" ? `ssh -L ${port}:${shellWord(listen.path)} <this host>` : isLoopbackAddress(listen.host) ? `ssh -L ${port ?? listen.port}:${bracketed}:${listen.port} <this host>` : null;
      try {
        return await runOpenCommand({
          windows, isTTY, enter, say, tunnelLine,
          // A socket console answers nothing a browser here could open without a tunnel, so it is the tunnel path, whoever is at the keyboard.
          local: listen.kind !== "unix" && (io.isLocal ?? isLocalBrowserSession)({ env, platform }),
          consoleCommand: localCommand("pi-dispatch-console"),
          plainUrl: ((origin) => (origin !== null ? `${origin}/` : listenUrl(listen)))(enrolledOrigin()),
          snapHint: platform !== "darwin",
          print: (text) => io.out(text),
          // The name again at each mint: a token revoked during a long wait must not get a code.
          mint: () => mintSignIn(signInName(), port),
          pending: (code) => (m.loginCodes.codePending ?? codePending)({ dir: m.loginCodes.loginCodesDir(config.tokensPath), code, fs }),
          openLink: (url) => (io.openLink ?? ((u) => openLinkViaFile(u, { open: openBrowser })))(url),
          openPlain: (url) => (io.openPlain ?? openBrowser)(url),
          ...(io.sleep ? { sleep: io.sleep } : {}),
          now,
        });
      } finally {
        enter?.close?.();
      }
    }
    case "audit verify": {
      // `withLast` (opt-in, so the result doctor reads is untouched) names the last row the chain vouches for and, when
      // the line at the break shows no `prev` that matches the row before it, that row, which the chain walked but
      // cannot vouch for: an edit to it leaves its own line well formed and only the NEXT line's `prev` would show it,
      // so whatever else is wrong with that line, nothing says whether the row was changed. Counting the rows read before
      // the break as intact, as this sentence did, vouched for exactly the row an edited outcome sits in.
      const res = m.audit.verifyConsoleAudit({ logsDir: config.logsDir, fs, withLast: true });
      if (res.ok) {
        const from = res.startsAt ? ` (starts at ${res.startsAt.file} row ${res.startsAt.seq}: older files were removed by retention)` : "";
        // Issue #761: a row with a shaped action or outcome this console does not know links like any other; such rows
        // are counted, and the chain is still intact. The sentence claims only what the check knows: the word is unknown
        // here and shaped, which is what a newer release writes.
        const n = res.unknown;
        const newer = n > 0 ? `, and ${n} of them ${n === 1 ? "names" : "name"} an action or outcome this pi-dispatch-console does not know (a newer release writes such rows)` : "";
        io.out(`the console audit log holds ${res.rows} rows and its chain is intact${from}${newer}`);
        return 0;
      }
      const { broken, last, suspect } = res;
      if (broken.file === null) throw new Refusal(`the console audit log cannot be checked: ${broken.reason}`);
      const either = suspect ? ` Row ${suspect.seq} before it (${suspect.file} line ${suspect.line}) is not vouched for either: the link between the two does not hold, so the chain cannot tell whether row ${suspect.seq} was changed.` : "";
      const intact = last ? `Rows through row ${last.seq} are intact` : "No row before it is vouched for";
      throw new Refusal(`the console audit log's chain breaks at ${broken.file} line ${broken.line}: ${broken.reason}.${either} ${intact}; keep the file for inspection`);
    }
    case "serve":
      return serve({ io, m, config, layered, audit, fs, now, uid, random });
    default:
      throw new Refusal(`unknown command "${command}"`);
  }
}

/** Startup refusals in order (tokens file, an operator, the lock, the bind), then serve until stopped. */
async function serve({ io, m, config, layered, audit, fs, now, uid, random }) {
  const readTokens = () => m.tokens.readTokensFile({ path: config.tokensPath, fs, uid });
  const first = readTokens();
  if (first.refusal) throw new Refusal(first.refusal);
  if (m.tokens.operatorCount(first.file) === 0) {
    throw new Refusal(`${config.tokensPath} holds no operator token, so nobody could change anything; add one with pi-dispatch-console token add --name <name> --role operator`);
  }
  const lock = acquireConsoleLock({ logsDir: config.logsDir, fs });
  if (lock.refusal) throw new Refusal(lock.refusal);
  let server = null;
  let redis = null;
  let fleet = null;
  let hub = null;
  let setup = null;
  let setupBroker = null;
  let gateway = null;
  let restart = null;
  try {
    // Every Valkey client of this process (the audit copy's, the fleet reader's) takes its password and its facts
    // about the deployment's Valkey from THIS deployment's `.env`, through the panel's one reader, as the pi extension
    // does for the pointer's deployment (`installPanelValkeyContext`); the console names its deployment itself.
    const shellEnv = io.env ?? process.env;
    m.connection?.useValkeyContext?.(() => m.readModel.panelValkeyContext({ env: shellEnv, pointerDir: config.dir, owned: [], fs, uid }));
    // The Valkey copy of the audit log (`console:audit`, INT-CONSOLE-AUDIT-LOG) is a view for a console elsewhere, never
    // the record: each row serve writes is pushed after the file holds it, a down or refusing Valkey costs nothing but
    // the copy, and no Valkey error reaches the log or refuses a request. This client lives as long as the console, so it
    // keeps reconnecting: a `failFast` one ended for good at the first Valkey restart, and the copy silently stopped there.
    // `noOfflineQueue` keeps the other half of that bound: a row is refused while nothing is connected, not held for later.
    // `commandTimeoutMs` is for the pages that read through this client too (`hostLoads`, the updates page): on a Valkey
    // that is connected and stopped answering, a read would otherwise wait for as long as it does not. A row already on
    // that socket arrives when Valkey wakes, which costs nothing: it is a copy of what the file holds.
    try {
      redis = m.connection?.makeRedisClient(config.valkeyUrl, { noOfflineQueue: true, disconnectTimeoutMs: 0, freshContext: true, commandTimeoutMs: READS_COMMAND_TIMEOUT_MS }) ?? null;
      redis?.on?.("error", () => {});
    } catch {
      redis = null;
    }
    const fileAudit = audit;
    audit = redis
      ? {
          ...fileAudit,
          append(row) {
            const stored = fileAudit.append(row);
            m.audit.mirrorRow(redis, stored);
            return stored;
          },
        }
      : audit;
    const withRandom = (args) => (random ? { ...args, random } : args);
    const codesDir = m.loginCodes.loginCodesDir(config.tokensPath);
    const log = io.log ?? ((line) => io.err(line));
    // Issue #849. `realpath` so one deployment has one cookie name however its path was spelled; a folder that is not there yet is taken as written.
    const tokensReal = (() => { try { return realpathSync(config.tokensPath); } catch { return config.tokensPath; } })();
    const devices = m.deviceTrust?.makeDeviceTrust(withRandom({ tokensPath: tokensReal, fs, uid, now, log: (line) => io.err(line), platform: io.platform ?? process.platform }));
    devices?.reap();
    const sessions = m.sessions.makeSessionStore(withRandom({ now, idleMs: config.idleMs, maxMs: config.maxMs, maxStreams: config.maxStreams, ...(devices ? { deviceVerdict: (hash) => devices.verdictOf(hash) } : {}) }));

    // The read side (issue #641): one fleet reader for every page, stream and /api/state, held for serve's life.
    const side = readSideOf({ m, env: shellEnv, dir: config.dir, fs, platform: io.platform ?? process.platform, uid });
    if (side.notice) io.err(`pi-dispatch-console: ${side.notice}`);
    // Read-only (the console never writes through its reader) and at most CONSOLE_ACTIVE_LIMIT active rows per
    // snapshot: a browser is told "and N more", never handed the whole active list. The TUI keeps the defaults.
    //
    // Issue #642: the same reader carries the console's kill switch (`pause`/`resume`) and the cancel request. Its pause
    // goes through `killSwitchPlan` over THIS deployment's folder (`killSwitchPlanFn`), so the two-Valkey refusal of a
    // resume holds here exactly as it does for the tools and the TUI. `readOnly` covers `snapshot()` alone.
    //
    // Issue #737: the waiting jobs and why each waits are NOT turned on here: the reader serves every page and
    // `/api/state`, so the overview's load asks for them per call (`pages.mjs` `PAGE_READS`), and a page that draws no
    // waiting job pays no read for one.
    const killSwitchPlanFn = ({ paused }) => m.readModel.killSwitchPlan({ paused, env: shellEnv, stateFn: () => ({ deploymentDir: config.dir, owned: [] }), fs, uid });
    fleet = m.readModel.createFleetReader(side.paths, { dollarEnvFn: () => side.env, nowFn: now, fs, readOnly: true, activeLimit: CONSOLE_ACTIVE_LIMIT, killSwitchPlanFn, ...(m.sandboxData?.SANDBOX_READ_DEPS ?? {}), sandboxRetentionFn: m.sandboxVerdict?.sandboxRetentionOf ?? null });
    // Issue #845: what this console read at start and keeps for its life (its settings and the read side's, `layered` and
    // `side` above) against what the same reads give now, the databases its two held clients were refused, and whether
    // either declined a changed password. Every page
    // draws the answer as a banner and the log says each change of it once (`restart-notice.mjs`). The reading's shell
    // environment is this one's, as at start, so a key this shell sets is never called changed by an edit to the file.
    const restartReading = () => restartReadingOf({ m, env: shellEnv, dir: config.dir, fs, platform: io.platform ?? process.platform, uid });
    // A start reading that throws is the problem every later one meets too, so it is the start's, not a change.
    const startProblem = (() => { try { return restartReading().problem; } catch (e) { return thrownProblem(e); } })();
    restart = makeRestartWatch({
      start: { values: restartValuesOf(m, layered?.env, side.env, config.dir), problem: startProblem },
      readNow: restartReading,
      refused: () => [m.connection?.refusedDatabaseOf?.(redis) ?? null, fleet.refusedDatabase?.() ?? null],
      declined: () => [m.connection?.passwordDeclinedOf?.(redis) === true, fleet.passwordDeclined?.() === true],
      now,
      timers: io.timers,
      log,
    });
    const zeroTouch = m.zeroTouchData?.makeZeroTouchService({ paths: side.paths, env: side.env, fs, now, log: () => log("console: Zero touch accounting needs repair") });
    // The console's hosts file, always a path: the read side's environment takes PI_SANDBOX_HOSTS_FILE from this shell
    // only, so a value set only in the deployment .env reaches the service through the console's configuration.
    const sandboxes = m.sandboxData?.makeSandboxService({ paths: side.paths, env: { ...side.env, PI_SANDBOX_HOSTS_FILE: config.sandboxHostsFile }, deploymentDir: config.dir, fleet, fs, now });
    const gatewayRegistry = () => config.sandboxGatewaysFile ? readSandboxGateways(config.sandboxGatewaysFile, { fs, uid, platform: io.platform ?? process.platform }) : { disabled: true };
    const gatewayEnrollment = gatewayRegistry();
    if (gatewayEnrollment.refusal) io.err(`pi-dispatch-console: ${gatewayEnrollment.refusal}`);
    if (redis) gateway = makeGatewayBroker({ redis, sessions, readTokens, findToken: m.tokens.findToken, readRegistry: gatewayRegistry, audit, readOnly: () => config.readOnly, now, ...(random ? { random } : {}), readSessions: () => fleet.sandboxSessions(), readRun: (id) => fleet.runById(id) });
    const answerer = makeAnswererService({ paths: side.paths, env: side.env, fs, now });
    const pricing = pricingOf(m.pricing);
    const modelsView = m.modelsView ? (snapshot = null) => m.modelsView.readModelsView({ paths: side.paths, env: side.env, deploymentDir: config.dir, now: now(), snapshot, fleet, fs, redis }) : null;
    const modelRoles = m.modelRolePlans?.createModelRoleActions({
      paths: side.paths, env: side.env, fs, now,
      checkModelsKnown: m.modelCatalog?.checkModelsKnown,
      canarySample: async ({ role, candidate, flow }) => (await modelsView?.())?.canaries?.find((sample) => sample.role === role && sample.candidate === candidate && sample.flow === flow) ?? null,
    });
    let actionDeps;
    const setupPlatform = ["linux", "darwin"].includes(io.platform ?? process.platform);
    const setupEntry = config.hostSetup && setupPlatform ? m.setupHostClient?.setupWorkerEntry(config.dir) : null;
    const setupEnabled = config.hostSetup && setupPlatform && !config.readOnly && typeof setupEntry?.entry === "string";
    const setupReason = !config.hostSetup ? "host-setup-disabled" : !setupPlatform ? "unsupported" : config.readOnly ? "read-only" : setupEntry?.refusal ?? null;
    if (setupEnabled) setupBroker = m.setupHostClient.makeSetupBroker({ cliPath: setupEntry.entry, deployment: config.dir, env: shellEnv });
    let setupBackends = null;
    const setupProvider = () => setupProviderOf({ m, env: shellEnv, dir: config.dir, fs, platform: io.platform ?? process.platform, uid });
    if (config.hostSetup && typeof m.serviceEnv?.deploymentServiceEnv === "function") {
      try {
        const declared = m.serviceEnv.deploymentServiceEnv({ env: {}, dir: config.dir, keys: ["PI_BACKENDS", "PI_PROVIDER"], fs, platform: io.platform ?? process.platform, uid }).env;
        setupBackends = declared.PI_BACKENDS ?? "local";
      } catch { /* unknown provider metadata leaves the key form unavailable; the terminal can repair it */ }
    }
    const gatewayOnly = typeof setupBackends === "string" && setupBackends.split(",").every(name => ["openshell", "openshell-bind"].includes(name.trim()));
    setup = m.setupActions?.makeSetupActions({
      broker: setupBroker, enabled: setupEnabled, reason: setupReason, tokensPath: config.tokensPath, deployment: config.dir,
      provider: setupProvider, sessions, readTokens, now, fs,
      operations: m.setupActions?.SETUP_ACTION_NAMES.filter(name => !gatewayOnly || name !== "setup-egress-start"),
      readExposure: makeSetupExposureReader({
        initial: side,
        keys: [...(m.readModel.PANEL_SERVICE_KEYS ?? []), ...RESERVE_ENV_KEYS],
        readSide: () => readSideOf({ m, env: {}, dir: config.dir, fs, platform: io.platform ?? process.platform, uid }),
        readExposure: () => m.consoleActions.readSetupExposure({ a: actionDeps, fs, now }),
      }),
    }) ?? null;
    const triggerHistory = cachedFor(() => m.readModel.scanRunRecords({ logsDir: side.paths.logsDir, sinceMs: now() - 30 * 86400_000, nowMs: now(), fs }), { now, ttlMs: INSIGHTS_CACHE_MS });
    // The fleet's records and not this host's: a canary runs on whichever host took the job, and Adopt's gate reads its record.
    const updatesHistory = cachedFor(() => m.readModel.scanFleetRunRecords({ redis, logsDir: side.paths.logsDir, sinceMs: now() - 30 * 86400_000, nowMs: now(), fs }), { now, ttlMs: INSIGHTS_CACHE_MS });
    // The page's and the actions' one read, so an Adopt's gate reads what the page drew.
    const readUpdatesFacts = async () => {
      const history = await updatesHistory().catch(() => ({ records: [], partial: true }));
      return await m.updatesView.readDeploymentUpdates({
        redis, now: now(), pinned: m.pricing.piAiVersion?.() ?? null, paths: side.paths, fs,
        records: history.records, recordsPartial: history.partial,
        audit: await Promise.resolve().then(() => m.audit.readConsoleAudit({ logsDir: config.logsDir, fs, limit: 200 })).then((read) => read?.rows ?? []).catch(() => []),
      });
    };
    const pageDeps = {
      fleet,
      sandboxes,
      // Doctor publishes these once a run, usually daily, and a run page reads them every tick: `doctorResults`' reason.
      hostLoads: cachedFor(() => m.hostLoadsView?.readHostLoadsView(redis, { now }) ?? null, { now, ttlMs: INSIGHTS_CACHE_MS }),
      gatewayView: async () => {
        if (gateway) return gateway.view();
        const read = gatewayRegistry();
        if (!read.config) return { enabledHosts: [], sessions: [], ...(read.refusal ? { problem: read.refusal } : {}) };
        const shells = await fleet.sandboxSessions();
        return { enabledHosts: Object.keys(read.config.hosts), sessions: shells?.sessions ?? [], partial: Boolean(shells?.unreachable || shells?.more || shells?.unreadable) };
      },
      answerer,
      modelsView,
      // Issue #849: the grant alone, for the overview, fleet and host pages (`data.setupGranted`), without the provider and allowlist reads `setup` makes.
      setupGranted: () => setup?.granted?.() === true,
      // This console's own host, by the worker's name rule over the deployment's env, as the fleet reader names it (`doctorSelf`): a run page's fix button only for a run refused here.
      selfHost: () => m.readModel.doctorSelfName?.(side.env) ?? null,
      setup: async ({ role, snapshot } = {}) => {
        const state = setup?.state(role ?? "operator", snapshot) ?? { enabled: false, reason: "host-setup-disabled", actions: [], providerKey: null, progress: [], allowlistCount: null };
        // Connections owns the allowlist reader; setup copies only its count, never a sample or secret.
        if (typeof m.connectionsView?.readConnections === "function") {
          try {
            const connection = await m.connectionsView.readConnections({ publications: false, snapshot, env: shellEnv, deploymentDir: config.dir, paths: side.paths, fs, now: now(), redis, platform: io.platform ?? process.platform, uid });
            if (Array.isArray(connection?.egress?.allowlist)) state.allowlistCount = connection.egress.allowlist.length + connection.egress.more;
            if (connection?.providerKeys) state.providerKeys = connection.providerKeys;
          } catch { /* unknown remains unknown */ }
        }
        return state;
      },
      agentWrites: () => readAgentWritesToday({ read: (opts) => m.audit.readConsoleAudit({ logsDir: config.logsDir, ...opts, positions: true, fs }), verify: () => m.audit.verifyConsoleAudit({ logsDir: config.logsDir, fs, withLast: true }), now, host: side.env.PI_WORKER_NAME ?? "console" }),
      paths: side.paths,
      configLocations: () => m.readModel.configLocationsOf({ paths: side.paths, deploymentDir: config.dir }),
      secretsView: (snapshot) => m.secretsView.secretsView({ snapshot, env: side.env, fs }),
      updates: () => readUpdatesFacts(),
      // Issue #849: the remembered browsers, for their page. The listing carries each record's hash for the actions; the page needs none of them.
      devices: devices ? () => { const listed = devices.list(); return listed.problem ? listed : { ...listed, devices: listed.devices.map(({ hash, ...rest }) => rest) }; } : null,
      connections: (snapshot) => m.connectionsView.readConnections({ snapshot, env: shellEnv, deploymentDir: config.dir, paths: side.paths, fs, now: now(), redis, platform: io.platform ?? process.platform, uid }),
      projectView: (id, snapshot) => m.projectView.readProjectView({ id, snapshot, paths: side.paths, env: side.env, deploymentDir: config.dir, pricing, fleet, fs, now: now(), platform: io.platform ?? process.platform, uid }),
      triggerCheck: (input) => m.triggerCheck.checkTriggerEvent({ input, triggersPath: side.paths.triggersPath, fs }),
      triggerList: async (snapshot) => {
        const [history, zones] = await Promise.all([
          triggerHistory(),
          m.scheduleZones.readTriggerScheduleZones({ url: side.paths.valkeyUrl, triggers: snapshot?.triggers?.triggers ?? [], now }),
        ]);
        const mirrored = snapshot?.recordDetails instanceof Map ? [...snapshot.recordDetails.values()] : Array.isArray(snapshot?.runs) ? snapshot.runs : null;
        const records = Array.isArray(history) ? [...history, ...(mirrored ?? [])] : mirrored;
        return m.triggerList.triggerListOf({
          snapshot, records, now: now(), pricing, scheduleZones: zones,
          subscriptions: m.readModel.readSubscriptions({ subscriptionsPath: side.paths.subscriptionsPath, fs }).subscriptions ?? [],
          // The local scan has the full retained window; foreign history is only the bounded mirror. A fleet
          // view cannot promise completeness from a readable local directory alone.
          coverage: { complete: false, partial: !Array.isArray(history) },
        });
      },
      triggerEditor: () => m.readModel.readTriggerEditor({ paths: side.paths, env: side.env, deploymentDir: config.dir, fs, platform: io.platform ?? process.platform, uid }),
      triggerFireCheck: (index) => m.readModel.planTriggerFire({
        index, triggersPath: side.paths.triggersPath, url: side.paths.valkeyUrl,
        env: side.env, grantsEnv: shellEnv,
        overlay: m.readModel.readSettingsView({ settingsFile: side.paths.settingsFile, fs }).overlay ?? {},
        modelEndpoints: endpointSnapshotFn({ m, env: side.env, paths: side.paths, dir: config.dir, fs })?.(),
        builtinModel: m.modelCatalog?.builtinModel, fs, now,
      }),
      killSwitchPlan: killSwitchPlanFn,
      hostCapacity: async (host) => {
        const capacity = await m.insights.assembleCapacityView(side.paths, "7d", now(), { envFn: () => side.env });
        return { ...capacity, hosts: (capacity?.hosts ?? []).filter((row) => row.name === host) };
      },
      watch: fleet.watch,
      zeroTouch: zeroTouch ? (query) => zeroTouch.read(query) : undefined,
      zeroTouchRuns: zeroTouch ? (query) => zeroTouch.runs(query) : undefined,
      insights: cachedPerWindow((window, opts) => (m.insights.assembleInsightsView ?? m.insights.assembleInsights)(side.paths, window, { ...opts, pricing, nowMs: now(), envFn: () => side.env }), { now }),
      // The what-if (REQ-COST-ANALYTICS): one shared record scan at the scan's 92-day ceiling per 30 s, the answers
      // bounded and cached per (model, flow, scan window) (`whatif.mjs`).
      ...(m.whatif ? { whatIf: m.whatif.makeWhatIfReader({ pricing, scan: () => m.readModel.scanRunRecords({ logsDir: side.paths.logsDir, nowMs: now(), fs }), subscriptions: () => m.readModel.readSubscriptions({ subscriptionsPath: side.paths.subscriptionsPath, fs })?.subscriptions ?? [], now }), pricedModels: memoOnce(() => m.whatif.pricedModelIds(pricing)) } : {}),
      // The audit page (issue #737) asks for each row's position (`positions`), so a row's chain state can be told by
      // where it sits against the verification's last good row and its first damaged one.
      audit: ({ limit, before, positions } = {}) => m.audit.readConsoleAudit({ logsDir: config.logsDir, limit, before, fs, positions: positions === true }),
      auditVerify: cachedFor(async () => ({ ...(await m.audit.verifyConsoleAudit({ logsDir: config.logsDir, fs, withLast: true })), checkedAt: now() }), { now, ttlMs: AUDIT_VERIFY_CACHE_MS }),
      // The subscriptions file, for a run's cost class (a plan-covered run is not a dollar run).
      subscriptions: () => m.readModel.readSubscriptions({ subscriptionsPath: side.paths.subscriptionsPath, fs }),
      env: side.env,
      // Issue #737: the deployment the first run's steps name, by its last folder alone (`deploymentOf`).
      deployment: deploymentOf(config.dir),
      now,
    };
    hub = m.live.makeLiveHub({
      loadPageData: (page, query, who) => m.pages.loadPageData(page, query, pageDeps, who),
      pagePanels: (page, ctx) => m.pages.pagePanels(page, ctx),
      queryKeyOf: (page, query) => m.pages.pageQueryString(page, query),
      // Issue #737: one load per page whatever its query's view-only parameters (pages.mjs's `dataQueryOf`: the
      // overview's grouping and zoom regroup one snapshot), keyed by the canonical text of what it returns. A pages
      // module without it loads once per distinct query, as before.
      ...(typeof m.pages.dataQueryOf === "function" ? { dataQueryOf: (page, query) => m.pages.dataQueryOf(page, query) } : {}),
      peekSession: (id, file) => sessions.peek(id, file),
      sessionHeld: (id, file) => sessions.verdict(id, file).unjudged === true,
      // Issue #737: why a stream's session ended, from the store's pure verdict (never `get`, which would delete it).
      endedReason: (id, file) => sessions.verdict(id, file).ended ?? null,
      // Issue #643: the operator's live transcript streams read through the same reader (non-blocking XRANGE).
      transcriptSince: (jobId, after, opts) => fleet.transcriptSince(jobId, after, opts),
      readTokens,
      readOnly: config.readOnly,
      now,
      log,
    });
    // Here and nowhere a tool's context is built, so a person's page is the only way to it (DES-ADMIN-VIA-PI-EXTENSION).
    const triggerEnvironment = m.triggerEnvironmentPlans?.createTriggerEnvironmentActions({
      paths: side.paths, env: side.env, fs, now,
      readHosts: () => m.readModel.readHosts({ url: side.paths.valkeyUrl, now }),
      readHostLoads: () => pageDeps.hostLoads(),
      readSkew: async (index, proposedFs) => fleet.triggerSkew(index, await fleet.waiting(), { fs: proposedFs }),
      readRunRecords: async (index) => m.readModel.triggerDetailOf(await fleet.snapshot(), index)?.history,
      // What the worker's pickup check reads on this host: the deployment's file alone, each key by the service's own rule. The
      // console's shell is not the service's, so a value only it holds would pass a job the worker refuses, and a value it
      // overrides would refuse one the worker runs. A line the reader cannot vouch for comes back by name, never as absent, and
      // a file another account can change gives nothing: the check then says it could not run. A line the service's loader reads
      // differently stops the reader taking any value the file spells, so `hazardLine` says which line it was: those keys were not on it.
      // A line a sourcing shell runs is said whatever was asked for: `. ./more.env` spells no key and can set every one.
      deploymentDir: config.dir,
      readHostEnv: (keys) => {
        const read = m.serviceEnv.deploymentServiceEnv({ env: {}, dir: config.dir, keys, fs, platform: io.platform ?? process.platform, uid });
        if (read.unreadable || read.untrusted) throw new Error("the deployment's .env cannot be read");
        return { env: read.env, unread: [...read.unread.map((row) => row.key), ...read.hazardSkipped], hazardLine: read.shellRunsLine ?? (read.hazardSkipped.length > 0 ? read.hazard?.line ?? null : null) };
      },
      readEndpoints: () => endpointSnapshotFn({ m, env: side.env, paths: side.paths, dir: config.dir, fs })?.()?.endpoints ?? [],
    });
    actionDeps = {
      updates: { read: readUpdatesFacts, setDesired: (row) => m.updates.setDesired(redis, row) },
      // Issue #849: "sign everyone out" stops every link not opened yet, host-minted and invitations alike.
      loginCodes: { clear: () => m.loginCodes.clearLoginCodes({ dir: codesDir, fs }) },
    modelRoles,
    triggerEnvironment,
    watch: fleet.watch,
    zeroTouch,
    sandboxes,
    answerer,
    rm: m.readModel,
    plans: m.writePlans ?? null,
    paths: side.paths,
    env: side.env,
    grantsEnv: shellEnv,
    fleet,
    killSwitchPlanFn,
    urlShown: m.connection?.urlShown,
    envelopeProblem: m.insights?.envelopeProblem,
    host: hostname(),
    // A retry's reserve reads the failed job's queue data (read-only); only the reserve reaches a page.
    readJobsData: m.jobData?.readJobsData,
    // Every reserve estimate's zero-rated inputs, the worker's: the endpoint snapshot and the builtin catalog's costs.
    modelEndpoints: endpointSnapshotFn({ m, env: side.env, paths: side.paths, dir: config.dir, fs }),
    builtinModel: m.modelCatalog?.builtinModel,
      setup,
    };
    server = m.server.createConsoleServer({
      config,
      fs,
      now,
      random,
      audit,
      sessions,
      devices,
      cookies: m.sessions.readDeviceCookie ? { ...m.sessions, readDeviceCookie: (name, header) => m.sessions.readDeviceCookie(name, header), readDeviceCookies: (name, header) => m.sessions.readDeviceCookies(name, header) } : m.sessions,
      tickets: m.confirm.makeConfirmTickets(withRandom({ now })),
      limiter: makeLoginLimiter({ now }),
      log,
      readTokens,
      findToken: m.tokens.findToken,
      keptTokens: m.tokens.keptTokens,
      consumeLoginCode: (code) => m.loginCodes.consumeLoginCode({ dir: codesDir, code, fs, now }),
      writePauseWindows: m.readModel.writePauseWindows,
      // What the action table writes with (issue #642, `actions.mjs`): the read model's funnels and the pi-free planners
      // the tools use, over the paths and env the read side resolved, so a console write lands in the files and queues
      // the service reads, refused in the tools' own words.
      actionDeps,
      pages: m.pages,
      pageDeps,
      hub,
      stateOf: m.live.stateOf,
      gateway,
      consoleOrigin: () => { const read = gatewayRegistry(); return read.refusal ? false : read.config?.consoleOrigin ?? null; },
      // Issue #845: the banner every page draws when this console needs a restart, for every role.
      restartNotice: () => restart.current(),
    });
    const bound = await listenOn(server, config.listen, { fs, uid });
    if (bound.refusal) throw new Refusal(bound.refusal);
    // The start is audited like any other event; a log that cannot be written refuses the start, since every write
    // the console could then make would be refused anyway.
    try {
      audit.append({ actor: { name: "shell", role: "shell", session: null }, action: "serve-started", target: config.listen.kind === "unix" ? config.listen.path : `${config.listen.host}:${bound.address.port}`, outcome: "ok" });
    } catch (e) {
      throw new Refusal(`the console audit log cannot be written (${e?.code ?? "error"}: ${e?.message ?? ""}); fix it before serving`);
    }
    // Issue #882 (review): an enrolled origin is the one address a browser may sign in from, so it is the one printed.
    const enrolled = gatewayEnrollment.config?.consoleOrigin ?? null;
    if (enrolled !== null) {
      io.out(`pi-dispatch console on ${enrolled}/ (its address in sandbox-gateways.json; it listens on ${config.listen.kind === "tcp" ? `${config.listen.host.includes(":") ? `[${config.listen.host}]` : config.listen.host}:${bound.address.port}` : `unix socket ${config.listen.path}`})`);
    } else if (config.listen.kind === "tcp") {
      const port = bound.address.port;
      io.out(`pi-dispatch console on ${listenUrl(config.listen, port)}`);
      io.out(`from another machine: ssh -L ${port}:${config.listen.host.includes(":") ? `[${config.listen.host}]` : config.listen.host}:${port} <this host>, then open http://${CONSOLE_HOSTNAME}:${port}/`);
    } else {
      io.out(`pi-dispatch console on unix socket ${config.listen.path}`);
      io.out(`from another machine: ssh -L 4790:${config.listen.path} <this host>, then open http://${CONSOLE_HOSTNAME}:4790/`);
    }
    // How to get in, never a token: the commands that make one (issue #737). A unix socket's link needs the tunnel's
    // local port, which only the operator knows. Issue #882: `link` prints a code to type as well, so it leads.
    io.out(`sign in: pi-dispatch-console link --name <you>${config.listen.kind === "tcp" ? "" : " --port <your tunnel's local port>"} prints a one-time link and a code to type; or paste a token (pi-dispatch-console token add --name <you> --role operator makes one)`);
    if (config.readOnly) io.out("read-only: every change is refused (PI_CONSOLE_READ_ONLY=1)");
    if (io.onListening) io.onListening(server);
    await (io.until ?? untilSignal());
    return 0;
  } finally {
    // The streams first, so closing the server is not held open by them; then the listener, the reader, the copy.
    restart?.close();
    setup?.close();
    setupBroker?.close();
    await gateway?.close();
    hub?.close();
    if (server?.listening) {
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
    try {
      await fleet?.dispose();
    } catch {
      // best-effort teardown
    }
    try {
      redis?.disconnect?.();
    } catch {
      // the copy is best effort, its client too
    }
    m.connection?.useValkeyContext?.(null);
    lock.release();
  }
}

/** True when this module is the program being run (directly, or through the npm bin symlink). */
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
