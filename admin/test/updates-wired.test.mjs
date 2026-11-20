// The Updates page and its actions in a REAL console: its real modules, real files and a LIVE Valkey (issue #796;
// VALKEY_TEST_URL, required in CI). Every other test of this page is handed its facts, which is how a canary on another
// host went unseen: the fixtures gave the page its records, and the real read looked only at this host's files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { makeRedisClient } from "@edgehero/pi-dispatch/connection";
import { makeRunMirror } from "@edgehero/pi-dispatch/run-mirror";
import { publishLook } from "@edgehero/pi-dispatch/updates";
import { runCli } from "../src/console/cli.mjs";
import { readConsoleAudit } from "@edgehero/pi-dispatch/console-audit";
import { VALKEY_UNREACHABLE } from "../src/console/actions.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { trippingProxy } from "./helpers/tripping-proxy.mjs";

const VALKEY = process.env.VALKEY_TEST_URL;
// CI sets this, which turns a missing URL into a failure rather than a quiet skip.
if (!VALKEY && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS) throw new Error("updates-wired.test REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS is set");

// Database 6, because these keys are not prefixed and start-wiring's test reads `updates:desired` whole on the default one.
// Every database is claimed by some test, so this one is shared with recovery-queue's uniquely tagged queues, and that is
// why this deletes what it wrote and never flushes: a flush here would take that file's queues with it.
const databaseUrl = () => {
  const url = new URL(VALKEY);
  url.pathname = "/6";
  return url.href;
};
const OWN_KEYS = ["updates:*", "runs:*", "console:audit", "bull:pi-jobs:*"];
async function deleteOwnKeys(redis) {
  for (const pattern of OWN_KEYS) {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) await redis.del(...keys);
  }
}
const NOW = 1_800_000_000_000;
const CACHE_PASSED = 31_000;

function deployment(url) {
  const dir = tempDir("updates-wired-");
  for (const sub of ["logs", "pi-global/packages"]) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, "pi-global/packages/packages.json"), JSON.stringify({ stagedAt: "2026-10-01T00:00:00.000Z", packages: [{ name: "pi-lint", version: "1.4.2", dir: "pi-lint--1.4.2--aaaaaaaa", from: "pi-packages" }] }));
  writeFileSync(join(dir, "triggers.json"), JSON.stringify({ triggers: [{ on: { type: "cron", id: "nightly", pattern: "0 6 * * *" }, run: { kind: "local", folder: "/f", flow: "fix", task: "t", maxCostUsd: 2 } }] }));
  return {
    dir,
    env: {
      PATH: process.env.PATH, HOME: dir, VALKEY_URL: url, PI_LOGS_DIR: join(dir, "logs"), PI_GLOBAL_PI_DIR: join(dir, "pi-global"), PI_TRIGGERS_FILE: join(dir, "triggers.json"),
      PI_CONSOLE_LISTEN: "127.0.0.1:0", PI_WORKER_NAME: "host-a", PI_DISPATCH_DEPLOYMENT_FILE: join(dir, "no-pointer.json"),
    },
  };
}

function httpTo(port) {
  return (method, path, { body, cookie } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { host: `127.0.0.1:${port}`, ...(cookie ? { cookie } : {}), ...(data ? { "content-type": "application/json", origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin", "content-length": Buffer.byteLength(data) } : {}) };
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

test("a canary on another host opens Adopt on a real console, through the real run mirror, and closes it when its record is gone", { skip: VALKEY ? false : "needs VALKEY_TEST_URL (CI sets it)", timeout: 60_000 }, async () => {
  const url = databaseUrl();
  const redis = makeRedisClient(url, {});
  await deleteOwnKeys(redis);
  const dep = deployment(url);
  let clock = NOW;
  const now = () => clock;
  const err = [];
  const io = { env: dep.env, now, uid: process.geteuid?.(), err: (line) => err.push(line) };
  const printed = [];
  assert.equal(await runCli(["token", "add", "--name", "ops", "--role", "operator", "--deployment", dep.dir], { ...io, out: (line) => printed.push(line) }), 0, err.join("\n"));
  const token = printed.join("\n").match(/pdc_[A-Za-z0-9_-]+/)?.[0];
  assert.ok(token, "the token is printed once");

  let stop;
  const until = new Promise((resolve) => (stop = resolve));
  let listening;
  const up = new Promise((resolve) => (listening = resolve));
  const running = runCli(["serve", "--deployment", dep.dir], { ...io, out: () => {}, until, onListening: listening });
  try {
    const call = httpTo((await up).address().port);
    const login = await call("POST", "/login", { body: { token } });
    assert.equal(login.status, 200, login.text.slice(0, 200));
    const cookie = [].concat(login.headers["set-cookie"]).map((c) => c.split(";")[0]).join("; ");
    // Past the page's cache, so each draw reads again. Fixed instants and an injected clock: the page judges staleness, and the record's window, by it.
    const page = async () => {
      clock += CACHE_PASSED;
      const res = await call("GET", "/config/updates", { cookie });
      assert.equal(res.status, 200, res.text.slice(0, 200));
      return res.text;
    };
    const act = (name, step, body) => call("POST", `/api/act/${name}/${step}`, { cookie, body });
    const adoptInput = { name: "pi-lint", version: "1.4.3" };

    let html = await page();
    assert.match(html, /pi-lint/, "the row comes from the real stage manifest");
    assert.doesNotMatch(html, /package-canary|package-adopt/, "nothing newer is known yet, so nothing is offered");

    await publishLook(redis, { v: 1, host: "host-b", at: clock, everyHours: 24, pi: { pinned: "1.5.0", newest: "1.5.0", read: "ok", checks: null }, hostPi: { version: "1.5.0", tested: "1.5.0", state: "same", needles: "ok", extension: "ok" }, packages: [{ name: "pi-lint", version: "1.4.2", newest: "1.4.3", read: "ok" }] });
    html = await page();
    assert.match(html, /package-canary/, "another host's look offers a canary of a trigger from the real triggers file");
    assert.doesNotMatch(html, /package-adopt/, "and no Adopt, with no canary yet");
    const refused = await act("package-adopt", "preview", adoptInput);
    assert.equal(refused.status, 400, "the gate refuses it however the request arrives");
    assert.match(JSON.parse(refused.text).error, /Run a canary of pi-lint 1\.4\.3 first/);

    // The canary ran on host-b. Its record reaches this console only through the mirror host-b wrote.
    const jobId = "trigger-nightly-canary-1";
    const record = { v: 1, jobId, host: "host-b", kind: "local", flow: "fix", outcome: "completed", startedAt: new Date(clock - 120_000).toISOString(), endedAt: new Date(clock - 60_000).toISOString(), tokens: { cost: 0.19 }, packageCanary: { name: "pi-lint", version: "1.4.3", load: "loaded" } };
    await makeRunMirror({ redis, retentionDays: 30, now }).mirror(record, jobId);
    assert.equal(existsSync(join(dep.env.PI_LOGS_DIR, `${jobId}.json`)), false, "this host's own files do not hold it");
    html = await page();
    assert.match(html, /read the run/, "the result, in its one wording");
    assert.doesNotMatch(html, /passed/i, "and never that word");
    assert.match(html, /package-adopt/, "a canary on another host opens Adopt");

    const preview = await act("package-adopt", "preview", adoptInput);
    assert.equal(preview.status, 200, preview.text.slice(0, 200));
    const confirmed = await act("package-adopt", "confirm", { ticket: JSON.parse(preview.text).ticket });
    assert.equal(confirmed.status, 200, confirmed.text.slice(0, 200));
    const desired = JSON.parse(await redis.hget("updates:desired", "pi-lint"));
    assert.deepEqual([desired.version, desired.op, desired.from, desired.by], ["1.4.3", "adopt", "1.4.2", "ops"], "the gate's answer is what the action wrote");
    html = await page();
    assert.match(html, /package-undo/);

    const undoPreview = await act("package-undo", "preview", { name: "pi-lint" });
    assert.equal(undoPreview.status, 200, undoPreview.text.slice(0, 200));
    assert.equal((await act("package-undo", "confirm", { ticket: JSON.parse(undoPreview.text).ticket })).status, 200);
    const undone = JSON.parse(await redis.hget("updates:desired", "pi-lint"));
    assert.deepEqual([undone.op, undone.version, undone.undoOf], ["undo", "1.4.2", desired.generation]);

    // The record expires. A finished canary no one can read any more must not keep Adopt open.
    await redis.del(`runs:rec:${jobId}`);
    await redis.hdel("updates:desired", "pi-lint");
    html = await page();
    assert.doesNotMatch(html, /package-adopt/, "no record, no Adopt");
    assert.deepEqual(err.filter((line) => /unexpected failure|TypeError/.test(line)), []);
  } finally {
    stop();
    await running;
    await deleteOwnKeys(redis);
    redis.disconnect();
  }
});

test("Adopt and Undo on a Valkey that stops answering at their write say it may or may not have been made, and it lands at the wake (issue #843)", { skip: VALKEY ? false : "needs VALKEY_TEST_URL (CI sets it)", timeout: 120_000 }, async () => {
  const url = databaseUrl();
  // Everything that holds a socket is opened inside the try, so a failure anywhere leaves none open and the file ends.
  let redis = null, proxy = null, running = null;
  let stop = () => {};
  try {
    redis = makeRedisClient(url, {});
    await deleteOwnKeys(redis);
    // The console reaches Valkey through a proxy that stops passing bytes at the write's own script: a `kill -STOP` as it leaves.
    proxy = await trippingProxy(url);
    const dep = deployment(proxy.url);
    let clock = NOW;
    const now = () => clock;
    const err = [];
    const io = { env: dep.env, now, uid: process.geteuid?.(), err: (line) => err.push(line) };
    const printed = [];
    assert.equal(await runCli(["token", "add", "--name", "ops", "--role", "operator", "--deployment", dep.dir], { ...io, out: (line) => printed.push(line) }), 0, err.join("\n"));
    const token = printed.join("\n").match(/pdc_[A-Za-z0-9_-]+/)?.[0];
    assert.ok(token, "the token is printed once");
    const until = new Promise((resolve) => (stop = resolve));
    let listening;
    const up = new Promise((resolve) => (listening = resolve));
    running = runCli(["serve", "--deployment", dep.dir], { ...io, out: () => {}, until, onListening: listening });
    const call = httpTo((await up).address().port);
    const login = await call("POST", "/login", { body: { token } });
    assert.equal(login.status, 200, login.text.slice(0, 200));
    const cookie = [].concat(login.headers["set-cookie"]).map((c) => c.split(";")[0]).join("; ");
    const act = (name, step, body) => call("POST", `/api/act/${name}/${step}`, { cookie, body });
    const lastRow = () => readConsoleAudit({ logsDir: dep.env.PI_LOGS_DIR, limit: 1 }).rows[0];
    const desired = async () => JSON.parse(await redis.hget("updates:desired", "pi-lint"));
    const landed = async (op) => {
      const until = Date.now() + 5000;
      while ((await desired())?.op !== op && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
      return await desired();
    };
    // The write's script, by the key only it names: no other script of the console matches.
    const theWrite = /\r\n\$4\r\neval\r\n[\s\S]*updates:generation/i;
    /** Preview while Valkey answers, then confirm with Valkey stopping at `pattern`, or already stopped when there is none. */
    const confirmed = async (name, input, pattern) => {
      // The console's client connects after the console listens, and until it has, its previews say Valkey could not be read.
      let preview;
      for (const until = Date.now() + 5000; ;) {
        clock += CACHE_PASSED;
        preview = await act(name, "preview", input);
        if (preview.status !== 503 || Date.now() > until) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(preview.status, 200, preview.text.slice(0, 300));
      const before = await desired();
      const frozen = pattern ? proxy.freezeAt(pattern) : Promise.resolve(proxy.freeze());
      const started = performance.now();
      const confirm = await act(name, "confirm", { ticket: JSON.parse(preview.text).ticket });
      const took = performance.now() - started;
      // The confirm has answered, so the command it was to stop at has been sent, or never will be: no wait without an end.
      assert.equal(await Promise.race([frozen.then(() => "stopped"), new Promise((resolve) => setTimeout(resolve, 1000, "never sent"))]), "stopped", "Valkey stopped answering at the named command");
      assert.deepEqual(await desired(), before, "nothing reached Valkey while it did not answer");
      return { status: confirm.status, said: JSON.parse(confirm.text).error, took, row: lastRow() };
    };
    const lost = (name) => `Valkey did not confirm the ${name} change, so it may or may not have been made. Look again once Valkey answers; the console's log has the reason`;
    const LOST_ROW = "the write threw (ETIMEDOUT); Valkey did not confirm it, so it may or may not have been made";

    // What opens Adopt: another host's look, and its canary's record through the mirror.
    await publishLook(redis, { v: 1, host: "host-b", at: clock, everyHours: 24, pi: { pinned: "1.5.0", newest: "1.5.0", read: "ok", checks: null }, hostPi: { version: "1.5.0", tested: "1.5.0", state: "same", needles: "ok", extension: "ok" }, packages: [{ name: "pi-lint", version: "1.4.2", newest: "1.4.3", read: "ok" }] });
    const jobId = "trigger-nightly-canary-843";
    await makeRunMirror({ redis, retentionDays: 30, now }).mirror({ v: 1, jobId, host: "host-b", kind: "local", flow: "fix", outcome: "completed", startedAt: new Date(clock - 120_000).toISOString(), endedAt: new Date(clock - 60_000).toISOString(), tokens: { cost: 0.19 }, packageCanary: { name: "pi-lint", version: "1.4.3", load: "loaded" } }, jobId);

    const adopt = await confirmed("package-adopt", { name: "pi-lint", version: "1.4.3" }, theWrite);
    assert.equal(adopt.status, 500, adopt.said);
    assert.equal(adopt.said, lost("package-adopt"));
    assert.deepEqual([adopt.row.kind, adopt.row.outcome, adopt.row.reason], ["package-adopt", "failed", LOST_ROW]);
    assert.ok(adopt.took > 4000 && adopt.took < 9000, `the client's bound decided, not a shorter timer (${Math.round(adopt.took)} ms)`);
    proxy.thaw();
    const adopted = await landed("adopt");
    assert.deepEqual([adopted?.op, adopted?.version, adopted?.from], ["adopt", "1.4.3", "1.4.2"], "the row the confirm could not vouch for landed when Valkey woke");

    // Valkey stopped before the confirm: its look at the desired rows is not answered. Nobody changed the package.
    const blind = await confirmed("package-undo", { name: "pi-lint" }, null);
    assert.equal(blind.status, 503, blind.said);
    assert.equal(blind.said, VALKEY_UNREACHABLE);
    assert.deepEqual([blind.row.kind, blind.row.outcome, blind.row.reason], ["package-undo", "failed", "Valkey could not be reached"]);
    assert.ok(blind.took < 4500, `after one read's bound, not after every read the page's facts make (${Math.round(blind.took)} ms)`);
    proxy.thaw();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await desired()).generation, adopted.generation, "and nothing was written");

    const undo = await confirmed("package-undo", { name: "pi-lint" }, theWrite);
    assert.equal(undo.status, 500, undo.said);
    assert.equal(undo.said, lost("package-undo"));
    assert.deepEqual([undo.row.kind, undo.row.outcome, undo.row.reason], ["package-undo", "failed", LOST_ROW]);
    proxy.thaw();
    const undone = await landed("undo");
    assert.deepEqual([undone?.op, undone?.version, undone?.undoOf], ["undo", "1.4.2", adopted.generation]);
    assert.deepEqual(err.filter((line) => /unexpected failure|TypeError/.test(line)), []);
  } finally {
    proxy?.thaw();
    stop();
    await running?.catch(() => {});
    if (redis) {
      await deleteOwnKeys(redis).catch(() => {});
      redis.disconnect();
    }
    proxy?.close();
  }
});
