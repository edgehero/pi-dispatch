import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";

// The write guard as the extension registers it (issue #504 part C), in a deployment found through the POINTER and
// its `.env`, which is the shape the wizard builds. Its own file, because the pointer is applied once per process.
// write-guard.session.test.mjs shows pi routes a model's call (nested ones included) to this handler; here the
// handler's file set is what is judged: the `.env` and the pointer are guarded, the set never shrinks when `.env`
// is pointed elsewhere, and a cwd default is guarded only when its key is set.

for (const k of Object.keys(process.env)) if (k.startsWith("PI_") || k === "VALKEY_URL") delete process.env[k];
const root = tempDir("pd-guard-wired-");
const dep = join(root, "dep");
const agent = join(root, "agent");
mkdirSync(dep);
mkdirSync(agent);
const envText = (projects) => [`PI_PROJECTS_FILE=${projects}`, `PI_SETTINGS_FILE=${join(dep, "settings.json")}`, `PI_TRIGGERS_FILE=${join(dep, "triggers.json")}`, `PI_SCOPED_LIMITS_FILE=${join(dep, "scoped-limits.json")}`, `PI_ENVELOPE_FILE=${join(dep, "envelope.json")}`, ""].join("\n");
writeFileSync(join(dep, ".env"), envText(join(dep, "projects.json")));
chmodSync(join(dep, ".env"), 0o600);
for (const n of ["projects", "envelope", "settings", "triggers", "scoped-limits"]) writeFileSync(join(dep, `${n}.json`), "{}\n");
const pointer = join(agent, "pi-dispatch-deployment.json");
writeFileSync(pointer, JSON.stringify({ version: 1, deploymentDir: dep, env: {} }));
process.env.PI_DISPATCH_DEPLOYMENT_FILE = pointer;

const { createJiti } = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("jiti");
const indexMod = await createJiti(import.meta.url).import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
const handlers = [];
indexMod.default(new Proxy({}, { get: (_t, k) => (k === "on" ? (event, h) => event === "tool_call" && handlers.push(h) : () => {}) }));
const guard = (path, toolName = "write") => handlers[0]({ type: "tool_call", toolName, toolCallId: "c", input: toolName === "edit" ? { path, edits: [{ oldText: "a", newText: "b" }] } : { path, content: "x" } }, { cwd: root });

test("the deployment's .env and the pointer are guarded, beside the five files they name", async () => {
  assert.equal(handlers.length, 1);
  for (const n of ["projects", "envelope", "settings", "triggers", "scoped-limits"]) assert.equal((await guard(join(dep, `${n}.json`)))?.block, true, n);
  const env = await guard(join(dep, ".env"), "edit");
  assert.equal(env?.block, true, "an edit of .env, which names every guarded path");
  assert.match(env.reason, /the deployment's \.env/);
  assert.equal((await guard(pointer))?.block, true, "the pointer, which names the deployment");
  assert.equal(await guard(join(dep, "notes.md")), undefined, "an unrelated file beside them passes");
});

test("pointing .env elsewhere does not unguard the files guarded before: the set only grows within a session", async () => {
  // As bash or the operator's editor could: the guard itself refuses a write tool on .env.
  const decoy = join(root, "decoy.json");
  writeFileSync(join(dep, ".env"), envText(decoy));
  assert.equal((await guard(decoy))?.block, true, "the new target is guarded from the next call");
  assert.equal((await guard(join(dep, "projects.json")))?.block, true, "and the original stays guarded");
  writeFileSync(join(dep, ".env"), envText(join(dep, "projects.json")));
  assert.equal((await guard(decoy))?.block, true, "a file once guarded stays guarded for the session");
  assert.equal(readFileSync(join(dep, "projects.json"), "utf8"), "{}\n");
});
