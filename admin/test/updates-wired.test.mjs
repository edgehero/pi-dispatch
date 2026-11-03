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
import { tempDir } from "./helpers/temp-dir.mjs";

const VALKEY = process.env.VALKEY_TEST_URL;
// CI sets this, which turns a missing URL into a failure rather than a quiet skip.
if (!VALKEY && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS) throw new Error("updates-wired.test REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS is set");

// Database 10, emptied before and after: updates:* and runs:* are not prefixed, and other files use their own databases.
const databaseUrl = () => {
  const url = new URL(VALKEY);
  url.pathname = "/10";
  return url.href;
};
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
  await redis.flushdb();
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
    await redis.flushdb();
    redis.disconnect();
  }
});
