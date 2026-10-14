import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { CONSOLE_ENV_KEYS, consoleConfig, consoleEnv, DEFAULT_LISTEN, deploymentDirOf } from "../src/console/config.mjs";

// The console's configuration (issue #640): every problem a refusal sentence, nothing clamped, nothing guessed.

const DIR = "/srv/deploy";

test("defaults: loopback 4790, 60 min idle, 12 h max, 4 streams, files in the deployment folder", () => {
  const c = consoleConfig({ env: { PI_LOGS_DIR: "/var/log/pd" }, dir: DIR });
  assert.equal(DEFAULT_LISTEN, "127.0.0.1:4790");
  assert.deepEqual(c.listen, { kind: "tcp", host: "127.0.0.1", port: 4790 });
  assert.equal(c.tokensPath, "/srv/deploy/console-tokens.json");
  assert.equal(c.pauseWindowsPath, "/srv/deploy/pause-windows.json");
  assert.equal(c.logsDir, "/var/log/pd");
  assert.equal(c.idleMs, 60 * 60_000);
  assert.equal(c.maxMs, 12 * 3_600_000);
  assert.equal(c.maxStreams, 4);
  assert.equal(c.readOnly, false);
  assert.equal(c.bindPublic, false);
  assert.deepEqual(c.allowedHosts, []);
});

test("explicit values, relative paths resolved against the deployment folder, and the tokens path from the injected rule", () => {
  const c = consoleConfig({
    env: { PI_CONSOLE_LISTEN: "[::1]:5000", PI_CONSOLE_TOKENS_FILE: "secrets/t.json", PI_CONSOLE_READ_ONLY: "1", PI_CONSOLE_IDLE_MINUTES: "5", PI_CONSOLE_MAX_HOURS: "168", PI_CONSOLE_MAX_STREAMS: "32", PI_CONSOLE_ALLOWED_HOSTS: " Console.LAN , pd.internal. ", PI_PAUSE_WINDOWS_FILE: "./pw.json", PI_LOGS_DIR: "logs" },
    dir: DIR,
  });
  assert.deepEqual(c.listen, { kind: "tcp", host: "::1", port: 5000 });
  assert.equal(c.tokensPath, "/srv/deploy/secrets/t.json");
  assert.equal(c.pauseWindowsPath, "/srv/deploy/pw.json");
  assert.equal(c.logsDir, "/srv/deploy/logs");
  assert.equal(c.readOnly, true);
  assert.equal(c.idleMs, 5 * 60_000);
  assert.equal(c.maxMs, 168 * 3_600_000);
  assert.equal(c.maxStreams, 32);
  assert.deepEqual(c.allowedHosts, ["console.lan", "pd.internal"]);
  const injected = consoleConfig({ env: {}, dir: DIR, tokensFilePath: (env, dir) => `${dir}/from-rule.json` });
  assert.equal(injected.tokensPath, "/srv/deploy/from-rule.json");
});

test("startup refusals: a public bind, a hostname bind, a too-long socket path, each a sentence", () => {
  assert.match(consoleConfig({ env: { PI_CONSOLE_LISTEN: "0.0.0.0:4790" }, dir: DIR }).refusal, /PI_CONSOLE_BIND_PUBLIC=1/);
  assert.equal(consoleConfig({ env: { PI_CONSOLE_LISTEN: "0.0.0.0:4790", PI_CONSOLE_BIND_PUBLIC: "1" }, dir: DIR }).bindPublic, true);
  assert.match(consoleConfig({ env: { PI_CONSOLE_LISTEN: "localhost:4790" }, dir: DIR }).refusal, /not an IP literal/);
  assert.match(consoleConfig({ env: { PI_CONSOLE_LISTEN: `unix:/${"x".repeat(200)}` }, dir: DIR, platform: "linux" }).refusal, /at most 107/);
});

test("a container gateway name in PI_CONSOLE_ALLOWED_HOSTS refuses the start; so does a value that is not a bare name", () => {
  for (const gw of ["host.docker.internal", "HOST.CONTAINERS.INTERNAL.", "gateway.docker.internal"]) {
    assert.match(consoleConfig({ env: { PI_CONSOLE_ALLOWED_HOSTS: `ok.lan,${gw}` }, dir: DIR }).refusal, /container gateway name/, gw);
  }
  for (const bad of ["http://x.lan", "x.lan:8080", "x lan", "a/b"]) {
    assert.match(consoleConfig({ env: { PI_CONSOLE_ALLOWED_HOSTS: bad }, dir: DIR }).refusal, /not a hostname/, bad);
  }
});

test("bounds are refused, never clamped, and switches take only 1 or unset", () => {
  const cases = [
    ["PI_CONSOLE_IDLE_MINUTES", "4"], ["PI_CONSOLE_IDLE_MINUTES", "1441"], ["PI_CONSOLE_IDLE_MINUTES", "1.5"],
    ["PI_CONSOLE_MAX_HOURS", "0"], ["PI_CONSOLE_MAX_HOURS", "169"],
    ["PI_CONSOLE_MAX_STREAMS", "0"], ["PI_CONSOLE_MAX_STREAMS", "33"], ["PI_CONSOLE_MAX_STREAMS", "four"],
    ["PI_CONSOLE_READ_ONLY", "yes"], ["PI_CONSOLE_BIND_PUBLIC", "true"],
  ];
  for (const [key, value] of cases) assert.match(consoleConfig({ env: { [key]: value }, dir: DIR }).refusal ?? "", new RegExp(key), `${key}=${value}`);
  assert.equal(consoleConfig({ env: { PI_CONSOLE_READ_ONLY: "0" }, dir: DIR }).readOnly, false);
});

test("deploymentDirOf: the flag, else the pointer, else cwd, and an ignored pointer is said", () => {
  const home = tempDir("console-config-");
  const pointer = join(home, "pointer.json");
  const env = { PI_DISPATCH_DEPLOYMENT_FILE: pointer };
  assert.deepEqual(deploymentDirOf({ arg: "rel", env, cwd: "/work" }), { dir: "/work/rel", source: "--deployment", notice: undefined });
  assert.equal(deploymentDirOf({ env, cwd: "/work" }).source, "cwd");
  writeFileSync(pointer, JSON.stringify({ version: 1, deploymentDir: "/srv/pd" }));
  assert.deepEqual(deploymentDirOf({ env, cwd: "/work" }), { dir: "/srv/pd", source: "pointer", notice: undefined });
  writeFileSync(pointer, "{not json");
  const broken = deploymentDirOf({ env, cwd: "/work" });
  assert.equal(broken.dir, "/work");
  assert.match(broken.notice, /pointer was ignored/);
});

test("consoleEnv takes the console keys from the deployment .env, resolves its relative paths, and lets this shell win", { skip: process.platform === "win32" ? "posix modes" : false }, () => {
  const dir = tempDir("console-env-");
  writeFileSync(join(dir, ".env"), "PI_CONSOLE_LISTEN=127.0.0.1:4800\nPI_LOGS_DIR=logs\nPI_CONSOLE_READ_ONLY=1\nGITHUB_TOKEN=nope\n");
  chmodSync(join(dir, ".env"), 0o600);
  const { env, notice } = consoleEnv({ env: { PI_CONSOLE_READ_ONLY: "0" }, dir });
  assert.equal(env.PI_CONSOLE_LISTEN, "127.0.0.1:4800");
  assert.equal(env.PI_LOGS_DIR, join(dir, "logs"));
  assert.equal(env.PI_CONSOLE_READ_ONLY, "0", "the shell's export outranks the file");
  assert.equal(env.GITHUB_TOKEN, undefined, "only the console's keys are taken");
  assert.match(notice, /PI_CONSOLE_READ_ONLY differently/);
  assert.ok(!notice.includes("4800"), "a notice names keys, never values");
  for (const key of ["PI_CONSOLE_LISTEN", "PI_CONSOLE_TOKENS_FILE", "PI_CONSOLE_ALLOWED_HOSTS", "PI_CONSOLE_READ_ONLY", "PI_CONSOLE_BIND_PUBLIC", "PI_CONSOLE_IDLE_MINUTES", "PI_CONSOLE_MAX_HOURS", "PI_CONSOLE_MAX_STREAMS"]) {
    assert.ok(CONSOLE_ENV_KEYS.includes(key), key);
  }
});

test("a blank PI_CONSOLE_LISTEN is the default, as doctor reads it", () => {
  for (const value of ["", "   ", "\t"]) assert.deepEqual(consoleConfig({ env: { PI_CONSOLE_LISTEN: value }, dir: DIR }).listen, { kind: "tcp", host: "127.0.0.1", port: 4790 }, JSON.stringify(value));
});
