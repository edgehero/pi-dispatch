// A sandbox End in a REAL console over a LIVE Valkey that stops answering at one named command (issue #843;
// VALKEY_TEST_URL, required in CI). The unit tests hand `requestSandboxEnd` an error at each step; only here do the
// console's own client, its bound and its wiring decide what the error is, which is where "nothing was changed" was said
// of a request that had been written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { makeRedisClient } from "@edgehero/pi-dispatch/connection";
import { readConsoleAudit } from "@edgehero/pi-dispatch/console-audit";
import { renewSandboxSession, sandboxEndKey, sandboxSessionKey, sandboxSessionMember, SANDBOX_SESSION_INDEX } from "@edgehero/pi-dispatch/sandbox-sessions";
import { runCli } from "../src/console/cli.mjs";
import { SANDBOX_END_UNCONFIRMED } from "../src/sandbox-data.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { commandOn, trippingProxy } from "./helpers/tripping-proxy.mjs";

const VALKEY = process.env.VALKEY_TEST_URL;
// CI sets this, which turns a missing URL into a failure rather than a quiet skip.
if (!VALKEY && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS) throw new Error("sandbox-end-wired.test REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS is set");

// Database 6, which no test flushes (updates-wired's reason). Every sandbox key here carries a random nonce or host
// name and is deleted again, as are the two keys a console writes by serving at all (`CONSOLE_KEYS`).
const databaseUrl = () => {
  const url = new URL(VALKEY);
  url.pathname = "/6";
  return url.href;
};
const CONSOLE_KEYS = ["console:audit", "bull:pi-jobs:*"];
const NOW = 1_800_000_000_000;

function httpTo(port) {
  return (path, { body, cookie } = {}) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = { host: `127.0.0.1:${port}`, ...(cookie ? { cookie } : {}), "content-type": "application/json", origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin", "content-length": Buffer.byteLength(data) };
    const req = request({ host: "127.0.0.1", port, method: "POST", path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

test("a sandbox End on a Valkey that stops answering says what is known by where it stopped, and takes back a request that may stand", { skip: VALKEY ? false : "needs VALKEY_TEST_URL (CI sets it)", timeout: 120_000 }, async () => {
  // Everything that holds a socket is opened inside the try, so a failure anywhere leaves none open and the file ends.
  let direct = null, proxy = null, running = null;
  let stop = () => {};
  const written = [];
  try {
    direct = makeRedisClient(databaseUrl(), {});
    proxy = await trippingProxy(databaseUrl());
    const dir = tempDir("sandbox-end-wired-");
    mkdirSync(join(dir, "logs"), { recursive: true });
    writeFileSync(join(dir, "triggers.json"), JSON.stringify({ triggers: [] }));
    const env = { PATH: process.env.PATH, HOME: dir, VALKEY_URL: proxy.url, PI_LOGS_DIR: join(dir, "logs"), PI_TRIGGERS_FILE: join(dir, "triggers.json"), PI_CONSOLE_LISTEN: "127.0.0.1:0", PI_WORKER_NAME: "host-a", PI_DISPATCH_DEPLOYMENT_FILE: join(dir, "no-pointer.json") };
    const err = [];
    const io = { env, now: () => NOW, uid: process.geteuid?.(), err: (line) => err.push(line) };
    const printed = [];
    assert.equal(await runCli(["token", "add", "--name", "ops", "--role", "operator", "--deployment", dir], { ...io, out: (line) => printed.push(line) }), 0, err.join("\n"));
    const token = printed.join("\n").match(/pdc_[A-Za-z0-9_-]+/)?.[0];
    assert.ok(token, "the token is printed once");
    const until = new Promise((resolve) => (stop = resolve));
    let listening;
    const up = new Promise((resolve) => (listening = resolve));
    running = runCli(["serve", "--deployment", dir], { ...io, out: () => {}, until, onListening: listening });
    const call = httpTo((await up).address().port);
    const login = await call("/login", { body: { token } });
    assert.equal(login.status, 200, login.text.slice(0, 200));
    const cookie = [].concat(login.headers["set-cookie"]).map((c) => c.split(";")[0]).join("; ");
    const lastRow = () => readConsoleAudit({ logsDir: env.PI_LOGS_DIR, limit: 1 }).rows[0];

    /** One shell of its own, previewed while Valkey answers, then confirmed with Valkey stopping at `pattern`. */
    const endWith = async (pattern) => {
      const nonce = randomBytes(16).toString("hex");
      const session = { v: 1, host: `sb-${nonce.slice(0, 12)}`, id: `sb-${nonce}`, nonce, containerId: "b".repeat(64), venue: "podman", by: "ops", since: NOW, at: NOW };
      written.push(sandboxSessionKey(session.host, session.id), sandboxEndKey(nonce));
      assert.equal(await renewSandboxSession(direct, session, { now: () => NOW }), true);
      written.push(["zrem", sandboxSessionMember(session.host, session.id)]);
      const preview = await call("/api/act/sandbox-end/preview", { cookie, body: { host: session.host, id: session.id, nonce, containerId: session.containerId } });
      assert.equal(preview.status, 200, preview.text.slice(0, 300));
      const frozen = proxy.freezeAt(pattern);
      const started = performance.now();
      const confirm = await call("/api/act/sandbox-end/confirm", { cookie, body: { ticket: JSON.parse(preview.text).ticket } });
      const took = performance.now() - started;
      // The confirm has answered, so the command it was to stop at has been sent, or never will be: no wait without an end.
      assert.equal(await Promise.race([frozen.then(() => "stopped"), new Promise((resolve) => setTimeout(resolve, 1000, "never sent"))]), "stopped", "Valkey stopped answering at the named command");
      const row = lastRow();
      // Nothing reached Valkey while it did not answer; what was sent arrives now, in order, as after a `kill -CONT`.
      const before = await direct.exists(sandboxEndKey(nonce));
      proxy.thaw();
      // A command of this test's own through the proxy, sent after what was held, so that has been read when it answers.
      const through = makeRedisClient(proxy.url, {});
      try { await through.ping(); } finally { through.disconnect(); }
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { status: confirm.status, said: JSON.parse(confirm.text).error, took, row, before, after: await direct.exists(sandboxEndKey(nonce)) };
    };

    // At the request's SET: it was written, so it may stand when Valkey wakes, and its removal goes out behind it.
    const atSet = await endWith(commandOn("set", "sandbox:end:"));
    assert.equal(atSet.status, 500, atSet.said);
    assert.equal(atSet.said, "Valkey did not confirm the sandbox-end change, so it may or may not have been made. Look again once Valkey answers; the console's log has the reason");
    assert.deepEqual([atSet.row.kind, atSet.row.outcome, atSet.row.reason], ["sandbox-end", "failed", "the write threw (ETIMEDOUT); Valkey did not confirm it, so it may or may not have been made"]);
    assert.ok(atSet.took > 4000 && atSet.took < 9000, `the client's bound decided, not a shorter timer (${Math.round(atSet.took)} ms)`);
    assert.deepEqual([atSet.before, atSet.after], [0, 0], "the request that landed at the wake was taken back right behind it");

    // At the read of the acknowledgment: the SET was answered, so the request stands, and is taken back the same way.
    const atAck = await endWith(commandOn("get", "sandbox:ended:"));
    assert.equal(atAck.status, 409, atAck.said);
    assert.equal(atAck.said, SANDBOX_END_UNCONFIRMED);
    assert.deepEqual([atAck.row.kind, atAck.row.outcome, atAck.row.reason], ["sandbox-end", "failed", SANDBOX_END_UNCONFIRMED]);
    assert.deepEqual([atAck.before, atAck.after], [1, 0], "the request stood while Valkey did not answer, and its removal landed at the wake");

    // At the read of the session, before anything was written: nothing was changed, and that is what is said.
    const atRead = await endWith(commandOn("get", "sandbox:shell:"));
    assert.equal(atRead.status, 500, atRead.said);
    assert.equal(atRead.said, "the sandbox-end change could not be made; nothing was changed, and the console's log has the reason");
    assert.deepEqual([atRead.row.kind, atRead.row.outcome, atRead.row.reason], ["sandbox-end", "failed", "the write threw (ETIMEDOUT)"]);
    assert.deepEqual([atRead.before, atRead.after], [0, 0], "no request was written, then or at the wake");
    assert.deepEqual(err.filter((line) => /unexpected failure|TypeError/.test(line)), []);
  } finally {
    proxy?.thaw();
    stop();
    await running?.catch(() => {});
    if (direct) {
      for (const key of written) await (Array.isArray(key) ? direct.zrem(SANDBOX_SESSION_INDEX, key[1]) : direct.del(key)).catch(() => {});
      for (const pattern of CONSOLE_KEYS) {
        const keys = await direct.keys(pattern).catch(() => []);
        if (keys.length > 0) await direct.del(...keys).catch(() => {});
      }
      direct.disconnect();
    }
    proxy?.close();
  }
});
