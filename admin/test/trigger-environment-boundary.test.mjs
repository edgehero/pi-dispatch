// What keeps a model's call away from a person's write (issue #800, DES-ADMIN-VIA-PI-EXTENSION): no tool reaches
// `trigger-environment-edit`, and `dispatch_trigger_edit` keeps its own scope. Tried from the tool's side, with the real tool
// adapter and a real triggers file, so a change that opens a way through turns this red whichever way it goes.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { tempDir } from "./helpers/temp-dir.mjs";
import { authorizeTransition, actionAgentPolicy, evaluateAgentAction } from "../src/action-policy.mjs";
import { ACTIONS, actionNamed } from "../src/console/actions.mjs";
import { executeToolAction, TOOL_ACTIONS, toolActionRequest } from "../src/tool-actions.mjs";
import { CARD_FIELDS, TRIGGER_ENVIRONMENT_EDIT_FIELDS, triggerEntryDigest } from "../src/trigger-edit-core.mjs";
import * as plans from "../src/write-plans.mjs";

const ACTION = "trigger-environment-edit";
/** What only a person may set. `flow`, `provider` and `model` stay the tool's, so they are the card's and not this list's. */
const PERSON_ONLY = CARD_FIELDS.filter((key) => !["flow", "provider", "model"].includes(key));
const VALUE = { maxCostUsd: "1", models: ["anthropic/claude-haiku-4-5"], fallbackModels: ["anthropic/claude-haiku-4-5"], mcp: ["linear"], packages: false, excludeTools: ["bash"] };
/** Every spelling a model might reach for: the loader's own near misses, and a homoglyph of each (Cyrillic letters). */
const NEAR_MISSES = {
  maxCostUsd: ["MaxCostUsd", "max_cost_usd", "maxCost", "MAX-COST-USD", "m\u0430xCostUsd"],
  models: ["Models", "allowedModels", "allowed_models", "modelIds", "\u0430llowedModels"],
  fallbackModels: ["FallbackModels", "fallback_models", "fallbackModel", "fallback-model-ids", "f\u0430llbackModels"],
  mcp: ["MCP", "mcps", "mcpServers", "mcp_servers", "mcp-server", "m\u0441p"],
  packages: ["Packages", "PACKAGES", "package", "pack_ages", "p\u0430ckages"],
  excludeTools: ["ExcludeTools", "exclude_tools", "excludeTool", "excludedTools", "EXCLUDE-TOOLS", "tools", "noTools", "NoTools", "\u0435xcludeTools"],
};

function fixture() {
  const dir = tempDir("pd-800-boundary-");
  const paths = { triggersPath: join(dir, "triggers.json"), settingsFile: join(dir, "settings.json"), logsDir: dir, valkeyUrl: "redis://unit.invalid" };
  writeFileSync(paths.settingsFile, "{}");
  writeFileSync(paths.triggersPath, `${JSON.stringify({ triggers: [{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix" } }] }, null, 2)}\n`);
  const audit = [];
  const options = { paths, env: {}, granted: true, fleet: { snapshot: async () => ({}) }, audit: { append: (row) => (audit.push(row), { seq: audit.length }) }, actor: { name: "agent", role: "agent", session: null } };
  return { paths, options, audit, read: () => readFileSync(paths.triggersPath, "utf8") };
}
const interactive = { hasUI: true, ui: { confirm: async () => assert.fail("no confirm is ever shown for this") } };

/** Every file a bundle of `entry` reaches, dynamic imports too, by esbuild's own resolution (write-plans.test.mjs' walk). */
async function reached(entry) {
  const res = await build({
    stdin: { contents: `import ${JSON.stringify(entry)};`, resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), loader: "js" },
    bundle: true, write: false, format: "esm", platform: "node", metafile: true, outfile: "unused.mjs", external: ["bullmq", "ioredis"], logLevel: "silent",
  });
  return Object.keys(res.metafile.inputs);
}
const isPlanner = (file) => file.endsWith("src/trigger-environment-plans.mjs");

test("the import graph of every tool never reaches the planner, and the walk would see it", async () => {
  for (const entry of ["./tool-actions.mjs", "./index.ts", "./write-plans.mjs", "./console/actions.mjs"]) {
    const files = await reached(entry);
    assert.ok(files.length > 1, `${entry}: the walk followed its imports`);
    assert.deepEqual(files.filter(isPlanner), [], entry);
  }
  // The control: the console's own command does reach it, so a regression above turns red rather than passing on a blind walk.
  assert.ok((await reached("./console/cli.mjs")).some(isPlanner));
});

test("no source a tool loads imports the planner, by the plain text of its imports either", () => {
  for (const file of ["../src/tool-actions.mjs", "../src/write-plans.mjs", "../src/trigger-edit-core.mjs", "../src/console/actions.mjs", "../src/action-policy.mjs"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from\s+"[^"]*trigger-environment-plans|import\(\s*"[^"]*trigger-environment-plans/, file);
  }
});

test("write-plans hands a tool nothing of the person's: no planner, no core, no field list", () => {
  for (const name of ["planTriggerEditCore", "createTriggerEnvironmentActions", "CARD_FIELDS", "TRIGGER_ENVIRONMENT_EDIT_FIELDS", "triggerEntryDigest"]) assert.equal(plans[name], undefined, name);
  // `toolPlans = { ...writePlans }` is every export, so what follows is the whole of what a tool can call.
  const callable = Object.keys(plans).filter((key) => /environment|card/i.test(key));
  assert.deepEqual(callable, []);
});

test("planTriggerEdit has no such parameter: a recording call reads exactly its six arguments, and nothing it is handed widens it", () => {
  const f = fixture();
  const read = new Set();
  const args = new Proxy({ params: { index: 0, flow: "review" }, paths: f.paths, env: {}, baseRun: () => ({}), card: true, fields: [...CARD_FIELDS], authority: "operator", role: "operator", extra: VALUE }, { get: (target, key) => (read.add(key), target[key]) });
  assert.ok(plans.planTriggerEdit(args).plan);
  assert.deepEqual([...read].sort(), ["env", "fs", "params", "paths", "surface", "tool"]);
  for (const key of PERSON_ONLY) {
    const refused = plans.planTriggerEdit({ params: { index: 0, flow: "review", [key]: VALUE[key] }, paths: f.paths, env: {}, surface: "console", role: "operator", authority: "operator", card: true, baseRun: () => ({ [key]: VALUE[key] }) });
    assert.match(refused.refusal, new RegExp(`cannot set run\\.${key}`), key);
  }
});

test("what a tool's edit writes holds no person-only key, whatever it was handed", () => {
  const f = fixture();
  const { plan } = plans.planTriggerEdit({ params: { index: 0, flow: "review" }, paths: f.paths, env: {} });
  const [written] = plan.mutate([{ on: {}, run: { flow: "fix" } }]);
  assert.deepEqual(written.run, { flow: "review" });
});

for (const key of PERSON_ONLY) {
  test(`${key}: the planner and the real tool refuse it with a reason, at the top level, under run and under on, and nothing is written`, async () => {
    const f = fixture();
    const before = f.read();
    for (const [where, params] of [["sent as", { [key]: VALUE[key] }], ["sent as run.", { run: { [key]: VALUE[key] } }], ["sent as on.", { on: { [key]: VALUE[key] } }]]) {
      const sent = { index: 0, flow: "review", ...params };
      const reason = new RegExp(`dispatch_trigger_edit cannot set run\\.${key} \\(${where.replace(".", "\\.")}${where.endsWith(".") ? "" : " "}${key}\\): .* never by a tool`);
      assert.match(plans.wideningFieldRefusal(sent, "dispatch_trigger_edit"), reason);
      assert.match(plans.planTriggerEdit({ params: sent, paths: f.paths, env: {} }).refusal, reason);
      await assert.rejects(executeToolAction("dispatch_trigger_edit", sent, interactive, f.options), reason);
      await assert.rejects(executeToolAction("dispatch_trigger_edit", sent, { hasUI: false }, f.options), reason);
    }
    assert.match(plans.wideningFieldRefusal({ flow: "x", [key]: VALUE[key] }, "dispatch_trigger_add"), /dispatch_trigger_add cannot set run\./, "the add tool's sweep is the same sweep");
    assert.equal(f.read(), before);
  });

  test(`${key}: every near miss is refused as the field it spells, never dropped`, async () => {
    const f = fixture();
    const before = f.read();
    assert.ok(NEAR_MISSES[key].length > 0);
    for (const miss of NEAR_MISSES[key]) {
      for (const params of [{ [miss]: VALUE[key] }, { run: { [miss]: VALUE[key] } }, { on: { [miss]: VALUE[key] } }]) {
        const sent = { index: 0, flow: "review", ...params };
        const reason = new RegExp(`cannot set run\\.${key} \\(sent as `);
        assert.match(String(plans.wideningFieldRefusal(sent, "dispatch_trigger_edit")), reason, miss);
        assert.match(String(plans.planTriggerEdit({ params: sent, paths: f.paths, env: {} }).refusal), reason, miss);
        await assert.rejects(executeToolAction("dispatch_trigger_edit", sent, interactive, f.options), reason, miss);
      }
    }
    assert.equal(f.read(), before);
  });
}

test("what is near nothing stays the tool's to send: a sweep this wide refuses no other field the edit tool takes", () => {
  const f = fixture();
  for (const params of [{ flow: "review" }, { provider: "anthropic" }, { model: "claude-haiku-4-5" }, { maxTurns: 3 }, { progress: true }, { steer: false }]) {
    assert.equal(plans.wideningFieldRefusal({ index: 0, ...params }, "dispatch_trigger_edit"), null, JSON.stringify(params));
    assert.ok(plans.planTriggerEdit({ params: { index: 0, ...params }, paths: f.paths, env: {} }).plan, JSON.stringify(params));
  }
  // Unrelated keys the sweep has no word for: other refusals decide them, and these do not read as a tool switch or a package.
  for (const key of ["toolset", "tool", "packageName", "packages_old", "pack", "image", "folder", "notes"]) assert.equal(plans.wideningFieldRefusal({ [key]: "x" }, "dispatch_trigger_edit"), null, key);
  // A key outside plain ASCII with too few plain letters left to spell anything: the loader's own floor, in each sweep.
  for (const key of ["k\u00e4", "\u00e9t\u00e9"]) assert.equal(plans.wideningFieldRefusal({ [key]: "x" }, "dispatch_trigger_edit"), null, key);
});

test("dispatch_trigger_edit keeps today's scope: its action's fields and its schema name no person-only field", async () => {
  assert.deepEqual([...actionNamed("trigger-edit").fields].filter((key) => key !== "becauseRun").sort(), ["backend", "flow", "index", "maxTurns", "model", "progress", "provider", "recover", "statusComment", "steer"]);
  const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { createJiti } = piRequire("jiti");
  const indexMod = await createJiti(import.meta.url).import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
  const tools = [];
  indexMod.default(new Proxy({}, { get: (_t, key) => (key === "registerTool" ? (tool) => tools.push(tool) : () => {}) }));
  assert.ok(tools.length > 0);
  const edit = tools.find((tool) => tool.name === "dispatch_trigger_edit");
  for (const key of PERSON_ONLY) assert.ok(!Object.hasOwn(edit.parameters.properties, key), key);
  // No registered tool maps to the action, under any name it might have been given.
  for (const tool of tools) {
    assert.notEqual(TOOL_ACTIONS[tool.name], ACTION, tool.name);
    assert.doesNotMatch(tool.name, /environment/);
  }
});

test("the action is in no tool's table, and a tool that names it is refused before any read", async () => {
  assert.ok(!Object.values(TOOL_ACTIONS).includes(ACTION));
  for (const name of [ACTION, "dispatch_trigger_environment_edit", "dispatch_trigger_env"]) {
    await assert.rejects(toolActionRequest(name, {}), /no declared console action/, name);
    const f = fixture();
    await assert.rejects(executeToolAction(name, { index: 0, packages: false }, interactive, f.options), /no declared console action/, name);
  }
  await assert.rejects(executeToolAction("__proto__", { index: 0, packages: false }, interactive, fixture().options), /no declared console action/);
});

test("the action is person-only, for every role on every surface a tool stands on", () => {
  const policy = actionAgentPolicy(ACTION);
  assert.equal(policy.mode, "person");
  assert.deepEqual(policy.tools, [], "no tool is declared for it");
  assert.equal(actionNamed(ACTION).agent.mode, "person");
  assert.equal(actionNamed(ACTION).kind, "trigger-edit");
  // Even a transition that only narrows: this action's rule does not read the change, so no evidence can buy it.
  const narrowing = { before: { triggers: [{ run: { packages: true } }] }, after: { triggers: [{ run: { packages: false } }] }, plan: { index: 0 } };
  assert.equal(evaluateAgentAction(ACTION, narrowing).mode, "person");
  for (const actor of [{ role: "agent" }, { role: "operator" }, { role: "viewer" }, {}]) {
    for (const [surface, interactive2, granted] of [["tool", false, false], ["tool", true, false], ["tool", false, true], ["tool", true, true]]) {
      assert.equal(authorizeTransition({ actor, action: ACTION, surface, interactive: interactive2, granted, transition: narrowing }).ok, false, JSON.stringify({ actor, surface, interactive2, granted }));
    }
  }
  assert.equal(authorizeTransition({ actor: { role: "agent" }, action: ACTION, surface: "api", granted: true, transition: narrowing }).ok, false);
  assert.equal(authorizeTransition({ actor: { role: "viewer" }, action: ACTION, surface: "api" }).ok, false);
  assert.equal(authorizeTransition({ actor: { role: "operator" }, action: ACTION, surface: "api" }).ok, true, "and the person it exists for");
});

test("the action hands the planner the session's own role, so the planner's refusal stands behind the routes' for any session", async () => {
  const asked = [];
  const a = { triggerEnvironment: { preview: async (_body, ctx) => (asked.push(ctx), { refusal: "stopped", status: 403 }), apply: async (_entry, ctx) => (asked.push(ctx), { invalid: "stopped" }) } };
  for (const role of ["viewer", "agent", "operator"]) {
    await actionNamed(ACTION).preview({ index: 0, pageDigest: "a".repeat(64), packages: false }, { a, session: { role, name: "n" } });
    await actionNamed(ACTION).apply({ payload: {} }, { a, session: { role, name: "n" } });
    assert.deepEqual(asked.splice(0), [{ surface: "console", role, name: "n" }, { surface: "console", role }], role);
  }
});

test("a tool's adapter handed the action by a wrong lookup still writes nothing: its context carries no planner", async () => {
  const f = fixture();
  const before = f.read();
  const digest = triggerEntryDigest(JSON.parse(before).triggers[0]);
  const lookups = [() => actionNamed(ACTION)];
  for (const actionLookup of lookups) {
    await assert.rejects(executeToolAction("dispatch_trigger_fire", { index: 0, pageDigest: digest }, interactive, { ...f.options, actionLookup }));
    await assert.rejects(executeToolAction("dispatch_trigger_fire", { index: 0, pageDigest: digest }, { hasUI: false }, { ...f.options, actionLookup }));
  }
  assert.equal(f.read(), before);
});

test("the action's field list is the one field list: every key, once, and the table reads it", () => {
  assert.deepEqual([...TRIGGER_ENVIRONMENT_EDIT_FIELDS].sort(), ["index", "pageDigest", "keyOrder", ...CARD_FIELDS].sort());
  assert.equal(new Set(TRIGGER_ENVIRONMENT_EDIT_FIELDS).size, TRIGGER_ENVIRONMENT_EDIT_FIELDS.length);
  assert.deepEqual([...actionNamed(ACTION).fields], [...TRIGGER_ENVIRONMENT_EDIT_FIELDS]);
  // The two the tool keeps, and the rest, which no tool may send. Held both ways so a new card field must choose a side here.
  assert.deepEqual(PERSON_ONLY, ["maxCostUsd", "models", "fallbackModels", "mcp", "packages", "excludeTools"]);
  const proof = /const TOOL_PROOF_FIELDS = new Set\(\[([^]*?)\]\)/.exec(readFileSync(new URL("../src/write-plans.mjs", import.meta.url), "utf8"))[1];
  assert.deepEqual([...proof.matchAll(/"run\.([^"]+)"/g)].map((m) => m[1]).sort(), [...PERSON_ONLY].sort());
  assert.equal(ACTIONS.filter((action) => action.name === ACTION).length, 1);
});

test("the specs' list of the card's fields is CARD_FIELDS, and the audit contract says which kind this action writes", () => {
  const spec = (name) => readFileSync(new URL(`../../specs/${name}`, import.meta.url), "utf8");
  for (const name of ["design.md", "requirements.md"]) {
    const said = /`CARD_FIELDS`: ((?:`[A-Za-z]+`(?:, )?)+)/.exec(spec(name));
    assert.ok(said, `${name} names the list`);
    assert.deepEqual([...said[1].matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]), [...CARD_FIELDS], name);
  }
  assert.match(spec("interfaces.md"), new RegExp(`\`${ACTION}\` \\(issue #800, AMENDED 2026-11-04\\) writes \`${actionNamed(ACTION).kind}\``));
  assert.match(spec("requirements.md"), new RegExp(`\`${ACTION}\` is a free, person-only console action with no tool, audited as \`${actionNamed(ACTION).kind}\``));
});

test("the specs' list of tool-proof fields and the two counts they say are the code's", () => {
  const spec = (name) => readFileSync(new URL(`../../specs/${name}`, import.meta.url), "utf8");
  const requirements = spec("requirements.md");
  const bullet = /\*\*Spend and reach on a trigger's page \(#800\)\*\*: ([^\n]*)/.exec(requirements)[1];
  const named = [...bullet.slice(0, bullet.indexOf(". ")).matchAll(/`run\.([A-Za-z]+)`/g)].map((m) => m[1]);
  const proof = /const TOOL_PROOF_FIELDS = new Set\(\[([^]*?)\]\)/.exec(readFileSync(new URL("../src/write-plans.mjs", import.meta.url), "utf8"))[1];
  const fields = [...proof.matchAll(/"run\.([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...named].sort(), [...fields].sort(), "the requirement names each tool-proof field");
  const WORDS = { six: 6, nine: 9 };
  const all = /A person changes all (\w+) on the trigger's page/.exec(bullet)[1];
  assert.equal(WORDS[all], fields.length, "and counts them");
  // What `dispatch_trigger_edit` may set, the row number aside: the action's fields as a tool can send them.
  const editable = actionNamed("trigger-edit").fields.filter((key) => !["index", "becauseRun"].includes(key));
  let counted = 0;
  for (const text of [requirements, spec("design.md")]) {
    for (const [, word] of text.matchAll(/`dispatch_trigger_edit`(?:'s| keeps its| also accepts `maxTurns`; its) (\w+) (?:editable )?fields/g)) {
      counted += 1;
      assert.equal(WORDS[word], editable.length, word);
    }
  }
  assert.ok(counted >= 3, `the specs say the count (${counted})`);
});
