import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { makeRedisClient, parseConnection } from "@edgehero/pi-dispatch/connection";
import { makeQueue } from "@edgehero/pi-dispatch/queue";
import { freezingProxy } from "../../worker/test/helpers/freezing-proxy.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * Issue #842: the stop of the real program, `pi-dispatch-console serve` run as a child process against a live Valkey
 * (VALKEY_TEST_URL, database 5 of it, where only this file's keys are written and deleted). What a test that calls
 * `runCli` in its own process cannot see: that the process exits once `serve` has returned, that nothing in flight is
 * cut by that exit, and that a handle left open does not hold it.
 *
 * The child is given the test Valkey in its environment AND in its deployment's `.env`, so no default address is read.
 */
const BASE = process.env.VALKEY_TEST_URL;
const live = { skip: BASE ? false : "needs VALKEY_TEST_URL", timeout: 120_000 };
const CLI = fileURLToPath(new URL("../src/console/cli.mjs", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The child's exit, or null when it has not exited within `ms`. */
function exitWithin(exited, ms) {
  let timer;
  return Promise.race([exited, new Promise((resolve) => (timer = setTimeout(resolve, ms, null)))]).finally(() => clearTimeout(timer));
}

function urlOfDatabase(n) {
  const u = new URL(BASE);
  u.pathname = `/${n}`;
  return u.toString();
}

/** A deployment folder of this test's own, its `.env` naming `valkeyUrl`, and the child's environment for it. */
function deploymentFor(valkeyUrl) {
  const dir = tempDir("console-stop-");
  writeFileSync(join(dir, ".env"), `VALKEY_URL=${valkeyUrl}\nPI_LOGS_DIR=${join(dir, "logs")}\nPI_CONSOLE_LISTEN=127.0.0.1:0\n`);
  chmodSync(join(dir, ".env"), 0o600);
  writeFileSync(join(dir, "triggers.json"), '{ "triggers": [] }\n');
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, VALKEY_URL: valkeyUrl, PI_DISPATCH_DEPLOYMENT_FILE: join(dir, "no-pointer.json") };
  return { dir, env, lock: join(dir, "logs", "console-audit", ".console.lock") };
}

/** Run the program to its end: `{ code, out }`. */
function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("exit", (code) => resolve({ code, out }));
  });
}

/** Start `serve`, wait for its listening line, sign in: `{ child, exited, port, cookie, post }`. */
async function serving(dep) {
  const made = await run(["token", "add", "--name", "tester", "--role", "operator", "--deployment", dep.dir], dep.env);
  assert.equal(made.code, 0, made.out.replace(/pdc_\S+/g, "pdc_<token>"));
  const token = made.out.split("\n").find((line) => line.startsWith("pdc_")).trim();
  const child = spawn(process.execPath, [CLI, "serve", "--deployment", dep.dir], { env: dep.env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, at: Date.now() })));
  const port = await (async () => {
    for (let i = 0; i < 300; i += 1) {
      const m = /pi-dispatch console on http:\/\/[^:]+:(\d+)\//.exec(out);
      if (m) return Number(m[1]);
      await sleep(50);
    }
    child.kill("SIGKILL");
    assert.fail(`serve did not start: ${out}`);
  })();
  const post = (path, body, cookie = null) =>
    new Promise((resolve) => {
      const text = JSON.stringify(body);
      const req = request({ host: "127.0.0.1", port, method: "POST", path, headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "sec-fetch-site": "same-origin", "content-type": "application/json", "content-length": Buffer.byteLength(text), ...(cookie ? { cookie } : {}) }, setHost: false }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            // a body that is no JSON is left null
          }
          resolve({ status: res.statusCode, json, headers: res.headers });
        });
      });
      req.on("error", (e) => resolve({ status: `connection ${e.code}`, json: null, headers: {} }));
      req.end(text);
    });
  const login = await post("/login", { token });
  assert.equal(login.status, 200);
  // What the test's process still holds of the child once it is done with it: the child itself, and its two pipes.
  const release = () => {
    child.kill("SIGKILL");
    child.stdout.destroy();
    child.stderr.destroy();
  };
  return { child, exited, port, post, release, cookie: login.headers["set-cookie"][0].split(";")[0], out: () => out };
}

const auditRows = (dep) =>
  readdirSync(join(dep.dir, "logs", "console-audit"))
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .flatMap((name) => readFileSync(join(dep.dir, "logs", "console-audit", name), "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line)));

/** Delete this file's keys in its database: the shared queue's, which is the only queue it builds. */
async function clean(url) {
  const redis = makeRedisClient(url);
  redis.on("error", () => {});
  const keys = await redis.keys("bull:pi-jobs:*");
  if (keys.length > 0) await redis.del(...keys);
  redis.disconnect();
}

test("SIGTERM during a bulk retry on a Valkey that answers: the program exits 0 with every job retried and audited, and its lock gone (#842, VALKEY_TEST_URL)", live, async () => {
  const url = urlOfDatabase(5);
  const dep = deploymentFor(url);
  const { Worker } = await import("bullmq");
  const queue = makeQueue(parseConnection(url, { failFast: true }));
  let con = null;
  try {
    await clean(url);
    await queue.addBulk(Array.from({ length: 100 }, (_, i) => ({ name: "github", data: { kind: "github", repo: "o/r" }, opts: { jobId: `stop-${i}`, attempts: 1 } })));
    const worker = new Worker("pi-jobs", async () => { throw new Error("seeded failure"); }, { connection: parseConnection(url), concurrency: 50 });
    worker.on("error", () => {});
    for (let i = 0; i < 400 && (await queue.getFailedCount()) < 100; i += 1) await sleep(50);
    await worker.close();
    assert.equal(await queue.getFailedCount(), 100);
    con = await serving(dep);
    const preview = await con.post("/api/act/retry-all-failed/preview", {}, con.cookie);
    assert.equal(preview.json?.targets?.length, 100, JSON.stringify(preview.json?.error));
    const confirm = con.post("/api/act/retry-all-failed/confirm", { ticket: preview.json.ticket }, con.cookie);
    await sleep(15);
    const at = Date.now();
    con.child.kill("SIGTERM");
    const end = await exitWithin(con.exited, 20_000);
    assert.ok(end, "the program exited");
    assert.deepEqual([end.code, end.signal], [0, null], con.out());
    assert.ok(end.at - at < 8000, `${end.at - at} ms`);
    assert.deepEqual(await queue.getJobCounts("failed", "waiting"), { failed: 0, waiting: 100, paused: 0 }, "the stop cut none of the confirm in flight");
    const rows = auditRows(dep).filter((r) => r.kind === "failed-retry-all");
    assert.deepEqual([rows.length, rows.filter((r) => r.outcome !== "ok").length], [100, 0], "an ok row per job, and no row saying one was cut");
    assert.equal((await confirm).json?.done, 100, "and the confirm was answered before the listener closed");
    assert.equal(existsSync(dep.lock), false, "the lock is gone");
  } finally {
    con?.release();
    await queue.close().catch(() => {});
    await clean(url);
  }
});

test("SIGTERM with a read in flight on a Valkey that stopped answering: a queue that is still connecting does not hold the program (#842, VALKEY_TEST_URL)", live, async () => {
  const proxy = await freezingProxy(urlOfDatabase(5));
  const dep = deploymentFor(proxy.url);
  let con = null;
  try {
    con = await serving(dep);
    proxy.freeze();
    // A preview that builds a queue of its own: on a Valkey that takes connections and answers nothing that queue
    // keeps trying to connect for over half a minute, with sockets and timers that hold a process open.
    void con.post("/api/act/retry-all-failed/preview", {}, con.cookie);
    await sleep(3500);
    const at = Date.now();
    con.child.kill("SIGTERM");
    const end = await exitWithin(con.exited, 20_000);
    assert.ok(end, `the program exited though a queue was still connecting: ${con.out()}`);
    assert.deepEqual([end.code, end.signal], [0, null]);
    assert.ok(end.at - at < 8000, `${end.at - at} ms: the reader's close bound, not the queue's half minute`);
    assert.equal(existsSync(dep.lock), false, "the lock is gone");
  } finally {
    con?.release();
    proxy.thaw();
    proxy.close();
    await clean(urlOfDatabase(5));
  }
});
