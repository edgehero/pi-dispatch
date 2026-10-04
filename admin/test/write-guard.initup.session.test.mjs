import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";

// A deployment built with `init` then `up` (issue #504 part C, review round 2): its paths live in its own `.env`, as
// absolute PI_*_FILE lines, there is NO pointer (only the setup wizard writes one), and pi is started in that folder
// with nothing exported. The panel never reads that `.env` for configuration, so before this rule the guard held
// only the settings overlay, while the panel's own confirm tools write the same files. A real pi session (faux
// provider), in its own process: the cwd and the pointer are process state.

for (const k of Object.keys(process.env)) if (k.startsWith("PI_") || k === "VALKEY_URL") delete process.env[k];
const root = tempDir("pd-504c-initup-");
const dep = join(root, "pi-dispatch");
const agent = tempDir("pd-504c-initup-agent-");
process.env.PI_DISPATCH_DEPLOYMENT_FILE = join(agent, "no-pointer.json");
const { mkdirSync } = await import("node:fs");
mkdirSync(dep);
const named = { PI_TRIGGERS_FILE: "triggers.json", PI_PROJECTS_FILE: "projects.json", PI_SCOPED_LIMITS_FILE: "scoped-limits.json", PI_ENVELOPE_FILE: "envelope.json" };
writeFileSync(join(dep, ".env"), `VALKEY_URL=redis://127.0.0.1:6390\n${Object.entries(named).map(([k, n]) => `${k}=${join(dep, n)}`).join("\n")}\n`, { mode: 0o600 });
for (const n of Object.values(named)) writeFileSync(join(dep, n), "ORIG\n");
const savedCwd = process.cwd();
process.chdir(dep);

const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const pi = await import(new URL("index.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const ai = await import(import.meta.resolve("@earendil-works/pi-ai", import.meta.resolve("@earendil-works/pi-coding-agent")));
const indexMod = await piRequire("jiti").createJiti(import.meta.url).import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));

async function runSession(responses) {
  const faux = ai.fauxProvider();
  const runtime = await pi.ModelRuntime.create({ authPath: join(agent, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  faux.setResponses(responses);
  const loader = new pi.DefaultResourceLoader({ cwd: dep, agentDir: agent, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [(api) => indexMod.default(api)] });
  await loader.reload();
  const { session } = await pi.createAgentSession({ cwd: dep, agentDir: agent, model: faux.getModel(), modelRuntime: runtime, resourceLoader: loader, sessionManager: pi.SessionManager.inMemory(dep), settingsManager: pi.SettingsManager.inMemory({}), tools: ["write"] });
  try {
    await session.prompt("go");
    return session.messages.filter((m) => m.role === "toolResult").map((m) => ({ isError: m.isError, text: (m.content ?? []).map((c) => c.text ?? "").join("") }));
  } finally {
    session.dispose();
  }
}
const call = (name, args) => ai.fauxAssistantMessage([ai.fauxToolCall(name, args)], { stopReason: "toolUse" });

test("init + up, no pointer, pi started in the deployment: every file its .env names, and that .env, are guarded", async () => {
  try {
    const out = await runSession([
      ...Object.values(named).map((n) => call("write", { path: n, content: "PWN" })),
      call("write", { path: ".env", content: "PWN" }),
      call("write", { path: "notes.md", content: "fine" }),
      ai.fauxAssistantMessage("done"),
    ]);
    for (const [i, n] of Object.values(named).entries()) {
      assert.equal(out[i].isError, true, n);
      assert.match(out[i].text, /^pi-dispatch blocked this write/);
      assert.equal(readFileSync(join(dep, n), "utf8"), "ORIG\n", `${n} untouched`);
    }
    assert.equal(out[4].isError, true, ".env");
    assert.match(out[4].text, /the deployment's \.env/);
    assert.equal(out[5].isError, false, "an unrelated file in the same folder is written");
  } finally {
    process.chdir(savedCwd);
  }
});
