/**
 * `pi-dispatch-console`, the operator console's command (issue #640). Bundled to `admin/dist/console.mjs`.
 *
 *   serve                                   run the console (prints its URL and an ssh -L hint, never a token)
 *   token add --name N --role operator|viewer
 *   token list | token revoke --name N | token rotate --name N
 *   sessions end-all                        sign every browser out (bumps the tokens file's generation)
 *   link --name N [--port P]                a one-time sign-in link for token N, valid 60 seconds (P: an ssh -L
 *                                           tunnel's local port, which the console cannot know)
 *   audit verify                            walk the audit log's hash chain
 *
 * Every subcommand takes `--deployment <dir>`. Exit codes: 0 done, 2 refused (a configuration or input problem, with a
 * sentence saying what to change), 1 unexpected.
 *
 * ONLY `token add` AND `token rotate` PRINT A TOKEN, on one line of its own, so a terminal log or a pasted transcript
 * holds a token only where the operator asked for one. `link` prints a one-time code inside a URL, which is its
 * purpose; the code is not the token and dies in 60 seconds or at first use.
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
import { consoleConfig, consoleEnv, deploymentDirOf } from "./config.mjs";
import { makeLoginLimiter } from "./guards.mjs";
import { listenOn, listenUrl } from "./listen.mjs";
import { acquireConsoleLock } from "./lock.mjs";
import { makeAnswererService } from "../answerer-data.mjs";
import { readAgentWritesToday } from "../agent-write-count.mjs";

export const USAGE = `usage: pi-dispatch-console <command> [--deployment <dir>]

  serve                                    run the console on PI_CONSOLE_LISTEN (default 127.0.0.1:4790)
  token add --name <name> --role <role>    add a token (operator, viewer or agent); prints it once
  token list                               names and roles, never a token
  token revoke --name <name>               remove a token; its sessions end at their next request
  token rotate --name <name>               a new secret for a name; prints it once
  sessions end-all                         sign every browser out
  link --name <name> [--port <n>] [--next /setup]  a one-time sign-in link, valid 60 seconds
  serve --host-setup                       explicitly allow local person-only setup actions
  audit verify                             check the audit log's hash chain

The deployment is --deployment, else the one the setup wizard recorded, else the current directory.`;

/** The CLI's audit actor: whoever holds the deployment account's shell. */
const SHELL = Object.freeze({ name: "shell", role: "shell", session: null });

class Refusal extends Error {}

/** Load the real collaborators. Dynamic so `--help` and the tests never need them; static strings so esbuild inlines them. */
export async function loadModules() {
  const [tokens, audit, sessions, loginCodes, confirm, readModel, connection, server, live, pages, insights, pricing, serviceEnv, forges, writePlans, jobData, workerConfig, modelEndpoints, modelCatalog, whatif, sandboxVerdict, triggerList, triggerCheck, scheduleZones, secretsView, connectionsView, projectView, zeroTouchData, sandboxData, modelsView, modelRolePlans, setupActions, setupHostClient, consoleActions] = await Promise.all([
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
    import("../models-view.mjs"),
    import("../model-role-plans.mjs"),
    import("../setup-actions.mjs"),
    import("../setup-host-client.mjs"),
    import("./actions.mjs"),
  ]);
  return { tokens, audit, sessions, loginCodes, confirm, readModel, connection, server, live, pages, insights, pricing, serviceEnv, forges, writePlans, jobData, workerConfig, modelEndpoints, modelCatalog, whatif, sandboxVerdict, triggerList, triggerCheck, scheduleZones, secretsView, connectionsView, projectView, zeroTouchData, sandboxData, modelsView, modelRolePlans, setupActions, setupHostClient, consoleActions };
}

/** How long one insights assembly is reused per window: it walks every run record, far too much for each request. */
export const INSIGHTS_CACHE_MS = 30_000;

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
  // The deployment's own forge URL variables (GITLAB_URL, FORGEJO_URL, AZURE_ORG_URL) are what a `.env` sets; the
  // job-container names after them only exist where the worker derived them.
  // Issue #642: the keys a reserve estimate reads as the worker does (the allowed-model list, the default provider and
  // model, and where the model-endpoint declaration lives), so a console preview judges a job by the service's settings.
  const extraKeys = [...Object.values(m.readModel.FORGE_HOST_ENV ?? {}).flat(), ...(m.forges?.FORGE_HOST_VARS ?? []), "PI_SESSIONS_DIR", ...RESERVE_ENV_KEYS];
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
      options: { deployment: { type: "string" }, name: { type: "string" }, role: { type: "string" }, port: { type: "string" }, next: { type: "string" }, "host-setup": { type: "boolean" }, help: { type: "boolean", short: "h" } },
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
 * free one), so the operator says it and the link is printed for `localhost` there, the one name a tunnel answers on.
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
  const known = ["serve", "token add", "token list", "token revoke", "token rotate", "sessions end-all", "link", "audit verify"];
  if (!known.includes(command)) throw new Refusal(`unknown command "${command.slice(0, 40)}"; run pi-dispatch-console --help`);
  // Refused before anything is read or written, so a `--port` that would be silently ignored never runs its command.
  if (values.port !== undefined && command !== "link") throw new Refusal("--port is for link only");
  if (values.next !== undefined && (command !== "link" || values.next !== "/setup")) throw new Refusal("--next is for link only and must be /setup");
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
      if (read.file.tokens.length === 0) io.out(`no tokens in ${config.tokensPath}; add one with pi-dispatch-console token add --name <name> --role operator`);
      for (const t of read.file.tokens) io.out(`${t.name}\t${t.role}\t${t.createdAt}`);
      return 0;
    }
    case "sessions end-all": {
      const res = m.tokens.endAllSessions(withRandom({ path: config.tokensPath, fs, uid }));
      invalid(res);
      io.out("every console session ends at its next request");
      return record({ action: "sessions-ended" }) ? 0 : 1;
    }
    case "link": {
      const name = needName(values);
      // Judged before the code is minted, so a mistyped port costs no code and no audit row.
      const port = values.port === undefined ? null : linkPortOf(values.port);
      const read = m.tokens.readTokensFile({ path: config.tokensPath, fs, uid });
      if (read.refusal) throw new Refusal(read.refusal);
      if (!read.file.tokens.some((t) => t.name === name)) throw new Refusal(`there is no token named "${name}"; see pi-dispatch-console token list`);
      // Bootstrap composes this command, so its audit intent must exist before a code file can be created.
      const row = { actor: SHELL, action: "login-code", target: name, ticket: (random ?? randomBytes)(6).toString("hex") };
      try { audit.append({ ...row, outcome: "ok" }); }
      catch (e) { io.err(`pi-dispatch-console: no sign-in code was minted because its audit row could not be written (${e?.code ?? "error"}); check PI_LOGS_DIR and run audit verify`); return 1; }
      const failed = () => {
        try { audit.append({ ...row, outcome: "failed", reason: "login-code-mint-failed" }); }
        catch (e) { io.err(`pi-dispatch-console: the sign-in code was not minted, but its failed audit row could not be written (${e?.code ?? "error"}); run audit verify`); }
      };
      let minted;
      try { minted = m.loginCodes.mintLoginCode(withRandom({ dir: m.loginCodes.loginCodesDir(config.tokensPath), name, fs, now })); }
      catch (e) { failed(); throw e; }
      if (minted.refusal) { failed(); throw new Refusal(minted.refusal); }
      const base = port !== null ? `http://localhost:${port}/` : (listenUrl(config.listen) ?? "http://localhost:<the local port of your ssh -L tunnel>/");
      io.out(`${base}login/code#${minted.code}${values.next === "/setup" ? "&next=/setup" : ""}`);
      io.err("open it within 60 seconds; it works once");
      return 0;
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
        io.out(`the console audit log holds ${res.rows} rows and its chain is intact${from}`);
        return 0;
      }
      const { broken, last, suspect } = res;
      if (broken.file === null) throw new Refusal(`the console audit log cannot be checked: ${broken.reason}`);
      const either = suspect ? ` Row ${suspect.seq} before it (${suspect.file} line ${suspect.line}) is not vouched for either: the link between the two does not hold, so the chain cannot tell whether row ${suspect.seq} was changed.` : "";
      const intact = last ? `Rows through row ${last.seq} are intact` : "No row before it is vouched for";
      throw new Refusal(`the console audit log's chain breaks at ${broken.file} line ${broken.line}: ${broken.reason}.${either} ${intact}; keep the file for inspection`);
    }
    case "serve":
      return serve({ io, m, config, audit, fs, now, uid, random });
    default:
      throw new Refusal(`unknown command "${command}"`);
  }
}

/** Startup refusals in order (tokens file, an operator, the lock, the bind), then serve until stopped. */
async function serve({ io, m, config, audit, fs, now, uid, random }) {
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
  try {
    // Every Valkey client of this process (the audit copy's, the fleet reader's) takes its password and its facts
    // about the deployment's Valkey from THIS deployment's `.env`, through the panel's one reader, as the pi extension
    // does for the pointer's deployment (`installPanelValkeyContext`); the console names its deployment itself.
    const shellEnv = io.env ?? process.env;
    m.connection?.useValkeyContext?.(() => m.readModel.panelValkeyContext({ env: shellEnv, pointerDir: config.dir, owned: [], fs, uid }));
    // The Valkey copy of the audit log (`console:audit`, INT-CONSOLE-AUDIT-LOG) is a view for a console elsewhere, never
    // the record: each row serve writes is pushed after the file holds it, a down or refusing Valkey costs nothing but
    // the copy, and no Valkey error reaches the log or refuses a request.
    try {
      redis = m.connection?.makeRedisClient(config.valkeyUrl, { failFast: true, disconnectTimeoutMs: 0 }) ?? null;
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
    const sessions = m.sessions.makeSessionStore(withRandom({ now, idleMs: config.idleMs, maxMs: config.maxMs, maxStreams: config.maxStreams }));

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
    const zeroTouch = m.zeroTouchData?.makeZeroTouchService({ paths: side.paths, env: side.env, fs, now, log: () => log("console: Zero touch accounting needs repair") });
    const sandboxes = m.sandboxData?.makeSandboxService({ paths: side.paths, env: { ...side.env, ...(config.sandboxHostsFile ? { PI_SANDBOX_HOSTS_FILE: config.sandboxHostsFile } : {}) }, deploymentDir: config.dir, fleet, fs, now });
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
    const pageDeps = {
      fleet,
      sandboxes,
      answerer,
      modelsView,
      setup: async ({ role, snapshot } = {}) => {
        const state = setup?.state(role ?? "operator", snapshot) ?? { enabled: false, reason: "host-setup-disabled", actions: [], providerKey: null, progress: [], allowlistCount: null };
        // Connections owns the allowlist reader; setup copies only its count, never a sample or secret.
        if (typeof m.connectionsView?.readConnections === "function") {
          try {
            const connection = await m.connectionsView.readConnections({ snapshot, env: shellEnv, deploymentDir: config.dir, paths: side.paths, fs, now: now(), redis, platform: io.platform ?? process.platform, uid });
            if (Array.isArray(connection?.egress?.allowlist)) state.allowlistCount = connection.egress.allowlist.length + connection.egress.more;
          } catch { /* unknown remains unknown */ }
        }
        return state;
      },
      agentWrites: () => readAgentWritesToday({ read: (opts) => m.audit.readConsoleAudit({ logsDir: config.logsDir, ...opts, positions: true, fs }), verify: () => m.audit.verifyConsoleAudit({ logsDir: config.logsDir, fs, withLast: true }), now, host: side.env.PI_WORKER_NAME ?? "console" }),
      paths: side.paths,
      configLocations: () => m.readModel.configLocationsOf({ paths: side.paths, deploymentDir: config.dir }),
      secretsView: (snapshot) => m.secretsView.secretsView({ snapshot, env: side.env, fs }),
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
      // Issue #737: why a stream's session ended, from the store's pure verdict (never `get`, which would delete it).
      endedReason: (id, file) => sessions.verdict(id, file).ended ?? null,
      // Issue #643: the operator's live transcript streams read through the same reader (non-blocking XRANGE).
      transcriptSince: (jobId, after, opts) => fleet.transcriptSince(jobId, after, opts),
      readTokens,
      readOnly: config.readOnly,
      now,
      log,
    });
    actionDeps = {
    modelRoles,
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
      cookies: m.sessions,
      tickets: m.confirm.makeConfirmTickets(withRandom({ now })),
      limiter: makeLoginLimiter({ now }),
      log,
      readTokens,
      findToken: m.tokens.findToken,
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
    if (config.listen.kind === "tcp") {
      const port = bound.address.port;
      io.out(`pi-dispatch console on ${listenUrl(config.listen, port)}`);
      io.out(`from another machine: ssh -L ${port}:${config.listen.host.includes(":") ? `[${config.listen.host}]` : config.listen.host}:${port} <this host>, then open http://localhost:${port}/`);
    } else {
      io.out(`pi-dispatch console on unix socket ${config.listen.path}`);
      io.out(`from another machine: ssh -L 4790:${config.listen.path} <this host>, then open http://localhost:4790/`);
    }
    // How to get in, never a token: the commands that make one (issue #737). A unix socket's link needs the tunnel's
    // local port, which only the operator knows.
    io.out(`sign in: paste a token (pi-dispatch-console token add --name <you> --role operator makes one), or open a one-time link: pi-dispatch-console link --name <you>${config.listen.kind === "tcp" ? "" : " --port <your tunnel's local port>"}`);
    if (config.readOnly) io.out("read-only: every change is refused (PI_CONSOLE_READ_ONLY=1)");
    if (io.onListening) io.onListening(server);
    await (io.until ?? untilSignal());
    return 0;
  } finally {
    // The streams first, so closing the server is not held open by them; then the listener, the reader, the copy.
    setup?.close();
    setupBroker?.close();
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
