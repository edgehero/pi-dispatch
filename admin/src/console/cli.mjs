/**
 * `pi-dispatch-console`, the operator console's command (issue #640). Bundled to `admin/dist/console.mjs`.
 *
 *   serve                                   run the console (prints its URL and an ssh -L hint, never a token)
 *   token add --name N --role operator|viewer
 *   token list | token revoke --name N | token rotate --name N
 *   sessions end-all                        sign every browser out (bumps the tokens file's generation)
 *   link --name N                           a one-time sign-in link for token N, valid 60 seconds
 *   audit verify                            walk the audit log's hash chain
 *
 * Every subcommand takes `--deployment <dir>`. Exit codes: 0 done, 2 refused (a configuration or input problem, with a
 * sentence saying what to change), 1 unexpected.
 *
 * ONLY `token add` AND `token rotate` PRINT A TOKEN, on one line of its own, so a terminal log or a pasted transcript
 * holds a token only where the operator asked for one. `link` prints a one-time code inside a URL, which is its
 * purpose; the code is not the token and dies in 60 seconds or at first use.
 *
 * The real collaborators (tokens, sessions, codes, tickets, audit, the pause-windows writer) are loaded here and
 * nowhere else, by `loadModules`; `runCli` takes them injected, so its tests run on fakes.
 */
import * as nodeFs from "node:fs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { consoleConfig, consoleEnv, deploymentDirOf } from "./config.mjs";
import { makeLoginLimiter } from "./guards.mjs";
import { listenOn, listenUrl } from "./listen.mjs";
import { acquireConsoleLock } from "./lock.mjs";
import { createConsoleServer } from "./server.mjs";

export const USAGE = `usage: pi-dispatch-console <command> [--deployment <dir>]

  serve                                    run the console on PI_CONSOLE_LISTEN (default 127.0.0.1:4790)
  token add --name <name> --role <role>    add a token (operator or viewer); prints it once
  token list                               names and roles, never a token
  token revoke --name <name>               remove a token; its sessions end at their next request
  token rotate --name <name>               a new secret for a name; prints it once
  sessions end-all                         sign every browser out
  link --name <name>                       a one-time sign-in link, valid 60 seconds
  audit verify                             check the audit log's hash chain

The deployment is --deployment, else the one the setup wizard recorded, else the current directory.`;

/** The CLI's audit actor: whoever holds the deployment account's shell. */
const SHELL = Object.freeze({ name: "shell", role: "shell", session: null });

class Refusal extends Error {}

/** Load the real collaborators. Dynamic so `--help` and the tests never need them; static strings so esbuild inlines them. */
export async function loadModules() {
  const [tokens, audit, sessions, loginCodes, confirm, readModel, connection] = await Promise.all([
    import("@edgehero/pi-dispatch/console-tokens"),
    import("@edgehero/pi-dispatch/console-audit"),
    import("./sessions.mjs"),
    import("./login-codes.mjs"),
    import("./confirm.mjs"),
    import("../read-model.mjs"),
    import("@edgehero/pi-dispatch/connection"),
  ]);
  return { tokens, audit, sessions, loginCodes, confirm, readModel, connection };
}

function parse(argv) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: { deployment: { type: "string" }, name: { type: "string" }, role: { type: "string" }, help: { type: "boolean", short: "h" } },
    });
  } catch (e) {
    throw new Refusal(`${e?.message ?? "the arguments could not be read"}; run pi-dispatch-console --help`);
  }
}

function needName(values) {
  if (typeof values.name !== "string" || values.name === "") throw new Refusal("this command needs --name <name>");
  return values.name;
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

  const m = io.modules ?? (await loadModules());
  const where = deploymentDirOf({ arg: values.deployment ?? null, env, fs, cwd });
  if (where.notice) io.err(`pi-dispatch-console: ${where.notice}`);
  const layered = consoleEnv({ env, dir: where.dir, fs, platform, uid });
  if (layered.notice) io.err(`pi-dispatch-console: ${layered.notice}`);
  const config = consoleConfig({ env: layered.env, dir: where.dir, platform, tokensFilePath: m.tokens.tokensFilePath });
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
      const read = m.tokens.readTokensFile({ path: config.tokensPath, fs, uid });
      if (read.refusal) throw new Refusal(read.refusal);
      if (!read.file.tokens.some((t) => t.name === name)) throw new Refusal(`there is no token named "${name}"; see pi-dispatch-console token list`);
      const minted = m.loginCodes.mintLoginCode(withRandom({ dir: m.loginCodes.loginCodesDir(config.tokensPath), name, fs, now }));
      if (minted.refusal) throw new Refusal(minted.refusal);
      if (!record({ action: "login-code", target: name })) return 1;
      const base = listenUrl(config.listen) ?? "http://localhost:<the local port of your ssh -L tunnel>/";
      io.out(`${base}login/code#${minted.code}`);
      io.err("open it within 60 seconds; it works once");
      return 0;
    }
    case "audit verify": {
      const res = m.audit.verifyConsoleAudit({ logsDir: config.logsDir, fs });
      if (res.ok) {
        const from = res.startsAt ? ` (starts at ${res.startsAt.file} row ${res.startsAt.seq}: older files were removed by retention)` : "";
        io.out(`the console audit log holds ${res.rows} rows and its chain is intact${from}`);
        return 0;
      }
      throw new Refusal(`the console audit log's chain breaks at ${res.broken.file} line ${res.broken.line}: ${res.broken.reason}. Rows before it (${res.rows}) are intact; keep the file for inspection`);
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
  try {
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
    server = createConsoleServer({
      config,
      fs,
      now,
      random,
      audit,
      sessions: m.sessions.makeSessionStore(withRandom({ now, idleMs: config.idleMs, maxMs: config.maxMs, maxStreams: config.maxStreams })),
      cookies: m.sessions,
      tickets: m.confirm.makeConfirmTickets(withRandom({ now })),
      limiter: makeLoginLimiter({ now }),
      log: io.log ?? ((line) => io.err(line)),
      readTokens,
      findToken: m.tokens.findToken,
      consumeLoginCode: (code) => m.loginCodes.consumeLoginCode({ dir: codesDir, code, fs, now }),
      writePauseWindows: m.readModel.writePauseWindows,
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
    if (config.readOnly) io.out("read-only: every change is refused (PI_CONSOLE_READ_ONLY=1)");
    if (io.onListening) io.onListening(server);
    await (io.until ?? untilSignal());
    return 0;
  } finally {
    if (server?.listening) {
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
    try {
      redis?.disconnect?.();
    } catch {
      // the copy is best effort, its client too
    }
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
