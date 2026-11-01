import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { CONSOLE_USAGE, consoleCommand, consolePagePath, parseConsoleArgs, probeLine } from "../src/console-command.mjs";
import { loginCodesDir } from "../src/console/login-codes.mjs";

// Issue #708: `/dispatch console`, driven through its seams. Every word goes to `notify`; the probe, the tokens file,
// the audit log, the mint and the opener are fakes that record what was asked of them, in order.

const CODE = "C".repeat(43);
const SHA = "e".repeat(64);
const TOKENS_PATH = "/dep/console-tokens.json";

function harness({ hasUI = true, mode = "tui", env = {}, state = "running", tokens = [{ name: "alice", role: "operator" }], tokensRefusal = null, auditFails = false, mintRefusal = null, select = null, local = true, guarded = true, tokensPath = TOKENS_PATH } = {}) {
  const order = [];
  const notes = [];
  const rows = [];
  const opened = [];
  const probes = [];
  const selects = [];
  const deps = {
    hasUI,
    mode,
    notify: (text, level) => notes.push([text, level]),
    select: select ? async (title, options) => (selects.push([title, options]), select(options)) : undefined,
    env,
    sessionEnv: {},
    platform: "darwin",
    logsDir: "/dep/logs",
    tokensPath,
    guarded: (dir) => (order.push("guarded"), guarded && dir === loginCodesDir(TOKENS_PATH)),
    ticket: "0123456789ab",
    probe: async (e) => (probes.push(e), order.push("probe"), { state, ...(state === "unknown" ? { reason: "nothing answered within 1000 ms" } : {}) }),
    readTokens: () => (order.push("read"), tokensRefusal ? { refusal: tokensRefusal } : { file: { version: 1, generation: 1, tokens: tokens.map((t) => ({ ...t, sha256: SHA, createdAt: "2026-10-01T00:00:00.000Z" })) } }),
    audit: {
      append: (row) => {
        order.push(`audit:${row.outcome}`);
        if (auditFails) {
          const e = new Error("disk full");
          e.code = "ENOSPC";
          throw e;
        }
        rows.push(row);
      },
    },
    actor: { name: "rob", role: "panel", session: null },
    mint: (o) => (order.push("mint"), assert.equal(o.dir, loginCodesDir(TOKENS_PATH)), mintRefusal ? { refusal: mintRefusal } : { code: CODE }),
    open: (url) => (order.push("open"), opened.push(url)),
    openLink: (url) => (order.push("openLink"), opened.push(url), { opened: true }),
    isLocal: () => local,
  };
  return { deps, order, notes, rows, opened, probes, selects };
}

const text = (h) => h.notes.map(([t]) => t).join("\n");

test("parseConsoleArgs and consolePagePath: the page words, a run id, --link [name], --no-open; anything else is usage", () => {
  assert.deepEqual(parseConsoleArgs([]), { page: null, link: false, name: null, noOpen: false });
  assert.deepEqual(parseConsoleArgs(["runs", "--link", "alice", "--no-open"]), { page: "runs", link: true, name: "alice", noOpen: true });
  assert.deepEqual(parseConsoleArgs(["--link", "--no-open"]), { page: null, link: true, name: null, noOpen: true });
  for (const bad of [["runs", "fleet"], ["--open"], ["--link", "a", "--link"], ["--no-open", "--no-open"], ["-x"]]) assert.equal(parseConsoleArgs(bad).usage, true, bad.join(" "));
  const pages = { runs: "runs", fleet: "fleet", insights: "insights", config: "config", parked: "parked", audit: "audit", "gh-acme-widgets-42.1": "run?id=gh-acme-widgets-42.1", "repeat:t1:1760000000000": "run?id=repeat:t1:1760000000000" };
  for (const [word, path] of Object.entries(pages)) assert.equal(consolePagePath(word), path, word);
  assert.equal(consolePagePath(null), "");
  for (const bad of ["<x>", "a/b", "x".repeat(201), "run id"]) assert.equal(consolePagePath(bad), null, bad);
});

test("without pi's UI it refuses before anything is probed, read or minted", async () => {
  const h = harness({ hasUI: false });
  assert.deepEqual(await consoleCommand(["--link"], h.deps), { refused: "no-ui" });
  assert.deepEqual(h.order, []);
  assert.equal(h.notes[0][1], "warning");
});

test("a bad word answers the usage line and probes nothing", async () => {
  for (const words of [["nonsense/page"], ["runs", "fleet"], ["--bogus"]]) {
    const h = harness();
    await consoleCommand(words, h.deps);
    assert.deepEqual(h.notes, [[CONSOLE_USAGE, "warning"]], words.join(" "));
    assert.deepEqual(h.order, []);
  }
});

test("the address and the state: running, not running (with how to start it), unknown (with why)", async () => {
  const running = harness();
  const r = await consoleCommand(["runs"], running.deps);
  assert.equal(r.state, "running");
  assert.equal(running.notes.length, 1);
  assert.deepEqual(running.notes[0][0].split("\n").slice(0, 2), ["http://127.0.0.1:4790/runs", "the console: running"]);
  assert.equal(running.notes[0][1], "info");

  const stopped = harness({ state: "not-running" });
  await consoleCommand(["gh-1"], stopped.deps);
  assert.match(text(stopped), /^http:\/\/127\.0\.0\.1:4790\/run\?id=gh-1\nthe console: not running: start it with pi-dispatch-console serve, or keep it running with pi-dispatch service install --console/);
  assert.equal(stopped.notes[0][1], "warning");
  assert.deepEqual(stopped.opened, [], "a console that is not running is not opened");

  const unknown = harness({ state: "unknown", env: { PI_CONSOLE_LISTEN: "127.0.0.1:0" } });
  await consoleCommand([], unknown.deps);
  assert.match(text(unknown), /port the OS picks/);
  assert.match(text(unknown), /the console: whether it runs is not known: nothing answered/);

  const sock = harness({ env: { PI_CONSOLE_LISTEN: "unix:/run/pd/c.sock" } });
  await consoleCommand(["fleet"], sock.deps);
  assert.match(text(sock), /ssh -L 4790:\/run\/pd\/c\.sock <this host>, then open http:\/\/localhost:4790\/fleet/);
  assert.deepEqual(sock.opened, [], "a socket is reached through a tunnel, never opened");
  assert.equal(sock.probes[0].PI_CONSOLE_LISTEN, "unix:/run/pd/c.sock", "the probe reads the deployment's env");
});

test("--link with one operator token: audit first, then the mint, then the link with the code after # and the page as next", async () => {
  const h = harness({ tokens: [{ name: "alice", role: "operator" }, { name: "watcher", role: "viewer" }] });
  const r = await consoleCommand(["runs", "--link"], h.deps);
  assert.equal(r.minted, true);
  assert.deepEqual(h.order, ["probe", "guarded", "read", "audit:ok", "mint", "openLink"], "a link is opened through the private page, never handed to the opener");
  assert.deepEqual(h.rows, [{ actor: { name: "rob", role: "panel", session: null }, action: "login-code", target: "alice", outcome: "ok", ticket: "0123456789ab" }]);
  const link = `http://127.0.0.1:4790/login/code#${CODE}&next=/runs`;
  assert.ok(text(h).includes(`sign-in link for "alice" (it works once, within 60 seconds): ${link}`), text(h));
  assert.deepEqual(h.opened, [link], "the local browser gets the link itself");
  assert.match(text(h), /handed to your browser$/m, "darwin: no snap or Flatpak note");
  const linux = harness();
  linux.deps.platform = "linux";
  await consoleCommand(["--link"], linux.deps);
  assert.match(text(linux), /handed to your browser \(a snap or Flatpak browser cannot read the page in \/tmp and shows it as not found: open the link above instead\)/);
  assert.ok(!text(h).includes(SHA), "the token's hash is never shown");
  assert.ok(!JSON.stringify(h.rows).includes(CODE), "the audit row never holds the code");
  assert.ok(!link.split("#")[0].includes("?"), "the code is never in a query string");

  const run = harness();
  await consoleCommand(["gh-acme-7", "--link"], run.deps);
  assert.ok(text(run).includes(`login/code#${CODE}&next=/run?id=gh-acme-7`));
  const home = harness();
  await consoleCommand(["--link"], home.deps);
  assert.match(text(home), new RegExp(`login/code#${CODE}$`, "m"), "no page: no next, the overview");
});

test("--link chooses among operator tokens: a name given, one alone, several by select, none refused with the add hint", async () => {
  const many = [{ name: "alice", role: "operator" }, { name: "bob", role: "operator" }, { name: "watcher", role: "viewer" }];
  const picked = harness({ tokens: many, select: () => "bob" });
  await consoleCommand(["--link"], picked.deps);
  assert.deepEqual(picked.selects[0][1], ["alice", "bob"], "only operators are offered");
  assert.equal(picked.rows[0].target, "bob");

  const cancelled = harness({ tokens: many, select: () => undefined });
  const c = await consoleCommand(["--link"], cancelled.deps);
  assert.equal(c.refused, "cancelled");
  assert.ok(!cancelled.order.includes("mint") && !cancelled.order.some((o) => o.startsWith("audit")));

  const named = harness({ tokens: many });
  await consoleCommand(["--link", "bob"], named.deps);
  assert.equal(named.rows[0].target, "bob");
  assert.equal(named.selects.length, 0);

  for (const [opts, words, why] of [
    [{ tokens: [{ name: "watcher", role: "viewer" }] }, ["--link"], /no operator token; add one in the operator's own shell with pi-dispatch-console token add --name <name> --role operator/],
    [{ tokensRefusal: "there is no console tokens file at /dep/console-tokens.json" }, ["--link"], /no console tokens file.*token add/],
    [{ tokens: many }, ["--link", "watcher"], /a viewer token, and the panel signs in operators only/],
    [{ tokens: many }, ["--link", "ghost"], /no token named "ghost"/],
    [{ tokens: many }, ["--link"], /2 operator tokens; name one/],
  ]) {
    const h = harness(opts);
    const r = await consoleCommand(words, h.deps);
    assert.equal(r.refused, "link", words.join(" "));
    assert.match(text(h), why);
    assert.ok(!h.order.includes("mint"), "nothing minted");
  }
});

test("--link: an audit row that cannot be appended means no code; a refused mint is recorded as failed", async () => {
  const h = harness({ auditFails: true });
  const r = await consoleCommand(["--link"], h.deps);
  assert.equal(r.refused, "link");
  assert.deepEqual(h.order, ["probe", "guarded", "read", "audit:ok"], "the mint is never reached");
  assert.match(text(h), /audit log could not be written \(ENOSPC\), so no code was made/);
  assert.deepEqual(h.opened, []);

  const m = harness({ mintRefusal: "the login-code directory /dep/console-login-codes can be reached by other accounts" });
  await consoleCommand(["--link"], m.deps);
  assert.deepEqual(m.rows.map((row) => [row.outcome, row.ticket]), [["ok", "0123456789ab"], ["failed", "0123456789ab"]], "one ticket ties the failed row to its ok row");
  assert.match(text(m), /can be reached by other accounts/);
});

test("--link refuses for a stopped console or an address it cannot name; through a socket it names the tunnel's end", async () => {
  const stopped = harness({ state: "not-running" });
  assert.equal((await consoleCommand(["--link"], stopped.deps)).refused, "link");
  assert.match(text(stopped), /not running, and a code expires 60 seconds/);
  assert.deepEqual(stopped.order, ["probe"]);
  const ephemeral = harness({ state: "unknown", env: { PI_CONSOLE_LISTEN: "127.0.0.1:0" } });
  assert.equal((await consoleCommand(["--link"], ephemeral.deps)).refused, "link");
  const sock = harness({ env: { PI_CONSOLE_LISTEN: "unix:/run/pd/c.sock" } });
  await consoleCommand(["audit", "--link"], sock.deps);
  assert.ok(text(sock).includes(`http://localhost:4790/login/code#${CODE}&next=/audit`));
  assert.deepEqual(sock.opened, []);
  const unknown = harness({ state: "unknown" });
  assert.equal((await consoleCommand(["--link"], unknown.deps)).refused, "link", "only a console found running gets a link");
  assert.match(text(unknown), /could not be confirmed running/);
  assert.deepEqual(unknown.order, ["probe"]);
});

test("--link mints only into a drop the write guard holds, and only in pi's terminal UI (issue #708, review round 1)", async () => {
  for (const [opts, why] of [
    [{ guarded: false }, /guards no login-code directory to mint into/],
    [{ tokensPath: null }, /does not see this deployment's tokens file/],
    [{ mode: "rpc" }, /rpc mode here, where a notice goes to another program/],
    [{ mode: "json" }, /json mode/],
    [{ unsetMode: true }, /an unknown mode here/],
  ]) {
    const h = harness(opts);
    if (opts.unsetMode) delete h.deps.mode; // a pi too old to say its mode
    const r = await consoleCommand(["--link"], h.deps);
    assert.equal(r.refused, "link", JSON.stringify(opts));
    assert.match(text(h), why);
    assert.ok(!h.order.includes("read") && !h.order.includes("mint") && !h.order.some((o) => o.startsWith("audit")), "nothing read, audited or minted");
  }
  const rpc = harness({ mode: "rpc" });
  await consoleCommand(["runs"], rpc.deps);
  assert.match(text(rpc), /^http:\/\/127\.0\.0\.1:4790\/runs\nthe console: running/, "the address and the state are fine in rpc mode");
});

test("the browser: opened on a local session for a TCP listener, never with --no-open or off a local session", async () => {
  const local = harness();
  assert.equal((await consoleCommand(["config"], local.deps)).opened, true);
  assert.deepEqual(local.opened, ["http://127.0.0.1:4790/config"]);
  assert.match(text(local), /handed to your browser$/m);

  const noOpen = harness();
  const r = await consoleCommand(["config", "--no-open"], noOpen.deps);
  assert.equal(r.opened, false);
  assert.deepEqual(noOpen.opened, []);
  assert.ok(text(noOpen).includes("http://127.0.0.1:4790/config"), "the URL is printed all the same");

  const remote = harness({ local: false });
  await consoleCommand(["config"], remote.deps);
  assert.deepEqual(remote.opened, []);
  assert.match(text(remote), /not opened: this is not a local session/);

  const anyHost = harness({ env: { PI_CONSOLE_LISTEN: "0.0.0.0:4790", PI_CONSOLE_BIND_PUBLIC: "1" } });
  await consoleCommand([], anyHost.deps);
  assert.deepEqual(anyHost.opened, [], "<this host> is no address to open");
  assert.match(text(anyHost), /http:\/\/<this host>:4790\//);
});

test("the default local-session check reads the session's env: SSH prints only", async () => {
  const h = harness();
  delete h.deps.isLocal;
  h.deps.sessionEnv = { SSH_CONNECTION: "10.0.0.2 5000 10.0.0.1 22" };
  await consoleCommand([], h.deps);
  assert.deepEqual(h.opened, []);
  h.deps.sessionEnv = {};
  await consoleCommand([], h.deps);
  assert.deepEqual(h.opened, ["http://127.0.0.1:4790/"], "darwin with no SSH variable is local");
});

test("the probe is the worker's one rule: through its request seam only loopback or the socket is ever contacted", async () => {
  // No `probe` fake here: the command's default, `@edgehero/pi-dispatch/console-probe`, the probe doctor uses too.
  const seen = [];
  const request = (opts, onResponse) => {
    seen.push(opts);
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => setImmediate(() => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.resume = () => {};
      onResponse(res);
    });
    return req;
  };
  const cases = [
    [{}, "running"],
    [{ PI_CONSOLE_LISTEN: "[::1]:4791" }, "running"],
    [{ PI_CONSOLE_LISTEN: "0.0.0.0:4790", PI_CONSOLE_BIND_PUBLIC: "1" }, "running"],
    [{ PI_CONSOLE_LISTEN: "unix:/run/pd/c.sock" }, "running"],
    [{ PI_CONSOLE_LISTEN: "192.168.1.5:4790", PI_CONSOLE_BIND_PUBLIC: "1" }, "unknown"],
    [{ PI_CONSOLE_LISTEN: "127.0.0.1:0" }, "unknown"],
    [{ PI_CONSOLE_LISTEN: "nonsense" }, "unknown"],
  ];
  for (const [env, want] of cases) {
    const h = harness({ env });
    delete h.deps.probe;
    h.deps.request = request;
    const r = await consoleCommand([], h.deps);
    assert.equal(r.state, want, JSON.stringify(env));
  }
  assert.equal(seen.length, 4, "the three unknowns contacted nothing");
  for (const o of seen) {
    assert.ok(o.socketPath === "/run/pd/c.sock" || ["127.0.0.1", "::1"].includes(o.host), `contacted ${o.host ?? o.socketPath}`);
    assert.equal(o.path, "/healthz");
    assert.equal(o.headers.host, "127.0.0.1");
  }
});

test("probeLine: running, not running with the reason and both ways to start it, unknown with why", () => {
  assert.equal(probeLine({ state: "running" }), "running");
  assert.equal(probeLine({ state: "not-running", reason: "nothing listens there" }), "not running (nothing listens there): start it with pi-dispatch-console serve, or keep it running with pi-dispatch service install --console (docs/console.md)");
  assert.match(probeLine({ state: "unknown", reason: "port 0" }), /not known: port 0/);
});

test("setup link uses the private guarded opener and validated /setup destination, never the public opener or audit payload", async () => {
  const h = harness();
  const result = await consoleCommand(["setup", "--link"], h.deps);
  assert.equal(result.minted, true);
  assert.equal(consolePagePath("setup"), "setup");
  assert.deepEqual(h.order, ["probe", "guarded", "read", "audit:ok", "mint", "openLink"]);
  assert.equal(h.opened[0], `http://127.0.0.1:4790/login/code#${CODE}&next=/setup`);
  assert.ok(!JSON.stringify(h.rows).includes(CODE));
  const unsafe = harness({ guarded: false });
  assert.equal((await consoleCommand(["setup", "--link"], unsafe.deps)).minted, undefined);
  assert.ok(!unsafe.order.includes("mint"));
  assert.deepEqual(unsafe.opened, []);
  const rpc = harness({ mode: "rpc" });
  await consoleCommand(["setup", "--link"], rpc.deps);
  assert.ok(!rpc.order.includes("mint"), "an RPC client never receives the setup credential");
});
