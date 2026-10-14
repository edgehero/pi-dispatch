import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { runCli, USAGE } from "../src/console/cli.mjs";
import { acquireConsoleLock, consoleLockPath } from "../src/console/lock.mjs";

// `pi-dispatch-console` (issue #640) on injected modules: the token, session, code, ticket and audit modules are fakes
// here, so these tests pin the command's own rules (exit codes, what it prints and where, the startup refusals, the
// lock) and nothing of its collaborators.

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const TOKEN = `pdc_${"t".repeat(43)}`;
const CODE = "k".repeat(43);

function fakeModules({ tokens = [{ name: "alice", role: "operator", sha256: "a".repeat(64), createdAt: "2026-10-01T00:00:00.000Z" }], tokensRefusal = null, auditFails = false, verify = { ok: true, rows: 3, startsAt: null } } = {}) {
  const rows = [];
  const calls = [];
  const file = { version: 1, generation: 0, tokens };
  return {
    rows,
    calls,
    tokens: {
      TOKEN_ROLES: ["operator", "viewer"],
      tokensFilePath: (env, dir) => join(dir, env.PI_CONSOLE_TOKENS_FILE || "console-tokens.json"),
      readTokensFile: () => (tokensRefusal ? { refusal: tokensRefusal } : { file }),
      operatorCount: (f) => f.tokens.filter((t) => t.role === "operator").length,
      findToken: () => null,
      addToken: (args) => {
        calls.push(["add", args]);
        return args.name === "taken" ? { invalid: "a token named taken already exists" } : { token: TOKEN, entry: { name: args.name, role: args.role } };
      },
      rotateToken: (args) => (calls.push(["rotate", args]), { token: TOKEN, entry: { name: args.name } }),
      revokeToken: (args) => (calls.push(["revoke", args]), args.name === "ghost" ? { invalid: "there is no token named ghost" } : { ok: true }),
      endAllSessions: (args) => (calls.push(["end-all", args]), { ok: true, generation: 1 }),
    },
    audit: {
      makeConsoleAudit: () => ({
        append(row) {
          if (auditFails) {
            const e = new Error("disk full");
            e.code = "ENOSPC";
            throw e;
          }
          rows.push(row);
          return row;
        },
      }),
      verifyConsoleAudit: () => verify,
    },
    sessions: {
      makeSessionStore: () => ({ create: () => ({ id: "s".repeat(43) }), get: () => null, destroy() {} }),
      sessionCookie: () => "pdc_session=x",
      clearSessionCookie: () => "pdc_session=; Max-Age=0",
      readSessionCookie: () => null,
      sessionDigest: () => "d".repeat(12),
    },
    loginCodes: {
      loginCodesDir: (p) => join(p, "..", "console-login-codes"),
      mintLoginCode: (args) => (calls.push(["mint", args]), { code: CODE }),
      consumeLoginCode: () => ({ refusal: "unknown" }),
    },
    confirm: { makeConfirmTickets: () => ({ issue: () => ({ ticket: "t" }), redeem: () => ({ refusal: "no" }) }) },
    readModel: { writePauseWindows: () => ({ ok: true }) },
  };
}

function deployment(env = {}) {
  const dir = tempDir("console-cli-");
  return { dir, env: { PI_LOGS_DIR: join(dir, "logs"), PI_CONSOLE_LISTEN: "127.0.0.1:0", PI_DISPATCH_DEPLOYMENT_FILE: join(dir, "no-pointer.json"), ...env } };
}

async function cli(argv, { modules = fakeModules(), env, dir, ...io } = {}) {
  const out = [];
  const err = [];
  const where = dir ?? deployment().dir;
  const code = await runCli([...argv, "--deployment", where], { env: env ?? deployment().env, modules, now: () => T0, uid: process.geteuid?.(), out: (l) => out.push(l), err: (l) => err.push(l), ...io });
  return { code, out, err, modules };
}

test("--help prints the usage and exits 0; no command, an unknown command or option exits 2 with a sentence", async () => {
  const help = await runCli(["--help"], { out: (l) => assert.equal(l, USAGE), err: () => assert.fail("nothing on stderr") });
  assert.equal(help, 0);
  for (const argv of [[], ["frobnicate"], ["token"], ["token", "add", "--bogus"]]) {
    const err = [];
    const code = await runCli(argv, { modules: fakeModules(), env: deployment().env, out: () => {}, err: (l) => err.push(l) });
    assert.equal(code, 2, argv.join(" "));
    assert.match(err.join("\n"), /^pi-dispatch-console: /);
  }
});

test("token add prints the token ALONE on one stdout line, says so on stderr, and audits as the shell", async () => {
  const r = await cli(["token", "add", "--name", "alice", "--role", "operator"]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.out, [TOKEN]);
  assert.ok(!r.err.join("\n").includes(TOKEN), "stderr never carries the token");
  assert.deepEqual(r.modules.rows, [{ actor: { name: "shell", role: "shell", session: null }, outcome: "ok", action: "token-added", target: "alice" }]);
  assert.ok(!JSON.stringify(r.modules.rows).includes("pdc_"));
});

test("token add refuses a bad role and a refused name with exit 2, printing no token", async () => {
  for (const argv of [["token", "add", "--name", "a", "--role", "admin"], ["token", "add", "--name", "a"], ["token", "add", "--role", "viewer"], ["token", "add", "--name", "taken", "--role", "viewer"]]) {
    const r = await cli(argv);
    assert.equal(r.code, 2, argv.join(" "));
    assert.deepEqual(r.out, []);
    assert.deepEqual(r.modules.rows, []);
  }
});

test("token rotate prints the new token alone; revoke, list and sessions end-all never print one", async () => {
  const rotate = await cli(["token", "rotate", "--name", "alice"]);
  assert.deepEqual([rotate.code, rotate.out], [0, [TOKEN]]);
  assert.equal(rotate.modules.rows[0].action, "token-rotated");
  for (const [argv, action] of [[["token", "revoke", "--name", "alice"], "token-revoked"], [["sessions", "end-all"], "sessions-ended"], [["token", "list"], null]]) {
    const r = await cli(argv);
    assert.equal(r.code, 0, argv.join(" "));
    const all = [...r.out, ...r.err].join("\n");
    assert.ok(!all.includes("pdc_") && !all.includes("a".repeat(64)), `${argv.join(" ")} printed a secret or a hash`);
    assert.equal(r.modules.rows[0]?.action ?? null, action);
  }
  const list = await cli(["token", "list"]);
  assert.deepEqual(list.out, ["alice\toperator\t2026-10-01T00:00:00.000Z"]);
  assert.equal((await cli(["token", "revoke", "--name", "ghost"])).code, 2);
});

test("a failed audit append after a CLI change is said loudly and exits 1; the token is still shown once", async () => {
  const r = await cli(["token", "add", "--name", "alice", "--role", "viewer"], { modules: fakeModules({ auditFails: true }) });
  assert.equal(r.code, 1);
  assert.deepEqual(r.out, [TOKEN]);
  assert.match(r.err.join("\n"), /audit row could not be written \(ENOSPC/);
});

test("link prints a one-time URL with the code in the fragment, for a known name only", async () => {
  const r = await cli(["link", "--name", "alice"], { env: deployment({ PI_CONSOLE_LISTEN: "127.0.0.1:4790" }).env });
  assert.equal(r.code, 0);
  assert.deepEqual(r.out, [`http://127.0.0.1:4790/login/code#${CODE}`]);
  assert.equal(r.modules.rows[0].action, "login-code");
  assert.ok(!JSON.stringify(r.modules.rows).includes(CODE), "the audit row never holds the code");
  assert.equal((await cli(["link", "--name", "nobody"])).code, 2);
  const unix = await cli(["link", "--name", "alice"], { env: deployment({ PI_CONSOLE_LISTEN: "unix:/tmp/pd.sock" }).env });
  assert.match(unix.out[0], /^http:\/\/localhost:<the local port of your ssh -L tunnel>\/login\/code#/);
});

test("audit verify: intact is 0, a broken chain is 2 naming where", async () => {
  const ok = await cli(["audit", "verify"], { modules: fakeModules({ verify: { ok: true, rows: 3, startsAt: { file: "2026-09.jsonl", seq: 40 } } }) });
  assert.equal(ok.code, 0);
  assert.match(ok.out[0], /3 rows.*intact.*starts at 2026-09.jsonl row 40/);
  const broken = await cli(["audit", "verify"], { modules: fakeModules({ verify: { ok: false, rows: 7, broken: { file: "2026-10.jsonl", line: 8, reason: "prev does not match" } } }) });
  assert.equal(broken.code, 2);
  assert.match(broken.err.join("\n"), /2026-10.jsonl line 8: prev does not match/);
});

test("serve refuses to start, exit 2: a public bind, a hostname bind, a bad tokens file, no operator token", async () => {
  const cases = [
    [{ env: deployment({ PI_CONSOLE_LISTEN: "0.0.0.0:4790" }).env }, /PI_CONSOLE_BIND_PUBLIC/],
    [{ env: deployment({ PI_CONSOLE_LISTEN: "localhost:4790" }).env }, /not an IP literal/],
    [{ modules: fakeModules({ tokensRefusal: "the tokens file is readable by others; chmod 600 it" }) }, /chmod 600/],
    [{ modules: fakeModules({ tokens: [{ name: "v", role: "viewer", sha256: "b".repeat(64), createdAt: "2026-10-01T00:00:00.000Z" }] }) }, /no operator token/],
  ];
  for (const [opts, why] of cases) {
    const r = await cli(["serve"], { ...opts, until: Promise.resolve() });
    assert.equal(r.code, 2);
    assert.match(r.err.join("\n"), why);
    assert.deepEqual(r.out, []);
  }
});

test("serve refuses a too-long or permissive unix socket", { skip: process.platform === "win32" ? "unix sockets" : false }, async () => {
  const long = await cli(["serve"], { env: deployment({ PI_CONSOLE_LISTEN: `unix:/${"x".repeat(120)}` }).env, until: Promise.resolve() });
  assert.equal(long.code, 2);
  assert.match(long.err.join("\n"), /bytes, and this platform allows at most/);
  const dep = deployment();
  const sockDir = join(tempDir("pdc-"), "s");
  mkdirSync(sockDir);
  chmodSync(sockDir, 0o755);
  const loose = await cli(["serve"], { dir: dep.dir, env: { ...dep.env, PI_CONSOLE_LISTEN: `unix:${join(sockDir, "c.sock")}` }, until: Promise.resolve() });
  assert.equal(loose.code, 2);
  assert.match(loose.err.join("\n"), /mode 755.*chmod 700/);
});

function get(port, path, host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path, headers: { host }, setHost: false }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, text }));
    }).on("error", reject).end();
  });
}

test("serve prints the URL and an ssh -L hint (never a token), answers, holds the lock against a second serve, and releases it", async (t) => {
  const dep = deployment();
  let stop;
  const until = new Promise((resolve) => (stop = resolve));
  // A failed assertion below must still stop the server, or its open listener keeps the run alive forever.
  t.after(() => stop());
  let listening;
  const up = new Promise((resolve) => (listening = resolve));
  const modules = fakeModules();
  const out = [];
  const err = [];
  const running = runCli(["serve", "--deployment", dep.dir], { env: dep.env, modules, now: () => T0, uid: process.geteuid?.(), out: (l) => out.push(l), err: (l) => err.push(l), until, onListening: listening });
  const server = await up;
  const port = server.address().port;
  assert.match(out[0], new RegExp(`^pi-dispatch console on http://127\\.0\\.0\\.1:${port}/$`));
  assert.match(out[1], new RegExp(`ssh -L ${port}:127\\.0\\.0\\.1:${port} <this host>`));
  assert.equal(out.length, 2);
  assert.ok(![...out, ...err].join("\n").includes("pdc_"));
  assert.equal(modules.rows.at(-1).action, "serve-started");
  assert.equal((await get(port, "/healthz")).text, "ok");
  assert.equal((await get(port, "/healthz", "host.docker.internal")).status, 421);
  const lockPath = consoleLockPath(join(dep.dir, "logs"));
  assert.equal(readFileSync(lockPath, "utf8").trim(), String(process.pid));

  const second = await cli(["serve"], { dir: dep.dir, env: dep.env, until: Promise.resolve() });
  assert.equal(second.code, 2);
  assert.match(second.err.join("\n"), /another console \(pid \d+\) is already serving this deployment/);

  stop();
  assert.equal(await running, 0);
  assert.equal(existsSync(lockPath), false, "the lock is released on stop");
  assert.equal(server.listening, false);
});

test("the lock: a dead holder is taken over, a live one refuses, and release never removes another's lock", () => {
  const logsDir = join(tempDir("console-lock-"), "logs");
  const a = acquireConsoleLock({ logsDir, pid: 111, alive: () => true });
  assert.equal(typeof a.release, "function");
  assert.match(acquireConsoleLock({ logsDir, pid: 222, alive: () => true }).refusal, /pid 111/);
  const b = acquireConsoleLock({ logsDir, pid: 222, alive: (pid) => pid !== 111 });
  assert.equal(typeof b.release, "function", "111 is dead, so 222 takes over");
  a.release();
  assert.equal(readFileSync(a.path, "utf8").trim(), "222", "the old holder's release left the new lock alone");
  b.release();
  assert.equal(existsSync(a.path), false);
  writeFileSync(a.path, "garbage\n");
  const c = acquireConsoleLock({ logsDir, pid: 333, alive: () => true });
  assert.equal(typeof c.release, "function", "an unreadable pid is stale");
  c.release();
});

test("serve copies each audit row it writes to the Valkey list after the file holds it, and a Valkey that fails costs only the copy", async (t) => {
  const dep = deployment();
  let stop;
  const until = new Promise((resolve) => (stop = resolve));
  t.after(() => stop());
  let listening;
  const up = new Promise((resolve) => (listening = resolve));
  const modules = fakeModules();
  const pushed = [];
  let disconnected = false;
  const mirrorCalls = [];
  modules.connection = {
    makeRedisClient: (url, opts) => {
      assert.equal(opts.failFast, true, "a down Valkey must fail fast, never queue rows in memory");
      return { on() {}, disconnect: () => (disconnected = true) };
    },
  };
  modules.audit.mirrorRow = async (redis, row) => {
    mirrorCalls.push(row);
    assert.ok(modules.rows.includes(row), "the file held the row before the copy was pushed");
    pushed.push(row.action);
    return false; // a failing Valkey: the copy is lost, nothing else
  };
  const err = [];
  const running = runCli(["serve", "--deployment", dep.dir], { env: dep.env, modules, now: () => T0, uid: process.geteuid?.(), out: () => {}, err: (l) => err.push(l), until, onListening: listening });
  // A serve that refuses to start resolves `running` and never `up`: say so instead of leaving the test pending.
  const server = await Promise.race([up, running.then((code) => assert.fail(`serve exited ${code} before listening: ${err.join(" ")}`))]);
  const port = server.address().port;
  const refused = await new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path: "/login", method: "POST", headers: { host: "evil.test" }, setHost: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    }).on("error", reject).end("{}");
  });
  assert.equal(refused, 421);
  assert.deepEqual(pushed, ["serve-started", "refused"], "the start and the refused write were both copied");
  stop();
  assert.equal(await running, 0);
  assert.equal(disconnected, true, "the Valkey client is closed on stop");
});

test("serve refuses to start, exit 2, when its start cannot be audited, and releases the lock it took", async () => {
  const dep = deployment();
  const res = await cli(["serve"], { dir: dep.dir, env: dep.env, modules: fakeModules({ auditFails: true }), until: Promise.resolve() });
  assert.equal(res.code, 2);
  assert.match(res.err.join("\n"), /audit log cannot be written .*ENOSPC/);
  assert.equal(existsSync(consoleLockPath(join(dep.dir, "logs"))), false, "the lock is released");
});
