import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { fakeAllocRedis } from "./helpers/fake-alloc-redis.mjs";

// The write guard and the delegated allocation write against a REAL pi 0.99.1 AgentSession (issue #504 part C): pi's
// own agent loop, tool pipeline and `tool_call` hooks, driven by pi-ai's faux provider so no network and no key is
// involved. The unit tests in write-guard.test.mjs judge the handler; these prove pi actually routes a model-issued
// `write`, a nested `ctx.executeTool` call and a codemode script's call through it, and that the delegated write
// applies in a session with no UI (what `pi -p` has).
//
// pi's SDK entry points are imported by file path: the package's `exports` map is ESM-only and this admin package
// has it as a devDependency, so `import.meta.resolve` finds the directory the same way the jiti loader below does.
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const pi = await import(new URL("index.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const ai = await import(import.meta.resolve("@earendil-works/pi-ai", import.meta.resolve("@earendil-works/pi-coding-agent")));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const indexMod = await jiti.import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));

const NOW = Date.parse("2026-10-05T12:00:00Z");

// A deployment pointer, set before the first session loads the extension (the pointer is applied once per process):
// its folder's `.env` names the deployment, so a model that could edit it could point the guard elsewhere. The
// per-test env keys below still win over it, as an operator's exports win over the pointer.
const pointed = tempDir("pd-504c-pointed-");
writeFileSync(join(pointed, ".env"), `PI_PROJECTS_FILE=${join(pointed, "projects.json")}\n`);
writeFileSync(join(pointed, "pointer.json"), JSON.stringify({ version: 1, deploymentDir: pointed, env: {} }));
process.env.PI_DISPATCH_DEPLOYMENT_FILE = join(pointed, "pointer.json");
const ENV_KEYS = ["PI_PROJECTS_FILE", "PI_SCOPED_LIMITS_FILE", "PI_ENVELOPE_FILE", "PI_SETTINGS_FILE", "PI_LOGS_DIR", "PI_MAX_COST_USD", "VALKEY_URL", "PI_WORKER_NAME", "PI_TRIGGERS_FILE"];

const ENVELOPE = {
  version: 1,
  window: "week",
  totalUsd: "100",
  floorsUsd: { shop: "10", platform: "10", _other: "0" },
  defaultWeights: { shop: 1, platform: 1, _other: 0 },
  delegation: { enabled: true, writers: ["operator-session", "portfolio-job"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 },
};

/** A deployment folder with every guarded file, the env pointed at it, the allocation seams on a fake; restored after. */
async function withDeployment(fn) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const dir = tempDir("pd-504c-session-");
  const files = {
    projects: join(dir, "projects.json"),
    limits: join(dir, "scoped-limits.json"),
    envelope: join(dir, "envelope.json"),
    settings: join(dir, "settings.json"),
    triggers: join(dir, "triggers.json"),
    logs: join(dir, "logs"),
  };
  writeFileSync(files.projects, JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["github:acme/web", "github:acme/api"] }, { id: "platform", members: ["github:acme/infra"] }] }));
  writeFileSync(files.envelope, JSON.stringify(ENVELOPE, null, 2));
  writeFileSync(files.settings, JSON.stringify({ maxCostUsd: "2" }));
  writeFileSync(files.triggers, JSON.stringify({ triggers: [] }));
  process.env.PI_PROJECTS_FILE = files.projects;
  process.env.PI_SCOPED_LIMITS_FILE = files.limits;
  process.env.PI_ENVELOPE_FILE = files.envelope;
  process.env.PI_SETTINGS_FILE = files.settings;
  process.env.PI_TRIGGERS_FILE = files.triggers;
  process.env.PI_LOGS_DIR = files.logs;
  process.env.VALKEY_URL = "redis://127.0.0.1:6390"; // never dialled: the fake answers
  process.env.PI_WORKER_NAME = "mini1";
  delete process.env.PI_MAX_COST_USD;
  const redis = fakeAllocRedis();
  indexMod._setAllocationSeamsForTests({ redisFn: () => redis, now: () => new Date(NOW) });
  try {
    await fn({ dir, files, redis });
  } finally {
    indexMod._setAllocationSeamsForTests({});
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * One real session: the admin extension (its default export, exactly what pi loads), a recording test extension, any
 * `extra` factories, the faux model scripted with `responses`, and only `tools` active. No UI is bound, so every tool
 * call's `ctx.hasUI` is false, as under `pi -p`. Returns the session's messages and what the recorder saw.
 */
async function runSession({ dir, responses, tools, extra = [] }) {
  const faux = ai.fauxProvider();
  // No models file and no create-time refresh: a FILE-backed models store writes after the test, recreating a removed
  // temp directory (measured: it left `models-store.json` behind the helper's cleanup).
  const runtime = await pi.ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  faux.setResponses(responses);
  const seen = [];
  const recorder = (api) => {
    api.on("tool_call", (event, ctx) => {
      seen.push({ tool: event.toolName, nested: Boolean(event.parentToolCallId), hasUI: ctx?.hasUI });
    });
  };
  const loader = new pi.DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [recorder, (api) => indexMod.default(api), ...extra],
  });
  await loader.reload();
  const { session } = await pi.createAgentSession({
    cwd: dir,
    agentDir: dir,
    model: faux.getModel(),
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: pi.SessionManager.inMemory(dir),
    settingsManager: pi.SettingsManager.inMemory({}),
    tools,
  });
  try {
    await session.prompt("go");
    return { messages: [...session.messages], seen };
  } finally {
    session.dispose();
  }
}

const call = (name, args) => ai.fauxAssistantMessage([ai.fauxToolCall(name, args)], { stopReason: "toolUse" });
const results = (messages) => messages.filter((m) => m.role === "toolResult").map((m) => ({ name: m.toolName, isError: m.isError, text: (m.content ?? []).map((c) => c.text ?? "").join("") }));

test("a model-issued write to the envelope is blocked by pi's own pipeline; a write beside it goes through", async () => {
  await withDeployment(async ({ dir, files }) => {
    const before = readFileSync(files.envelope, "utf8");
    const notes = join(dir, "notes.md");
    const { messages } = await runSession({
      dir,
      tools: ["write"],
      responses: [call("write", { path: files.envelope, content: "{}" }), call("write", { path: "@notes.md", content: "hello" }), ai.fauxAssistantMessage("done")],
    });
    const [blocked, passed] = results(messages);
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /pi-dispatch blocked this write: it writes the allocation envelope \(PI_ENVELOPE_FILE\)/);
    assert.equal(readFileSync(files.envelope, "utf8"), before, "the envelope is untouched");
    assert.equal(passed.isError, false, "an unrelated file in the same folder is written");
    assert.equal(readFileSync(notes, "utf8"), "hello");
  });
});

test("a model-issued edit of the deployment's .env (which names every guarded path) is blocked, and the pointer too", async () => {
  await withDeployment(async ({ dir }) => {
    const env = join(pointed, ".env");
    const before = readFileSync(env, "utf8");
    const { messages } = await runSession({
      dir,
      tools: ["write", "edit"],
      responses: [
        call("edit", { path: env, edits: [{ oldText: "PI_PROJECTS_FILE=", newText: "PI_PROJECTS_FILE=/decoy/" }] }),
        call("write", { path: join(pointed, "pointer.json"), content: "{}" }),
        ai.fauxAssistantMessage("done"),
      ],
    });
    const [envEdit, pointerWrite] = results(messages);
    assert.equal(envEdit.isError, true);
    assert.match(envEdit.text, /pi-dispatch blocked this edit: it writes the deployment's \.env/);
    assert.equal(pointerWrite.isError, true);
    assert.match(pointerWrite.text, /it writes the deployment pointer/);
    assert.equal(readFileSync(env, "utf8"), before, ".env is untouched");
  });
});

test("a NESTED ctx.executeTool write and a codemode script's write reach the guard and are blocked", async () => {
  await withDeployment(async ({ dir, files }) => {
    const before = readFileSync(files.envelope, "utf8");
    // A tool that calls `write` through `ctx.executeTool`, the way the codemode tool does.
    const nester = (api) => {
      api.registerTool({
        name: "nest",
        label: "nest",
        description: "writes a file through ctx.executeTool",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        async execute(_id, params, _signal, _onUpdate, ctx) {
          const outcome = await ctx.executeTool("write", { path: params.path, content: "x" });
          return { content: [{ type: "text", text: JSON.stringify(outcome) }], details: {} };
        },
      });
    };
    const script = `try { await tools.write({ path: ${JSON.stringify(files.projects)}, content: "{}" }); return "WROTE"; } catch (e) { return "ERR " + e.message; }`;
    const { messages, seen } = await runSession({
      dir,
      tools: ["write", "nest", "codemode"],
      extra: [nester, pi.createCodemodeExtension()],
      responses: [call("nest", { path: files.envelope }), call("codemode", { code: script }), ai.fauxAssistantMessage("done")],
    });
    const [nested, codemode] = results(messages);
    assert.match(nested.text, /pi-dispatch blocked this write: it writes the allocation envelope/, "the nested outcome carries the guard's reason");
    assert.match(codemode.text, /ERR [^"]*pi-dispatch blocked this write: it writes projects\.json/, "the script's call is rejected with the guard's reason");
    assert.equal(readFileSync(files.envelope, "utf8"), before);
    assert.notEqual(readFileSync(files.projects, "utf8"), "{}");
    assert.deepEqual(seen.filter((s) => s.tool === "write").map((s) => s.nested), [true, true], "pi fired tool_call for both nested writes, marked as nested");
  });
});

test("headless (no UI, as pi -p): the model's dispatch_priorities_set applies 3:1 with no dialog, and the confirm-gated envelope write refuses", async () => {
  await withDeployment(async ({ dir, files, redis }) => {
    const envBefore = readFileSync(files.envelope, "utf8");
    const { messages, seen } = await runSession({
      dir,
      tools: ["dispatch_priorities_set", "dispatch_envelope_set"],
      responses: [
        call("dispatch_priorities_set", { projects: [{ id: "shop", weight: 3, reason: "launch on Friday" }, { id: "platform", weight: 1 }] }),
        call("dispatch_envelope_set", { minIntervalHours: 0 }),
        ai.fauxAssistantMessage("done"),
      ],
    });
    assert.ok(seen.length >= 2 && seen.every((s) => s.hasUI === false), "every call ran with no interactive operator");
    const [priorities, envelope] = results(messages);
    assert.equal(priorities.isError, false);
    const out = JSON.parse(priorities.text);
    assert.equal(out.outcome, "applied");
    assert.equal(out.clamped, false);
    assert.equal(out.after.allocations.shop, 70_000_000);
    assert.equal(out.after.allocations.platform, 30_000_000);
    assert.ok(!priorities.text.includes("launch"), "no reason text in the result the model reads");
    assert.equal(JSON.parse(redis.store.get("alloc:plan")).writer, "operator-session");
    assert.equal(envelope.isError, true);
    assert.match(envelope.text, /needs an interactive operator to confirm it/);
    assert.equal(readFileSync(files.envelope, "utf8"), envBefore, "the refused envelope write wrote nothing");
    assert.ok(existsSync(join(files.logs, "allocations", "2026-10.jsonl")), "the apply was audited on this host");
  });
});
