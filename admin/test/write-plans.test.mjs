import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { tempDir } from "./helpers/temp-dir.mjs";
import { KNOWN_KEYS, writeProjects, writeScopedLimits, writeTriggers } from "../src/read-model.mjs";
import * as plans from "../src/write-plans.mjs";

// The pre-confirm half of every panel and tool write, moved out of index.ts so the operator console (a process that
// never loads pi) refuses with the same words (issue #642). Two things are held here: the module stays pi-free, and
// each plan says exactly what the tool says, refusal and confirm alike, because the tools now run these plans.
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const indexMod = await createJiti(import.meta.url).import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
// Every tool write below is audited as the panel; keep those rows out of the account's own logs directory.
process.env.PI_LOGS_DIR = tempDir("pd-642-plans-logs-");

/** Every file a bundle of `entry` reaches, by esbuild's own resolution (insights-assembly.test.mjs' walk). */
async function reached(entry) {
  const res = await build({
    stdin: { contents: `import ${JSON.stringify(entry)};`, resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), loader: "js" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    metafile: true,
    outfile: "unused.mjs",
    external: ["bullmq", "ioredis"],
    logLevel: "silent",
  });
  return Object.keys(res.metafile.inputs);
}
const PI_OR_TYPEBOX = /node_modules\/(?:@earendil-works\/pi-coding-agent|typebox)\//;

test("write-plans.mjs and audited-write.mjs reach neither the pi runtime nor typebox, and the walk would see them", async () => {
  for (const entry of ["./write-plans.mjs", "./audited-write.mjs"]) {
    const files = await reached(entry);
    assert.ok(files.length > 1, `${entry}: the walk followed the module's imports`);
    assert.deepEqual(files.filter((f) => PI_OR_TYPEBOX.test(f)), [], entry);
  }
  assert.ok((await reached("./write-plans.mjs")).some((f) => f.endsWith("src/read-model.mjs")));
  // The control: index.ts, which these left, does reach typebox, so a regression that imports it here turns this red.
  assert.ok((await reached("./index.ts")).some((f) => PI_OR_TYPEBOX.test(f)), "the walk finds typebox where it is");
});

function tools() {
  const list = [];
  const pi = new Proxy({}, { get: (_t, k) => (k === "registerTool" ? (t) => list.push(t) : () => {}) });
  indexMod.default(pi);
  return Object.fromEntries(list.map((t) => [t.name, t]));
}
/** A ctx whose confirm records what it was shown and declines, so a tool shows its confirm and writes nothing. */
function recordingCtx() {
  const shown = [];
  return { shown, ctx: { hasUI: true, ui: { confirm: async (title, message) => { shown.push({ title, message }); return false; } } } };
}
/** What a tool does with `params`: `{ refusal }` (its thrown message) or `{ title, message }` (its confirm). */
async function toolSays(tool, params) {
  const { shown, ctx } = recordingCtx();
  try {
    await tool.execute("id", params, undefined, undefined, ctx);
  } catch (e) {
    return { refusal: e.message };
  }
  return shown[0] ?? {};
}
/** What a plan says, in the same shape. */
function planSays(res) {
  return res.refusal !== undefined ? { refusal: res.refusal } : { title: res.plan.title, message: res.plan.message };
}

function deployment(env = {}) {
  const dir = tempDir("pd-642-plans-");
  const paths = {
    triggersPath: join(dir, "triggers.json"),
    settingsFile: join(dir, "settings.json"),
    pauseWindowsPath: join(dir, "pause-windows.json"),
    scopedLimitsPath: join(dir, "scoped-limits.json"),
    projectsFile: join(dir, "projects.json"),
    envelopeFile: null,
    logsDir: join(dir, "logs"),
    valkeyUrl: "not-a-url",
  };
  writeFileSync(paths.triggersPath, JSON.stringify({ triggers: [{ on: { type: "label", any: ["bug"] }, run: { kind: "github", flow: "fix" } }] }));
  writeFileSync(paths.pauseWindowsPath, JSON.stringify({ windows: [{ scope: "acme/web", from: "22:00", to: "06:00" }] }));
  writeFileSync(paths.scopedLimitsPath, JSON.stringify({ version: 1, limits: [{ scope: "acme/web", day: 5 }] }));
  const saved = {};
  const set = { PI_TRIGGERS_FILE: paths.triggersPath, PI_SETTINGS_FILE: paths.settingsFile, PI_PAUSE_WINDOWS_FILE: paths.pauseWindowsPath, PI_SCOPED_LIMITS_FILE: paths.scopedLimitsPath, PI_PROJECTS_FILE: paths.projectsFile, ...env };
  for (const [k, v] of Object.entries(set)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };
  return { paths, restore };
}

test("each trigger plan says what its tool says: every refusal and the confirm, byte for byte", async () => {
  const t = tools();
  const { paths, restore } = deployment({ PI_BACKENDS: "local" });
  try {
    const env = process.env;
    const addCases = [
      { kind: "label", flow: "fix", labels: ["bug"] },
      { kind: "label", flow: "fix", labels: ["bug"], maxCostUsd: "1" },
      { kind: "label", flow: "fix", labels: ["bug"], run: { max_cost_usd: "1" } },
      { kind: "label", flow: "fix", labels: ["bug"], backend: "podman" },
      { kind: "label", flow: "fix", labels: ["bug"], provider: "anthropic" },
      { kind: "cron", flow: "fix", id: "n", pattern: "0 3 * * *", folder: "/srv", task: "t", maxTurns: 0 },
      { kind: "telepathy", flow: "fix" },
      { kind: "label", flow: "fix", labels: ["bug"], progress: true, statusComment: true },
      { kind: "cron", flow: "fix", id: "n", pattern: "0 3 * * *", folder: "/srv", task: "t", statusComment: true },
      { kind: "label", flow: "fix", labels: ["bug"], recover: true },
      { kind: "cron", flow: "fix", id: "n", pattern: "0 3 * * *", folder: "/srv", task: "t", recover: true },
      { kind: "label", flow: "fix", labels: ["bug"], steer: true },
      { kind: "cron", flow: "fix", id: "n", pattern: "0 3 * * *", folder: "/srv", task: "t", steer: true },
      { kind: "label", flow: "fix", labels: ["bug"], steer: "yes" },
    ];
    for (const params of addCases) {
      assert.deepEqual(planSays(plans.planTriggerAdd({ params, paths, env })), await toolSays(t.dispatch_trigger_add, params), JSON.stringify(params));
    }
    const editCases = [{ index: 0, flow: "review" }, { index: 0, flow: "review", backend: "local", model: "m1", provider: "openai" }, { index: 3, flow: "x" }, { index: 0, flow: "  " }, { index: 0, flow: "x", backend: "vapour" }, { index: 0, flow: "x", models: ["a/b"] }, { index: 0, flow: "x", progress: true, statusComment: false }, { index: 0, flow: "x", recover: true }, { index: 0, flow: "x", recover: "yes" }, { index: 0, flow: "x", steer: true }, { index: 0, flow: "x", steer: "yes" }];
    for (const params of editCases) {
      assert.deepEqual(planSays(plans.planTriggerEdit({ params, paths, env })), await toolSays(t.dispatch_trigger_edit, params), JSON.stringify(params));
    }
    for (const index of [0, 9]) assert.deepEqual(planSays(plans.planTriggerDelete({ index, paths })), await toolSays(t.dispatch_trigger_delete, { index }));
    // Under an EMPTY blessed set, refused too (#227).
    assert.equal(plans.planTriggerAdd({ params: { kind: "label", flow: "f", labels: ["b"], backend: "local" }, paths, env: { PI_BACKENDS: "vapour" } }).refusal, "this deployment blesses no backends, so run.backend cannot be set (see PI_BACKENDS)");
  } finally {
    restore();
  }
});

test("a trigger plan's mutate and expect drive the read-model funnel to the entry the confirm showed", () => {
  const { paths, restore } = deployment();
  try {
    const add = plans.planTriggerAdd({ params: { kind: "comment", flow: "fix", phrase: "@pi" }, paths, env: {} }).plan;
    assert.deepEqual(add.summary, add.message.split("\n"));
    assert.equal(add.target, paths.triggersPath);
    assert.deepEqual(add.expect, [{ path: paths.triggersPath, text: readFileSync(paths.triggersPath, "utf8") }], "the file as the plan was built from it");
    const res = writeTriggers({ triggersPath: paths.triggersPath, mutate: add.mutate });
    assert.ok(res.ok, JSON.stringify(res));
    assert.deepEqual(JSON.parse(readFileSync(paths.triggersPath, "utf8")).triggers[1], add.entry);
    const edit = plans.planTriggerEdit({ params: { index: 1, flow: "review" }, paths, env: {} }).plan;
    assert.equal(edit.message, "trigger #2 (comment) flow: fix -> review");
    writeTriggers({ triggersPath: paths.triggersPath, mutate: edit.mutate });
    assert.equal(JSON.parse(readFileSync(paths.triggersPath, "utf8")).triggers[1].run.flow, "review");
  } finally {
    restore();
  }
});

test("run.progress and run.statusComment (issue #644): carried only as booleans, judged by the loader before the confirm, merged only when sent", () => {
  const { paths, restore } = deployment();
  try {
    // The add: carried on every webhook kind and on cron, each only when a boolean, so an entry naming neither is unchanged.
    for (const kind of ["label", "comment", "pull_request", "issue"]) {
      const entry = plans.buildTriggerEntry(kind, { flow: "fix", labels: ["bug"], phrase: "@pi", action: ["opened"], progress: true, statusComment: false });
      assert.equal(entry.run.progress, true, kind);
      assert.equal(entry.run.statusComment, false, kind);
      const plain = plans.buildTriggerEntry(kind, { flow: "fix", labels: ["bug"], phrase: "@pi", action: ["opened"] });
      assert.equal("progress" in plain.run, false, kind);
      assert.equal("statusComment" in plain.run, false, kind);
    }
    assert.equal(plans.buildTriggerEntry("cron", { id: "n", pattern: "0 3 * * *", folder: "/srv", flow: "f", task: "t", progress: true }).run.progress, true);
    // A non-boolean, and a status comment on cron, refused with the loader's own words before the operator is asked.
    assert.match(plans.planTriggerAdd({ params: { kind: "label", flow: "fix", labels: ["bug"], progress: "yes" }, paths, env: {} }).refusal, /run\.progress must be true or false/);
    assert.match(plans.planTriggerAdd({ params: { kind: "cron", flow: "f", id: "n", pattern: "0 3 * * *", folder: "/srv", task: "t", statusComment: true }, paths, env: {} }).refusal, /run\.statusComment is only available on a forge trigger/);
    const add = plans.planTriggerAdd({ params: { kind: "label", flow: "fix", labels: ["go"], progress: true, statusComment: true }, paths, env: {} }).plan;
    assert.match(add.message, /"progress":true,"statusComment":true/, "the confirm shows what is armed");
    assert.ok(writeTriggers({ triggersPath: paths.triggersPath, mutate: add.mutate }).ok);
    // The edit: merged only when sent, the before and after on the confirm, and refused on cron by the entry's own type.
    const edit = plans.planTriggerEdit({ params: { index: 0, flow: "fix", statusComment: true }, paths, env: {} }).plan;
    assert.equal(edit.message, "trigger #1 (label) flow: fix -> fix, statusComment: - -> true");
    assert.ok(writeTriggers({ triggersPath: paths.triggersPath, mutate: edit.mutate }).ok);
    const after = JSON.parse(readFileSync(paths.triggersPath, "utf8")).triggers;
    assert.deepEqual(after[0].run, { kind: "github", flow: "fix", statusComment: true });
    assert.equal(after[1].run.progress, true);
    const flowOnly = plans.planTriggerEdit({ params: { index: 1, flow: "review" }, paths, env: {} }).plan;
    assert.ok(writeTriggers({ triggersPath: paths.triggersPath, mutate: flowOnly.mutate }).ok);
    assert.deepEqual(JSON.parse(readFileSync(paths.triggersPath, "utf8")).triggers[1].run, { kind: "github", flow: "review", progress: true, statusComment: true, secretBundle: false }, "an edit that sends neither keeps both (and the add tool's bundle opt-out, #704)");
    writeFileSync(paths.triggersPath, JSON.stringify({ triggers: [{ on: { type: "cron", id: "n", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv", flow: "f", task: "t" } }] }));
    assert.match(plans.planTriggerEdit({ params: { index: 0, flow: "f", statusComment: true }, paths, env: {} }).refusal, /run\.statusComment is only available on a forge trigger/);
    assert.equal(plans.planTriggerEdit({ params: { index: 0, flow: "f", progress: true }, paths, env: {} }).plan.message, "trigger #1 (cron) flow: f -> f, progress: - -> true");
  } finally {
    restore();
  }
});

test("run.recover (issue #645): carried only as a boolean, refused on cron and beside a command by the loader before the confirm, merged only when sent", () => {
  const { paths, restore } = deployment();
  try {
    for (const kind of ["label", "comment", "pull_request", "issue"]) {
      assert.equal(plans.buildTriggerEntry(kind, { flow: "fix", labels: ["bug"], phrase: "@pi", action: ["opened"], recover: true }).run.recover, true, kind);
      assert.equal(plans.buildTriggerEntry(kind, { flow: "fix", labels: ["bug"], phrase: "@pi", action: ["opened"], recover: false }).run.recover, false, kind);
      assert.equal("recover" in plans.buildTriggerEntry(kind, { flow: "fix", labels: ["bug"], phrase: "@pi", action: ["opened"], recover: "yes" }).run, false, `${kind}: only a boolean is carried`);
      assert.equal("recover" in plans.buildTriggerEntry(kind, { flow: "fix", labels: ["bug"], phrase: "@pi", action: ["opened"] }).run, false, kind);
    }
    assert.match(plans.planTriggerAdd({ params: { kind: "label", flow: "fix", labels: ["bug"], recover: "yes" }, paths, env: {} }).refusal, /run\.recover must be true or false/);
    assert.match(plans.planTriggerAdd({ params: { kind: "cron", flow: "f", id: "n", pattern: "0 3 * * *", folder: "/srv", task: "t", recover: true }, paths, env: {} }).refusal, /run\.recover is only available on a forge trigger/);
    const add = plans.planTriggerAdd({ params: { kind: "label", flow: "fix", labels: ["go"], recover: true }, paths, env: {} }).plan;
    assert.match(add.message, /"recover":true/, "the confirm shows what is armed");
    assert.ok(writeTriggers({ triggersPath: paths.triggersPath, mutate: add.mutate }).ok);
    const edit = plans.planTriggerEdit({ params: { index: 0, flow: "fix", recover: true }, paths, env: {} }).plan;
    assert.equal(edit.message, "trigger #1 (label) flow: fix -> fix, recover: - -> true");
    assert.ok(writeTriggers({ triggersPath: paths.triggersPath, mutate: edit.mutate }).ok);
    assert.deepEqual(JSON.parse(readFileSync(paths.triggersPath, "utf8")).triggers[0].run, { kind: "github", flow: "fix", recover: true });
    const flowOnly = plans.planTriggerEdit({ params: { index: 1, flow: "review" }, paths, env: {} }).plan;
    assert.ok(writeTriggers({ triggersPath: paths.triggersPath, mutate: flowOnly.mutate }).ok);
    assert.equal(JSON.parse(readFileSync(paths.triggersPath, "utf8")).triggers[1].run.recover, true, "an edit that does not send it keeps it");
    // Judged against the entry's own type and its own command, so neither refusal reaches the operator's confirm.
    writeFileSync(paths.triggersPath, JSON.stringify({ triggers: [
      { on: { type: "cron", id: "n", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv", flow: "f", task: "t" } },
      { on: { type: "label", any: ["go"] }, run: { kind: "github", command: "wf run" } },
    ] }));
    assert.match(plans.planTriggerEdit({ params: { index: 0, flow: "f", recover: true }, paths, env: {} }).refusal, /run\.recover is only available on a forge trigger/);
    assert.match(plans.planTriggerEdit({ params: { index: 1, flow: "f", recover: true }, paths, env: {} }).refusal, /run\.recover cannot be set beside run\.command/);
    assert.equal(plans.planTriggerEdit({ params: { index: 0, flow: "f", recover: false }, paths, env: {} }).plan.message, "trigger #1 (cron) flow: f -> f, recover: - -> false");
  } finally {
    restore();
  }
});

test("run.steer (issue #646): carried only as a boolean, allowed on cron, refused beside a command by the loader before the confirm, merged only when sent", () => {
  const { paths, restore } = deployment();
  try {
    for (const kind of ["label", "comment", "pull_request", "issue", "cron"]) {
      const f = { flow: "fix", labels: ["bug"], phrase: "@pi", action: ["opened"], id: "n", pattern: "0 3 * * *", folder: "/srv", task: "t" };
      assert.equal(plans.buildTriggerEntry(kind, { ...f, steer: true }).run.steer, true, kind);
      assert.equal(plans.buildTriggerEntry(kind, { ...f, steer: false }).run.steer, false, kind);
      assert.equal("steer" in plans.buildTriggerEntry(kind, { ...f, steer: "yes" }).run, false, `${kind}: only a boolean is carried`);
      assert.equal("steer" in plans.buildTriggerEntry(kind, f).run, false, kind);
    }
    assert.match(plans.planTriggerAdd({ params: { kind: "label", flow: "fix", labels: ["bug"], steer: "yes" }, paths, env: {} }).refusal, /run\.steer must be true or false/);
    const cron = plans.planTriggerAdd({ params: { kind: "cron", flow: "f", id: "n", pattern: "0 3 * * *", folder: "/srv", task: "t", steer: true }, paths, env: {} });
    assert.equal(cron.refusal, undefined, "allowed on cron, unlike recover");
    assert.match(cron.plan.message, /"steer":true/);
    const add = plans.planTriggerAdd({ params: { kind: "label", flow: "fix", labels: ["go"], steer: true }, paths, env: {} }).plan;
    assert.match(add.message, /"steer":true/, "the confirm shows what is armed");
    assert.ok(writeTriggers({ triggersPath: paths.triggersPath, mutate: add.mutate }).ok);
    const edit = plans.planTriggerEdit({ params: { index: 0, flow: "fix", steer: true }, paths, env: {} }).plan;
    assert.equal(edit.message, "trigger #1 (label) flow: fix -> fix, steer: - -> true");
    assert.ok(writeTriggers({ triggersPath: paths.triggersPath, mutate: edit.mutate }).ok);
    assert.deepEqual(JSON.parse(readFileSync(paths.triggersPath, "utf8")).triggers[0].run, { kind: "github", flow: "fix", steer: true });
    const flowOnly = plans.planTriggerEdit({ params: { index: 1, flow: "review" }, paths, env: {} }).plan;
    assert.ok(writeTriggers({ triggersPath: paths.triggersPath, mutate: flowOnly.mutate }).ok);
    assert.equal(JSON.parse(readFileSync(paths.triggersPath, "utf8")).triggers[1].run.steer, true, "an edit that does not send it keeps it");
    // Judged against the entry's own command, so the refusal never reaches the operator's confirm; cron is allowed.
    writeFileSync(paths.triggersPath, JSON.stringify({ triggers: [
      { on: { type: "cron", id: "n", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv", flow: "f", task: "t" } },
      { on: { type: "label", any: ["go"] }, run: { kind: "github", command: "wf run" } },
    ] }));
    assert.equal(plans.planTriggerEdit({ params: { index: 0, flow: "f", steer: true }, paths, env: {} }).plan.message, "trigger #1 (cron) flow: f -> f, steer: - -> true");
    assert.match(plans.planTriggerEdit({ params: { index: 1, flow: "f", steer: true }, paths, env: {} }).refusal, /run\.steer cannot be set beside run\.command/);
  } finally {
    restore();
  }
});

test("the settings plans: the tool surface says what dispatch_set says, the command surface what /dispatch set says", async () => {
  const t = tools();
  const { paths, restore } = deployment();
  try {
    const env = process.env;
    for (const params of [{ key: "dailyCap", value: "7" }, { key: "nope", value: "1" }, { key: "dailyCostUsd", value: "1e3" }, { key: "dailyCap" }, { key: "model", value: " " }]) {
      assert.deepEqual(planSays(plans.planSettingChange({ key: params.key, value: params.value, paths, env })), await toolSays(t.dispatch_set, params), JSON.stringify(params));
    }
    assert.equal(plans.planSettingSet({ key: "nope", value: "1", paths, env }).refusal, "unknown key 'nope'. valid keys: " + plans.planSettingSet({ key: "nope", value: "1", paths, env }).refusal.split("valid keys: ")[1]);
    assert.match(plans.planSettingSet({ key: "nope", valueTokens: ["1"], paths, env, surface: "command" }).refusal, /^set: unknown key 'nope'\. valid keys: /);
    assert.match(plans.planSettingUnset({ key: "nope", paths, env, surface: "command" }).refusal, /^unset: unknown key 'nope'\. valid keys: /);
    assert.equal(plans.planSettingSet({ key: "model", valueTokens: ["a", "b"], paths, env, surface: "command" }).refusal, "set: model takes exactly one value");
    const set = plans.planSettingSet({ key: "dailyCap", value: "7", paths, env }).plan;
    assert.deepEqual(set.mutate({ model: "m" }), { model: "m", dailyCap: 7 });
    assert.equal(set.unset, false);
    const unset = plans.planSettingUnset({ key: "model", paths, env }).plan;
    assert.deepEqual(unset.mutate({ model: "m", dailyCap: 7 }), { dailyCap: 7 });
    const dollar = plans.planSettingSet({ key: "dailyCostUsd", valueTokens: ["2.50"], paths, env, shown: { deploymentDir: "/d" }, surface: "command" }).plan;
    assert.deepEqual(dollar.mutate({}), { dailyCostUsd: "2.50" }, "a dollar key keeps the typed text");
    assert.deepEqual(dollar.writeArgs, { dollarEnv: env, deploymentDir: "/d" }, "and its write warns over the merged values");
    // An invalid file is refused on the tool surface BEFORE the confirm.
    writeFileSync(paths.settingsFile, "{ not json");
    assert.deepEqual(planSays(plans.planSettingChange({ key: "dailyCap", value: "3", paths, env })), await toolSays(t.dispatch_set, { key: "dailyCap", value: "3" }));
    assert.match(plans.planSettingChange({ key: "dailyCap", value: "3", paths, env }).refusal, /^rejected: the settings file is invalid/);
  } finally {
    restore();
  }
});

test("the pause-window and scoped-limit plans say what their tools say", async () => {
  const t = tools();
  const { paths, restore } = deployment();
  try {
    const env = process.env;
    const fields = { scope: "*", from: "01:00", to: "02:00", days: ["mon"] };
    assert.deepEqual(planSays(plans.planPauseWindowAdd({ fields, paths })), await toolSays(t.dispatch_pause_add, fields));
    for (const p of [{ index: 0, to: "07:00" }, { index: 4 }]) assert.deepEqual(planSays(plans.planPauseWindowEdit({ index: p.index, fields: p, paths })), await toolSays(t.dispatch_pause_edit, p), JSON.stringify(p));
    for (const index of [0, 4]) assert.deepEqual(planSays(plans.planPauseWindowDelete({ index, paths })), await toolSays(t.dispatch_pause_delete, { index }));
    for (const p of [{ scope: "acme/api", day: 3 }, { scope: "acme/api" }, { scope: "acme/api", dayUsd: "1e-9" }, { scope: "acme/api", memory: "12q" }]) {
      assert.deepEqual(planSays(plans.planLimitAdd({ params: p, paths, env })), await toolSays(t.dispatch_limit_add, p), JSON.stringify(p));
    }
    for (const p of [{ index: 0, week: 9 }, { index: 0, scope: "github:acme/web" }, { index: 2, day: 1 }, { index: 0, weekUsd: "x" }]) {
      assert.deepEqual(planSays(plans.planLimitEdit({ params: p, paths, env })), await toolSays(t.dispatch_limit_edit, p), JSON.stringify(p));
    }
    for (const index of [0, 5]) assert.deepEqual(planSays(plans.planLimitDelete({ index, paths, env })), await toolSays(t.dispatch_limit_delete, { index }));
    // The plan's writeArgs ARE the funnel's arguments, expect included: a concurrent change after the plan refuses.
    const add = plans.planLimitAdd({ params: { scope: "acme/api", day: 3 }, paths, env }).plan;
    writeFileSync(paths.scopedLimitsPath, JSON.stringify({ version: 1, limits: [] }));
    assert.ok(writeScopedLimits(add.writeArgs).invalid, "the file changed after the plan, so the write refuses");
    const fresh = plans.planLimitAdd({ params: { scope: "acme/api", day: 3 }, paths, env }).plan;
    assert.ok(writeScopedLimits(fresh.writeArgs).ok);
    assert.deepEqual(JSON.parse(readFileSync(paths.scopedLimitsPath, "utf8")).limits, [{ scope: "acme/api", day: 3 }]);
  } finally {
    restore();
  }
});

test("the project, envelope, secret-profile and priorities plans", async () => {
  const t = tools();
  const { paths, restore } = deployment();
  try {
    const env = process.env;
    // No projects file yet: the add plans through the parser; edit and delete name the missing id as the tools do.
    for (const p of [{ id: "web", members: ["github:acme/web"] }, { id: "BAD", members: ["github:acme/web"] }, { id: "web", members: ["acme/web"] }]) {
      assert.deepEqual(planSays(plans.planProjectAdd({ params: p, paths, env })), await toolSays(t.dispatch_project_add, p), JSON.stringify(p));
    }
    assert.deepEqual(planSays(plans.planProjectEdit({ params: { id: "web", name: "W" }, paths, env })), await toolSays(t.dispatch_project_edit, { id: "web", name: "W" }));
    assert.deepEqual(planSays(plans.planProjectDelete({ id: "web", paths, env })), await toolSays(t.dispatch_project_delete, { id: "web" }));
    assert.deepEqual(planSays(plans.planEnvelope({ params: {}, paths, env })), await toolSays(t.dispatch_envelope_set, {}));
    // Secret profiles: the command's own sentences.
    assert.match(plans.planSecretProfileAdd({ name: "pro,d", path: "/x", profiles: {}, settingsFile: "/s" }).refusal, /^a profile name may use letters, digits, dot, dash and underscore only \u2014 PI_SECRET_PROFILES/);
    assert.equal(plans.planSecretProfileAdd({ name: "prod", path: "rel/x", profiles: {}, settingsFile: "/s" }).refusal, "the resolver needs an ABSOLUTE path: a service manager's working directory is not your shell's");
    const add = plans.planSecretProfileAdd({ name: "prod", path: "/opt/r.sh", profiles: { dev: "/opt/d.sh" }, settingsFile: "/s/settings.json" }).plan;
    assert.equal(add.title, "Declare a secret resolver");
    assert.match(add.message, /^\/s\/settings\.json gets:\n\{\n {2}"secretProfiles": \{\n {4}"dev": "\/opt\/d\.sh",\n {4}"prod": "\/opt\/r\.sh"/);
    assert.deepEqual(add.mutate({ model: "m" }), { model: "m", secretProfiles: { dev: "/opt/d.sh", prod: "/opt/r.sh" } });
    assert.equal(plans.planSecretProfileRemove({ name: "gone", profiles: {}, settingsFile: "/s" }).refusal, "no such profile. No resolver profiles are declared in the settings overlay.");
    assert.deepEqual(plans.planSecretProfileRemove({ name: "dev", profiles: { dev: "/d", x: "/x" }, settingsFile: "/s" }).plan.mutate({}), { secretProfiles: { x: "/x" } });
    // Bundle resolvers (issue #704): the validator's `{ path, format }` shape, a replace said, and the stranded bundles named.
    const badd = plans.planSecretBundleAdd({ name: "op-shop", path: "/opt/b2.mjs", format: "dotenv", bundles: { "op-shop": { path: "/opt/b.mjs", format: "json" } }, settingsFile: "/s/settings.json" }).plan;
    assert.equal(badd.title, "Declare a secret bundle resolver");
    assert.deepEqual(badd.mutate({ secretProfiles: { a: "/a" } }), { secretProfiles: { a: "/a" }, secretBundles: { "op-shop": { path: "/opt/b2.mjs", format: "dotenv" } } });
    assert.match(badd.message, /This REPLACES the current op-shop -> \/opt\/b\.mjs \(json\)/);
    const brm = plans.planSecretBundleRemove({ name: "op-shop", bundles: { "op-shop": { path: "/opt/b.mjs", format: "json" } }, bound: ["shop", "web"], settingsFile: "/s" }).plan;
    assert.deepEqual(brm.mutate({}), { secretBundles: {} });
    assert.match(brm.message, /The jobs of bundles shop, web are refused PRE-SPEND .*, or on a multi-host worker's shared queue held for a host that declares it/);
    const one = { "op-shop": { path: "/b", format: "json" } };
    assert.match(plans.planSecretBundleRemove({ name: "op-shop", bundles: one, bound: null, settingsFile: "/s" }).plan.message, /The triggers file could not be read, so the jobs of any bundle naming it are refused/);
    assert.match(plans.planSecretBundleRemove({ name: "op-shop", bundles: one, bound: [], settingsFile: "/s" }).plan.message, /No bundle in triggers\.json names it, so no project's jobs depend on it\.$/);
    assert.match(plans.planSecretBundleRemove({ name: "op-shop", bundles: one, bound: ["shop"], envBundles: { "op-shop": { path: "/e", format: "json" } }, settingsFile: "/s" }).plan.message, /PI_SECRET_BUNDLES also declares op-shop, so removing it here resolves the ambiguity/);
    // Any colliding name makes EVERY bundle ambiguous (mergeSecretProfiles), so another collision left keeps it so.
    const two = { "op-shop": { path: "/b", format: "json" }, "op-web": { path: "/w", format: "json" } };
    const env2 = { "op-shop": { path: "/e", format: "json" }, "op-web": { path: "/f", format: "json" } };
    assert.match(plans.planSecretBundleRemove({ name: "op-shop", bundles: two, bound: [], envBundles: env2, settingsFile: "/s" }).plan.message, /so this removes one collision\. Still ambiguous after this: op-web also collides with PI_SECRET_BUNDLES/);
    assert.match(plans.planSecretBundleRemove({ name: "op-shop", bundles: two, bound: [], envBundles: { "op-web": { path: "/f", format: "json" } }, settingsFile: "/s" }).plan.message, /removing op-shop does not change that\. Still ambiguous after this: op-web also collides/);
    // Priorities: the plan applyPriorities takes, validUntil from the injected clock.
    const now = new Date(Date.UTC(2026, 9, 15, 0, 0, 0));
    assert.deepEqual(plans.planPriorities({ projects: [{ id: "web", weight: 3, reason: "r" }], validDays: 2, now }).plan.plan, { validUntil: "2026-10-17T00:00:00.000Z", projects: [{ id: "web", weight: 3, reason: "r" }] });
    assert.deepEqual(plans.planPriorities({ projects: [{ id: "a", weight: 1 }], now }).plan.plan, { projects: [{ id: "a", weight: 1 }] });
  } finally {
    restore();
  }
});

// ---- the refusal sentences themselves (issue #642's review) ----
//
// The plan-against-tool comparisons above cannot see a sentence change: the tools call these same planners, so both
// sides move together. Here every refusal sentence is asserted LITERALLY, and a source scan lists every refusal literal
// in write-plans.mjs (`refusal:`, `unchanged:`, a thrown template, and the strings the `*Refusal` helpers return) and
// requires each to be produced, and asserted, by one row of the table below. A new refusal sentence with no row fails.

const PLANS_SRC = readFileSync(fileURLToPath(new URL("../src/write-plans.mjs", import.meta.url)), "utf8");

/** Read one JS string or template literal starting at `src[i]` (a quote or backtick): `{ parts, end }`, holes as null. */
function readLiteral(src, i) {
  const q = src[i];
  const parts = [];
  let cur = "";
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === "\\") {
      cur += src.slice(j, j + 2);
      j += 2;
      continue;
    }
    if (c === q) break;
    if (q === "`" && c === "$" && src[j + 1] === "{") {
      parts.push(cur, null);
      cur = "";
      let depth = 1;
      j += 2;
      while (depth > 0) {
        if (src[j] === "{") depth += 1;
        else if (src[j] === "}") depth -= 1;
        j += 1;
      }
      continue;
    }
    cur += c;
    j += 1;
  }
  parts.push(cur);
  // The static text's escapes (`\u2014`) decoded the way the module's own string would hold them.
  return { parts: parts.map((p) => (p === null ? null : JSON.parse(`"${p.replace(/"/g, '\\"')}"`))), end: j + 1 };
}
/** Every refusal literal in the module, as `{ line, parts }`. */
function refusalLiterals() {
  const found = [];
  const at = (idx) => PLANS_SRC.slice(0, idx).split("\n").length;
  for (const m of PLANS_SRC.matchAll(/(?:refusal|unchanged): (?=["`])|throw new Error\((?=`)/g)) {
    const idx = m.index + m[0].length;
    found.push({ line: at(idx), parts: readLiteral(PLANS_SRC, idx).parts });
  }
  // The `*Refusal` helpers return their sentences: every literal of 25 characters or more inside their bodies.
  for (const m of PLANS_SRC.matchAll(/^export function \w+Refusal\([^)]*\) \{\n([\s\S]*?)^\}/gm)) {
    const bodyAt = m.index + m[0].indexOf(m[1]);
    let consumed = 0; // a quote inside a literal already read (its closing quote first of all) opens nothing
    for (const q of m[1].matchAll(/["`]/g)) {
      const idx = bodyAt + q.index;
      if (idx < consumed) continue;
      const lit = readLiteral(PLANS_SRC, idx);
      consumed = lit.end;
      if (lit.parts.join("").length >= 25) found.push({ line: at(idx), parts: lit.parts });
    }
  }
  return found;
}
const literalRe = (parts) => new RegExp(`^${parts.map((p) => (p === null ? "[\\s\\S]*?" : p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("")}$`);

test("every refusal sentence in write-plans.mjs is asserted word for word, and a scan finds each one in the table", () => {
  const { paths, restore } = deployment();
  try {
    const env = process.env;
    const dir = tempDir("pd-642-plans-lit-");
    const projectsFile = join(dir, "projects.json");
    writeFileSync(projectsFile, JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["github:acme/web"] }] }));
    const envelopeFile = join(dir, "envelope.json");
    const envelope = { version: 1, window: "week", totalUsd: "100", floorsUsd: { shop: "10", _other: "0" }, defaultWeights: { shop: 1, _other: 0 }, delegation: { enabled: true, writers: ["operator-session"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 } };
    writeFileSync(envelopeFile, JSON.stringify(envelope));
    const settingsFile = join(dir, "settings.json");
    writeFileSync(settingsFile, JSON.stringify({ maxCostUsd: "2" }));
    const alloc = { ...paths, projectsFile, envelopeFile, settingsFile, scopedLimitsPath: join(dir, "none.json") };
    const badProjects = join(dir, "bad-projects.json");
    writeFileSync(badProjects, "{ not json");
    const keys = KNOWN_KEYS.join(", ");
    const thrown = (fn) => {
      try {
        fn();
      } catch (e) {
        return e.message;
      }
      return null;
    };
    // [what, the sentence the planner returned, the sentence it must be (a string is exact; { prefix } where the rest
    // is another module's words, already pinned there)].
    const rows = [
      ["unknown trigger kind", plans.planTriggerAdd({ params: { kind: "telepathy", flow: "fix" }, paths, env }).refusal, "unknown trigger kind 'telepathy' (cron|label|comment|pull_request|issue)"],
      ["trigger edit index", plans.planTriggerEdit({ params: { index: 3, flow: "x" }, paths, env }).refusal, "no trigger at index 3 (have 1)"],
      ["blank flow", plans.planTriggerEdit({ params: { index: 0, flow: "  " }, paths, env }).refusal, "flow must be non-empty"],
      ["trigger delete index", plans.planTriggerDelete({ index: 9, paths }).refusal, "no trigger at index 9 (have 1)"],
      ["tool unknown key", plans.planSettingChange({ key: "nope", value: "1", paths, env }).refusal, `unknown key 'nope'. valid keys: ${keys}`],
      ["command unknown key (set)", plans.planSettingSet({ key: "nope", valueTokens: ["1"], paths, env, surface: "command" }).refusal, `set: unknown key 'nope'. valid keys: ${keys}`],
      ["command unknown key (unset)", plans.planSettingUnset({ key: "nope", paths, env, surface: "command" }).refusal, `unset: unknown key 'nope'. valid keys: ${keys}`],
      ["one value", plans.planSettingSet({ key: "model", valueTokens: ["a", "b"], paths, env, surface: "command" }).refusal, "set: model takes exactly one value"],
      ["a value is needed", plans.planSettingSet({ key: "model", value: " ", paths, env }).refusal, "a value is needed to set a key; unset it instead"],
      ["tool envelope break", plans.planSettingChange({ key: "maxCostUsd", paths: alloc, env: {} }).refusal, { prefix: "rejected: this change would leave the allocation envelope invalid" }],
      ["command envelope break", plans.planSettingUnset({ key: "maxCostUsd", paths: alloc, env: {}, surface: "command" }).refusal, { prefix: "unset: this change would leave the allocation envelope invalid" }],
      ["pause window index", plans.planPauseWindowEdit({ index: 4, fields: {}, paths }).refusal, "no pause window at index 4 (have 1)"],
      ["pause window delete index", plans.planPauseWindowDelete({ index: 4, paths }).refusal, "no pause window at index 4 (have 1)"],
      ["scoped limit index", plans.planLimitEdit({ params: { index: 2, day: 1 }, paths, env }).refusal, "no scoped limit at index 2 (have 1)"],
      ["projects unset", plans.projectAt({ ...paths, projectsFile: null }, "shop").refusal, "PI_PROJECTS_FILE is unset, so the worker reads no projects; set it in the deployment's .env (pi-dispatch up does) and restart the worker"],
      ["projects invalid", plans.projectAt({ ...paths, projectsFile: badProjects }, "shop").refusal, { prefix: "the projects file does not load: " }],
      ["projects unreadable", plans.projectAt({ ...paths, projectsFile: dir }, "shop").refusal, { prefix: `the projects file ${dir} could not be read (` }],
      ["no such project", plans.projectAt(alloc, "nope").refusal, "no project with id \"nope\" (dispatch_projects lists them)"],
      ["no such project, thrown", thrown(() => plans.currentProject(alloc, "nope")), "no project with id \"nope\" (dispatch_projects lists them)"],
      ["project add refused", plans.planProjectAdd({ params: { id: "BAD", members: ["github:acme/web"] }, paths, env }).refusal, { prefix: "rejected: " }],
      ["nothing to change", plans.planEnvelope({ params: {}, paths, env }).refusal, "nothing to change: name at least one of window, totalUsd, floorsUsd, defaultWeights, enabled, writers, maxStepPct, minIntervalHours, maxPlanDays"],
      ["envelope refused", plans.planEnvelope({ params: { totalUsd: "x" }, paths: alloc, env: {} }).refusal, { prefix: "rejected: " }],
      ["envelope unchanged", plans.planEnvelope({ params: { totalUsd: "100" }, paths: alloc, env: {} }).unchanged, "no change: the envelope already says this"],
      ["no such profile", plans.planSecretProfileRemove({ name: "gone", profiles: {}, settingsFile: "/s" }).refusal, "no such profile. No resolver profiles are declared in the settings overlay."],
      ["no such profile, with some", plans.planSecretProfileRemove({ name: "gone", profiles: { dev: "/d" }, settingsFile: "/s" }).refusal, "no such profile. Resolver profiles (settings overlay):\n  dev -> /d"],
      ["profile name", plans.planSecretProfileAdd({ name: "pro d", path: "/x", profiles: {}, settingsFile: "/s" }).refusal, "a profile name may use letters, digits, dot, dash and underscore only \u2014 PI_SECRET_PROFILES is a comma-separated list of name:path pairs"],
      ["resolver path", plans.planSecretProfileAdd({ name: "prod", path: "rel/x", profiles: {}, settingsFile: "/s" }).refusal, "the resolver needs an ABSOLUTE path: a service manager's working directory is not your shell's"],
      // Issue #704: the bundle resolvers' own sentences.
      ["bundle profile name", plans.planSecretBundleAdd({ name: "op shop", path: "/x", format: "json", bundles: {}, settingsFile: "/s" }).refusal, "a bundle profile name may use letters, digits, dot, dash and underscore only \u2014 PI_SECRET_BUNDLES is a comma-separated list of name:path:format entries"],
      ["bundle format", plans.planSecretBundleAdd({ name: "op-shop", path: "/x", format: "yaml", bundles: {}, settingsFile: "/s" }).refusal, "the format is dotenv or json: what the resolver prints, declared, because the worker never guesses it from the output"],
      ["bundle name in PI_SECRET_BUNDLES", plans.planSecretBundleAdd({ name: "op-shop", path: "/x", format: "json", bundles: {}, envBundles: { "op-shop": { path: "/y", format: "json" } }, settingsFile: "/s" }).refusal, "PI_SECRET_BUNDLES already declares op-shop on this deployment; the worker reads a name declared in both places as ambiguous and refuses every bundled job, so pick another name or change the .env"],
      ["no such bundle resolver", plans.planSecretBundleRemove({ name: "gone", bundles: {}, settingsFile: "/s" }).refusal, "no such bundle resolver. No bundle resolvers are declared in the settings overlay."],
      // Issue #712: an env-declared profile name, and a resolver outside the roots, refused before the confirm.
      ["profile name in PI_SECRET_PROFILES", plans.planSecretProfileAdd({ name: "prod", path: "/opt/pi/r", profiles: {}, envProfiles: { prod: "/opt/pi/x" }, settingsFile: "/s" }).refusal, "PI_SECRET_PROFILES already declares prod on this deployment; the worker reads a name declared in both places as ambiguous and refuses every secrets job, so pick another name or change the .env"],
      ["resolver outside the roots", plans.planSecretProfileAdd({ name: "prod", path: "/tmp/r", profiles: {}, env: { PI_SECRET_RESOLVER_ROOTS: "/opt/pi" }, settingsFile: "/s", fs: { realpathSync: (p) => p } }).refusal, "/tmp/r is outside PI_SECRET_RESOLVER_ROOTS (/opt/pi), so the worker would refuse it on every job; put the resolver inside one of them, or add its directory to PI_SECRET_RESOLVER_ROOTS"],
      ["resolver under a root written through a link", plans.resolverRootsRefusal("/tmp/pi/r", { PI_SECRET_RESOLVER_ROOTS: "/tmp/pi" }, "/private/tmp/pi/r", "/private/tmp/pi"), "/tmp/pi/r (it resolves to /private/tmp/pi/r) is outside PI_SECRET_RESOLVER_ROOTS (/tmp/pi), so the worker would refuse it on every job; put the resolver inside one of them, or add its directory to PI_SECRET_RESOLVER_ROOTS, or write the root as its real path (/private/tmp/pi)"],
      ["roots set and empty", plans.resolverRootsJudgement("/opt/pi/r", { PI_SECRET_RESOLVER_ROOTS: "" }).refusal, "PI_SECRET_RESOLVER_ROOTS is set and empty on this deployment, so the worker refuses every resolver the settings overlay declares; set it to the directory your resolvers live in first"],
      ["run.recover on a venue that does not recover", plans.planTriggerAdd({ params: { kind: "label", flow: "fix", labels: ["go"], recover: true }, paths, env: { PI_BACKENDS: "openshell" } }).refusal, { prefix: "run.recover cannot be armed on a trigger whose jobs run in the openshell venue" }],
      ["no backends", plans.backendRefusal("local", { PI_BACKENDS: "vapour" }), "this deployment blesses no backends, so run.backend cannot be set (see PI_BACKENDS)"],
      ["backend not blessed", plans.backendRefusal("podman", { PI_BACKENDS: "local" }), "backend 'podman' is not blessed by this deployment (PI_BACKENDS: local)"],
      ["tool-proof dollar cap", plans.wideningFieldRefusal({ maxCostUsd: "1" }, "dispatch_trigger_add"), "dispatch_trigger_add cannot set run.maxCostUsd (sent as maxCostUsd): a trigger's per-job dollar cap is set by hand in the triggers file, never by a tool"],
      ["tool-proof model list", plans.wideningFieldRefusal({ run: { models: ["a/b"] } }, "dispatch_trigger_edit"), "dispatch_trigger_edit cannot set run.models (sent as run.models): a trigger's allowed-model list is set by hand in the triggers file, never by a tool"],
      ["tool-proof mcp", plans.wideningFieldRefusal({ mcp: [] }, "dispatch_trigger_add"), "dispatch_trigger_add cannot set run.mcp (sent as mcp): a trigger's list of MCP servers is set by hand in the triggers file, never by a tool"],
      ["memory size", thrown(() => plans.sizeFieldsOf({ memory: "12q" })), { prefix: "memory: " }],
      ["cpus size", thrown(() => plans.sizeFieldsOf({ cpus: "lots" })), { prefix: "cpus: " }],
    ];
    for (const [what, got, want] of rows) {
      if (typeof want === "string") assert.equal(got, want, what);
      else {
        assert.equal(typeof got, "string", `${what}: a sentence came back`);
        assert.ok(got.startsWith(want.prefix) && got.length > want.prefix.length, `${what}: ${JSON.stringify(got)}`);
      }
    }
    const literals = refusalLiterals();
    assert.ok(literals.length >= 25, `the scan found the module's refusal literals (${literals.length})`);
    for (const lit of literals) {
      const re = literalRe(lit.parts);
      assert.ok(rows.some(([, got]) => typeof got === "string" && re.test(got)), `write-plans.mjs:${lit.line} ${JSON.stringify(lit.parts.map((p) => p ?? "${...}").join(""))} has no row in the table`);
    }
  } finally {
    restore();
  }
});


// Issue #704: a model-callable tool can never widen a project secret bundle's grant.
test("a trigger the add tool writes opts out of its project's bundle, and no tool call can carry secretBundle (#704)", () => {
  const { paths, restore } = deployment();
  try {
    const add = plans.planTriggerAdd({ params: { kind: "cron", id: "n", pattern: "0 3 * * *", folder: "/srv", flow: "f", task: "t" }, paths, env: {} }).plan;
    assert.equal(add.entry.run.secretBundle, false, "the tool path writes the opt-out");
    assert.match(add.message, /"secretBundle":false/, "and the confirm shows it");
    const console = plans.planTriggerAdd({ params: { kind: "label", flow: "fix", labels: ["go"] }, paths, env: {}, surface: "console" }).plan;
    assert.equal("secretBundle" in console.entry.run, false, "the operator-typed console form keeps the entry as built");
    for (const params of [{ kind: "label", flow: "fix", labels: ["go"], secretBundle: true }, { kind: "label", flow: "fix", labels: ["go"], run: { secret_bundle: true } }, { kind: "label", flow: "fix", labels: ["go"], SecretBundles: false }]) {
      assert.match(plans.planTriggerAdd({ params, paths, env: {} }).refusal, /cannot set run\.secretBundle/, JSON.stringify(params));
    }
    assert.ok(writeTriggers({ triggersPath: paths.triggersPath, mutate: add.mutate }).ok);
    assert.match(plans.planTriggerEdit({ params: { index: 1, flow: "f", secretBundle: true }, paths, env: {} }).refusal, /cannot set run\.secretBundle/);
    const edit = plans.planTriggerEdit({ params: { index: 1, flow: "g" }, paths, env: {} }).plan;
    assert.ok(writeTriggers({ triggersPath: paths.triggersPath, mutate: edit.mutate }).ok);
    assert.equal(JSON.parse(readFileSync(paths.triggersPath, "utf8")).triggers[1].run.secretBundle, false, "an edit keeps the opt-out");
  } finally {
    restore();
  }
});

test("the project tools refuse to change a bundled project's members, before the confirm and again at the write (#704)", () => {
  const { paths, restore } = deployment();
  try {
    writeFileSync(paths.projectsFile, JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["github:acme/shop"] }, { id: "tools", members: ["github:acme/tools"] }] }));
    writeFileSync(paths.triggersPath, JSON.stringify({ triggers: [], secretBundles: { env: { profile: "p", ref: "r", project: "shop" } } }));
    const why = /secretBundles "env" \(project shop\) .* names this project.*change the bundle in triggers\.json first\. Nothing was written/;
    assert.match(plans.planProjectEdit({ params: { id: "shop", members: ["github:acme/shop", "github:acme/web"] }, paths, env: {} }).refusal, why);
    assert.match(plans.planProjectDelete({ id: "shop", paths, env: {} }).refusal, why);
    assert.ok(plans.planProjectEdit({ params: { id: "shop", name: "Shop" }, paths, env: {} }).plan, "a rename leaves membership, and the grant, as it is");
    assert.ok(plans.planProjectEdit({ params: { id: "tools", members: ["github:acme/tools", "github:acme/web"] }, paths, env: {} }).plan, "an unbundled project is edited as before");
    // A project created under a bundled id would start the bundle applying to its members.
    writeFileSync(paths.triggersPath, JSON.stringify({ triggers: [], secretBundles: { env: { profile: "p", ref: "r", project: "ghost" } } }));
    assert.match(plans.planProjectAdd({ params: { id: "ghost", members: ["github:acme/web"] }, paths, env: {} }).refusal, /project ghost/);
    // After the confirm: the bundle appears between the plan and the write, and the write judges the file as it is then.
    writeFileSync(paths.triggersPath, JSON.stringify({ triggers: [] }));
    const plan = plans.planProjectEdit({ params: { id: "shop", members: ["github:acme/web"] }, paths, env: {} }).plan;
    writeFileSync(paths.triggersPath, JSON.stringify({ triggers: [], secretBundles: { env: { profile: "p", ref: "r", project: "shop" } } }));
    assert.ok(writeProjects({ ...plan.writeArgs, expect: null }).invalid, "writeProjects refuses after the confirm too");
    // An unreadable/invalid triggers file cannot rule a bundle out.
    writeFileSync(paths.triggersPath, "{ nope");
    assert.match(plans.planProjectEdit({ params: { id: "tools", members: ["github:acme/x"] }, paths, env: {} }).refusal, /cannot be ruled out/);
  } finally {
    restore();
  }
});

// ---- issue #712 --------------------------------------------------------------------------------------------------------

test("run.recover is refused before the confirm on a venue that does not serve recovery: named, or PI_BACKENDS[0] when none is (#712)", async () => {
  const { recoverVenueProblem } = await import("../../worker/src/triggers.mjs");
  const { paths, restore } = deployment();
  try {
    const add = (params, env) => plans.planTriggerAdd({ params: { kind: "label", flow: "fix", labels: ["go"], ...params }, paths, env });
    assert.equal(add({ recover: true, backend: "openshell" }, { PI_BACKENDS: "local,openshell" }).refusal, recoverVenueProblem("openshell"), "an explicit venue: the loader's own sentence");
    assert.equal(add({ recover: true }, { PI_BACKENDS: "openshell,local" }).refusal, recoverVenueProblem("openshell"), "no venue named: the deployment default, which the loader cannot see");
    assert.ok(add({ recover: true }, { PI_BACKENDS: "local,openshell" }).plan, "the default serves it");
    assert.ok(add({ recover: true, backend: "openshell-bind" }, { PI_BACKENDS: "openshell-bind" }).plan, "bind mode serves it");
    assert.ok(add({ recover: false, backend: "openshell" }, { PI_BACKENDS: "openshell" }).plan, "false arms nothing");
    // The edit judges the entry as it would be after it, and only when it sends `recover` or a venue.
    const edit = (params, env) => plans.planTriggerEdit({ params: { index: 0, flow: "fix", ...params }, paths, env });
    assert.equal(edit({ recover: true }, { PI_BACKENDS: "openshell" }).refusal, recoverVenueProblem("openshell"));
    writeFileSync(paths.triggersPath, JSON.stringify({ triggers: [{ on: { type: "label", any: ["bug"] }, run: { kind: "github", flow: "fix", recover: true } }] }));
    assert.equal(edit({ backend: "openshell" }, { PI_BACKENDS: "local,openshell" }).refusal, recoverVenueProblem("openshell"), "moving a recovering trigger onto the venue");
    assert.ok(edit({}, { PI_BACKENDS: "openshell" }).plan, "an edit of the flow alone is not refused over a pairing it did not touch");
    assert.ok(edit({ recover: false }, { PI_BACKENDS: "openshell" }).plan, "and turning recovery off is the fix, so it passes");
  } finally {
    restore();
  }
});

test("the profile list names PI_SECRET_PROFILES' profiles beside the overlay's, and a name in both is marked ambiguous (#712)", async () => {
  const { envSecretProfiles } = await import("../src/read-model.mjs");
  assert.deepEqual(envSecretProfiles(undefined), { profiles: {}, malformed: false, seen: false });
  assert.deepEqual(envSecretProfiles("prod:/opt/pi/p.sh"), { profiles: { prod: "/opt/pi/p.sh" }, malformed: false, seen: true });
  assert.deepEqual(envSecretProfiles("prod:relative"), { profiles: {}, malformed: true, seen: true }, "the worker's parser refuses it, so nothing half-parsed is shown");
  assert.equal(plans.renderProfiles({ dev: "/d" }, envSecretProfiles(undefined)), "Resolver profiles (settings overlay):\n  dev -> /d", "not visible: the overlay's own list, as before");
  assert.equal(plans.renderProfiles({}, envSecretProfiles("prod:/opt/pi/p.sh")), "No resolver profiles are declared in the settings overlay.\nResolver profiles (PI_SECRET_PROFILES):\n  prod -> /opt/pi/p.sh");
  assert.match(plans.renderProfiles({ prod: "/o" }, envSecretProfiles("prod:/opt/pi/p.sh")), /prod -> \/opt\/pi\/p\.sh \(AMBIGUOUS: also in the settings overlay, so the worker refuses every secrets job\)/);
  assert.match(plans.renderProfiles({}, envSecretProfiles("x:rel")), /PI_SECRET_PROFILES does not parse/);
  // The roots: judged only where visible, on this host's realpath, fail-closed on an empty value (the realpath cases
  // are the next test).
  const asWritten = { realpathSync: (p) => p };
  const add = (path, env) => plans.planSecretProfileAdd({ name: "prod", path, profiles: {}, env, settingsFile: "/s", fs: asWritten });
  assert.ok(add("/tmp/r", null).plan, "roots not visible: not judged, and the confirm says the worker checks");
  assert.ok(add("/opt/pi/r", { PI_SECRET_RESOLVER_ROOTS: `/srv${delimiter}/opt/pi` }).plan);
  assert.match(add("/opt/pi-evil/r", { PI_SECRET_RESOLVER_ROOTS: "/opt/pi" }).refusal, /outside PI_SECRET_RESOLVER_ROOTS/, "a separator boundary, the worker's withinRoots");
  assert.match(plans.planSecretBundleAdd({ name: "b", path: "/tmp/b", format: "json", bundles: {}, env: { PI_SECRET_RESOLVER_ROOTS: "/opt/pi" }, settingsFile: "/s", fs: asWritten }).refusal, /outside PI_SECRET_RESOLVER_ROOTS/, "the bundle resolvers by the same rule");
});

test("the resolver roots are judged on this host's realpath, as the worker judges them: a symlink either way, and a path this host cannot resolve (#712)", () => {
  const dir = realpathSync(tempDir("pd-712-roots-"));
  const roots = join(dir, "roots");
  const outside = join(dir, "outside");
  mkdirSync(roots);
  mkdirSync(outside);
  writeFileSync(join(roots, "real.sh"), "#!/bin/sh\n");
  writeFileSync(join(outside, "real.sh"), "#!/bin/sh\n");
  symlinkSync(join(outside, "real.sh"), join(roots, "to-outside.sh"));
  symlinkSync(join(roots, "real.sh"), join(outside, "to-inside.sh"));
  // A root spelled through a symlink (macOS writes /tmp as /private/tmp): the worker never resolves a root, so it holds
  // nothing whose real path is under the target, and the refusal says to write the root as its real path.
  symlinkSync(roots, join(dir, "roots-link"));
  const env = { PI_SECRET_RESOLVER_ROOTS: roots };
  const add = (path, e = env) => plans.planSecretProfileAdd({ name: "prod", path, profiles: {}, env: e, settingsFile: "/s" });
  assert.ok(add(join(roots, "real.sh")).plan);
  assert.equal(add(join(roots, "to-outside.sh")).refusal, `${join(roots, "to-outside.sh")} (it resolves to ${join(outside, "real.sh")}) is outside PI_SECRET_RESOLVER_ROOTS (${roots}), so the worker would refuse it on every job; put the resolver inside one of them, or add its directory to PI_SECRET_RESOLVER_ROOTS`, "inside as written, outside on the real path: refused, as the worker would");
  assert.ok(add(join(outside, "to-inside.sh")).plan, "outside as written, inside on the real path: admitted, as the worker would");
  const viaLink = add(join(roots, "real.sh"), { PI_SECRET_RESOLVER_ROOTS: join(dir, "roots-link") });
  assert.equal(viaLink.refusal, `${join(roots, "real.sh")} is outside PI_SECRET_RESOLVER_ROOTS (${join(dir, "roots-link")}), so the worker would refuse it on every job; put the resolver inside one of them, or add its directory to PI_SECRET_RESOLVER_ROOTS, or write the root as its real path (${roots})`, "the roots are compared as written, as the worker compares them");
  assert.match(add(join(dir, "roots-link", "real.sh"), { PI_SECRET_RESOLVER_ROOTS: join(dir, "roots-link") }).refusal, /it resolves to .*write the root as its real path/, "the resolver's own path through the link is resolved too");
  // Only an error with a code means "cannot be resolved here"; anything else is a fault, never a pass.
  const broken = { realpathSync: () => { throw new TypeError("not a path"); } };
  assert.throws(() => plans.resolverRootsJudgement("/x", env, broken), TypeError);
  assert.ok(plans.resolverRootsJudgement("/x", env, { realpathSync: () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); } }).warning, "a coded error is a note");
  const missing = add(join(dir, "nowhere", "r.sh"));
  assert.ok(missing.plan, "a path this host cannot resolve is not refused");
  assert.match(missing.plan.message, /Note: .*nowhere\/r\.sh cannot be resolved on this host, so whether its real path sits inside PI_SECRET_RESOLVER_ROOTS .* is checked only by the worker, where it runs/);
  assert.ok(!add(join(roots, "real.sh")).plan.message.includes("Note:"), "a resolved path adds no note");
});
