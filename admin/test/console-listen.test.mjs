import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { isLoopbackAddress, listenOn, listenUrl, parseListen } from "../src/console/listen.mjs";

// Where the console binds (issue #640, REQ-CONSOLE-SECURITY a and j).

test("parseListen: loopback IP literals and absolute socket paths", () => {
  assert.deepEqual(parseListen("127.0.0.1:4790"), { kind: "tcp", host: "127.0.0.1", port: 4790 });
  assert.deepEqual(parseListen("127.8.9.10:1"), { kind: "tcp", host: "127.8.9.10", port: 1 });
  assert.deepEqual(parseListen("[::1]:4790"), { kind: "tcp", host: "::1", port: 4790 });
  assert.deepEqual(parseListen("unix:/run/user/1000/pd.sock"), { kind: "unix", path: "/run/user/1000/pd.sock" });
});

test("parseListen refuses a public bind unless PI_CONSOLE_BIND_PUBLIC=1", () => {
  for (const value of ["0.0.0.0:4790", "192.168.1.5:4790", "[::]:4790", "[2001:db8::1]:4790", "[::ffff:192.168.1.5]:4790"]) {
    assert.match(parseListen(value).refusal, /not a loopback address.*PI_CONSOLE_BIND_PUBLIC/, value);
  }
  assert.deepEqual(parseListen("0.0.0.0:4790", { bindPublic: true }), { kind: "tcp", host: "0.0.0.0", port: 4790 });
  // a v4-mapped loopback literal is loopback, and is judged as such
  assert.equal(parseListen("[::ffff:127.0.0.1]:4790").kind, "tcp");
});

test("parseListen refuses hostnames, even localhost, and every malformed value, each with a sentence", () => {
  for (const name of ["localhost:4790", "console.lan:4790", "[localhost]:4790"]) assert.match(parseListen(name).refusal ?? "", /not (an IP literal|\[ipv6\])|IP literal/, name);
  assert.match(parseListen("localhost:4790").refusal, /hostname can resolve anywhere/);
  for (const bad of ["", "127.0.0.1", "127.0.0.1:", "127.0.0.1:65536", "127.0.0.1:-1", "127.0.0.1:http", "::1:4790", "[::1]4790", "unix:relative.sock", "unix:"]) {
    assert.equal(typeof parseListen(bad).refusal, "string", JSON.stringify(bad));
  }
  assert.match(parseListen("::1:4790").refusal, /without brackets/);
});

test("parseListen refuses a socket path longer than the platform's sun_path, by name", () => {
  const at = (n) => `/${"a".repeat(n - 1)}`;
  assert.equal(parseListen(`unix:${at(103)}`, { platform: "darwin" }).kind, "unix");
  assert.match(parseListen(`unix:${at(104)}`, { platform: "darwin" }).refusal, /104 bytes.*at most 103/);
  assert.equal(parseListen(`unix:${at(107)}`, { platform: "linux" }).kind, "unix");
  assert.match(parseListen(`unix:${at(108)}`, { platform: "linux" }).refusal, /at most 107/);
  // bytes, not characters: a multibyte name counts what the kernel counts
  const wide = `/${"é".repeat(52)}`;
  assert.equal(wide.length, 53);
  assert.match(parseListen(`unix:${wide}`, { platform: "darwin" }).refusal, /105 bytes/);
});

test("isLoopbackAddress and listenUrl", () => {
  assert.ok(isLoopbackAddress("127.0.0.1") && isLoopbackAddress("127.255.0.1") && isLoopbackAddress("::1") && isLoopbackAddress("0:0:0:0:0:0:0:1"));
  assert.ok(!isLoopbackAddress("128.0.0.1") && !isLoopbackAddress("::") && !isLoopbackAddress("localhost"));
  assert.equal(listenUrl({ kind: "tcp", host: "::1", port: 80 }), "http://[::1]:80/");
  assert.equal(listenUrl({ kind: "tcp", host: "127.0.0.1", port: 0 }, 5555), "http://127.0.0.1:5555/");
  assert.equal(listenUrl({ kind: "unix", path: "/x" }), null);
});

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("listenOn binds TCP and refuses a port in use with a sentence", async () => {
  const a = createServer();
  const bound = await listenOn(a, { kind: "tcp", host: "127.0.0.1", port: 0 });
  assert.equal(bound.ok, true);
  const b = createServer();
  const again = await listenOn(b, { kind: "tcp", host: "127.0.0.1", port: bound.address.port });
  assert.match(again.refusal, /already in use/);
  await close(a);
});

const unixOnly = process.platform === "win32" ? "unix sockets are not this platform's" : false;

// A short directory: tmpdir() on macOS is already ~50 bytes, so the socket name is kept to a few characters.
function socketDir() {
  const dir = join(tempDir("pdc-"), "s");
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

test("unix socket: created 0600 in a 0700 directory, and it serves HTTP", { skip: unixOnly }, async () => {
  const path = join(socketDir(), "c.sock");
  const server = createServer((req, res) => res.end(`host=${req.headers.host}`));
  const bound = await listenOn(server, { kind: "unix", path });
  assert.equal(bound.ok, true, bound.refusal);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const body = await new Promise((resolve, reject) => {
    request({ socketPath: path, path: "/", headers: { host: "localhost:9999" } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve(text));
    }).on("error", reject).end();
  });
  assert.equal(body, "host=localhost:9999");
  // a second console on the same live socket is refused, never displaces the first
  const second = await listenOn(createServer(), { kind: "unix", path });
  assert.match(second.refusal, /another process is listening/);
  await close(server);
});

test("unix socket: a permissive, foreign, missing or symlinked directory is refused", { skip: unixOnly }, async () => {
  const dir = socketDir();
  chmodSync(dir, 0o755);
  assert.match((await listenOn(createServer(), { kind: "unix", path: join(dir, "c.sock") })).refusal, /mode 755.*chmod 700/);
  chmodSync(dir, 0o700);
  assert.match((await listenOn(createServer(), { kind: "unix", path: join(dir, "c.sock") }, { uid: 999999 })).refusal, /owned by uid/);
  assert.match((await listenOn(createServer(), { kind: "unix", path: join(dir, "nope", "c.sock") })).refusal, /does not exist/);
  // a symlink to a good directory is still refused: the link could be repointed between the check and the bind
  const link = join(socketDir(), "link");
  symlinkSync(dir, link);
  const linked = await listenOn(createServer(), { kind: "unix", path: join(link, "c.sock") });
  assert.ok(linked.refusal, "a symlinked socket directory is refused");
  assert.equal(existsSync(join(dir, "c.sock")), false, "nothing was bound through the link");
});

test("unix socket: a stale socket (its process killed) is replaced; a regular file at the path is left alone and refused", { skip: unixOnly }, async () => {
  const dir = socketDir();
  const path = join(dir, "c.sock");
  // A process that dies by SIGKILL never removes its socket file, which is exactly the stale case.
  const child = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.stdout.write("up"))`], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve) => child.stdout.once("data", resolve));
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  assert.ok(lstatSync(path).isSocket(), "the dead process left its socket behind");
  const server = createServer();
  const res = await listenOn(server, { kind: "unix", path });
  assert.equal(res.ok, true, res.refusal);
  await close(server);
  const file = join(dir, "f.sock");
  writeFileSync(file, "not a socket");
  assert.match((await listenOn(createServer(), { kind: "unix", path: file })).refusal, /not a socket.*left alone/);
});
