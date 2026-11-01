import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { OPENAI_REDIRECT_URI, verifyPinnedOpenAIOAuth } from "../../worker/src/oauth-openai.mjs";

test("the host guide states the actual worker callback and the pinned upstream URI, with real owner/context recovery", () => {
  assert.equal(verifyPinnedOpenAIOAuth(), true, "the named upstream file is still the reviewed pinned bytes");
  const source = readFileSync(new URL("../../worker/src/oauth-openai.mjs", import.meta.url), "utf8");
  const redirect = OPENAI_REDIRECT_URI;
  assert.ok(source.includes("redirect_uri: OPENAI_REDIRECT_URI"), "login and token exchange use the reviewed callback constant");
  const [port, host] = /server\.listen\((\d+), "([^"]+)"/.exec(source).slice(1);
  const upstreamPath = fileURLToPath(new URL("../auth/oauth/openai-chatgpt.js", import.meta.resolve("@earendil-works/pi-ai/providers/openai")));
  const upstream = readFileSync(upstreamPath, "utf8");
  const upstreamPort = /const CALLBACK_PORT = (\d+);/.exec(upstream)[1];
  const upstreamCallback = /const CALLBACK_PATH = "([^"]+)"/.exec(upstream)[1];
  assert.ok(upstream.includes('const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;'));
  const guide = readFileSync(new URL("../../docs/subscription-auth.md", import.meta.url), "utf8");
  assert.equal(redirect, `http://127.0.0.1:${upstreamPort}${upstreamCallback}`, "worker and pinned upstream must agree before claiming compatibility");
  assert.ok(guide.includes(redirect), "the worker's exact requested callback is disclosed");
  assert.ok(guide.includes(`ssh -L ${port}:${host}:${port}`), "the tunnel follows the real listener rather than the console port");
  assert.ok(guide.includes(`http://127.0.0.1:${upstreamPort}${upstreamCallback}`), "the upstream callback is identified separately");
  const cli = readFileSync(new URL("../../worker/src/cli.mjs", import.meta.url), "utf8");
  for (const key of ["PI_AUTH_CONNECTIONS_FILE", "PI_AUTH_STORE_DIR", "PI_WORKER_NAME", "PI_SETTINGS_FILE", "VALKEY_URL"]) { assert.ok(cli.includes(`"${key}"`)); assert.ok(guide.includes(key)); }
  assert.match(guide, /does not itself perform a live authenticated login/);
  assert.match(guide, /auth login chatgpt-main/);
  assert.match(guide, /ownerHost.*match the effective[\s\S]*PI_WORKER_NAME/);
});
