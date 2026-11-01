import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { basename, join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { AUDIT_VERIFY_CACHE_MS, cachedFor, cachedPerWindow, deploymentOf, endpointSnapshotFn, INSIGHTS_CACHE_MS, loadModules, makeSetupExposureReader, readSideOf, RESERVE_ENV_KEYS, runCli, setupProviderOf, USAGE } from "../src/console/cli.mjs";
import * as live from "../src/console/live.mjs";
import { acquireConsoleLock, consoleLockPath } from "../src/console/lock.mjs";
import * as realPages from "../src/console/pages.mjs";
import * as server from "../src/console/server.mjs";
import { readTriggerEditor, configLocationsOf, panelEnv, PANEL_SERVICE_KEYS } from "../src/read-model.mjs";
import * as realWhatif from "../src/console/whatif.mjs";

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
  // The #641 read side, faked: one fleet reader the serve tests can watch being built and disposed.
  const fleet = {
    built: [],
    disposed: 0,
    snapshots: 0,
    // What each snapshot was asked for (issue #737: the waiting jobs are asked per call), null for nothing.
    asked: [],
    async snapshot(opts) {
      fleet.snapshots += 1;
      fleet.asked.push(opts ?? null);
      return { queue: { pausedState: false, pausedPartial: false, counts: { waiting: 2, active: 1 } }, failed: { rows: [{ jobId: "j1", queue: "pi", attemptsMade: 1, endedAt: 1, failedReason: "boom" }], more: 0 } };
    },
    async dispose() {
      fleet.disposed += 1;
    },
  };
  const pageDepsSeen = [];
  const insightCalls = [];
  return {
    rows,
    calls,
    fleet,
    pageDepsSeen,
    insightCalls,
    server,
    live,
    pages: {
      ...realPages,
      loadPageData: async (name, query, deps) => (pageDepsSeen.push(deps), { snap: await deps.fleet.snapshot() }),
      pagePanels: async (name, ctx) => [{ id: "p-main", html: `<p>${name} ${ctx.session.role}</p>` }],
      renderPage: async (name) => ({ status: 200, html: `<!doctype html><title>${name}</title>` }),
    },
    insights: { assembleInsights: async (paths, window, opts) => (insightCalls.push({ paths, window, opts }), { window }) },
    pricing: { listPricedModels() {}, getPricedModel() {}, isZeroRated() {}, reprice() {}, piAiVersion() {}, other() {} },
    connection: { useValkeyContext: (fn) => calls.push(["valkey-context", typeof fn, fn]) },
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
      // The store's whole surface as the server and the hub call it (issue #737 adds the verdict, the reason a session
      // ended, and the one-shot flash), each a no-op: these tests pin the command, not the store.
      makeSessionStore: () => ({ create: () => ({ id: "s".repeat(43) }), get: () => null, peek: () => null, verdict: () => ({ ended: null }), endedOf: () => null, destroy(id, reason = null) {}, setFlash() {}, takeFlash: () => null }),
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
    confirm: { makeConfirmTickets: () => ({ issue: () => ({ ticket: "t", expiresAt: T0 + 300_000 }), redeem: () => ({ refusal: "no" }) }) },
    readModel: {
      configLocationsOf,
      readTriggerEditor,
      writePauseWindows: () => ({ ok: true }),
      panelEnv: ({ env }) => ({ env: { ...env }, dir: null, notice: undefined }),
      panelValkeyContext: (args) => (calls.push(["panel-context", args.pointerDir]), {}),
      resolvePaths: (env) => ({ valkeyUrl: env.VALKEY_URL ?? "redis://127.0.0.1:6379", logsDir: env.PI_LOGS_DIR ?? "./logs", triggersPath: env.PI_TRIGGERS_FILE ?? "./triggers.json", subscriptionsPath: "./subscriptions.json" }),
      createFleetReader: (paths, seams) => (fleet.built.push({ paths, seams }), fleet),
      readSubscriptions: (args) => (calls.push(["subscriptions", args.subscriptionsPath]), { version: 1, subscriptions: [] }),
      scanRunRecords: (args) => (calls.push(["scan", args.logsDir, args.sinceMs]), []),
    },
    whatif: realWhatif,
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

test("link --port prints the link for the tunnel's local port on localhost, over tcp or a unix socket; a bad port mints nothing", async () => {
  for (const listen of ["127.0.0.1:4790", "unix:/tmp/pd.sock"]) {
    const r = await cli(["link", "--name", "alice", "--port", "8080"], { env: deployment({ PI_CONSOLE_LISTEN: listen }).env });
    assert.equal(r.code, 0, listen);
    assert.deepEqual(r.out, [`http://localhost:8080/login/code#${CODE}`], listen);
  }
  assert.deepEqual((await cli(["link", "--name", "alice", "--port", "1"])).out, [`http://localhost:1/login/code#${CODE}`]);
  assert.deepEqual((await cli(["link", "--name", "alice", "--port", "65535"])).out, [`http://localhost:65535/login/code#${CODE}`]);
  assert.deepEqual((await cli(["link", "--name", "alice", "--port", "0080"])).out, [`http://localhost:80/login/code#${CODE}`], "the number, not the digits typed");
  for (const bad of ["0", "65536", "99999", "123456", "abc", "80a", " 80", "-1", "8.0", "", "0x50"]) {
    // `--port=<v>`, so a value that starts with a dash reaches the rule rather than the parser's own refusal.
    const r = await cli(["link", "--name", "alice", `--port=${bad}`]);
    assert.equal(r.code, 2, JSON.stringify(bad));
    assert.deepEqual(r.out, [], JSON.stringify(bad));
    assert.ok(r.err.includes("pi-dispatch-console: --port must be a port number (1 to 65535): the local port of your ssh -L tunnel"), `${JSON.stringify(bad)}: ${r.err.join(" | ")}`);
    assert.equal(r.modules.calls.filter((c) => c[0] === "mint").length, 0, `${JSON.stringify(bad)}: no code minted`);
    assert.deepEqual(r.modules.rows, [], `${JSON.stringify(bad)}: nothing audited`);
  }
  // --port with no value is the parser's refusal.
  assert.equal((await cli(["link", "--name", "alice", "--port"])).code, 2);
});

test("--port on any command but link is refused before anything runs: it would be ignored, so it is said", async () => {
  for (const argv of [["serve"], ["token", "add", "--name", "a", "--role", "viewer"], ["token", "list"], ["token", "revoke", "--name", "alice"], ["token", "rotate", "--name", "alice"], ["sessions", "end-all"], ["audit", "verify"]]) {
    const r = await cli([...argv, "--port", "8080"], { until: Promise.resolve() });
    assert.equal(r.code, 2, argv.join(" "));
    assert.deepEqual(r.err, ["pi-dispatch-console: --port is for link only"], argv.join(" "));
    assert.deepEqual([r.out, r.modules.calls, r.modules.rows], [[], [], []], `${argv.join(" ")}: nothing ran`);
  }
  assert.match(USAGE, /^  link --name <name> \[--port <n>\] \[--next \/setup\] {2}a one-time sign-in link, valid 60 seconds$/m);
});

test("audit verify: intact is 0, a broken chain is 2 naming where", async () => {
  const ok = await cli(["audit", "verify"], { modules: fakeModules({ verify: { ok: true, rows: 3, startsAt: { file: "2026-09.jsonl", seq: 40 } } }) });
  assert.equal(ok.code, 0);
  assert.match(ok.out[0], /3 rows.*intact.*starts at 2026-09.jsonl row 40/);
  // A line whose prev matched the row before it and whose seq does not follow: the line is damaged alone.
  const broken = await cli(["audit", "verify"], { modules: fakeModules({ verify: { ok: false, rows: 7, broken: { file: "2026-10.jsonl", line: 8, reason: "seq 9 follows seq 7" }, last: { file: "2026-10.jsonl", line: 7, seq: 7 }, suspect: null, files: [] } }) });
  assert.equal(broken.code, 2);
  assert.deepEqual(broken.err, ["pi-dispatch-console: the console audit log's chain breaks at 2026-10.jsonl line 8: seq 9 follows seq 7. Rows through row 7 are intact; keep the file for inspection"]);
});

test("audit verify on a broken prev vouches for neither end of the link: the rows before the row before it are intact", async () => {
  // A real log, row 5's outcome edited: row 6's prev no longer matches. Row 5 was read before the break, but the chain
  // cannot tell whether it or line 6 changed, so the sentence vouches for rows through 4 and names both ends. The first
  // version said "Rows before it (5) are intact", vouching for the edited row.
  const { makeConsoleAudit, verifyConsoleAudit } = await import("@edgehero/pi-dispatch/console-audit");
  const dep = deployment();
  const logsDir = join(dep.dir, "logs");
  for (let i = 1; i <= 7; i++) makeConsoleAudit({ logsDir, now: () => T0 + i * 60_000, alive: () => true }).append({ actor: { name: "ops", role: "operator", session: null }, action: "login", outcome: "ok" });
  const file = join(logsDir, "console-audit", "2026-10.jsonl");
  writeFileSync(file, readFileSync(file, "utf8").replace(/^(.*"seq":5,.*)"outcome":"ok"/m, '$1"outcome":"refused"'));
  const seen = [];
  const modules = fakeModules();
  modules.audit.verifyConsoleAudit = (args) => (seen.push(args.withLast), verifyConsoleAudit(args));
  const r = await cli(["audit", "verify"], { modules, dir: dep.dir, env: { ...dep.env, PI_LOGS_DIR: logsDir } });
  assert.equal(r.code, 2);
  assert.deepEqual(seen, [true], "asks the verifier for the ends of the link");
  assert.deepEqual(r.err, ["pi-dispatch-console: the console audit log's chain breaks at 2026-10.jsonl line 6: prev does not match the row before it (seq 5): a row was changed, removed or moved. Row 5 before it (2026-10.jsonl line 5) is not vouched for either: the link between the two does not hold, so the chain cannot tell whether row 5 was changed. Rows through row 4 are intact; keep the file for inspection"]);
  assert.deepEqual(verifyConsoleAudit({ logsDir }), { ok: false, rows: 5, broken: { file: "2026-10.jsonl", line: 6, reason: "prev does not match the row before it (seq 5): a row was changed, removed or moved" } }, "the verifier's own result, without withLast, is as it was");
  // The link's other end is the first row: nothing is vouched for. A directory that cannot be read is no line.
  const first = await cli(["audit", "verify"], { modules: fakeModules({ verify: { ok: false, rows: 1, broken: { file: "2026-10.jsonl", line: 2, reason: "prev does not match the row before it (seq 1): a row was changed, removed or moved" }, last: null, suspect: { file: "2026-10.jsonl", line: 1, seq: 1 }, files: [] } }) });
  assert.match(first.err.join("\n"), /Row 1 before it \(2026-10\.jsonl line 1\) is not vouched for either: the link between the two does not hold, so the chain cannot tell whether row 1 was changed\. No row before it is vouched for; keep the file for inspection$/);
  const dir = await cli(["audit", "verify"], { modules: fakeModules({ verify: { ok: false, rows: 0, broken: { file: null, line: 0, reason: "the audit directory /x/console-audit cannot be read (EACCES)" }, last: null, suspect: null, files: [] } }) });
  assert.deepEqual(dir.err, ["pi-dispatch-console: the console audit log cannot be checked: the audit directory /x/console-audit cannot be read (EACCES)"]);
});

test("audit verify: an edited row followed by a garbled line is not vouched for, whatever the garbled line says", async () => {
  // A real log, row 5's outcome edited and line 6 cut short. Line 6 shows no prev at all, so nothing vouches for row 5:
  // the sentence names it and counts only rows through 4 as intact.
  const { makeConsoleAudit, verifyConsoleAudit } = await import("@edgehero/pi-dispatch/console-audit");
  const dep = deployment();
  const logsDir = join(dep.dir, "logs");
  for (let i = 1; i <= 7; i++) makeConsoleAudit({ logsDir, now: () => T0 + i * 60_000, alive: () => true }).append({ actor: { name: "ops", role: "operator", session: null }, action: "login", outcome: "ok" });
  const file = join(logsDir, "console-audit", "2026-10.jsonl");
  const modules = fakeModules();
  modules.audit.verifyConsoleAudit = verifyConsoleAudit;
  const lines = readFileSync(file, "utf8").split("\n");
  lines[4] = lines[4].replace('"outcome":"ok"', '"outcome":"refused"');
  lines[5] = lines[5].slice(0, 30);
  writeFileSync(file, lines.join("\n"));
  const r = await cli(["audit", "verify"], { modules, dir: dep.dir, env: { ...dep.env, PI_LOGS_DIR: logsDir } });
  assert.equal(r.code, 2);
  assert.deepEqual(r.err, ["pi-dispatch-console: the console audit log's chain breaks at 2026-10.jsonl line 6: the line is not a JSON row (damaged, or written by something else). Row 5 before it (2026-10.jsonl line 5) is not vouched for either: the link between the two does not hold, so the chain cannot tell whether row 5 was changed. Rows through row 4 are intact; keep the file for inspection"]);
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
  assert.equal(out[2], "sign in: paste a token (pi-dispatch-console token add --name <you> --role operator makes one), or open a one-time link: pi-dispatch-console link --name <you>", "how to get in, never a token");
  assert.equal(out.length, 3);
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

// ---- issue #641: the read side, the hub and the pages wired by serve ----

/** One raw request; resolves `{status, headers, text}`. */
function http(port, { method = "GET", path, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers }, setHost: false }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(body ?? undefined);
  });
}

test("serve wires one fleet reader on the deployment, answers /api/state and a live stream, and disposes reader, hub and context on stop", async (t) => {
  const dep = deployment();
  let stop;
  const until = new Promise((resolve) => (stop = resolve));
  t.after(() => stop());
  let listening;
  const up = new Promise((resolve) => (listening = resolve));
  const modules = fakeModules();
  modules.sessions = await import("../src/console/sessions.mjs");
  modules.tokens.findToken = (f, presented) => (presented === TOKEN ? f.tokens[0] : null);
  const auditReads = [];
  modules.audit.readConsoleAudit = (args) => (auditReads.push(args), { rows: [], next: null });
  const verifies = [];
  modules.audit.verifyConsoleAudit = (args) => (verifies.push(args), { ok: true, rows: 0, startsAt: null, last: null });
  const err = [];
  let clock = T0;
  const running = runCli(["serve", "--deployment", dep.dir], { env: dep.env, modules, now: () => clock, uid: process.geteuid?.(), out: () => {}, err: (l) => err.push(l), until, onListening: listening });
  const srv = await Promise.race([up, running.then((code) => assert.fail(`serve exited ${code} before listening: ${err.join(" ")}`))]);
  const port = srv.address().port;

  assert.equal(modules.fleet.built.length, 1, "one reader for the whole serve");
  const { paths, seams } = modules.fleet.built[0];
  assert.equal(paths.logsDir, join(dep.dir, "logs"));
  assert.equal(paths.triggersPath, join(dep.dir, "triggers.json"), "a relative default is the deployment folder's, not the shell's cwd");
  assert.equal(typeof seams.dollarEnvFn, "function");
  assert.equal(seams.readOnly, true, "the console's reader is read-only");
  assert.equal(seams.activeLimit, 50, "the console reads at most 50 active jobs per snapshot");
  // Issue #737: the waiting jobs are not the reader's to read on every snapshot: the overview's load asks for them.
  assert.equal(Object.hasOwn(seams, "waiting"), false, "the reader is not built to read the waiting jobs");
  const installed = modules.calls.filter((c) => c[0] === "valkey-context");
  assert.deepEqual(installed.map((c) => c[1]), ["function"]);
  assert.equal(modules.calls.some((c) => c[0] === "panel-context"), false, "the context is read per client, not at install");
  installed[0][2]();
  assert.deepEqual(modules.calls.find((c) => c[0] === "panel-context"), ["panel-context", dep.dir], "from THIS deployment's .env, not the pointer's");

  const login = await http(port, { method: "POST", path: "/login", headers: { origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN }) });
  assert.equal(login.status, 200, login.text);
  const cookie = login.headers["set-cookie"][0].split(";")[0];

  const askedBefore = modules.fleet.asked.length;
  const state = await http(port, { path: "/api/state", headers: { cookie } });
  assert.equal(state.status, 200);
  const body = JSON.parse(state.text);
  assert.equal(body.counts.waiting, 2);
  assert.equal(body.failed.rows[0].failedReason, "boom", "alice is an operator");
  assert.deepEqual(modules.fleet.asked.slice(askedBefore), [null], "/api/state reads one snapshot and asks it for no waiting job");

  // The page deps the CLI built: the reader, a 30 s insights cache over the real assembler's call shape, the audit read.
  const page = await http(port, { path: "/fleet", headers: { cookie } });
  assert.equal(page.status, 200);
  const deps = modules.pageDepsSeen.at(-1);
  assert.equal(deps.fleet, modules.fleet);
  // The deployment the first run names (issue #737): its last folder alone, never the path.
  assert.deepEqual(deps.deployment, { folder: basename(dep.dir) });
  assert.deepEqual(deploymentOf("/srv/pi-dispatch/acme-prod"), { folder: "acme-prod" }, "the last folder, none of the path before it");
  // Over the deps serve built, pages.mjs's own load asks the reader for the waiting jobs on the overview alone.
  for (const name of ["overview", "fleet", "parked", "config"]) {
    const from = modules.fleet.asked.length;
    await realPages.loadPageData(name, {}, deps);
    assert.deepEqual(modules.fleet.asked.slice(from), [["overview", "fleet"].includes(name) ? { waiting: true } : null], name);
  }
  await deps.insights("7d");
  await deps.insights("7d");
  await deps.insights("30d");
  assert.deepEqual(modules.insightCalls.map((c) => c.window), ["7d", "30d"], "one assembly per window inside the cache");
  assert.deepEqual(Object.keys(modules.insightCalls[0].opts.pricing).sort(), ["getPricedModel", "isZeroRated", "listPricedModels", "piAiVersion", "reprice"]);
  assert.equal(modules.insightCalls[0].paths, paths);
  assert.equal(modules.insightCalls[0].opts.fullPaths, undefined, "a names-only assembly asks for no host path");
  // An operator's paths=full is its own entry: a full-path assembly is never handed to a names-only request.
  await deps.insights("7d", { fullPaths: true });
  await deps.insights("7d", { fullPaths: true });
  await deps.insights("7d");
  assert.deepEqual(modules.insightCalls.map((c) => [c.window, c.opts.fullPaths === true]), [["7d", false], ["30d", false], ["7d", true]]);
  // The what-if (REQ-COST-ANALYTICS): the reader over this deployment's logs at the scan's own 92-day ceiling (no
  // display window), and the priced catalog for the form, both wired.
  assert.equal(typeof deps.whatIf, "function");
  assert.deepEqual(deps.pricedModels(), [], "the fake façade lists nothing");
  const answer = await deps.whatIf({ model: "acme/m-1", flow: "tidy" });
  assert.equal(answer.result.class, "seeded", "no ledgered run in an empty scan: the seeded band");
  assert.deepEqual(modules.calls.filter((c) => c[0] === "scan"), [["scan", paths.logsDir, undefined]], "one scan, at the scan's own ceiling");
  // The reader keeps its scan on serve's clock, not the wall clock: past the TTL on the injected clock it scans again.
  await deps.whatIf({ model: "acme/m-1", flow: "tidy" });
  assert.equal(modules.calls.filter((c) => c[0] === "scan").length, 1, "within the TTL, the held scan and answer");
  clock += realWhatif.WHATIF_LIMITS.ttlMs;
  await deps.whatIf({ model: "acme/m-1", flow: "tidy" });
  assert.equal(modules.calls.filter((c) => c[0] === "scan").length, 2, "past it on the injected clock, a new scan");
  await deps.audit({ limit: 5, before: null });
  await deps.audit({ limit: 50, before: "2026-10:7", positions: true });
  assert.deepEqual(auditReads.map((a) => [a.logsDir, a.limit, a.before, a.positions]), [[join(dep.dir, "logs"), 5, null, false], [join(dep.dir, "logs"), 50, "2026-10:7", true]], "positions only when the page asks");
  // The chain verification (issue #737): one walk per 30 s on serve's clock, asking for its last good row, and stamped
  // with when it ran (`checkedAt`, serve's clock), which the audit page's About card shows: a cached answer is that old.
  const walked = clock;
  assert.deepEqual(await deps.auditVerify(), { ok: true, rows: 0, startsAt: null, last: null, checkedAt: walked });
  clock += 1000;
  assert.equal((await deps.auditVerify()).checkedAt, walked, "a cached answer keeps the time of its walk");
  assert.equal(verifies.length, 1, "inside the cache: one walk");
  assert.deepEqual([verifies[0].logsDir, verifies[0].withLast], [join(dep.dir, "logs"), true]);
  clock += AUDIT_VERIFY_CACHE_MS;
  assert.equal((await deps.auditVerify()).checkedAt, clock, "a new walk, a new time");
  assert.equal(verifies.length, 2, "past it on the injected clock, a new walk");
  assert.deepEqual(deps.subscriptions(), { version: 1, subscriptions: [] });
  assert.deepEqual(modules.calls.find((c) => c[0] === "subscriptions"), ["subscriptions", join(dep.dir, "subscriptions.json")]);

  // A live stream: its first panel arrives, and stopping serve ends it rather than holding the close open.
  const streamEnded = new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/events?page=overview", headers: { host: `127.0.0.1:${port}`, cookie }, setHost: false }, (res) => {
      assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
      let text = "";
      res.on("data", (c) => {
        text += c;
        if (text.includes("event: panel")) stop();
      });
      res.on("end", () => resolve(text));
      res.on("error", () => resolve(text));
    });
    req.on("error", reject);
    req.end();
  });
  const text = await streamEnded;
  assert.match(text, /event: panel\ndata: \{"id":"p-main","html":"<p>overview operator<\/p>"\}/);
  assert.match(text, /event: end\ndata: \{"ended":"shutdown"\}\n\n$/, "the hub said goodbye on stop: the console stopping, not a sign-out");
  assert.equal(await running, 0);
  assert.equal(modules.fleet.disposed, 1, "the reader is disposed on stop");
  assert.deepEqual(modules.calls.filter((c) => c[0] === "valkey-context").at(-1).slice(0, 2), ["valkey-context", "object"], "the context is put back");
});

test("serve wires the hub's endedReason to the store's pure verdict, and a unix socket's sign-in hint asks for the tunnel's port", { skip: process.platform === "win32" ? "unix sockets" : false }, async (t) => {
  const dep = deployment();
  const sockDir = join(tempDir("pdc-"), "s");
  mkdirSync(sockDir);
  chmodSync(sockDir, 0o700);
  let stop;
  const until = new Promise((resolve) => (stop = resolve));
  t.after(() => stop());
  let listening;
  const up = new Promise((resolve) => (listening = resolve));
  const modules = fakeModules();
  let hubOpts = null;
  modules.live = { ...live, makeLiveHub: (opts) => ((hubOpts = opts), live.makeLiveHub(opts)) };
  const verdicts = [];
  const answers = { a: { ended: "revoked" }, b: { session: { id: "b" } }, c: { unjudged: true }, d: { ended: null } };
  modules.sessions = { ...modules.sessions, makeSessionStore: () => ({ ...fakeModules().sessions.makeSessionStore(), verdict: (id, file) => (verdicts.push([id, file]), answers[id]), get: () => assert.fail("the hub never calls get"), destroy: () => assert.fail("nor destroy") }) };
  const out = [];
  const err = [];
  const running = runCli(["serve", "--deployment", dep.dir], { env: { ...dep.env, PI_CONSOLE_LISTEN: `unix:${join(sockDir, "c.sock")}` }, modules, now: () => T0, uid: process.geteuid?.(), out: (l) => out.push(l), err: (l) => err.push(l), until, onListening: listening });
  await Promise.race([up, running.then((code) => assert.fail(`serve exited ${code} before listening: ${err.join(" ")}`))]);
  const file = { version: 1, generation: 0, tokens: [] };
  assert.deepEqual(["a", "b", "c", "d"].map((id) => hubOpts.endedReason(id, file)), ["revoked", null, null, null]);
  assert.deepEqual(verdicts.map(([id, f]) => [id, f === file]), [["a", true], ["b", true], ["c", true], ["d", true]]);
  assert.equal(out[2], "sign in: paste a token (pi-dispatch-console token add --name <you> --role operator makes one), or open a one-time link: pi-dispatch-console link --name <you> --port <your tunnel's local port>");
  assert.equal(out.length, 3);
  stop();
  assert.equal(await running, 0);
});

test("serve shares one page load across the queries pages.mjs's dataQueryOf says draw from the same data (issue #737); a pages module without it loads per query", async (t) => {
  const QUERIES = [{ rows: "host", zoom: "24h" }, { rows: "project", zoom: "1h" }];
  const nullRes = () => ({ writableLength: 0, write: () => true, end() {}, destroy() {} });
  // One serve on its own deployment, its hub driven by hand: two overview streams of one operator, two queries.
  async function loadsOf(pages) {
    const dep = deployment();
    let stop;
    const until = new Promise((resolve) => (stop = resolve));
    t.after(() => stop());
    let listening;
    const up = new Promise((resolve) => (listening = resolve));
    const modules = fakeModules();
    const loads = [];
    modules.pages = { ...pages, loadPageData: async (name, query) => (loads.push([name, query]), {}), pagePanels: async () => [{ id: "p-main", html: "<p>x</p>" }] };
    modules.sessions = { ...modules.sessions, makeSessionStore: () => ({ ...fakeModules().sessions.makeSessionStore(), peek: (id) => ({ id }) }) };
    let hub = null;
    let hubOpts = null;
    modules.live = { ...live, makeLiveHub: (opts) => ((hubOpts = opts), (hub = live.makeLiveHub(opts))) };
    const err = [];
    const running = runCli(["serve", "--deployment", dep.dir], { env: dep.env, modules, now: () => T0, uid: process.geteuid?.(), out: () => {}, err: (l) => err.push(l), until, onListening: listening });
    await Promise.race([up, running.then((code) => assert.fail(`serve exited ${code} before listening: ${err.join(" ")}`))]);
    for (const [i, query] of QUERIES.entries()) hub.subscribe({ res: nullRes(), sessionId: `s${i}`, session: { name: "alice", role: "operator" }, page: "overview", query });
    await hub.tick();
    loads.length = 0;
    await hub.tick();
    stop();
    assert.equal(await running, 0);
    return { loads, hubOpts };
  }
  const asked = [];
  const withIt = await loadsOf({ ...realPages, dataQueryOf: (name, query) => (asked.push([name, query]), name === "overview" ? {} : query) });
  assert.deepEqual(withIt.loads, [["overview", {}]], "one load for both queries, asked with the data's query");
  assert.ok(asked.some(([name, query]) => name === "overview" && query === QUERIES[0]) && asked.some(([, query]) => query === QUERIES[1]), "pages.mjs's own dataQueryOf, asked of each stream's query");
  assert.equal(withIt.hubOpts.dataKeyOf, undefined, "the hub keys the load by queryKeyOf over the data's query");
  const without = Object.fromEntries(Object.entries(realPages).filter(([name]) => name !== "dataQueryOf"));
  const before = await loadsOf(without);
  assert.equal(Object.hasOwn(before.hubOpts, "dataQueryOf"), false, "without it the hub keeps its default");
  assert.ok(before.loads.length >= 1 && before.loads.every(([name, query]) => name === "overview" && QUERIES.includes(query)), "each load asked with a stream's whole query, as before");
});

test("cachedFor: one call within the TTL on the injected clock, a new one after, a rejection not kept, a clock gone backwards a miss", async () => {
  assert.equal(AUDIT_VERIFY_CACHE_MS, 30_000);
  let t = T0;
  let calls = 0;
  let fail = false;
  const cached = cachedFor(async () => {
    calls += 1;
    if (fail) throw new Error("EACCES");
    return calls;
  }, { now: () => t, ttlMs: 1000 });
  assert.equal(await cached(), 1);
  t += 999;
  assert.equal(await cached(), 1);
  t += 1;
  assert.equal(await cached(), 2);
  t -= 5000;
  assert.equal(await cached(), 3, "an entry from the future is not trusted");
  fail = true;
  t += 10_000;
  await assert.rejects(cached(), /EACCES/);
  fail = false;
  assert.equal(await cached(), 5, "a failure is tried again at once, not served for the TTL");
  // A synchronous throw is a rejection too, not a throw at the caller.
  const sync = cachedFor(() => {
    throw new Error("sync");
  }, { now: () => t, ttlMs: 1000 });
  await assert.rejects(sync(), /sync/);
});

test("cachedPerWindow: one call per window within the TTL on the injected clock, a new one after, and a rejection is not kept", async () => {
  let t = T0;
  const seen = [];
  let fail = true;
  const cached = cachedPerWindow(async (w) => {
    seen.push(w);
    if (w === "bad" && fail) throw new Error("x");
    return `v-${w}-${seen.length}`;
  }, { now: () => t });
  assert.equal(await cached("7d"), "v-7d-1");
  t += INSIGHTS_CACHE_MS - 1;
  assert.equal(await cached("7d"), "v-7d-1");
  t += 1;
  assert.equal(await cached("7d"), "v-7d-2");
  await assert.rejects(cached("bad"));
  fail = false;
  assert.equal(await cached("bad"), "v-bad-4", "a failed assembly is tried again, not served for 30 s");
  // Only fullPaths: true is the full-path entry; false or any other value is the names entry, asked with no option.
  const optsSeen = [];
  const names = cachedPerWindow(async (w, o) => (optsSeen.push(o), w), { now: () => t });
  await names("7d");
  await names("7d", { fullPaths: false });
  await names("7d", { fullPaths: "yes" });
  assert.deepEqual(optsSeen, [undefined], "one names-only assembly, asked for no host path");
  await names("7d", { fullPaths: true });
  assert.deepEqual(optsSeen, [undefined, { fullPaths: true }]);
});

test("readSideOf: the deployment .env fills the read side's keys, relative paths are the deployment folder's, PI_SESSIONS_DIR turns on sessionsDir", async () => {
  const [readModel, serviceEnv, forges] = await Promise.all([import("../src/read-model.mjs"), import("@edgehero/pi-dispatch/service-env"), import("@edgehero/pi-dispatch/forges")]);
  const m = { readModel, serviceEnv, forges };
  const dir = tempDir("console-side-");
  writeFileSync(join(dir, ".env"), "PI_LOGS_DIR=runlogs\nPI_SESSIONS_DIR=sess\nGITLAB_HOST=https://gl.example.test\nFORGEJO_URL=https://code.example.test\nAZURE_ORG_URL=https://dev.azure.com/acme\n", { mode: 0o600 });
  const side = readSideOf({ m, env: { HOME: dir }, dir, fs: await import("node:fs"), platform: process.platform, uid: process.geteuid?.() });
  assert.equal(side.notice, undefined, String(side.notice));
  assert.equal(side.paths.logsDir, join(dir, "runlogs"));
  assert.equal(side.paths.sessionsDir, join(dir, "sess"));
  assert.equal(side.paths.triggersPath, join(dir, "triggers.json"));
  assert.equal(side.env.GITLAB_HOST, "https://gl.example.test", "forge host variables reach forgeLinkOf");
  // and the names a deployment .env actually sets for its forges, which forgeLinkOf reads first
  assert.equal(side.env.FORGEJO_URL, "https://code.example.test");
  assert.equal(side.env.AZURE_ORG_URL, "https://dev.azure.com/acme");
  assert.equal(readModel.forgeLinkOf({ kind: "forgejo", target: "acme/web#7" }, side.env), "https://code.example.test/acme/web/issues/7");
  const bare = tempDir("console-side-");
  const none = readSideOf({ m, env: { HOME: bare }, dir: bare, fs: await import("node:fs"), platform: process.platform, uid: process.geteuid?.() });
  assert.equal(none.paths.sessionsDir, undefined, "no PI_SESSIONS_DIR, no chain counts");
});

test("readSideOf: this shell's environment outranks the deployment .env (panelEnv's rule), the .env fills the rest, and a panel key they disagree on is named, never valued", async () => {
  const [readModel, serviceEnv, forges] = await Promise.all([import("../src/read-model.mjs"), import("@edgehero/pi-dispatch/service-env"), import("@edgehero/pi-dispatch/forges")]);
  const m = { readModel, serviceEnv, forges };
  const dir = tempDir("console-side-");
  writeFileSync(join(dir, ".env"), "PI_LOGS_DIR=file-logs\nPI_TRIGGERS_FILE=file-triggers.json\nPI_SESSIONS_DIR=file-sess\nFORGEJO_URL=https://file.example.test\n", { mode: 0o600 });
  const shell = { HOME: dir, PI_LOGS_DIR: "/shell/logs", PI_SESSIONS_DIR: "/shell/sess", FORGEJO_URL: "https://shell.example.test" };
  const side = readSideOf({ m, env: shell, dir, fs: await import("node:fs"), platform: process.platform, uid: process.geteuid?.() });
  assert.equal(side.paths.logsDir, "/shell/logs", "the shell's panel key wins");
  assert.equal(side.paths.sessionsDir, "/shell/sess", "and so does its PI_SESSIONS_DIR");
  assert.equal(side.env.FORGEJO_URL, "https://shell.example.test", "and its forge host");
  assert.equal(side.paths.triggersPath, join(dir, "file-triggers.json"), "the .env fills what the shell leaves unset");
  assert.match(String(side.notice), /PI_LOGS_DIR/, "the disagreement is said by name");
  assert.ok(!String(side.notice).includes("/shell/logs") && !String(side.notice).includes("file-logs"), "never by value");
});

test("readSideOf: the keys a reserve estimate reads (PI_ALLOWED_MODELS, PI_MODEL_ENDPOINTS_FILE, ...) come from the deployment .env as the worker reads them", async () => {
  const [readModel, serviceEnv, forges] = await Promise.all([import("../src/read-model.mjs"), import("@edgehero/pi-dispatch/service-env"), import("@edgehero/pi-dispatch/forges")]);
  const dir = tempDir("console-side-");
  writeFileSync(join(dir, ".env"), "PI_ALLOWED_MODELS=ollama/qwen3\nPI_MODEL_ENDPOINTS_FILE=eps.json\nPI_PROVIDER=ollama\nPI_MODEL=qwen3\n", { mode: 0o600 });
  const side = readSideOf({ m: { readModel, serviceEnv, forges }, env: { HOME: dir }, dir, fs: await import("node:fs"), platform: process.platform, uid: process.geteuid?.() });
  for (const [k, v] of Object.entries({ PI_ALLOWED_MODELS: "ollama/qwen3", PI_MODEL_ENDPOINTS_FILE: "eps.json", PI_PROVIDER: "ollama", PI_MODEL: "qwen3" })) assert.equal(side.env[k], v, k);
  assert.ok(RESERVE_ENV_KEYS.includes("PI_MAX_COST_USD"));
});

test("endpointSnapshotFn: the worker's endpoint snapshot, so a job that can only call a declared, free local model previews $0, and the full cap without one", async () => {
  const m = await loadModules();
  assert.equal(typeof m.modelEndpoints.loadModelEndpoints, "function", "loadModules loads the worker's endpoint loader");
  assert.equal(typeof m.modelCatalog.builtinModel, "function", "and the builtin catalog's cost lookup");
  const fs = await import("node:fs");
  const { estimateReserve } = await import("@edgehero/pi-dispatch/reserve-estimate");
  const dir = tempDir("console-eps-");
  const overlay = join(dir, "overlay");
  mkdirSync(overlay);
  writeFileSync(join(overlay, "models.json"), JSON.stringify({ providers: { ollama: { baseUrl: "http://host.docker.internal:11434/v1", api: "openai-completions", models: [{ id: "qwen3" }] } } }));
  const paths = { valkeyUrl: "redis://127.0.0.1:6379/0", globalPiDir: overlay };
  const job = { kind: "github", provider: "ollama", model: "qwen3", maxCostUsd: "1.5" };
  const none = endpointSnapshotFn({ m, env: {}, paths, dir, fs })();
  assert.deepEqual(none, { endpoints: [], models: null }, "no declaration: no endpoint, and the overlay is not even read (the worker's rule)");
  assert.equal(estimateReserve(job, { modelEndpoints: none }).dollarsMicros, 1_500_000, "not declared local: the full cap");
  writeFileSync(join(dir, "model-endpoints.json"), JSON.stringify({ version: 1, endpoints: [{ id: "ollama", host: "host.docker.internal", port: 11434, slots: 2 }] }));
  const snap = endpointSnapshotFn({ m, env: {}, paths, dir, fs })();
  assert.equal(snap.endpoints.length, 1);
  assert.deepEqual(estimateReserve(job, { modelEndpoints: snap, builtinModel: m.modelCatalog.builtinModel }), { slots: 1, dollarsMicros: 0, capMicros: 1_500_000, zeroRated: true });
  // PI_MODEL_ENDPOINTS_FILE names another file, relative to the deployment folder, as the worker resolves it.
  writeFileSync(join(dir, "eps.json"), JSON.stringify({ version: 1, endpoints: [] }));
  assert.deepEqual(endpointSnapshotFn({ m, env: { PI_MODEL_ENDPOINTS_FILE: "eps.json" }, paths, dir, fs })().endpoints, []);
  assert.equal(endpointSnapshotFn({ m: {}, env: {}, paths, dir, fs }), null, "no loader loaded: no snapshot");
});

test("the console bundle does not reach the pi runtime (@earendil-works/pi-coding-agent), directly or through any import", async (t) => {
  const pagesFile = new URL("../src/console/pages.mjs", import.meta.url);
  if (!existsSync(pagesFile)) {
    t.skip("pages.mjs is not in this tree yet");
    return;
  }
  const { build } = await import("esbuild");
  const result = await build({
    entryPoints: [new URL("../src/console/cli.mjs", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node22",
    external: ["@earendil-works/pi-coding-agent", "bullmq", "ioredis"],
    metafile: true,
    logLevel: "silent",
  });
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(inputs.some((p) => p.endsWith("src/console/live.mjs")), "the walk saw the console's own modules");
  for (const [path, input] of Object.entries(result.metafile.inputs)) {
    assert.ok(!path.includes("pi-coding-agent"), path);
    for (const imp of input.imports) assert.ok(!imp.path.includes("@earendil-works/pi-coding-agent"), `${path} imports ${imp.path}`);
  }
  for (const output of Object.values(result.metafile.outputs)) {
    for (const imp of output.imports) assert.ok(!imp.path.includes("@earendil-works/pi-coding-agent"), `the bundle imports ${imp.path}`);
  }
});

test("serve gives Fire now the process environment separately from deployment defaults (#750)", async () => {
  const dep = deployment();
  dep.env.PI_DISPATCH_RUN_ROOTS = dep.dir;
  dep.env.PI_DISPATCH_RUN_PER_HOUR = "2";
  const modules = fakeModules();
  let captured;
  modules.server = { ...server, createConsoleServer: (opts) => { captured = opts; return server.createConsoleServer(opts); } };
  let stop;
  const until = new Promise((resolve) => { stop = resolve; });
  const errors = [];
  const code = await runCli(["serve", "--deployment", dep.dir], { env: dep.env, modules, now: () => T0, uid: process.geteuid?.(), out: () => {}, err: (line) => errors.push(line), until, onListening: () => stop() });
  assert.equal(code, 0, errors.join("\n"));
  assert.equal(captured.actionDeps.grantsEnv, dep.env);
  assert.equal(captured.actionDeps.grantsEnv.PI_DISPATCH_RUN_ROOTS, dep.dir);
  assert.equal(captured.actionDeps.grantsEnv.PI_DISPATCH_RUN_PER_HOUR, "2");
  assert.equal(typeof captured.pageDeps.triggerFireCheck, "function");
});

test("serve hands each live load's who to loadPageData: a load no operator's stream shows says viewer, one an operator's shows names no role, each is marked live, and the console's readOnly rides along", async (t) => {
  const nullRes = () => ({ writableLength: 0, write: () => true, end() {}, destroy() {} });
  const dep = deployment();
  let stop;
  const until = new Promise((resolve) => (stop = resolve));
  t.after(() => stop());
  let listening;
  const up = new Promise((resolve) => (listening = resolve));
  const modules = fakeModules();
  const loads = [];
  modules.pages = { ...realPages, loadPageData: async (name, query, deps, who) => (loads.push([name, who]), {}), pagePanels: async () => [{ id: "p-main", html: "<p>x</p>" }] };
  modules.sessions = { ...modules.sessions, makeSessionStore: () => ({ ...fakeModules().sessions.makeSessionStore(), peek: (id) => ({ id }) }) };
  let hub = null;
  modules.live = { ...live, makeLiveHub: (opts) => (hub = live.makeLiveHub(opts)) };
  const err = [];
  const running = runCli(["serve", "--deployment", dep.dir], { env: dep.env, modules, now: () => T0, uid: process.geteuid?.(), out: () => {}, err: (l) => err.push(l), until, onListening: listening });
  await Promise.race([up, running.then((code) => assert.fail(`serve exited ${code} before listening: ${err.join(" ")}`))]);
  hub.subscribe({ res: nullRes(), sessionId: "s1", session: { name: "bob", role: "viewer" }, page: "parked", query: {} });
  await hub.tick();
  const viewers = loads.filter(([name]) => name === "parked");
  loads.length = 0;
  hub.subscribe({ res: nullRes(), sessionId: "s2", session: { name: "alice", role: "operator" }, page: "parked", query: {} });
  await hub.tick();
  const operators = loads.filter(([name]) => name === "parked");
  stop();
  assert.equal(await running, 0);
  assert.ok(viewers.length >= 1, JSON.stringify(viewers));
  for (const [, who] of viewers) assert.deepEqual(who, { role: "viewer", readOnly: false, live: true });
  assert.ok(operators.length >= 1, JSON.stringify(operators));
  for (const [, who] of operators) assert.deepEqual(who, { readOnly: false, live: true });
});

test("Spend cache keeps views, projects, roles and path permissions apart and bounds user-chosen keys", async () => {
  let calls = 0;
  let t = T0;
  const cached = cachedPerWindow(async (window, opts) => ({ sequence: ++calls, window, opts }), { now: () => t });
  const args = { view: "budget-split", project: "site", role: "operator", fullPaths: true };
  const first = await cached("7d", args);
  assert.equal((await cached("7d", args)).sequence, first.sequence);
  for (const opts of [{ ...args, role: "viewer", fullPaths: false }, { ...args, fullPaths: false }, { ...args, project: "other" }, { ...args, view: "breakdown" }]) assert.notEqual((await cached("7d", opts)).sequence, first.sequence);
  assert.notEqual((await cached("30d", args)).sequence, first.sequence);
  for (let i = 0; i < 130; i++) await cached("7d", { view: "breakdown", project: `p${i}` });
  assert.notEqual((await cached("7d", args)).sequence, first.sequence, "the oldest entry is evicted after the bounded cache fills");
  const before = calls;
  t += INSIGHTS_CACHE_MS;
  await cached("7d", args);
  assert.equal(calls, before + 1, "an expired answer is recomputed on the injected clock");
});


test("manual console editor metadata reads configured webhooks from deployment .env without widening process grants (#750)", async () => {
  const dep = deployment();
  writeFileSync(join(dep.dir, ".env"), "WEBHOOK_SECRET=PRIVATE_VALUE\nPI_DISPATCH_RUN_ROOTS=/file/grant\nPI_DISPATCH_RUN_PER_HOUR=999\n", { mode: 0o600 });
  const modules = fakeModules();
  modules.readModel.readTriggerEditor = readTriggerEditor;
  modules.readModel.configLocationsOf = configLocationsOf;
  const resolvePaths = modules.readModel.resolvePaths;
  modules.readModel.resolvePaths = (env) => ({ ...resolvePaths(env), settingsFile: join(dep.dir, "settings.json"), triggersPath: join(dep.dir, "triggers.json") });
  let captured;
  modules.server = { ...server, createConsoleServer: (opts) => { captured = opts; return server.createConsoleServer(opts); } };
  let stop;
  const until = new Promise((resolve) => { stop = resolve; });
  const code = await runCli(["serve", "--deployment", dep.dir], { env: dep.env, modules, now: () => T0, uid: process.geteuid?.(), out: () => {}, err: () => {}, until, onListening: () => stop() });
  assert.equal(code, 0);
  const metadata = await captured.pageDeps.triggerEditor();
  assert.deepEqual(metadata.forges, ["github"]);
  assert.doesNotMatch(JSON.stringify(metadata), /PRIVATE_VALUE|file\/grant|999/);
  const locations = captured.pageDeps.configLocations();
  assert.deepEqual(locations, { settings: `.../${basename(dep.dir)}/settings.json`, triggers: `.../${basename(dep.dir)}/triggers.json`, settingsOutsideDeployment: false });
  assert.ok(!JSON.stringify(locations).includes(dep.dir), "the raw deployment path does not enter either role's display");
  assert.equal(captured.actionDeps.grantsEnv.PI_DISPATCH_RUN_ROOTS, undefined);
  assert.equal(captured.actionDeps.grantsEnv.PI_DISPATCH_RUN_PER_HOUR, undefined);
});

test("the rules read joins retained local history, mirrored records and verified scheduler clocks without changing shared state", async () => {
  const dep = deployment();
  let t = T0;
  const modules = fakeModules();
  const local = { jobId: "gh-local", endedAt: new Date(T0 - 7 * 86400_000).toISOString() };
  const mirror = { jobId: "gh-mirror", endedAt: new Date(T0).toISOString() };
  const scans = [], checks = [], zoneReads = [];
  modules.readModel.scanRunRecords = (args) => (scans.push(args), [local]);
  modules.readModel.readSubscriptions = () => ({ subscriptions: [{ provider: "plan:test" }] });
  modules.scheduleZones = { readTriggerScheduleZones: async (args) => (zoneReads.push(args), { nightly: { zone: "Europe/Amsterdam" } }) };
  modules.triggerList = { triggerListOf: (args) => args };
  modules.triggerCheck = { checkTriggerEvent: (args) => (checks.push(args), { matched: null }) };
  let captured;
  modules.server = { ...server, createConsoleServer: (opts) => { captured = opts; return server.createConsoleServer(opts); } };
  let stop;
  const until = new Promise((resolve) => { stop = resolve; });
  assert.equal(await runCli(["serve", "--deployment", dep.dir], { env: dep.env, modules, now: () => t, uid: process.geteuid?.(), out: () => {}, err: () => {}, until, onListening: () => stop() }), 0);
  const snapshot = { triggers: { triggers: [{ type: "cron", id: "nightly", pattern: "0 3 * * *" }] }, recordDetails: new Map([[mirror.jobId, mirror]]) };
  const read = await captured.pageDeps.triggerList(snapshot);
  assert.deepEqual(read.records, [local, mirror]);
  assert.equal(scans[0].sinceMs, T0 - 30 * 86400_000);
  assert.equal(scans[0].nowMs, T0);
  assert.deepEqual(read.scheduleZones, { nightly: { zone: "Europe/Amsterdam" } });
  assert.deepEqual(zoneReads[0].triggers, snapshot.triggers.triggers);
  assert.equal(zoneReads[0].now(), T0);
  assert.equal(read.coverage.complete, false, "a full local scan alone cannot promise full foreign history");
  assert.deepEqual(read.subscriptions, [{ provider: "plan:test" }]);
  assert.equal(read.snapshot, snapshot);
  await captured.pageDeps.triggerList(snapshot);
  assert.equal(scans.length, 1, "the retained local scan is cached on the injected clock");
  const input = { forge: "github", comment: "not persisted" };
  assert.deepEqual(captured.pageDeps.triggerCheck(input), { matched: null });
  assert.equal(checks[0].input, input);
  assert.ok(checks[0].triggersPath.endsWith("triggers.json"));
  assert.deepEqual(snapshot.recordDetails.get(mirror.jobId), mirror);
  t += INSIGHTS_CACHE_MS + 1;
  modules.readModel.scanRunRecords = () => ({ unreachable: "read failed" });
  const unknown = await captured.pageDeps.triggerList({ triggers: snapshot.triggers });
  assert.equal(unknown.records, null, "an unread local history and absent mirror are not an empty readable history");
  assert.equal(unknown.coverage.partial, true);
  const real = await loadModules();
  assert.equal(typeof real.scheduleZones.readTriggerScheduleZones, "function");
  assert.equal(typeof real.triggerCheck.checkTriggerEvent, "function");
  assert.equal(typeof real.triggerList.triggerListOf, "function");
});

test("host setup authority comes only from the serve flag, and production wiring keeps preview/apply separate from page reads", async () => {
  for (const explicit of [false, true]) {
    const dep = deployment({ PI_CONSOLE_HOST_SETUP: "1" });
    writeFileSync(join(dep.dir, ".env"), `PI_CONSOLE_HOST_SETUP=1\nPI_BACKENDS=openshell\nPI_PROVIDER=openai\nPI_LOGS_DIR=${dep.env.PI_LOGS_DIR}\nPI_CONSOLE_LISTEN=${dep.env.PI_CONSOLE_LISTEN}\n`, { mode: 0o600 });
    const modules = fakeModules();
    const { deploymentServiceEnv } = await import("@edgehero/pi-dispatch/service-env");
    modules.serviceEnv = { deploymentServiceEnv };
    modules.readModel.panelEnv = panelEnv;
    modules.readModel.PANEL_SERVICE_KEYS = PANEL_SERVICE_KEYS;
    modules.workerConfig = { ...(await import("@edgehero/pi-dispatch/config")), settingsFilePath: () => join(dep.dir, "settings.json") };
    modules.readModel.readSettingsView = () => ({ overlay: {} });
    let options, pageReads = 0, brokerCalls = 0, exposureContext;
    modules.setupHostClient = { setupWorkerEntry: () => ({ entry: "/installed/worker/src/cli.mjs" }), makeSetupBroker: () => { brokerCalls++; return { close() {} }; } };
    modules.consoleActions = { readSetupExposure: ctx => { exposureContext = ctx; return { complete: true, at: T0, lines: [] }; } };
    modules.setupActions = { SETUP_ACTION_NAMES: ["setup-worker-start", "setup-provider-key", "setup-egress-start"], makeSetupActions: opts => { options = opts; return { state: role => { pageReads++; return { enabled: opts.enabled, actions: role === "operator" && opts.enabled ? opts.operations : [], progress: [] }; }, close() {} }; } };
    let captured;
    modules.server = { ...server, createConsoleServer: opts => { captured = opts; return server.createConsoleServer(opts); } };
    const r = await cli(["serve", ...(explicit ? ["--host-setup"] : [])], { dir: dep.dir, env: dep.env, modules, platform: "linux", until: Promise.resolve() });
    assert.equal(r.code, 0, r.err.join(" "));
    assert.equal(options.enabled, explicit, "neither a shell variable nor deployment .env can grant setup");
    assert.equal(captured.config.hostSetup, explicit);
    assert.equal(brokerCalls, explicit ? 1 : 0);
    if (explicit) {
      assert.equal(typeof options.provider, "function");
      assert.equal(options.provider(), "openai", "safe metadata uses the current actual deployment provider");
      assert.equal(options.deployment, dep.dir, "the viewer lock binds the host-resolved deployment");
      assert.equal(options.operations.includes("setup-egress-start"), false, "gateway-only deployments offer no proxy action");
    }
    await captured.pageDeps.setup({ role: "viewer", snapshot: {} });
    assert.equal(pageReads, 1);
    assert.equal(brokerCalls, explicit ? 1 : 0, "a setup page read never constructs or invokes another child");
    assert.equal((await options.readExposure()).complete, true);
    assert.equal(exposureContext.a, captured.actionDeps, "the actual complete fleet/queue reserve path is wired, not a permanent refusal stub");
    assert.equal(exposureContext.fs.readFileSync, readFileSync);
  }
});

test("CLI setup destinations and grants reject misuse before any token or code write", async () => {
  const linked = await cli(["link", "--name", "alice", "--next", "/setup"], { env: deployment({ PI_CONSOLE_LISTEN: "127.0.0.1:4790" }).env });
  assert.equal(linked.code, 0);
  assert.equal(linked.out[0], `http://127.0.0.1:4790/login/code#${CODE}&next=/setup`);
  for (const argv of [["link", "--name", "alice", "--next", "https://evil.example"], ["link", "--name", "alice", "--next", "/runs"], ["token", "list", "--host-setup"], ["serve", "--next", "/setup"]]) {
    const res = await cli(argv, { until: Promise.resolve() });
    assert.equal(res.code, 2, argv.join(" "));
    assert.deepEqual(res.out, []);
    assert.ok(!res.modules.calls.some(call => ["mint", "add", "rotate", "revoke"].includes(call[0])));
  }
});

test("link audit failure cannot create a code, and a failed mint appends a correlated failed intent without logging the code", async () => {
  const denied = fakeModules({ auditFails: true });
  const refusal = await cli(["link", "--name", "alice", "--next", "/setup"], { modules: denied });
  assert.equal(refusal.code, 1);
  assert.deepEqual(refusal.out, []);
  assert.equal(denied.calls.some(([name]) => name === "mint"), false);
  assert.match(refusal.err.join("\n"), /no sign-in code was minted.*audit row could not be written/);
  for (const throws of [false, true]) {
    const modules = fakeModules();
    modules.loginCodes.mintLoginCode = () => {
      assert.equal(modules.rows.length, 1, "the durable intent precedes the first mint attempt");
      if (throws) throw Object.assign(new Error("fixture mint failure"), { code: "EACCES" });
      return { refusal: "fixture login-code directory is unavailable" };
    };
    const failed = await cli(["link", "--name", "alice"], { modules });
    assert.equal(failed.code, throws ? 1 : 2);
    assert.deepEqual(failed.out, []);
    assert.deepEqual(modules.rows.map(row => [row.action, row.outcome]), [["login-code", "ok"], ["login-code", "failed"]]);
    assert.equal(modules.rows[0].ticket, modules.rows[1].ticket);
    assert.match(modules.rows[0].ticket, /^[0-9a-f]{12}$/);
    assert.equal(modules.rows[1].reason, "login-code-mint-failed");
    assert.ok(!JSON.stringify(modules.rows).includes(CODE));
  }
});


test("setup starts refuse stale reserve context while key-only .env edits preserve current observations", async () => {
  const before = { env: { PI_MAX_COST_USD: "1", PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "" }, paths: { valkeyUrl: "redis://local/0", settingsFile: "/deployment/settings.json" } };
  let current = structuredClone(before), reads = 0;
  const read = makeSetupExposureReader({ initial: before, readSide: () => current, readExposure: async () => { reads++; return { complete: true, at: T0 }; } });
  assert.equal((await read()).complete, true);
  current.env.ANTHROPIC_API_KEY = "synthetic-key-never-in-guard-output";
  assert.equal((await read()).complete, true);
  for (const change of [
    side => { side.env.PI_MAX_COST_USD = "10"; },
    side => { side.env.PI_PROVIDER = "openai"; },
    side => { side.env.PI_MODEL = "another"; },
    side => { side.env.PI_ALLOWED_MODELS = "another"; },
    side => { side.env.PI_MODEL_ENDPOINTS_FILE = "another.json"; },
    side => { side.paths.settingsFile = "/deployment/new-settings.json"; },
    side => { side.paths.valkeyUrl = "redis://other/0"; },
  ]) {
    current = structuredClone(before); change(current);
    assert.deepEqual(await read(), { complete: false, reason: "configuration-drift" });
  }
  assert.equal(reads, 2, "no cached reserve scan runs under changed configuration");
  const broken = makeSetupExposureReader({ initial: before, readSide: () => { throw Error("private detail"); }, readExposure: async () => assert.fail("must refuse") });
  assert.deepEqual(await broken(), { complete: false });
});


test("setup key metadata matches shell/file/overlay precedence and refuses invalid sources without a child", async () => {
  const dir = tempDir("setup-provider-metadata-");
  const shellSettings = join(dir, "shell-settings.json"), fileSettings = join(dir, "file-settings.json");
  const workerConfig = await import("@edgehero/pi-dispatch/config");
  const serviceEnv = await import("@edgehero/pi-dispatch/service-env");
  const { readSettingsView } = await import("../src/read-model.mjs");
  const env = { PI_PROVIDER: "openai", PI_SETTINGS_FILE: shellSettings };
  const m = { serviceEnv, workerConfig, readModel: { readSettingsView } };
  const read = () => setupProviderOf({ m, env, dir });
  writeFileSync(join(dir, ".env"), "", { mode: 0o600 });
  assert.equal(read(), "openai", "a shell-only provider matches the child rather than labelling Anthropic");
  writeFileSync(join(dir, ".env"), "PI_PROVIDER=groq\n");
  assert.equal(read(), "groq", "the deployment file overrides the host shell");
  writeFileSync(shellSettings, JSON.stringify({ provider: "openrouter" }));
  assert.equal(read(), "openrouter", "a shell-only settings path is the same source the child reads");
  writeFileSync(fileSettings, JSON.stringify({ provider: "deepseek" }));
  writeFileSync(join(dir, ".env"), `PI_PROVIDER=mistral\nPI_SETTINGS_FILE=${fileSettings}\n`);
  assert.equal(read(), "deepseek", "file-selected overlay overrides both provider defaults");
  writeFileSync(fileSettings, "{");
  assert.equal(read(), null, "invalid overlays never invent a supported key slot");
  writeFileSync(join(dir, ".env"), "PI_PROVIDER=invalid/provider\n");
  env.PI_SETTINGS_FILE = join(dir, "absent-settings.json");
  assert.equal(read(), null, "invalid effective provider refuses metadata");
  chmodSync(join(dir, ".env"), 0o666);
  assert.equal(read(), null, "unsafe deployment metadata refuses without loading a host executor");
});
