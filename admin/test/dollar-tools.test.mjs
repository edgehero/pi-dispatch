import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { renderTriggers } from "../src/render.mjs";

/**
 * Issue #501, part 7 (and #502's obligation from PR #536's review): the model-callable surfaces of the dollar caps.
 * `dispatch_costs` and `dispatch_limits` gain dollar rows; the scoped-limit writers take the dollar fields behind
 * their confirm, judged by the worker's own parser before it; `dispatch_set`'s dollar keys are judged the same way;
 * and NEITHER trigger tool can set `run.maxCostUsd` or `run.models`, while an existing value rides through untouched.
 */
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const indexMod = await jiti.import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
const { buildTriggerEntry } = indexMod;
const { validateToolArguments } = await import("@earendil-works/pi-ai");

function registeredTools() {
  const tools = [];
  const pi = new Proxy({}, { get: (_t, k) => (k === "registerTool" ? (t) => tools.push(t) : () => {}) });
  indexMod.default(pi);
  return tools;
}
const toolByName = (name) => registeredTools().find((t) => t.name === name);
function toolCtx({ hasUI = true, answer = true } = {}) {
  const shown = [];
  const ui = { confirm: async (title, message) => { shown.push({ title, message }); return answer; } };
  return { ctx: { hasUI, ui: hasUI ? ui : {} }, shown };
}
const textOf = (res) => JSON.parse(res.content[0].text);
const read = (path) => JSON.parse(readFileSync(path, "utf8"));

function tmpFile(name, value, envName) {
  const path = join(tempDir("pd-501-p7-"), name);
  if (value !== undefined) writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  process.env[envName] = path;
  return path;
}

// --- no widening by tool -----------------------------------------------------------------------------------

const GUARDED = { triggers: [{ on: { type: "label", any: ["bug"] }, run: { kind: "github", flow: "fix", provider: "openai", model: "gpt-x", models: ["openai/gpt-x", "openai/gpt-y"], maxCostUsd: "1.50" } }] };

for (const field of ["maxCostUsd", "models"]) {
  const value = field === "models" ? ["openai/gpt-x"] : "0.50";

  test(`dispatch_trigger_add refuses ${field} before any confirm, and writes nothing`, async () => {
    const path = tmpFile("triggers.json", { triggers: [] }, "PI_TRIGGERS_FILE");
    const { ctx, shown } = toolCtx({ answer: true });
    await assert.rejects(
      () => toolByName("dispatch_trigger_add").execute("id", { kind: "label", flow: "fix", labels: ["bug"], [field]: value }, undefined, undefined, ctx),
      new RegExp(`cannot set run\\.${field}`),
    );
    assert.equal(shown.length, 0, "the operator is never asked");
    assert.deepEqual(read(path), { triggers: [] });
  });

  test(`dispatch_trigger_edit refuses ${field} before any confirm, and the entry keeps its own`, async () => {
    const path = tmpFile("triggers.json", GUARDED, "PI_TRIGGERS_FILE");
    const before = readFileSync(path, "utf8");
    const { ctx, shown } = toolCtx({ answer: true });
    await assert.rejects(
      () => toolByName("dispatch_trigger_edit").execute("id", { index: 0, flow: "fix", [field]: field === "models" ? ["openai/gpt-z"] : "99" }, undefined, undefined, ctx),
      new RegExp(`cannot set run\\.${field}`),
    );
    assert.equal(shown.length, 0);
    assert.equal(readFileSync(path, "utf8"), before);
  });
}

test("the add builder never carries maxCostUsd or models, whatever it is handed", () => {
  for (const kind of ["cron", "label", "comment", "pull_request", "issue"]) {
    const entry = buildTriggerEntry(kind, { flow: "fix", id: "n", pattern: "0 3 * * *", folder: "/srv/x", task: "t", labels: ["bug"], phrase: "@pi", action: ["opened"], maxCostUsd: "0.10", models: ["a/b"] });
    assert.ok(!("maxCostUsd" in entry.run) && !("models" in entry.run), `${kind}: ${JSON.stringify(entry.run)}`);
  }
});

test("an approved trigger edit carries the entry's models and maxCostUsd through unchanged", async () => {
  const path = tmpFile("triggers.json", GUARDED, "PI_TRIGGERS_FILE");
  const { ctx } = toolCtx({ answer: true });
  const out = textOf(await toolByName("dispatch_trigger_edit").execute("id", { index: 0, flow: "review", model: "gpt-y" }, undefined, undefined, ctx));
  assert.equal(out.applied, true);
  const run = read(path).triggers[0].run;
  assert.equal(run.flow, "review");
  assert.equal(run.model, "gpt-y");
  assert.deepEqual(run.models, ["openai/gpt-x", "openai/gpt-y"]);
  assert.equal(run.maxCostUsd, "1.50");
});

test("dispatch_triggers and the plain trigger line show the models and the per-job cap (PR #536's obligation)", async () => {
  tmpFile("triggers.json", GUARDED, "PI_TRIGGERS_FILE");
  const [t] = textOf(await toolByName("dispatch_triggers").execute("id", {}, undefined, undefined, undefined));
  assert.deepEqual(t.models, ["openai/gpt-x", "openai/gpt-y"]);
  assert.equal(t.maxCostUsd, "1.50");
  const text = renderTriggers({ schedulers: [], triggers: { triggers: [t] } });
  assert.match(text, /\[models openai\/gpt-x, openai\/gpt-y\]  \[max \$1\.50\]/);
  // A trigger that sets neither keeps exactly its keys and its line.
  tmpFile("triggers.json", { triggers: [{ on: { type: "label", any: ["bug"] }, run: { kind: "github", flow: "fix" } }] }, "PI_TRIGGERS_FILE");
  const [plain] = textOf(await toolByName("dispatch_triggers").execute("id", {}, undefined, undefined, undefined));
  assert.ok(!("models" in plain) && !("maxCostUsd" in plain));
});

// --- scoped-limit writers ------------------------------------------------------------------------------------

test("dispatch_limit_add writes a dollar window in canonical form, stamps version 2, and asks first", async () => {
  const path = tmpFile("scoped-limits.json", { version: 1, limits: [] }, "PI_SCOPED_LIMITS_FILE");
  const { ctx, shown } = toolCtx({ answer: true });
  const out = textOf(await toolByName("dispatch_limit_add").execute("id", { scope: "acme/web", day: 3, dayUsd: "2.5" }, undefined, undefined, ctx));
  assert.equal(out.applied, true);
  assert.match(shown[0].message, /"dayUsd":"2\.50"/, "the confirm shows exactly what the file will hold");
  assert.deepEqual(read(path), { version: 2, limits: [{ scope: "acme/web", day: 3, dayUsd: "2.50" }] });
});

test("dispatch_limit_add takes a model row with dollar fields only", async () => {
  const path = tmpFile("scoped-limits.json", undefined, "PI_SCOPED_LIMITS_FILE");
  const { ctx } = toolCtx({ answer: true });
  textOf(await toolByName("dispatch_limit_add").execute("id", { scope: "model:openai/gpt-x", monthUsd: "25" }, undefined, undefined, ctx));
  assert.deepEqual(read(path), { version: 2, limits: [{ scope: "model:openai/gpt-x", monthUsd: "25.00" }] });
});

test("the limit writers keep the LOWEST version: a count-only file stays version 1, and drops back to it", async () => {
  const path = tmpFile("scoped-limits.json", { version: 2, limits: [{ scope: "acme/web", day: 3 }, { scope: "acme/api", dayUsd: "5" }] }, "PI_SCOPED_LIMITS_FILE");
  const { ctx } = toolCtx({ answer: true });
  await toolByName("dispatch_limit_edit").execute("id", { index: 0, day: 4 }, undefined, undefined, ctx);
  assert.equal(read(path).version, 2, "a dollar row still needs version 2");
  await toolByName("dispatch_limit_delete").execute("id", { index: 1 }, undefined, undefined, ctx);
  assert.deepEqual(read(path), { version: 1, limits: [{ scope: "acme/web", day: 4 }] }, "the last dollar row gone, the file is version 1 again");
  await toolByName("dispatch_limit_add").execute("id", { scope: "acme/ops", concurrent: 1 }, undefined, undefined, ctx);
  assert.equal(read(path).version, 1, "a count-only add writes version 1, readable by an older worker");
});

for (const [field, bad] of [["dayUsd", "1e3"], ["weekUsd", "0"], ["monthUsd", "0.1234567"], ["dayUsd", "2,50"]]) {
  test(`a malformed ${field} (${JSON.stringify(bad)}) is refused before the confirm, by both limit writers`, async () => {
    const initial = { version: 2, limits: [{ scope: "acme/web", dayUsd: "5" }] };
    const path = tmpFile("scoped-limits.json", initial, "PI_SCOPED_LIMITS_FILE");
    const { ctx, shown } = toolCtx({ answer: true });
    await assert.rejects(() => toolByName("dispatch_limit_add").execute("id", { scope: "acme/api", [field]: bad }, undefined, undefined, ctx), new RegExp(`${field} must be a dollar amount`));
    await assert.rejects(() => toolByName("dispatch_limit_edit").execute("id", { index: 0, [field]: bad }, undefined, undefined, ctx), new RegExp(`${field} must be a dollar amount`));
    assert.equal(shown.length, 0, "never asked to approve a value the write would refuse");
    assert.deepEqual(read(path), initial);
  });
}

test("a dollar field the model sends as a JSON number reaches the tool as a string through pi's own validator, and is judged by its value", async () => {
  // pi's validateToolArguments runs Value.Convert first, so no tool schema can keep a number out (PR #550's review).
  // What is pinned instead: the converted value goes through parseUsdMicros before the confirm, like a typed one.
  const path = tmpFile("scoped-limits.json", { version: 1, limits: [] }, "PI_SCOPED_LIMITS_FILE");
  const tool = toolByName("dispatch_limit_add");
  const args = validateToolArguments(tool, { name: tool.name, arguments: { scope: "acme/api", dayUsd: 2.5 } });
  assert.equal(args.dayUsd, "2.5", "the validator converted it");
  const ok = toolCtx({ answer: true });
  await tool.execute("id", args, undefined, undefined, ok.ctx);
  assert.deepEqual(read(path).limits, [{ scope: "acme/api", dayUsd: "2.50" }]);
  const tiny = validateToolArguments(tool, { name: tool.name, arguments: { scope: "acme/ops", dayUsd: 1e-7 } });
  const no = toolCtx({ answer: true });
  await assert.rejects(() => tool.execute("id", tiny, undefined, undefined, no.ctx), /dayUsd must be a dollar amount/);
  assert.equal(no.shown.length, 0, "1e-7 prints as an exponent and is refused before the confirm");
});

test("dispatch_limit_edit replaces a sent dollar field, carries the others, and shows both sides", async () => {
  const path = tmpFile("scoped-limits.json", { version: 2, limits: [{ scope: "acme/web", day: 3, dayUsd: "5", monthUsd: "60" }] }, "PI_SCOPED_LIMITS_FILE");
  const { ctx, shown } = toolCtx({ answer: true });
  textOf(await toolByName("dispatch_limit_edit").execute("id", { index: 0, dayUsd: "4.25", weekUsd: "20" }, undefined, undefined, ctx));
  assert.deepEqual(read(path).limits[0], { scope: "acme/web", day: 3, dayUsd: "4.25", weekUsd: "20.00", monthUsd: "60.00" });
  assert.match(shown[0].message, /"dayUsd":"5\.00".*\n→ .*"dayUsd":"4\.25"/s);
});

test("dispatch_limits gives each row its summary and, for a dollar row, its windows with the counter", async () => {
  tmpFile("scoped-limits.json", { version: 2, limits: [{ scope: "acme/web", day: 3, dayUsd: "5" }, { scope: "model:openai/gpt-x", weekUsd: "25" }, { scope: "acme/ops", concurrent: 1 }] }, "PI_SCOPED_LIMITS_FILE");
  process.env.VALKEY_URL = "not-a-url"; // degrade synchronously
  try {
    const rows = textOf(await toolByName("dispatch_limits").execute("id", {}, undefined, undefined, undefined));
    assert.equal(rows[0].summary, "day 3 · day $5.00");
    assert.deepEqual(rows[0].dollars, [{ window: "day", cap: "5.00", capMicros: 5_000_000, counterMicros: null }], "null on an unreachable queue, never an invented 0");
    assert.deepEqual(rows[1].dollars, [{ window: "week", cap: "25.00", capMicros: 25_000_000, counterMicros: null }]);
    assert.deepEqual(rows[2], { index: 2, scope: "acme/ops", day: null, week: null, month: null, concurrent: 1, dayUsd: null, weekUsd: null, monthUsd: null, used: null }, "a row with no dollar window reads exactly as before");
  } finally {
    delete process.env.VALKEY_URL;
  }
});

// --- dispatch_set's dollar keys --------------------------------------------------------------------------------

test("dispatch_set takes each of the four dollar keys behind its confirm, written as the string typed", async () => {
  const saved = process.env.PI_MAX_COST_USD;
  try {
    process.env.PI_MAX_COST_USD = "2";
    for (const key of ["maxCostUsd", "dailyCostUsd", "weeklyCostUsd", "monthlyCostUsd"]) {
      const settingsFile = tmpFile("settings.json", {}, "PI_SETTINGS_FILE");
      const declined = toolCtx({ answer: false });
      assert.equal(textOf(await toolByName("dispatch_set").execute("id", { key, value: "2.50" }, undefined, undefined, declined.ctx)).applied, false);
      assert.equal(declined.shown.length, 1, `${key}: asked`);
      assert.deepEqual(read(settingsFile), {}, `${key}: a decline writes nothing`);
      const approved = toolCtx({ answer: true });
      await toolByName("dispatch_set").execute("id", { key, value: "2.50" }, undefined, undefined, approved.ctx);
      assert.deepEqual(read(settingsFile), { [key]: "2.50" }, `${key}: kept as typed, never Number("2.50")`);
    }
  } finally {
    if (saved === undefined) delete process.env.PI_MAX_COST_USD;
    else process.env.PI_MAX_COST_USD = saved;
  }
});

test("dispatch_set refuses a malformed dollar value BEFORE the confirm, naming the key and never the value", async () => {
  const settingsFile = tmpFile("settings.json", { maxCostUsd: "2" }, "PI_SETTINGS_FILE");
  for (const bad of ["1e3", "0", "-1", "2.1234567", "0x10", "abc"]) {
    const { ctx, shown } = toolCtx({ answer: true });
    await assert.rejects(
      () => toolByName("dispatch_set").execute("id", { key: "dailyCostUsd", value: bad }, undefined, undefined, ctx),
      // The value is never echoed (a value typed into the wrong field could be anything); "0" and "-1" are too short to
      // tell apart from the message's own "1000000".
      (err) => /dailyCostUsd must be a dollar amount/.test(err.message) && (bad.length < 3 || !err.message.includes(bad)),
    );
    assert.equal(shown.length, 0, `${bad}: never asked`);
  }
  assert.deepEqual(read(settingsFile), { maxCostUsd: "2" });
});

// --- dispatch_costs ----------------------------------------------------------------------------------------------

test("dispatch_costs carries the dollar windows and the per-run dollars beside the fold", async () => {
  const logsDir = tempDir("pd-501-p7-logs-");
  process.env.PI_LOGS_DIR = logsDir;
  const now = Date.now();
  const at = (ms) => new Date(ms).toISOString();
  const rec = (jobId, over) => ({ jobId, kind: "github", target: "acme/web#1", flow: "fix", startedAt: at(now - 60_000), endedAt: at(now - 30_000), outcome: "completed", tokens: { total: 1, cost: 0.4, boundExceeded: 0 }, usage: null, ...over });
  writeFileSync(join(logsDir, "a.json"), JSON.stringify(rec("a", { dollars: { reservedMicros: 2_000_000, settledMicros: 400_000, basis: "metered", modelBasis: null } })));
  writeFileSync(join(logsDir, "b.json"), JSON.stringify(rec("b", { dollars: null })));
  tmpFile("settings.json", { maxCostUsd: "2", dailyCostUsd: "10" }, "PI_SETTINGS_FILE");
  tmpFile("scoped-limits.json", { version: 2, limits: [{ scope: "acme/web", dayUsd: "5" }] }, "PI_SCOPED_LIMITS_FILE");
  tmpFile("subscriptions.json", undefined, "PI_SUBSCRIPTIONS_FILE");
  tmpFile("triggers.json", { triggers: [] }, "PI_TRIGGERS_FILE");
  process.env.VALKEY_URL = "not-a-url";
  try {
    const out = textOf(await toolByName("dispatch_costs").execute("id", {}, undefined, undefined, undefined));
    assert.ok(out.fold, "the fold is still there");
    assert.deepEqual(out.dollars.windows.map((w) => [w.ledger, w.name, w.window, w.capMicros, w.counterMicros, w.records?.settledMicros]), [
      ["deployment", null, "day", 10_000_000, null, 400_000],
      ["scope", "acme/web", "day", 5_000_000, null, 400_000],
    ]);
    assert.ok(out.dollars.countersUnreachable, "an unreadable counter is said, not zeroed");
    assert.deepEqual(out.dollars.runs.map((r) => [r.jobId, r.dollars.basis, r.dollars.settledMicros]), [["a", "metered", 400_000]], "only runs that carry dollars");
    assert.equal(out.dollars.more, 0);
  } finally {
    delete process.env.VALKEY_URL;
  }
});

// --- PR #550's review ----------------------------------------------------------------------------------------

for (const extra of [{ MaxCostUsd: "9" }, { max_cost_usd: "9" }, { maxcostusd: "9" }, { "maxCostUsd ": "9" }, { allowedModels: ["a/b"] }, { run: { maxCostUsd: "9" } }, { run: { models: ["a/b"] } }, { on: { maxCostUsd: "9" } }, { "m\u0430xCostUsd": "9" }]) {
  test(`a near miss of a tool-proof field is refused too, before any confirm: ${JSON.stringify(extra)}`, async () => {
    const path = tmpFile("triggers.json", GUARDED, "PI_TRIGGERS_FILE");
    const before = readFileSync(path, "utf8");
    for (const [name, args] of [["dispatch_trigger_add", { kind: "label", flow: "fix", labels: ["bug"] }], ["dispatch_trigger_edit", { index: 0, flow: "fix" }]]) {
      const { ctx, shown } = toolCtx({ answer: true });
      await assert.rejects(() => toolByName(name).execute("id", { ...args, ...extra }, undefined, undefined, ctx), /cannot set run\.(maxCostUsd|models)/);
      assert.equal(shown.length, 0);
    }
    assert.equal(readFileSync(path, "utf8"), before);
  });
}

test("the near-miss refusal leaves the ordinary model fields alone", async () => {
  const path = tmpFile("triggers.json", { triggers: [] }, "PI_TRIGGERS_FILE");
  const { ctx } = toolCtx({ answer: true });
  await toolByName("dispatch_trigger_add").execute("id", { kind: "label", flow: "fix", labels: ["bug"], provider: "openai", model: "gpt-x", maxTurns: 4 }, undefined, undefined, ctx);
  assert.deepEqual(read(path).triggers[0].run, { kind: "github", flow: "fix", model: "gpt-x", provider: "openai", maxTurns: 4 });
});

test("with no dollar setting, dispatch_costs and dispatch_limits return exactly main's shapes", async () => {
  const logsDir = tempDir("pd-501-p7-logs-");
  process.env.PI_LOGS_DIR = logsDir;
  const now = Date.now();
  writeFileSync(join(logsDir, "a.json"), JSON.stringify({ jobId: "a", kind: "github", target: "acme/web#1", flow: "fix", startedAt: new Date(now - 60_000).toISOString(), endedAt: new Date(now - 30_000).toISOString(), outcome: "completed", tokens: { total: 1, cost: 0.4 }, usage: null, dollars: null }));
  tmpFile("settings.json", { maxCostUsd: "2" }, "PI_SETTINGS_FILE");
  tmpFile("scoped-limits.json", { version: 1, limits: [{ scope: "acme/web", day: 3 }] }, "PI_SCOPED_LIMITS_FILE");
  tmpFile("subscriptions.json", undefined, "PI_SUBSCRIPTIONS_FILE");
  tmpFile("triggers.json", { triggers: [] }, "PI_TRIGGERS_FILE");
  process.env.VALKEY_URL = "not-a-url";
  try {
    const costs = textOf(await toolByName("dispatch_costs").execute("id", {}, undefined, undefined, undefined));
    assert.deepEqual(Object.keys(costs), ["window", "fold"], "no dollars key at all");
    const rows = textOf(await toolByName("dispatch_limits").execute("id", {}, undefined, undefined, undefined));
    assert.deepEqual(rows, [{ index: 0, scope: "acme/web", day: 3, week: null, month: null, concurrent: null, used: null }], "no summary, no dollars");
  } finally {
    delete process.env.VALKEY_URL;
  }
});

// --- PR #550's review, round 2 -------------------------------------------------------------------------------

test("dispatch_costs names an unreadable dollar setting even when no window is left to show", async () => {
  tmpFile("settings.json", {}, "PI_SETTINGS_FILE");
  tmpFile("scoped-limits.json", undefined, "PI_SCOPED_LIMITS_FILE");
  tmpFile("subscriptions.json", undefined, "PI_SUBSCRIPTIONS_FILE");
  tmpFile("triggers.json", { triggers: [] }, "PI_TRIGGERS_FILE");
  process.env.PI_LOGS_DIR = tempDir("pd-501-p7-logs-");
  const saved = process.env.PI_DAILY_COST_USD;
  process.env.PI_DAILY_COST_USD = "abc";
  try {
    const out = textOf(await toolByName("dispatch_costs").execute("id", {}, undefined, undefined, undefined));
    assert.deepEqual(out.dollars.invalid, ["dailyCostUsd"]);
    assert.deepEqual(out.dollars.windows, []);
  } finally {
    if (saved === undefined) delete process.env.PI_DAILY_COST_USD;
    else process.env.PI_DAILY_COST_USD = saved;
  }
});

test("a dollar field with surrounding blanks is trimmed, judged, and written canonical", async () => {
  const path = tmpFile("scoped-limits.json", { version: 1, limits: [] }, "PI_SCOPED_LIMITS_FILE");
  const { ctx, shown } = toolCtx({ answer: true });
  await toolByName("dispatch_limit_add").execute("id", { scope: "acme/web", dayUsd: " 2.5 " }, undefined, undefined, ctx);
  assert.match(shown[0].message, /"dayUsd":"2\.50"/);
  assert.deepEqual(read(path).limits, [{ scope: "acme/web", dayUsd: "2.50" }]);
});

test("readScopedBudget swallows ioredis' error events too", async () => {
  const { readScopedBudget } = await import("../src/read-model.mjs");
  const events = [];
  const fake = { on: (ev) => events.push(ev), async get() { return "1"; }, disconnect() {} };
  const out = await readScopedBudget({ url: "redis://127.0.0.1:1", limits: [{ scope: "acme/web", day: 3 }], redisFn: () => fake });
  assert.deepEqual(out, { rows: [{ day: 1 }] });
  assert.deepEqual(events, ["error"]);
});
