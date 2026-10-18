import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { cachedPerWindow, endpointSnapshotFn, INSIGHTS_CACHE_MS, loadModules, readSideOf, RESERVE_ENV_KEYS, runCli, USAGE } from "../src/console/cli.mjs";
import * as live from "../src/console/live.mjs";
import { acquireConsoleLock, consoleLockPath } from "../src/console/lock.mjs";
import * as realPages from "../src/console/pages.mjs";
import * as server from "../src/console/server.mjs";
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
    async snapshot() {
      fleet.snapshots += 1;
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
    readModel: {
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
  const installed = modules.calls.filter((c) => c[0] === "valkey-context");
  assert.deepEqual(installed.map((c) => c[1]), ["function"]);
  assert.equal(modules.calls.some((c) => c[0] === "panel-context"), false, "the context is read per client, not at install");
  installed[0][2]();
  assert.deepEqual(modules.calls.find((c) => c[0] === "panel-context"), ["panel-context", dep.dir], "from THIS deployment's .env, not the pointer's");

  const login = await http(port, { method: "POST", path: "/login", headers: { origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN }) });
  assert.equal(login.status, 200, login.text);
  const cookie = login.headers["set-cookie"][0].split(";")[0];

  const state = await http(port, { path: "/api/state", headers: { cookie } });
  assert.equal(state.status, 200);
  const body = JSON.parse(state.text);
  assert.equal(body.counts.waiting, 2);
  assert.equal(body.failed.rows[0].failedReason, "boom", "alice is an operator");

  // The page deps the CLI built: the reader, a 30 s insights cache over the real assembler's call shape, the audit read.
  const page = await http(port, { path: "/fleet", headers: { cookie } });
  assert.equal(page.status, 200);
  const deps = modules.pageDepsSeen.at(-1);
  assert.equal(deps.fleet, modules.fleet);
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
  assert.deepEqual(auditReads.map((a) => [a.logsDir, a.limit]), [[join(dep.dir, "logs"), 5]]);
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
  assert.match(text, /event: end/, "the hub said goodbye on stop");
  assert.equal(await running, 0);
  assert.equal(modules.fleet.disposed, 1, "the reader is disposed on stop");
  assert.deepEqual(modules.calls.filter((c) => c[0] === "valkey-context").at(-1).slice(0, 2), ["valkey-context", "object"], "the context is put back");
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
