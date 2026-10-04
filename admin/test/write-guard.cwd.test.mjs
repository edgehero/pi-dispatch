import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";

// The write guard in a session with NO deployment (issue #504 part C): no pointer, no PI_* key. The panel's cwd
// defaults (./triggers.json, ./scoped-limits.json, ./projects.json) are files the worker never reads then
// (config.mjs: each key is null when unset), so a repository that happens to hold one must not be refused. Its own
// file, because the pointer and the cwd are process state.

for (const k of Object.keys(process.env)) if (k.startsWith("PI_") || k === "VALKEY_URL") delete process.env[k];
const repo = tempDir("pd-guard-repo-");
process.env.PI_DISPATCH_DEPLOYMENT_FILE = join(repo, "no-pointer-here.json");
for (const n of ["triggers.json", "scoped-limits.json", "projects.json"]) writeFileSync(join(repo, n), "{}\n");
const saved = process.cwd();
process.chdir(repo);
const { createJiti } = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("jiti");
const indexMod = await createJiti(import.meta.url).import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
const handlers = [];
indexMod.default(new Proxy({}, { get: (_t, k) => (k === "on" ? (event, h) => event === "tool_call" && handlers.push(h) : () => {}) }));
const write = (path) => handlers[0]({ type: "tool_call", toolName: "write", toolCallId: "c", input: { path, content: "x" } }, { cwd: repo });

test("with no deployment, a repository's own triggers.json, scoped-limits.json and projects.json are not guarded", async () => {
  try {
    for (const n of ["triggers.json", "scoped-limits.json", "projects.json"]) assert.equal(await write(n), undefined, n);
    // The key set (as a deployment's .env or pointer would set it): the worker reads that file, so it is guarded.
    process.env.PI_TRIGGERS_FILE = join(repo, "triggers.json");
    assert.equal((await write("triggers.json"))?.block, true, "a configured key makes it the deployment's file");
    assert.equal(await write("scoped-limits.json"), undefined, "and only that one");
  } finally {
    delete process.env.PI_TRIGGERS_FILE;
    process.chdir(saved);
  }
});

test("an init scaffold folder (its four files there) guards the panel's own cwd targets, and a session .env only ADDS, relative paths included", async () => {
  const dep = tempDir("pd-guard-scaffold-");
  for (const n of [".env", "triggers.json", "pause-windows.json", "subscriptions.json", "projects.json"]) writeFileSync(join(dep, n), n === ".env" ? "PI_ENVELOPE_FILE=./envelope.json\nPI_SETTINGS_FILE=\"conf/settings.json\"\n" : "{}\n");
  const savedCwd = process.cwd();
  try {
    process.chdir(dep);
    const at = (p) => handlers[0]({ type: "tool_call", toolName: "write", toolCallId: "c", input: { path: p, content: "x" } }, { cwd: dep });
    for (const p of ["triggers.json", "scoped-limits.json", "projects.json", ".env", "envelope.json", "conf/settings.json"]) assert.equal((await at(p))?.block, true, p);
    assert.equal(await at("pause-windows.json"), undefined, "a file no guarded tool or key names passes");
    // The .env named the envelope, but configuration is untouched: the panel still reads no envelope from it.
    assert.equal(indexMod.guardedFiles().some((g) => g.path.endsWith("/envelope.json")), true);
    assert.equal(process.env.PI_ENVELOPE_FILE, undefined);
  } finally {
    process.chdir(savedCwd);
  }
});
