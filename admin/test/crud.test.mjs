import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { fakeAllocRedis } from "./helpers/fake-alloc-redis.mjs";
import { envelopeDigest, parseEnvelope } from "@edgehero/pi-dispatch/envelope";

// The command-side CRUD driver (index.ts `handleDashboardAction`) runs pi's ctx.ui dialogs and calls the
// validated/atomic writeTriggers/writeSettings. Loaded through pi's jiti (the extension is erasable TS).
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const indexMod = await jiti.import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
const { handleDashboardAction } = indexMod;
// Issue #642: every write these drive is audited as the panel into PI_LOGS_DIR's console-audit chain, so the file's
// writes land in a directory of its own rather than the account's default logs directory.
process.env.PI_LOGS_DIR = tempDir("pi-crud-logs-");

/** Load the extension against a recording `pi` and return the registered tools by name. */
function registeredTools() {
  const tools = [];
  const pi = new Proxy({}, { get: (_t, k) => (k === "registerTool" ? (t) => tools.push(t) : () => {}) });
  indexMod.default(pi);
  return tools;
}
const toolByName = (name) => registeredTools().find((t) => t.name === name);
/** A ctx whose `confirm` records the (title, message) it is shown and returns a canned answer. */
function toolCtx({ hasUI = true, answer = true } = {}) {
  const shown = [];
  const ui = { confirm: async (title, message) => { shown.push({ title, message }); return answer; } };
  return { ctx: { hasUI, ui: hasUI ? ui : {} }, shown };
}
const textOf = (res) => JSON.parse(res.content[0].text);

/** A mock ctx.ui: `select`/`input`/`confirm` return canned answers in order; `notify` records. */
function mockUi({ select = [], input = [], confirm = [] } = {}) {
  const notes = [];
  const sel = [...select];
  const inp = [...input];
  const con = [...confirm];
  return {
    notes,
    async select() {
      return sel.shift();
    },
    async input() {
      return inp.shift();
    },
    async confirm() {
      return con.shift();
    },
    notify: (m, t) => notes.push({ m, t }),
  };
}

function tmpTriggers(initial) {
  const dir = tempDir("pi-crud-");
  const path = join(dir, "triggers.json");
  writeFileSync(path, JSON.stringify(initial));
  return path;
}
const read = (path) => JSON.parse(readFileSync(path, "utf8"));

test("addTrigger: kind-first dialogs write a validated label trigger (live-reloadable)", async () => {
  const path = tmpTriggers({ triggers: [] });
  // The label form now prompts forge first, then labels + flow.
  const ui = mockUi({ select: ["label"], input: ["github", "pi:fix urgent", "frontend-fix"] });
  await handleDashboardAction({ action: "addTrigger" }, { triggersPath: path }, { ui });
  const w = read(path);
  assert.equal(w.triggers.length, 1);
  assert.equal(w.triggers[0].on.type, "label");
  assert.deepEqual(w.triggers[0].on.any, ["pi:fix", "urgent"]);
  assert.equal(w.triggers[0].run.flow, "frontend-fix");
  assert.equal(w.triggers[0].run.kind, "github");
  assert.ok(ui.notes.some((n) => /added \(live\)/.test(n.m)), "a live-added notice is shown");
});

test("addTrigger: a cron entry pairs with local by construction (the diagonal is not offered)", async () => {
  const path = tmpTriggers({ triggers: [] });
  // The cron form prompts id/pattern/folder/flow/task, then the optional model/provider/maxTurns (blank here).
  const ui = mockUi({ select: ["cron"], input: ["nightly", "0 3 * * *", "/srv/site", "tidy", "run tidy", "", "", ""] });
  await handleDashboardAction({ action: "addTrigger" }, { triggersPath: path }, { ui });
  const t = read(path).triggers[0];
  assert.equal(t.on.type, "cron");
  assert.equal(t.run.kind, "local"); // never github — the form only builds the diagonal partner
  assert.equal(t.run.folder, "/srv/site");
  assert.ok(!("model" in t.run), "a blank model override is omitted, resolving the deployment default");
});

test("addTrigger: a cron entry can pin its own model/provider/maxTurns", async () => {
  const path = tmpTriggers({ triggers: [] });
  const ui = mockUi({ select: ["cron"], input: ["nightly", "0 3 * * *", "/srv/site", "tidy", "run tidy", "claude-sonnet-5", "anthropic", "20"] });
  await handleDashboardAction({ action: "addTrigger" }, { triggersPath: path }, { ui });
  const t = read(path).triggers[0];
  assert.equal(t.run.model, "claude-sonnet-5");
  assert.equal(t.run.provider, "anthropic");
  assert.equal(t.run.maxTurns, 20, "maxTurns is coerced to a number");
});

test("editTrigger: updates the flow in place", async () => {
  const path = tmpTriggers({ triggers: [{ on: { type: "label", any: ["x"] }, run: { kind: "github", flow: "old" } }] });
  await handleDashboardAction({ action: "editTrigger", index: 0 }, { triggersPath: path }, { ui: mockUi({ input: ["newflow"] }) });
  assert.equal(read(path).triggers[0].run.flow, "newflow");
});

test("editTrigger: an existing run.packages opt-in survives the write round-trip", async () => {
  // The admin re-serializes and re-validates the WHOLE file on every edit, so a field it has no dialog for
  // is exactly the field a round-trip could silently drop. `packages` is security-relevant (it decides
  // whether the job loads third-party code, REQ-GLOBAL-PI-OVERLAY), so losing it would quietly change what
  // a reviewed trigger does -- and re-adding it would need another human approval.
  const path = tmpTriggers({ triggers: [{ on: { type: "label", any: ["x"] }, run: { kind: "github", flow: "old", packages: true } }] });
  await handleDashboardAction({ action: "editTrigger", index: 0 }, { triggersPath: path }, { ui: mockUi({ input: ["newflow"] }) });
  const t = read(path).triggers[0];
  assert.equal(t.run.flow, "newflow", "the edited field changed");
  assert.equal(t.run.packages, true, "the untouched opt-in survived the round-trip");
});

test("editTrigger and deleteTrigger keep every other top-level key of the file (#704)", async () => {
  // The project secret bundles live beside the triggers array, so a console write that rebuilt the file as
  // `{ triggers }` would delete them on every edit. Both keys must come back with identical content.
  // A VALID bundle since the loader validates `secretBundles` strictly (#704 part 2): every write re-validates the file.
  const bundles = { acme: { profile: "op", ref: "op://vault/item", project: "acme", forkReviews: false } };
  const path = tmpTriggers({
    secretBundles: bundles,
    triggers: [{ on: { type: "label", any: ["a"] }, run: { kind: "github", flow: "old" } }, { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "f2" } }],
    x: [1],
  });
  await handleDashboardAction({ action: "editTrigger", index: 0 }, { triggersPath: path }, { ui: mockUi({ input: ["newflow"] }) });
  assert.equal(read(path).triggers[0].run.flow, "newflow");
  await handleDashboardAction({ action: "deleteTrigger", index: 1, confirmed: true }, { triggersPath: path }, { ui: mockUi() });
  const after = read(path);
  assert.equal(after.triggers.length, 1);
  assert.deepEqual(Object.keys(after), ["secretBundles", "triggers", "x"], "key order is kept, triggers replaced in place");
  assert.equal(JSON.stringify(after.secretBundles), JSON.stringify(bundles));
  assert.equal(JSON.stringify(after.x), "[1]");
});

test("deleteTrigger: removes on confirm, no-ops on decline", async () => {
  const two = { triggers: [{ on: { type: "label", any: ["a"] }, run: { kind: "github", flow: "f1" } }, { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "f2" } }] };
  const path = tmpTriggers(two);
  await handleDashboardAction({ action: "deleteTrigger", index: 0 }, { triggersPath: path }, { ui: mockUi({ confirm: [false] }) });
  assert.equal(read(path).triggers.length, 2, "a declined confirm leaves the file untouched");
  await handleDashboardAction({ action: "deleteTrigger", index: 0 }, { triggersPath: path }, { ui: mockUi({ confirm: [true] }) });
  assert.deepEqual(read(path).triggers.map((t) => t.on.type), ["comment"]);
});

test("deleteTrigger: an overlay-confirmed delete skips the dialog and still writes through the validator", async () => {
  const two = { triggers: [{ on: { type: "label", any: ["a"] }, run: { kind: "github", flow: "f1" } }, { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "f2" } }] };
  const path = tmpTriggers(two);
  // The overlay's own footer asked y/n (TRIGGER_DETAIL arms `x`), so asking again via ui.confirm would be
  // the same question twice. A confirm that WOULD decline proves the dialog was never consulted.
  await handleDashboardAction({ action: "deleteTrigger", index: 0, confirmed: true }, { triggersPath: path }, { ui: mockUi({ confirm: [false] }) });
  assert.deepEqual(read(path).triggers.map((t) => t.on.type), ["comment"], "the pre-confirmed delete wrote without a second dialog");
  // Anything short of the overlay's literal `confirmed: true` still goes through the dialog.
  await handleDashboardAction({ action: "deleteTrigger", index: 0, confirmed: "yes" }, { triggersPath: path }, { ui: mockUi({ confirm: [false] }) });
  assert.equal(read(path).triggers.length, 1, "a non-boolean marker does not bypass the confirm");
});

test("editSettings: pick a key + value writes the overlay; blank unsets", async () => {
  const dir = tempDir("pi-crud-");
  const settingsFile = join(dir, "settings.json");
  writeFileSync(settingsFile, JSON.stringify({ dailyCap: 25 }));
  await handleDashboardAction({ action: "editSettings" }, { settingsFile }, { ui: mockUi({ select: ["dailyCap"], input: ["50"] }) });
  assert.equal(read(settingsFile).dailyCap, 50);
  await handleDashboardAction({ action: "editSettings" }, { settingsFile }, { ui: mockUi({ select: ["dailyCap"], input: [""] }) });
  assert.equal("dailyCap" in read(settingsFile), false, "a blank value unsets the key");
});

test("a cancelled dialog (undefined) is a no-op", async () => {
  const path = tmpTriggers({ triggers: [] });
  await handleDashboardAction({ action: "addTrigger" }, { triggersPath: path }, { ui: mockUi({ select: [undefined] }) });
  assert.equal(read(path).triggers.length, 0);
});

test("a build without the dialog primitives degrades to a notice, no write", async () => {
  const path = tmpTriggers({ triggers: [] });
  const notes = [];
  await handleDashboardAction({ action: "addTrigger" }, { triggersPath: path }, { ui: { notify: (m, t) => notes.push({ m, t }) } });
  assert.equal(read(path).triggers.length, 0);
  assert.ok(notes.some((n) => /newer pi/.test(n.m)), "the missing-dialog notice is shown");
});

/**
 * The model-callable WRITE tools are the confirm gate in code: the model emits the call, a human answers the
 * confirm. These prove the three arms of `confirmedWrite` at the tool boundary -- no UI refuses (throws), a
 * decline applies nothing, an approval writes -- plus that the confirm shows the concrete change, plus the
 * out-of-range guard. Each tool reads its paths from process.env, so the temp files are wired through it.
 */
function withSettings(initial) {
  const settingsFile = join(tempDir("pi-set-"), "settings.json");
  writeFileSync(settingsFile, JSON.stringify(initial));
  process.env.PI_SETTINGS_FILE = settingsFile;
  return settingsFile;
}

test("dispatch_set: refuses (throws) with no interactive operator and writes nothing", async () => {
  const settingsFile = withSettings({ dailyCap: 25 });
  const { ctx } = toolCtx({ hasUI: false });
  await assert.rejects(
    () => toolByName("dispatch_set").execute("id", { key: "dailyCap", value: "99" }, undefined, undefined, ctx),
    /refused|interactive operator/,
  );
  assert.equal(read(settingsFile).dailyCap, 25, "no write without a confirm-capable UI");
});

test("dispatch_set: a declined confirm applies nothing, and the confirm shows the value before and after", async () => {
  const settingsFile = withSettings({ dailyCap: 25 });
  const { ctx, shown } = toolCtx({ answer: false });
  const out = textOf(await toolByName("dispatch_set").execute("id", { key: "dailyCap", value: "99" }, undefined, undefined, ctx));
  assert.equal(out.applied, false);
  assert.equal(read(settingsFile).dailyCap, 25, "a decline leaves the value untouched");
  assert.match(shown[0].message, /dailyCap: 25 to 99/, "the operator saw the concrete change");
});

test("dispatch_set: an approved confirm writes the coerced value", async () => {
  const settingsFile = withSettings({ dailyCap: 25 });
  const { ctx } = toolCtx({ answer: true });
  const out = textOf(await toolByName("dispatch_set").execute("id", { key: "dailyCap", value: "30" }, undefined, undefined, ctx));
  assert.equal(out.applied, true);
  assert.equal(read(settingsFile).dailyCap, 30, "written as a coerced JSON number");
});

test("dispatch_set: a dollar key's confirm shows the EFFECTIVE before-value and its source (#501)", async () => {
  // With PI_MAX_COST_USD=2 in env and no overlay key, "(unset) to 1000000" would read as adding a cap while it
  // raises one 500,000 times.
  const saved = process.env.PI_MAX_COST_USD;
  try {
    process.env.PI_MAX_COST_USD = "2";
    withSettings({});
    let probe = toolCtx({ answer: false });
    await toolByName("dispatch_set").execute("id", { key: "maxCostUsd", value: "1000000" }, undefined, undefined, probe.ctx);
    assert.match(probe.shown[0].message, /^maxCostUsd: 2 \(env PI_MAX_COST_USD\) to 1000000$/);
    withSettings({ maxCostUsd: "1.50" });
    probe = toolCtx({ answer: false });
    await toolByName("dispatch_set").execute("id", { key: "maxCostUsd", value: "3" }, undefined, undefined, probe.ctx);
    assert.match(probe.shown[0].message, /^maxCostUsd: 1\.50 \(overlay\) to 3$/);
    delete process.env.PI_MAX_COST_USD;
    withSettings({});
    probe = toolCtx({ answer: false });
    await toolByName("dispatch_set").execute("id", { key: "maxCostUsd", value: "3" }, undefined, undefined, probe.ctx);
    // No deployment pointer here: pi's environment is not the worker's, so an absent variable proves nothing.
    assert.match(probe.shown[0].message, /^maxCostUsd: \(not in the overlay; the worker's environment is not visible here\) to 3$/);
    // An EMPTY variable is unset, the worker's own reading.
    process.env.PI_MAX_COST_USD = "";
    probe = toolCtx({ answer: false });
    await toolByName("dispatch_set").execute("id", { key: "maxCostUsd", value: "3" }, undefined, undefined, probe.ctx);
    assert.match(probe.shown[0].message, /^maxCostUsd: \(not in the overlay; the worker's environment is not visible here\) to 3$/);
    delete process.env.PI_MAX_COST_USD;
    // The AFTER side of an unset is the value the key falls back to, by the same rule.
    process.env.PI_MAX_COST_USD = "2.00";
    withSettings({ maxCostUsd: "1.50" });
    probe = toolCtx({ answer: false });
    await toolByName("dispatch_set").execute("id", { key: "maxCostUsd" }, undefined, undefined, probe.ctx);
    assert.match(probe.shown[0].message, /^maxCostUsd: 1\.50 \(overlay\) to 2\.00 \(env PI_MAX_COST_USD\)$/);
    delete process.env.PI_MAX_COST_USD;
    withSettings({ maxCostUsd: "1.50" });
    probe = toolCtx({ answer: false });
    await toolByName("dispatch_set").execute("id", { key: "maxCostUsd", value: "" }, undefined, undefined, probe.ctx);
    assert.match(probe.shown[0].message, /^maxCostUsd: 1\.50 \(overlay\) to \(not in the overlay; the worker's environment is not visible here\)$/);
  } finally {
    if (saved === undefined) delete process.env.PI_MAX_COST_USD;
    else process.env.PI_MAX_COST_USD = saved;
  }
});

test("dispatch_set: an invalid current overlay is refused BEFORE the confirm, and the file is left alone (#501)", async () => {
  const settingsFile = join(tempDir("pi-set-"), "settings.json");
  const text = '{"maxCostUsd":"1","maxCostUsd":"1","dailyCap":4}';
  writeFileSync(settingsFile, text);
  process.env.PI_SETTINGS_FILE = settingsFile;
  const { ctx, shown } = toolCtx({ answer: true });
  await assert.rejects(
    () => toolByName("dispatch_set").execute("id", { key: "concurrency", value: "2" }, undefined, undefined, ctx),
    /rejected: the settings file is invalid \(settings file has a duplicate key "maxCostUsd".*\), so nothing was written/,
  );
  assert.equal(shown.length, 0, "the operator is never asked to approve a write that would be refused");
  assert.equal(readFileSync(settingsFile, "utf8"), text);
});

test("dispatch_set: a blank settings file (whitespace or a BOM only) is written over like a missing one (#540)", async () => {
  for (const text of ["", " \n\t\r\n", "﻿", "﻿ \n"]) {
    const settingsFile = join(tempDir("pi-set-"), "settings.json");
    writeFileSync(settingsFile, text);
    process.env.PI_SETTINGS_FILE = settingsFile;
    const declined = toolCtx({ answer: false });
    const outNo = textOf(await toolByName("dispatch_set").execute("id", { key: "dailyCap", value: "7" }, undefined, undefined, declined.ctx));
    assert.equal(outNo.applied, false);
    assert.equal(declined.shown.length, 1, `the operator is asked, as over a missing file (${JSON.stringify(text)})`);
    assert.match(declined.shown[0].message, /^dailyCap: \(unset\) to 7$/);
    assert.equal(readFileSync(settingsFile, "utf8"), text, "a decline leaves the blank file alone");
    const approved = toolCtx({ answer: true });
    const outYes = textOf(await toolByName("dispatch_set").execute("id", { key: "dailyCap", value: "7" }, undefined, undefined, approved.ctx));
    assert.equal(outYes.applied, true);
    assert.deepEqual(read(settingsFile), { dailyCap: 7 }, "approved, the blank file is written over");
  }
  // An unset over a blank file is the same: asked, then written as an empty overlay.
  const settingsFile = join(tempDir("pi-set-"), "settings.json");
  writeFileSync(settingsFile, "﻿\n");
  process.env.PI_SETTINGS_FILE = settingsFile;
  const { ctx, shown } = toolCtx({ answer: true });
  const out = textOf(await toolByName("dispatch_set").execute("id", { key: "dailyCap" }, undefined, undefined, ctx));
  assert.equal(out.applied, true);
  assert.equal(shown.length, 1);
  assert.deepEqual(read(settingsFile), {});
});

test("dispatch_set: an unknown key throws before any confirm", async () => {
  withSettings({ dailyCap: 25 });
  const { ctx } = toolCtx({ answer: true });
  await assert.rejects(
    () => toolByName("dispatch_set").execute("id", { key: "dailycap", value: "5" }, undefined, undefined, ctx),
    /unknown key/,
  );
});

test("dispatch_trigger_add: an approved confirm appends a validated entry", async () => {
  const path = tmpTriggers({ triggers: [] });
  process.env.PI_TRIGGERS_FILE = path;
  const { ctx, shown } = toolCtx({ answer: true });
  const out = textOf(await toolByName("dispatch_trigger_add").execute("id", { kind: "label", flow: "frontend-fix", labels: ["pi:fix"] }, undefined, undefined, ctx));
  assert.equal(out.applied, true);
  const w = read(path);
  assert.equal(w.triggers[0].on.type, "label");
  assert.deepEqual(w.triggers[0].on.any, ["pi:fix"]);
  assert.equal(w.triggers[0].run.flow, "frontend-fix");
  assert.match(shown[0].message, /triggers\.json/, "the confirm shows the entry being added");
});

test("dispatch_trigger_add: a file changed while the confirm was open is refused, and the other write is kept (issue #642)", async () => {
  // A valid entry another session could have written, made by the tool itself into a scratch file.
  const scratch = tmpTriggers({ triggers: [] });
  process.env.PI_TRIGGERS_FILE = scratch;
  await toolByName("dispatch_trigger_add").execute("id", { kind: "label", flow: "someone-else", labels: ["other"] }, undefined, undefined, toolCtx().ctx);
  const other = read(scratch);
  const path = tmpTriggers({ triggers: [] });
  process.env.PI_TRIGGERS_FILE = path;
  // The operator is reading the confirm when another session writes the file: the shown diff no longer holds.
  const ctx = { hasUI: true, ui: { confirm: async () => (writeFileSync(path, JSON.stringify(other)), true) } };
  await assert.rejects(
    toolByName("dispatch_trigger_add").execute("id", { kind: "label", flow: "frontend-fix", labels: ["pi:fix"] }, undefined, undefined, ctx),
    /changed after this change was built from it/,
  );
  assert.deepEqual(read(path), other, "nothing of the stale confirm was written over the other session's change");
});

test("dispatch_trigger_add: a cron entry carries an approved model/maxTurns override", async () => {
  const path = tmpTriggers({ triggers: [] });
  process.env.PI_TRIGGERS_FILE = path;
  const { ctx } = toolCtx({ answer: true });
  const out = textOf(await toolByName("dispatch_trigger_add").execute(
    "id",
    { kind: "cron", id: "nightly", pattern: "0 3 * * *", folder: "/srv", flow: "tidy", task: "run", model: "claude-opus-4-8", maxTurns: 40 },
    undefined, undefined, ctx,
  ));
  assert.equal(out.applied, true);
  const t = read(path).triggers[0];
  assert.equal(t.run.model, "claude-opus-4-8");
  assert.equal(t.run.maxTurns, 40);
  assert.equal(t.on.type, "cron");
});

test("dispatch_trigger_add: kind issue defaults the action to the forge's close word and carries number/once", async () => {
  // The close-trigger kind (issue #231), round-tripped through the SHARED validator: writeTriggers
  // refuses anything parseTriggers would, so a landed file is one the worker boots on and the
  // receiver groups. The action default is the forge's own close word -- the model states the match
  // it means without knowing three forges' spellings.
  const path = tmpTriggers({ triggers: [] });
  process.env.PI_TRIGGERS_FILE = path;
  const { ctx, shown } = toolCtx({ answer: true });
  const out = textOf(await toolByName("dispatch_trigger_add").execute("id", { kind: "issue", flow: "deploy", number: 40, once: true }, undefined, undefined, ctx));
  assert.equal(out.applied, true);
  const t = read(path).triggers[0];
  assert.deepEqual(t.on, { type: "issue", action: ["closed"], number: 40, once: true }, "github's close word is the default action");
  assert.equal(t.run.kind, "github");
  assert.equal(t.run.flow, "deploy");
  assert.match(shown[0].message, /"once":true/, "the confirm shows the one-shot the operator is arming");

  // The written bytes round-trip the shared validator directly -- the same parse the worker boots on.
  const { parseTriggers } = await import("@edgehero/pi-dispatch/triggers");
  const parsed = parseTriggers(readFileSync(path, "utf8"), path);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].on, { type: "issue", action: ["closed"], number: 40, once: true });

  // A gitlab entry defaults to gitlab's own spelling of the close.
  const path2 = tmpTriggers({ triggers: [] });
  process.env.PI_TRIGGERS_FILE = path2;
  await toolByName("dispatch_trigger_add").execute("id", { kind: "issue", flow: "announce", forge: "gitlab", number: 7, once: true }, undefined, undefined, toolCtx({ answer: true }).ctx);
  assert.deepEqual(read(path2).triggers[0].on.action, ["close"]);
  assert.equal(read(path2).triggers[0].run.kind, "gitlab");
});

test("dispatch_trigger_add: an issue one-shot without a number is refused at the write, nothing lands", async () => {
  // The tool passes number/once through rather than validating them (the unrecognised-forge rule):
  // the refusal is the shared validator's, with its race-analysis message, never a silent rewrite.
  const path = tmpTriggers({ triggers: [] });
  process.env.PI_TRIGGERS_FILE = path;
  const { ctx } = toolCtx({ answer: true });
  await assert.rejects(
    () => toolByName("dispatch_trigger_add").execute("id", { kind: "issue", flow: "deploy", once: true }, undefined, undefined, ctx),
    /rejected.*on\.once requires on\.number/,
  );
  assert.equal(read(path).triggers.length, 0);
});

// --- run.portfolio (issue #505): reviewed-file-only, so no tool or dialog writes it, and every edit keeps it ---

const PM_CRON = { on: { type: "cron", id: "pm-weekly", pattern: "0 6 * * 1" }, run: { kind: "local", folder: "/srv/pm", flow: "pm", task: "plan", portfolio: true } };

test("dispatch_trigger_add cannot produce run.portfolio, even sent as an extra field (#505)", async () => {
  const path = tmpTriggers({ triggers: [] });
  process.env.PI_TRIGGERS_FILE = path;
  const { ctx, shown } = toolCtx({ answer: true });
  // Issue #737: a field the kind does not take is refused by name before the confirm, where it used to be dropped in
  // silence, so the flag can neither be written nor shown.
  await assert.rejects(
    toolByName("dispatch_trigger_add").execute(
      "id",
      { kind: "cron", id: "pm-weekly", pattern: "0 6 * * 1", folder: "/srv/pm", flow: "pm", task: "plan", portfolio: true, run: { portfolio: true } },
      undefined, undefined, ctx,
    ),
    { message: "dispatch_trigger_add does not take portfolio for a cron trigger; it takes kind, id, pattern, folder, flow, task, model, provider, maxTurns, backend, progress, statusComment, recover, steer. Nothing was changed" },
  );
  assert.equal(shown.length, 0, "the operator was never asked");
  assert.equal(read(path).triggers.length, 0, "and nothing was written");
});

test("the panel's add-trigger dialogs never ask for run.portfolio, and the cron entry they write has none (#505)", async () => {
  const path = tmpTriggers({ triggers: [] });
  const asked = [];
  // Extra "true" answers queued past the cron form's eight prompts: a ninth prompt would take one and show here.
  const ui = mockUi({ select: ["cron"], input: ["pm-weekly", "0 6 * * 1", "/srv/pm", "pm", "plan", "", "", "", "true", "true"] });
  const input = ui.input;
  ui.input = async (label, ...rest) => (asked.push(label), input(label, ...rest));
  const select = ui.select;
  const offered = [];
  ui.select = async (title, options, ...rest) => (offered.push(...(options ?? [])), select(title, options, ...rest));
  await handleDashboardAction({ action: "addTrigger" }, { triggersPath: path }, { ui });
  assert.equal(asked.length, 8, "the cron form asks exactly its eight questions");
  assert.equal(asked.some((l) => /portfolio/i.test(l)), false);
  assert.equal(offered.some((o) => /portfolio/i.test(String(o))), false);
  const t = read(path).triggers[0];
  assert.equal(t.on.id, "pm-weekly");
  assert.equal("portfolio" in t.run, false);
});

test("dispatch_trigger_edit keeps an existing run.portfolio flag through a flow and model edit (#505)", async () => {
  const path = tmpTriggers({ triggers: [PM_CRON] });
  process.env.PI_TRIGGERS_FILE = path;
  const { ctx } = toolCtx({ answer: true });
  await toolByName("dispatch_trigger_edit").execute("id", { index: 0, flow: "pm2", model: "qwen" }, undefined, undefined, ctx);
  const t = read(path).triggers[0];
  assert.equal(t.run.flow, "pm2");
  assert.equal(t.run.portfolio, true, "the reviewed flag survives the round trip");
});

test("the panel's flow edit keeps an existing run.portfolio flag (#505)", async () => {
  const path = tmpTriggers({ triggers: [PM_CRON] });
  await handleDashboardAction({ action: "editTrigger", index: 0 }, { triggersPath: path }, { ui: mockUi({ input: ["pm3"] }) });
  assert.deepEqual(read(path).triggers[0], { ...PM_CRON, run: { ...PM_CRON.run, flow: "pm3" } });
});

test("dispatch_trigger_edit: an approved confirm changes the flow and shows the old and the new", async () => {
  const path = tmpTriggers({ triggers: [{ on: { type: "label", any: ["a"] }, run: { kind: "github", flow: "old" } }] });
  process.env.PI_TRIGGERS_FILE = path;
  const { ctx, shown } = toolCtx({ answer: true });
  await toolByName("dispatch_trigger_edit").execute("id", { index: 0, flow: "new" }, undefined, undefined, ctx);
  assert.equal(read(path).triggers[0].run.flow, "new");
  assert.match(shown[0].message, /old to new/);
});

test("dispatch_trigger_edit: provider and model ride the confirm and land on the entry (#502)", async () => {
  const path = tmpTriggers({ triggers: [{ on: { type: "label", any: ["a"] }, run: { kind: "github", flow: "old", model: "gpt-5.4" } }] });
  process.env.PI_TRIGGERS_FILE = path;
  const { ctx, shown } = toolCtx({ answer: true });
  const out = textOf(await toolByName("dispatch_trigger_edit").execute("id", { index: 0, flow: "old", provider: "anthropic", model: "claude-sonnet-4-5" }, undefined, undefined, ctx));
  assert.equal(out.applied, true);
  assert.deepEqual(read(path).triggers[0].run, { kind: "github", flow: "old", model: "claude-sonnet-4-5", provider: "anthropic" });
  assert.match(shown[0].message, /provider: - to anthropic/);
  assert.match(shown[0].message, /model: gpt-5\.4 to claude-sonnet-4-5/);
});

test("dispatch_trigger_edit: a malformed model is refused BEFORE the confirm, with the loader's message (#502)", async () => {
  const initial = { triggers: [{ on: { type: "label", any: ["a"] }, run: { kind: "github", flow: "old" } }] };
  const path = tmpTriggers(initial);
  process.env.PI_TRIGGERS_FILE = path;
  for (const bad of [{ model: "gpt 5" }, { model: "x".repeat(65) }, { provider: "open/ai" }]) {
    const { ctx, shown } = toolCtx({ answer: true });
    await assert.rejects(
      () => toolByName("dispatch_trigger_edit").execute("id", { index: 0, flow: "old", ...bad }, undefined, undefined, ctx),
      /trigger #1: run\.(model|provider) must be/,
    );
    assert.equal(shown.length, 0, "the operator is never asked to approve a value the write would refuse");
  }
  assert.deepEqual(read(path), initial);
});

test("dispatch_trigger_edit: a model that falls off the trigger's own run.models is refused BEFORE the confirm (#502)", async () => {
  const initial = { triggers: [{ on: { type: "label", any: ["a"] }, run: { kind: "github", flow: "old", provider: "openai", model: "gpt-5.4", models: ["openai/gpt-5.4"] } }] };
  const path = tmpTriggers(initial);
  process.env.PI_TRIGGERS_FILE = path;
  const { ctx, shown } = toolCtx({ answer: true });
  await assert.rejects(
    () => toolByName("dispatch_trigger_edit").execute("id", { index: 0, flow: "old", model: "gpt-5.4-mini" }, undefined, undefined, ctx),
    /trigger #1: run\.models does not list this trigger's own run\.provider\/run\.model/,
  );
  assert.equal(shown.length, 0, "the merged run is checked, so the operator is never asked to approve an entry the write refuses");
  assert.deepEqual(read(path), initial);
});

test("dispatch_trigger_edit: an edit that sends no model keeps the one the entry has (#502)", async () => {
  const path = tmpTriggers({ triggers: [{ on: { type: "label", any: ["a"] }, run: { kind: "github", flow: "old", provider: "openai", model: "gpt-5.4" } }] });
  process.env.PI_TRIGGERS_FILE = path;
  const { ctx, shown } = toolCtx({ answer: true });
  await toolByName("dispatch_trigger_edit").execute("id", { index: 0, flow: "new", model: "  " }, undefined, undefined, ctx);
  assert.deepEqual(read(path).triggers[0].run, { kind: "github", flow: "new", provider: "openai", model: "gpt-5.4" });
  assert.equal(/model:|provider:/.test(shown[0].message), false, "nothing sent, nothing shown as changing");
});

test("dispatch_trigger_add: a webhook trigger keeps the model it was given (#502)", async () => {
  const path = tmpTriggers({ triggers: [] });
  process.env.PI_TRIGGERS_FILE = path;
  const { ctx } = toolCtx({ answer: true });
  await toolByName("dispatch_trigger_add").execute("id", { kind: "label", labels: ["pi:go"], flow: "fix", provider: "openai", model: "gpt-5.4", maxTurns: 4 }, undefined, undefined, ctx);
  assert.deepEqual(read(path).triggers[0].run, { kind: "github", flow: "fix", model: "gpt-5.4", provider: "openai", maxTurns: 4, secretBundle: false });
  // And a malformed one is the loader's own refusal BEFORE the confirm, never an approval wasted on an
  // entry the write then refuses, and never a silent drop.
  for (const bad of [{ model: "gpt 5" }, { provider: "open/ai" }, { maxTurns: 0 }]) {
    const fresh = toolCtx({ answer: true });
    await assert.rejects(
      () => toolByName("dispatch_trigger_add").execute("id", { kind: "comment", phrase: "@pi", flow: "fix", ...bad }, undefined, undefined, fresh.ctx),
      /the new trigger: run\.(model|provider|maxTurns) must be/,
    );
    assert.equal(fresh.shown.length, 0, "the operator is never asked to approve a value the write would refuse");
  }
  assert.equal(read(path).triggers.length, 1);
});

test("dispatch_trigger_delete: out-of-range index throws and writes nothing", async () => {
  const path = tmpTriggers({ triggers: [{ on: { type: "label", any: ["a"] }, run: { kind: "github", flow: "f" } }] });
  process.env.PI_TRIGGERS_FILE = path;
  const { ctx } = toolCtx({ answer: true });
  await assert.rejects(
    () => toolByName("dispatch_trigger_delete").execute("id", { index: 9 }, undefined, undefined, ctx),
    /no trigger at index/,
  );
  assert.equal(read(path).triggers.length, 1);
});

test("the extension advertises the operate-pi-dispatch skill via resources_discover", () => {
  let handler;
  const pi = new Proxy({}, {
    get: (_t, k) => (k === "on" ? (evt, h) => { if (evt === "resources_discover") handler = h; } : () => {}),
  });
  indexMod.default(pi);
  assert.equal(typeof handler, "function", "registered a resources_discover handler");
  const res = handler({ type: "resources_discover", cwd: "/", reason: "startup" }, {});
  assert.ok(Array.isArray(res.skillPaths) && res.skillPaths.length === 1, "advertises one skill dir");
  assert.ok(existsSync(join(res.skillPaths[0], "operate-pi-dispatch", "SKILL.md")), "the dir holds the skill");
});

// ── scoped pause windows (REQ-SCOPED-PAUSE-WINDOWS): same confirm-gated CRUD as triggers ─────────────────
function tmpPauses(initial) {
  const path = join(tempDir("pi-pw-"), "pause-windows.json");
  writeFileSync(path, JSON.stringify(initial));
  process.env.PI_PAUSE_WINDOWS_FILE = path;
  return path;
}

test("dispatch_pause_add: an approved confirm writes a validated window (tz/days carried)", async () => {
  const path = tmpPauses({ windows: [] });
  const { ctx, shown } = toolCtx({ answer: true });
  const out = textOf(await toolByName("dispatch_pause_add").execute("id", { scope: "acme/web", from: "22:00", to: "06:00", tz: "Europe/Amsterdam", days: ["fri"] }, undefined, undefined, ctx));
  assert.equal(out.applied, true);
  const w = read(path).windows[0];
  assert.equal(w.scope, "acme/web");
  assert.equal(w.from, "22:00");
  assert.equal(w.tz, "Europe/Amsterdam");
  assert.deepEqual(w.days, ["fri"]);
  assert.match(shown[0].message, /pause-windows\.json/);
});

test("dispatch_pause_add: an invalid window (from==to) is rejected, nothing written", async () => {
  const path = tmpPauses({ windows: [] });
  const { ctx } = toolCtx({ answer: true });
  await assert.rejects(() => toolByName("dispatch_pause_add").execute("id", { scope: "x", from: "09:00", to: "09:00" }, undefined, undefined, ctx), /rejected|differ/);
  assert.equal(read(path).windows.length, 0);
});

test("dispatch_pause_add: refuses with no interactive operator and writes nothing", async () => {
  const path = tmpPauses({ windows: [] });
  const { ctx } = toolCtx({ hasUI: false });
  await assert.rejects(() => toolByName("dispatch_pause_add").execute("id", { scope: "x", from: "22:00", to: "06:00" }, undefined, undefined, ctx), /refused|interactive operator/);
  assert.equal(read(path).windows.length, 0);
});

test("dispatch_pause_delete: out-of-range index throws and writes nothing", async () => {
  const path = tmpPauses({ windows: [{ scope: "acme/web", from: "22:00", to: "06:00" }] });
  const { ctx } = toolCtx({ answer: true });
  await assert.rejects(() => toolByName("dispatch_pause_delete").execute("id", { index: 9 }, undefined, undefined, ctx), /no pause window at index/);
  assert.equal(read(path).windows.length, 1);
});

test("managePauses: Add writes a validated pause window (live)", async () => {
  const path = tmpPauses({ windows: [] });
  const ui = mockUi({ select: ["Add a pause window"], input: ["acme/web", "22:00", "06:00", "", "", "", ""] });
  await handleDashboardAction({ action: "managePauses" }, { pauseWindowsPath: path }, { ui });
  const w = read(path).windows;
  assert.equal(w.length, 1);
  assert.equal(w[0].scope, "acme/web");
  assert.equal(w[0].to, "06:00");
  assert.ok(ui.notes.some((n) => /added \(live\)/.test(n.m)), "a live-added notice is shown");
});

test("managePauses: Delete removes the picked window on confirm", async () => {
  const path = tmpPauses({ windows: [{ scope: "acme/web", from: "22:00", to: "06:00" }, { scope: "*", from: "00:00", to: "01:00" }] });
  const ui = mockUi({ select: ["Delete a pause window", "#1  acme/web  22:00-06:00 UTC"], confirm: [true] });
  await handleDashboardAction({ action: "managePauses" }, { pauseWindowsPath: path }, { ui });
  assert.deepEqual(read(path).windows.map((w) => w.scope), ["*"], "only the picked window is removed");
});

test("dispatch_pause_edit: an approved partial edit changes one field and keeps the rest", async () => {
  const path = tmpPauses({ windows: [{ scope: "acme/web", from: "22:00", to: "06:00", tz: "Europe/Amsterdam", days: ["mon", "tue"] }] });
  const { ctx, shown } = toolCtx({ answer: true });
  const out = textOf(await toolByName("dispatch_pause_edit").execute("id", { index: 0, to: "07:00" }, undefined, undefined, ctx));
  assert.equal(out.applied, true);
  const w = read(path).windows[0];
  assert.equal(w.to, "07:00", "the changed field");
  assert.equal(w.from, "22:00", "unchanged field kept");
  assert.equal(w.tz, "Europe/Amsterdam", "unchanged field kept");
  assert.deepEqual(w.days, ["mon", "tue"], "unchanged field kept");
  assert.match(shown[0].message, /06:00/);
  assert.match(shown[0].message, /07:00/);
});

test("dispatch_pause_edit: out-of-range index throws and writes nothing", async () => {
  const path = tmpPauses({ windows: [{ scope: "acme/web", from: "22:00", to: "06:00" }] });
  const { ctx } = toolCtx({ answer: true });
  await assert.rejects(() => toolByName("dispatch_pause_edit").execute("id", { index: 9, to: "07:00" }, undefined, undefined, ctx), /no pause window at index/);
  assert.equal(read(path).windows[0].to, "06:00");
});

test("dispatch_pause_edit: refuses with no interactive operator and writes nothing", async () => {
  const path = tmpPauses({ windows: [{ scope: "acme/web", from: "22:00", to: "06:00" }] });
  const { ctx } = toolCtx({ hasUI: false });
  await assert.rejects(() => toolByName("dispatch_pause_edit").execute("id", { index: 0, to: "07:00" }, undefined, undefined, ctx), /refused|interactive operator/);
  assert.equal(read(path).windows[0].to, "06:00");
});

test("managePauses: Edit re-prompts fields (blank keeps) and updates the picked window", async () => {
  const path = tmpPauses({ windows: [{ scope: "acme/web", from: "22:00", to: "06:00", tz: "Europe/Amsterdam" }] });
  // pick the window, then blank-keep scope/from, change `to`, blank-keep tz/days/dateFrom/dateTo.
  const ui = mockUi({ select: ["Edit a pause window", "#1  acme/web  22:00-06:00 Europe/Amsterdam"], input: ["", "", "07:00", "", "", "", ""] });
  await handleDashboardAction({ action: "managePauses" }, { pauseWindowsPath: path }, { ui });
  const w = read(path).windows[0];
  assert.equal(w.to, "07:00", "the changed field");
  assert.equal(w.from, "22:00", "kept");
  assert.equal(w.tz, "Europe/Amsterdam", "kept");
  assert.ok(ui.notes.some((n) => /updated \(live\)/.test(n.m)), "a live-updated notice is shown");
});

test("addTrigger: a gitlab label trigger writes run.kind gitlab and passes the shared validator", async () => {
  const path = tmpTriggers({ triggers: [] });
  const ui = mockUi({ select: ["label"], input: ["gitlab", "pi:fix", "frontend-fix"] });
  await handleDashboardAction({ action: "addTrigger" }, { triggersPath: path }, { ui });
  const w = read(path);
  assert.equal(w.triggers.length, 1, "the write must survive parseTriggers -- writeTriggers validates before it lands");
  assert.equal(w.triggers[0].run.kind, "gitlab");
});

test("addTrigger: a gitlab MR trigger's action words are gitlab's, and github's are refused at the write", async () => {
  const path = tmpTriggers({ triggers: [] });
  const ok = mockUi({ select: ["pull_request"], input: ["gitlab", "open update", "", "review"] });
  await handleDashboardAction({ action: "addTrigger" }, { triggersPath: path }, { ui: ok });
  assert.deepEqual(read(path).triggers[0].on.action, ["open", "update"]);

  // The dialog passes the operator's word through rather than correcting it, so the shared validator is
  // what refuses -- a silent rewrite to a valid-looking word would arm a trigger they did not ask for.
  const path2 = tmpTriggers({ triggers: [] });
  const bad = mockUi({ select: ["pull_request"], input: ["gitlab", "synchronize", "", "review"] });
  await handleDashboardAction({ action: "addTrigger" }, { triggersPath: path2 }, { ui: bad });
  assert.equal(read(path2).triggers.length, 0, "a github action word on a gitlab trigger must not be written");
  assert.ok(bad.notes.some((n) => /rejected/.test(n.m)), "and the operator is told why");
});

// --- /dispatch secrets: declaring a resolver profile (REQ-TRIGGER-SECRETS, issue #225) ---

test("declaring a profile writes the overlay only after a confirm showing the EXACT bytes", async () => {
  // The deployment pointer's discipline: this file redirects what the worker EXECUTES, so the operator
  // approves the thing itself rather than a summary of it.
  const { runSecretsCommand } = await jiti.import("../src/secrets-command.ts");
  const files = {};
  const fs = {
    readFileSync: (p) => {
      if (!(p in files)) { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
      return files[p];
    },
    writeFileSync: (p, d) => (files[p] = d),
    renameSync: (a, b) => { files[b] = files[a]; delete files[a]; },
    mkdirSync: () => {},
  };
  const shown = [];
  const notes = [];
  const ctx = { ui: { input: async (t) => (/profile name/.test(t) ? "prod" : "/opt/pi/resolve.sh"), confirm: async (_t, m) => (shown.push(m), true), notify: () => {} } };
  await runSecretsCommand({ settingsFile: "/s/settings.json" }, ctx, (m) => notes.push(m), ["add"], { fs });

  assert.match(shown[0], /"secretProfiles"/, "the exact JSON to be written is shown");
  assert.match(shown[0], /prod/);
  assert.match(shown[0], /executes this script/, "the operator is told what they are granting");
  assert.match(shown[0], /PI_SECRET_RESOLVER_ROOTS/, "and that the worker still has to admit it");
  assert.deepEqual(JSON.parse(files["/s/settings.json"]), { secretProfiles: { prod: "/opt/pi/resolve.sh" } });
  assert.ok(notes.some((n) => /triggers\.json/.test(n)), "and the operator is told binding it is still a file edit");
});

test("/dispatch secrets reads a blank settings file (whitespace or a BOM only) as a missing one (#540)", async () => {
  const { runSecretsCommand } = await jiti.import("../src/secrets-command.ts");
  const memFs = (text) => {
    const files = { "/s/settings.json": text };
    return {
      files,
      readFileSync: (p) => {
        if (!(p in files)) { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
        return files[p];
      },
      writeFileSync: (p, d) => (files[p] = d),
      renameSync: (a, b) => { files[b] = files[a]; delete files[a]; },
      mkdirSync: () => {},
    };
  };
  const ctx = (shown) => ({ ui: { input: async (t) => (/profile name/.test(t) ? "prod" : "/opt/pi/resolve.sh"), confirm: async (_t, m) => (shown.push(m), true), notify: () => {} } });
  for (const text of ["", " \n", "﻿", "﻿ \n"]) {
    const label = JSON.stringify(text);
    let notes = [];
    await runSecretsCommand({ settingsFile: "/s/settings.json" }, ctx([]), (m) => notes.push(m), ["list"], { fs: memFs(text) });
    assert.deepEqual(notes, ["No resolver profiles are declared in the settings overlay."], label);
    const fs = memFs(text);
    const shown = [];
    notes = [];
    await runSecretsCommand({ settingsFile: "/s/settings.json" }, ctx(shown), (m) => notes.push(m), ["add"], { fs });
    assert.equal(shown.length, 1, `the operator is asked, as over a missing file (${label})`);
    assert.deepEqual(JSON.parse(fs.files["/s/settings.json"]), { secretProfiles: { prod: "/opt/pi/resolve.sh" } }, label);
    notes = [];
    await runSecretsCommand({ settingsFile: "/s/settings.json" }, ctx([]), (m) => notes.push(m), ["remove", "prod"], { fs: memFs(text) });
    assert.match(notes[0], /^no such profile\. No resolver profiles are declared/, label);
  }
  // A file that is invalid and NOT blank is still refused, with nothing asked and nothing written.
  const fs = memFs('{"secretProfiles":{"a":"/x"},"secretProfiles":{}}');
  const shown = [];
  const notes = [];
  await runSecretsCommand({ settingsFile: "/s/settings.json" }, ctx(shown), (m) => notes.push(m), ["add"], { fs });
  assert.equal(shown.length, 0);
  assert.match(notes[0], /^settings overlay is unreadable \(settings file has a duplicate key/);
  assert.equal(fs.files["/s/settings.json"], '{"secretProfiles":{"a":"/x"},"secretProfiles":{}}');
});

// --- /dispatch secrets --bundle: declaring a bundle resolver (issue #704, DES-PROJECT-SECRET-BUNDLES) ---

/** An in-memory fs over `files` for the secrets command. */
function bundleFs(files) {
  return {
    files,
    readFileSync: (p) => {
      if (!(p in files)) { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; }
      return files[p];
    },
    writeFileSync: (p, d) => (files[p] = d),
    renameSync: (a, b) => { files[b] = files[a]; delete files[a]; },
    mkdirSync: () => {},
    // Issue #712: a path this fake cannot resolve, as a real fs answers for one that is not there.
    realpathSync: () => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; },
  };
}

test("secrets add --bundle writes the overlay's secretBundles only after a confirm showing the exact bytes, in the validator's shape", async () => {
  const { runSecretsCommand } = await jiti.import("../src/secrets-command.ts");
  const { readOverlay } = await import("@edgehero/pi-dispatch/runtime-settings");
  const fs = bundleFs({ "/s/settings.json": JSON.stringify({ model: "m" }) });
  const shown = [];
  const notes = [];
  const answers = { "bundle profile name": "op-shop", resolver: "/opt/pi/op-shop.mjs", format: "json" };
  const input = async (t) => answers[Object.keys(answers).find((k) => t.startsWith(k))];
  const ctx = { ui: { input, confirm: async (_t, m) => (shown.push(m), true), notify: () => {} } };
  await runSecretsCommand({ settingsFile: "/s/settings.json" }, ctx, (m) => notes.push(m), ["add", "--bundle"], { fs, env: {}, audit: { append() {} } });
  assert.equal(shown.length, 1);
  assert.match(shown[0], /^\/s\/settings\.json gets:\n\{\n {2}"secretBundles": \{\n {4}"op-shop": \{\n {6}"path": "\/opt\/pi\/op-shop\.mjs",\n {6}"format": "json"\n/);
  assert.match(shown[0], /executes this script.*once per job start.*every variable it prints \(json\).*PI_SECRET_RESOLVER_ROOTS/s);
  const written = JSON.parse(fs.files["/s/settings.json"]);
  assert.deepEqual(written, { model: "m", secretBundles: { "op-shop": { path: "/opt/pi/op-shop.mjs", format: "json" } } });
  assert.deepEqual(readOverlay("/s/settings.json", { fs }).overlay.secretBundles, written.secretBundles, "the worker's validator reads it back as written");
  assert.ok(notes.some((n) => /"secretBundles" entry naming "profile": "op-shop" in triggers\.json/.test(n)), "binding it is still a file edit");
  // A format the worker would not read, and a name PI_SECRET_BUNDLES holds, are refused before any confirm.
  for (const [extra, env, why] of [[{ format: "yaml" }, {}, /^the format is dotenv or json/], [{}, { PI_SECRET_BUNDLES: "op-shop:/opt/x:json" }, /^PI_SECRET_BUNDLES already declares op-shop/]]) {
    const again = bundleFs({});
    const asked = [];
    const said = [];
    const a = { ...answers, ...extra };
    await runSecretsCommand({ settingsFile: "/s/settings.json" }, { ui: { input: async (t) => a[Object.keys(a).find((k) => t.startsWith(k))], confirm: async () => (asked.push(1), true), notify: () => {} } }, (m) => said.push(m), ["add", "--bundle"], { fs: again, env, audit: { append() {} } });
    assert.equal(asked.length, 0, JSON.stringify(extra));
    assert.match(said[0], why);
    assert.deepEqual(again.files, {});
  }
});

test("a near miss of --bundle is refused with the usage line, never read as a profile add (review L6)", async () => {
  const { runSecretsCommand } = await jiti.import("../src/secrets-command.ts");
  for (const tokens of [["add", "--bundles"], ["add", "-b"], ["remove", "--Bundle", "x"], ["add", "--bundle=yes"]]) {
    const fs = bundleFs({});
    const notes = [];
    let asked = 0;
    await runSecretsCommand({ settingsFile: "/s/settings.json" }, { ui: { input: async () => (asked++, "x"), confirm: async () => true, notify: () => {} } }, (m) => notes.push(m), tokens, { fs, env: {}, audit: { append() {} } });
    assert.equal(asked, 0, tokens.join(" "));
    assert.match(notes[0], /^unknown flag .*usage: \/dispatch secrets <list\|add \[--bundle\]\|remove \[--bundle\] <name>>$/, tokens.join(" "));
    assert.deepEqual(fs.files, {});
  }
});

test("secrets remove --bundle names the bundles it strands, and list shows profiles, bundle resolvers and the bindings, never a ref", async () => {
  const { runSecretsCommand } = await jiti.import("../src/secrets-command.ts");
  const files = {
    "/s/settings.json": JSON.stringify({ secretProfiles: { prod: "/opt/p.sh" }, secretBundles: { "op-shop": { path: "/opt/b.mjs", format: "json" } } }),
    "/s/triggers.json": JSON.stringify({ triggers: [{ on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "fix", secretBundle: false } }], secretBundles: { shop: { profile: "op-shop", ref: "env-ref-canary", project: "shop" } } }),
    "/s/projects.json": JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["github:acme/shop"] }] }),
  };
  const fs = bundleFs(files);
  const paths = { settingsFile: "/s/settings.json", triggersPath: "/s/triggers.json", projectsFile: "/s/projects.json" };
  const notes = [];
  await runSecretsCommand(paths, { ui: {} }, (m) => notes.push(m), ["list"], { fs, env: { PI_SECRET_RESOLVER_ROOTS: "/opt" } });
  assert.equal(notes[0], [
    "Resolver profiles (settings overlay):\n  prod: /opt/p.sh",
    // The fake fs resolves neither profile nor bundle executables, so both leave the roots for the worker to judge.
    "Secret profiles in use (names only; the resolver paths are listed above):\n  prod: declared in the settings overlay; its resolver cannot be resolved on this host, so only the worker can judge it against PI_SECRET_RESOLVER_ROOTS (doctor --secrets); used by no trigger; last resolve: no run in view recorded it; served by: the registry is not read here (the console's and the panel's profiles show the live hosts)",
    "Bundle resolvers (settings overlay):\n  op-shop: /opt/b.mjs (json)",
    "Secret bundles (triggers.json; names only, never a reference or a value):\n  shop: project shop; profile op-shop (declared in the settings overlay, json; its resolver cannot be resolved on this host, so only the worker can judge it against PI_SECRET_RESOLVER_ROOTS; doctor --secrets checks it runs); fork reviews do not; no endpoints; 1 trigger opts out: #1",
  ].join("\n\n"));
  assert.ok(!notes[0].includes("env-ref-canary"));
  // Roots the panel can see that do not hold the path: the worker would not run it, and the list says so.
  const closed = [];
  await runSecretsCommand(paths, { ui: {} }, (m) => closed.push(m), ["list"], { fs, env: { PI_SECRET_RESOLVER_ROOTS: "" } });
  assert.match(closed[0], /profile op-shop \(declared in the settings overlay but outside PI_SECRET_RESOLVER_ROOTS, so the worker will not run it/);
  // Roots the panel cannot see at all prove nothing about the worker's host: said as not visible, never as outside.
  const unseen = [];
  await runSecretsCommand(paths, { ui: {} }, (m) => unseen.push(m), ["list"], { fs, env: {} });
  assert.match(unseen[0], /profile op-shop \(declared in the settings overlay, json; PI_SECRET_RESOLVER_ROOTS is not visible to the panel; doctor --secrets checks it runs\)/);
  const shown = [];
  const said = [];
  await runSecretsCommand(paths, { ui: { input: async () => "", confirm: async (_t, m) => (shown.push(m), true), notify: () => {} } }, (m) => said.push(m), ["remove", "--bundle", "op-shop"], { fs, env: {}, audit: { append() {} } });
  assert.match(shown[0], /^op-shop: \/opt\/b\.mjs \(json\)\n\nThe jobs of bundle shop are refused pre-spend after this \(secret-bundle-profile-unknown\), or on a multi-host worker's shared queue held for a host that declares it/);
  assert.deepEqual(JSON.parse(fs.files["/s/settings.json"]), { secretProfiles: { prod: "/opt/p.sh" }, secretBundles: {} });
  assert.deepEqual(said, ["removed bundle resolver op-shop"]);
  // The profile of the same name is a different namespace: `remove prod` without --bundle still removes the profile.
  said.length = 0;
  await runSecretsCommand(paths, { ui: { input: async () => "", confirm: async () => true, notify: () => {} } }, (m) => said.push(m), ["remove", "--bundle", "prod"], { fs, env: {}, audit: { append() {} } });
  assert.match(said[0], /^no such bundle resolver\. No bundle resolvers are declared in the settings overlay\.$/);
});

// The OPERATOR-TYPED rule for bundle resolvers (issue #704): a bundle resolver is an exec path that hands a project's
// whole environment to its jobs, so no model-callable tool may write the overlay's `secretBundles`, exactly as none may
// write `secretProfiles`. Three doors, each shut here: no tool parameter, `dispatch_set`'s generic key (refused, the file
// untouched, nothing shown), and the planners themselves, reached only from the operator-typed command and the console.
test("no registered tool can write the overlay's secretBundles: no parameter, dispatch_set refuses the key, and only operator surfaces reach the planners (#704)", async () => {
  const { OPERATOR_ONLY_KEYS } = await import("@edgehero/pi-dispatch/runtime-settings");
  assert.ok(OPERATOR_ONLY_KEYS.includes("secretBundles"));
  for (const tool of registeredTools()) {
    const keys = Object.keys(tool.parameters?.properties ?? {});
    for (const forbidden of ["secretBundles", "secretBundle", "bundle"]) assert.equal(keys.includes(forbidden), false, `${tool.name} exposes ${forbidden}`);
    assert.equal(/secretBundles/.test(tool.description ?? ""), false, `${tool.name}'s description advertises secretBundles`);
  }
  for (const key of OPERATOR_ONLY_KEYS) {
    const settingsFile = withSettings({ model: "m" });
    const before = readFileSync(settingsFile, "utf8");
    const { ctx, shown } = toolCtx({ answer: true });
    await assert.rejects(() => toolByName("dispatch_set").execute("id", { key, value: JSON.stringify({ x: { path: "/opt/x", format: "json" } }) }, undefined, undefined, ctx), /unknown key/, key);
    assert.equal(shown.length, 0, `${key}: no confirm is even asked`);
    assert.equal(readFileSync(settingsFile, "utf8"), before, key);
  }
  // The planners that mutate the overlay's secretBundles are exactly the two, and only the operator surfaces name them.
  const src = (rel) => readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");
  assert.equal([...src("write-plans.mjs").matchAll(/\.\.\.o, secretBundles\b/g)].length, 2, "planSecretBundleAdd and planSecretBundleRemove, nothing else");
  // Every source file under admin/src, walked, so a new module that calls a planner cannot hide from a hand-kept list.
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const walk = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.(mjs|ts)$/.test(e.name) ? [join(dir, e.name)] : []));
  const files = walk("");
  assert.ok(files.includes("index.ts") && files.includes(join("console", "actions.mjs")), "the walk found the sources");
  const callers = files.filter((f) => f !== "write-plans.mjs" && /planSecretBundle(Add|Remove)/.test(src(f))).sort();
  assert.deepEqual(callers, [join("console", "actions.mjs"), "secrets-command.ts"]);
  assert.equal(/secretBundles\s*:/.test(src("index.ts")), false, "index.ts, where every tool lives, writes no secretBundles key");
});

// Issue #704 review M1/L3: a run's bundle variable NAMES are the operator's manager's contents, and the operator-only
// overlay keys are resolver paths the worker executes; neither reaches model context. Every registered tool is run
// (reads with their default or a job id, writes with no interactive operator, so each refuses), over a deployment
// whose record and overlay carry distinctive canaries, and no result or refusal holds one.
test("no registered tool's result carries a bundle variable name or an operator-only overlay path (#704)", async () => {
  const saved = Object.fromEntries(["PI_SETTINGS_FILE", "VALKEY_URL", "PI_TRIGGERS_FILE"].map((k) => [k, process.env[k]]));
  const dir = tempDir("pi-704-tools-");
  const logsDir = process.env.PI_LOGS_DIR;
  const NAME = "ZQX_CANARY_BUNDLE_VAR";
  const SHADOW = "ZQX_CANARY_SHADOWED";
  const PATH_CANARY = "/opt/zqx-canary-resolver.sh";
  writeFileSync(join(logsDir, "gh-zqx-canary.json"), JSON.stringify({ jobId: "gh-zqx-canary", kind: "github", target: "acme/web#1", flow: "fix", outcome: "completed", startedAt: "2026-10-20T10:00:00Z", endedAt: "2026-10-20T10:05:00Z", bundle: { id: "shop", variables: [NAME, SHADOW], shadowed: [SHADOW], placeholders: 1, plain: 1 } }));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "m", secretProfiles: { prod: PATH_CANARY }, secretBundles: { "op-shop": { path: PATH_CANARY, format: "json" } } }));
  writeFileSync(join(dir, "triggers.json"), JSON.stringify({ triggers: [], secretBundles: { shop: { profile: "op-shop", ref: "zqx-ref-canary", project: "shop" } } }));
  Object.assign(process.env, { PI_SETTINGS_FILE: join(dir, "settings.json"), VALKEY_URL: "not-a-url", PI_TRIGGERS_FILE: join(dir, "triggers.json") }); // degrade synchronously, never a timeout burn
  try {
    const { ctx } = toolCtx({ hasUI: false });
    const seen = [];
    for (const tool of registeredTools()) {
      for (const params of tool.name === "dispatch_runs" ? [{}, { jobId: "gh-zqx-canary" }] : [{}]) {
        let out;
        let timer;
        try {
          out = JSON.stringify(await Promise.race([tool.execute("id", params, undefined, undefined, ctx), new Promise((r) => (timer = setTimeout(() => r("timeout"), 15000)))]));
        } catch (e) {
          out = String(e?.message ?? e);
        } finally {
          clearTimeout(timer);
        }
        assert.notEqual(out, JSON.stringify("timeout"), `${tool.name} did not answer, so its result was never checked`);
        seen.push(tool.name);
        for (const canary of [NAME, SHADOW, PATH_CANARY, "zqx-ref-canary"]) assert.ok(!out.includes(canary), `${tool.name} ${JSON.stringify(params)} returned ${canary}`);
      }
    }
    assert.ok(seen.includes("dispatch_runs") && seen.includes("dispatch_status") && seen.includes("dispatch_triggers"));
    // What the model does get: the counts.
    const one = textOf(await toolByName("dispatch_runs").execute("id", { jobId: "gh-zqx-canary" }, undefined, undefined, ctx));
    assert.deepEqual(one.bundle, { id: "shop", received: 2, shadowed: 1, placeholders: 1, plain: 1 });
    const status = textOf(await toolByName("dispatch_status").execute("id", {}, undefined, undefined, ctx));
    assert.deepEqual(status.settings.overlay, { model: "m" }, "dispatch_status leaves the operator-only keys out");
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("declining the confirm writes nothing at all", async () => {
  const { runSecretsCommand } = await jiti.import("../src/secrets-command.ts");
  let wrote = false;
  const fs = {
    readFileSync: () => { const e = new Error("ENOENT"); e.code = "ENOENT"; throw e; },
    writeFileSync: () => (wrote = true),
    renameSync: () => (wrote = true),
    mkdirSync: () => {},
  };
  const ctx = { ui: { input: async (t) => (/profile name/.test(t) ? "prod" : "/opt/pi/resolve.sh"), confirm: async () => false, notify: () => {} } };
  await runSecretsCommand({ settingsFile: "/s/settings.json" }, ctx, () => {}, ["add"], { fs });
  assert.equal(wrote, false);
});

test("a relative resolver path is refused before any dialog approves it", async () => {
  // resolveEnvSetup's reason, restated where the operator meets it: a service manager's working directory
  // is not a login shell's, so a relative path is a different file on every host.
  const { runSecretsCommand } = await jiti.import("../src/secrets-command.ts");
  const notes = [];
  let confirmed = false;
  const ctx = { ui: { input: async (t) => (/profile name/.test(t) ? "prod" : "relative/resolve.sh"), confirm: async () => (confirmed = true), notify: () => {} } };
  await runSecretsCommand({ settingsFile: "/s/settings.json" }, ctx, (m) => notes.push(m), ["add"]);
  assert.equal(confirmed, false, "it must never reach the confirm");
  assert.ok(notes.some((n) => /absolute path/.test(n)));
});

test("a profile name carrying a list separator is refused -- it could not round-trip its declaration", async () => {
  const { runSecretsCommand } = await jiti.import("../src/secrets-command.ts");
  const notes = [];
  const ctx = { ui: { input: async () => "pro,d", confirm: async () => assert.fail("must not reach the confirm"), notify: () => {} } };
  await runSecretsCommand({ settingsFile: "/s/settings.json" }, ctx, (m) => notes.push(m), ["add"]);
  assert.ok(notes.some((n) => /letters, digits/.test(n)));
});

// ── scoped limits (issue #242, INT-SCOPED-LIMITS-FILE-CONTRACT): the pause trio's twin ───────────────────
function tmpLimits(initial) {
  const path = join(tempDir("pi-sl-"), "scoped-limits.json");
  writeFileSync(path, JSON.stringify(initial));
  process.env.PI_SCOPED_LIMITS_FILE = path;
  return path;
}

test("dispatch_limit_add: an approved confirm writes a validated limit", async () => {
  const path = tmpLimits({ version: 1, limits: [] });
  const { ctx, shown } = toolCtx({ answer: true });
  const out = textOf(await toolByName("dispatch_limit_add").execute("id", { scope: "acme/web", day: 10, concurrent: 1 }, undefined, undefined, ctx));
  assert.equal(out.applied, true);
  const l = read(path).limits[0];
  assert.deepEqual(l, { scope: "acme/web", day: 10, concurrent: 1 });
  assert.equal(read(path).version, 1);
  assert.match(shown[0].message, /scoped-limits\.json/, "the confirm names the file being changed");
});

test("dispatch_limit_add: a row that limits nothing is rejected by the shared parser, nothing written", async () => {
  const path = tmpLimits({ version: 1, limits: [] });
  const { ctx } = toolCtx({ answer: true });
  await assert.rejects(
    () => toolByName("dispatch_limit_add").execute("id", { scope: "acme/web" }, undefined, undefined, ctx),
    /at least one of day, week, month, concurrent/,
  );
  assert.deepEqual(read(path).limits, [], "the file is unchanged");
});

test("dispatch_limit_add: refused with no interactive operator (headless)", async () => {
  const path = tmpLimits({ version: 1, limits: [] });
  const { ctx } = toolCtx({ hasUI: false });
  await assert.rejects(() => toolByName("dispatch_limit_add").execute("id", { scope: "a/b", day: 1 }, undefined, undefined, ctx), /interactive operator/);
  assert.deepEqual(read(path).limits, []);
});

test("dispatch_limit_add: a declined confirm changes nothing", async () => {
  const path = tmpLimits({ version: 1, limits: [] });
  const { ctx } = toolCtx({ answer: false });
  const out = textOf(await toolByName("dispatch_limit_add").execute("id", { scope: "a/b", day: 1 }, undefined, undefined, ctx));
  assert.equal(out.applied, false);
  assert.deepEqual(read(path).limits, []);
});

test("dispatch_limit_edit: an approved partial edit changes one field and keeps the rest", async () => {
  const path = tmpLimits({ version: 1, limits: [{ scope: "acme/web", day: 10, week: 40 }] });
  const { ctx, shown } = toolCtx({ answer: true });
  const out = textOf(await toolByName("dispatch_limit_edit").execute("id", { index: 0, day: 5 }, undefined, undefined, ctx));
  assert.equal(out.applied, true);
  const l = read(path).limits[0];
  assert.deepEqual(l, { scope: "acme/web", day: 5, week: 40 });
  assert.match(shown[0].message, /\nto \{/, "the confirm shows before, then after");
});

test("dispatch_limit_edit KEEPS a row's dollar window and the file stays version 2 (PR #549's review)", async () => {
  const path = tmpLimits({ version: 2, limits: [{ scope: "acme/web", day: 3, dayUsd: "5" }] });
  const { ctx, shown } = toolCtx({ answer: true });
  const out = textOf(await toolByName("dispatch_limit_edit").execute("id", { index: 0, day: 5 }, undefined, undefined, ctx));
  assert.equal(out.applied, true);
  const file = read(path);
  assert.equal(file.version, 2);
  assert.deepEqual(file.limits[0], { scope: "acme/web", day: 5, dayUsd: "5.00" });
  assert.match(shown[0].message, /dayUsd/, "the confirm shows the dollar field it keeps");
});

test("dispatch_limit_delete's confirm summarizes a model row by its dollar caps (PR #549's review)", async () => {
  tmpLimits({ version: 2, limits: [{ scope: "model:openai/gpt-x", weekUsd: "25" }] });
  const { ctx, shown } = toolCtx({ answer: false });
  await toolByName("dispatch_limit_delete").execute("id", { index: 0 }, undefined, undefined, ctx);
  assert.match(shown[0].message, /model:openai\/gpt-x week \$25\.00/);
});

test("dispatch_limit_edit / _delete: out-of-range index throws and writes nothing", async () => {
  const path = tmpLimits({ version: 1, limits: [{ scope: "acme/web", day: 1 }] });
  const { ctx } = toolCtx({ answer: true });
  await assert.rejects(() => toolByName("dispatch_limit_edit").execute("id", { index: 3, day: 2 }, undefined, undefined, ctx), /no scoped limit at index 3 \(have 1\)/);
  await assert.rejects(() => toolByName("dispatch_limit_delete").execute("id", { index: 3 }, undefined, undefined, ctx), /no scoped limit at index 3/);
  assert.equal(read(path).limits[0].day, 1);
});

test("dispatch_limit_delete: an approved confirm removes the picked limit", async () => {
  const path = tmpLimits({ version: 1, limits: [{ scope: "acme/web", day: 1 }, { scope: "/srv/site", month: 6 }] });
  const { ctx, shown } = toolCtx({ answer: true });
  const out = textOf(await toolByName("dispatch_limit_delete").execute("id", { index: 0 }, undefined, undefined, ctx));
  assert.equal(out.applied, true);
  assert.deepEqual(read(path).limits.map((l) => l.scope), ["/srv/site"]);
  assert.match(shown[0].message, /day 1/, "the confirm shows the human summary");
});

test("dispatch_limits lists rows with their index and null used counts on an unreachable queue", async () => {
  tmpLimits({ version: 1, limits: [{ scope: "acme/web", day: 10, concurrent: 1 }] });
  process.env.VALKEY_URL = "not-a-url"; // degrade synchronously, never a timeout burn
  const rows = textOf(await toolByName("dispatch_limits").execute("id", {}, undefined, undefined, undefined));
  assert.equal(rows[0].index, 0);
  assert.equal(rows[0].scope, "acme/web");
  assert.equal(rows[0].used, null, "used stays null on unreachable -- never an invented zero");
  delete process.env.VALKEY_URL;
});

test("manageLimits: Add writes a validated limit (live); blanks drop out", async () => {
  const path = tmpLimits({ version: 1, limits: [] });
  const ui = mockUi({ select: ["Add a scoped limit"], input: ["acme/web", "10", "", "", "1"] });
  await handleDashboardAction({ action: "manageLimits" }, { scopedLimitsPath: path }, { ui });
  assert.deepEqual(read(path).limits, [{ scope: "acme/web", day: 10, concurrent: 1 }]);
  assert.ok(ui.notes.some((n) => /added \(live\)/.test(n.m)));
});

test("manageLimits: Edit blank-keeps-current; Delete removes on confirm; a decline writes nothing", async () => {
  const path = tmpLimits({ version: 1, limits: [{ scope: "acme/web", day: 10, week: 40 }] });
  const editUi = mockUi({ select: ["Edit a scoped limit", "#1  acme/web  day 10 · week 40"], input: ["", "5", "", "", ""] });
  await handleDashboardAction({ action: "manageLimits" }, { scopedLimitsPath: path }, { ui: editUi });
  assert.deepEqual(read(path).limits[0], { scope: "acme/web", day: 5, week: 40 }, "blank keeps, typed replaces");
  const declineUi = mockUi({ select: ["Delete a scoped limit", "#1  acme/web  day 5 · week 40"], confirm: [false] });
  await handleDashboardAction({ action: "manageLimits" }, { scopedLimitsPath: path }, { ui: declineUi });
  assert.equal(read(path).limits.length, 1, "a declined confirm deletes nothing");
  const deleteUi = mockUi({ select: ["Delete a scoped limit", "#1  acme/web  day 5 · week 40"], confirm: [true] });
  await handleDashboardAction({ action: "manageLimits" }, { scopedLimitsPath: path }, { ui: deleteUi });
  assert.deepEqual(read(path).limits, []);
});

test("issue #498: an edit that rewrites a bare scope to a qualified one says the count starts over, in the tool confirm and the dialog", async () => {
  const path = tmpLimits({ version: 1, limits: [{ scope: "acme/web", day: 10 }] });
  const { ctx, shown } = toolCtx({ answer: true });
  textOf(await toolByName("dispatch_limit_edit").execute("id", { index: 0, scope: "github:acme/web" }, undefined, undefined, ctx));
  assert.match(shown[0].message, /starts a new count under a new key/);
  assert.match(shown[0].message, /Jobs already running keep their slot under the old scope/, "the in-flight window is named too");
  assert.match(shown[0].message, /up to 2N jobs can run/, "and its size: the new row counts from zero beside the old jobs");
  assert.deepEqual(read(path).limits[0], { scope: "github:acme/web", day: 10 });
  assert.equal(read(path).version, 2, "a qualified row stamps version 2, so a released worker refuses the file instead of ignoring the row");
  // A count-only edit says nothing about it.
  const { ctx: ctx2, shown: shown2 } = toolCtx({ answer: true });
  textOf(await toolByName("dispatch_limit_edit").execute("id", { index: 0, day: 4 }, undefined, undefined, ctx2));
  assert.doesNotMatch(shown2[0].message, /new count/);
  // The panel dialog asks before a scope change, and a decline writes nothing.
  const declineUi = mockUi({ select: ["Edit a scoped limit", "#1  github:acme/web  day 4"], input: ["forgejo:acme/web", "", "", "", ""], confirm: [false] });
  await handleDashboardAction({ action: "manageLimits" }, { scopedLimitsPath: path }, { ui: declineUi });
  assert.equal(read(path).limits[0].scope, "github:acme/web");
  const okUi = mockUi({ select: ["Edit a scoped limit", "#1  github:acme/web  day 4"], input: ["forgejo:acme/web", "", "", "", ""], confirm: [true] });
  await handleDashboardAction({ action: "manageLimits" }, { scopedLimitsPath: path }, { ui: okUi });
  assert.equal(read(path).limits[0].scope, "forgejo:acme/web");
});

test("a stored field cannot reach pi's dialogs raw, on EVERY dialog (#404)", async () => {
  // THE FOURTH FUNNEL. #382 gated the three that RENDER -- pane lines, the frame, and the model-visible
  // `send`. pi's dialogs are none of those: `select`, `input`, `confirm` and `notify` take strings this
  // extension builds from stored fields, and `pause-windows.mjs` checks only `isNonEmptyString(w.scope)`,
  // so the FILE is the whole validator.
  //
  // EVERY dialog, because a first version of this test backed out at the second select and left `input`,
  // `confirm` and `notify` unwrapped-and-unnoticed: three mutations removing those wrappers survived the
  // whole suite. This one answers every prompt so the edit runs to its notify.
  const payload = "\u001b[2J\u001b]52;c;cm0=\u0007\u001b]8;;http://evil.example\u0007click\u001b]8;;\u0007";
  const dir = tempDir("pi-dialog-gate-");
  const pauseWindowsPath = join(dir, "pause-windows.json");
  writeFileSync(pauseWindowsPath, JSON.stringify({ windows: [{ scope: `acme/web${payload}`, from: "22:00", to: "06:00", tz: "UTC" }] }));

  const seen = [];
  const record = (...args) => {
    for (const a of args) {
      if (typeof a === "string") seen.push(a);
      else if (Array.isArray(a)) for (const o of a) seen.push(typeof o === "string" ? o : JSON.stringify(o));
    }
  };
  let selects = 0;
  const calls = { select: 0, input: 0, confirm: 0, notify: 0, round: 0 };
  const ui = {
    // pi's selector returns THE EXACT STRING IT WAS HANDED (`options[selectedIndex]`), which is what makes
    // the round-trip below load-bearing rather than cosmetic.
    async select(_title, options) {
      record(_title, options);
      calls.select += 1;
      return selects++ === 0 ? (calls.round === 0 ? "Edit a pause window" : "Delete a pause window") : options[0];
    },
    async input(...a) {
      record(...a);
      calls.input += 1;
      return ""; // BLANK is keep(); `undefined` CANCELS, which is how the first version of this test
      // backed out at the third prompt and never reached `confirm` or `notify` at all.
    },
    async confirm(...a) {
      record(...a);
      calls.confirm += 1;
      return true;
    },
    notify: (...a) => {
      record(...a);
      calls.notify += 1;
    },
  };
  // BOTH ARMS, because the edit path has no confirm at all and the delete path is where it lives. Run edit
  // first, then delete, on the same dirty window.
  await handleDashboardAction({ action: "managePauses" }, { pauseWindowsPath }, { ui });
  calls.round = 1;
  selects = 0;
  await handleDashboardAction({ action: "managePauses" }, { pauseWindowsPath }, { ui });

  assert.ok(seen.some((t) => t.includes("acme/web")), "the window's own scope reached a dialog, so this is not asserting about an empty one");
  // COUNTED, not inferred from a length: `seen.length >= 4` was satisfied by the first select alone (a
  // title plus three options), so it said nothing about the prompts it was named for.
  for (const kind of ["select", "input", "confirm", "notify"]) {
    assert.ok(calls[kind] > 0, `every dialog kind ran; ${kind} did not (${JSON.stringify(calls)})`);
  }
  for (const text of seen) {
    assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/, `a dialog string carried a control byte: ${JSON.stringify(text)}`);
  }
});

test("the gate returns the CALLER's option, so a dirty row can still be edited (#404)", async () => {
  // THE REGRESSION THE FIRST VERSION OF THIS GATE SHIPPED, caught by a review pass. pi returns the option
  // string it was handed; the gate hands it a SCRUBBED copy, so `labels.indexOf(picked)` came back -1
  // against the caller's own unscrubbed array and `editPauseWindowViaDialogs` returned silently -- the
  // operator picks a window and nothing happens, with no notify and no error. Measured on all four of the
  // edit/delete pause and scoped-limit actions.
  const payload = "\u001b[2J";
  const dir = tempDir("pi-dialog-roundtrip-");
  const pauseWindowsPath = join(dir, "pause-windows.json");
  writeFileSync(pauseWindowsPath, JSON.stringify({ windows: [{ scope: `acme/web${payload}`, from: "22:00", to: "06:00", tz: "UTC" }] }));
  const before = readFileSync(pauseWindowsPath, "utf8");

  const notes = [];
  let selects = 0;
  const ui = {
    async select(_t, options) {
      return selects++ === 0 ? "Edit a pause window" : options[0];
    },
    async input(_t, dflt) {
      // BLANK keeps the field (the edit path's own `keep()`); `undefined` would CANCEL the dialog, which
      // would make this test pass for the wrong reason.
      return dflt === "22:00" ? "23:30" : "";
    },
    async confirm() {
      return true;
    },
    notify: (m) => notes.push(String(m)),
  };
  await handleDashboardAction({ action: "managePauses" }, { pauseWindowsPath }, { ui });

  assert.ok(notes.some((m) => /updated \(live\)/.test(m)), `the edit LANDED rather than returning silently; notes were ${JSON.stringify(notes)}`);
  assert.notEqual(readFileSync(pauseWindowsPath, "utf8"), before, "and the file changed");
});

test("dispatch_set: a window that would leave no maxCostUsd anywhere is warned in the confirm when the worker's env is not visible (#501, PR #542)", async () => {
  const saved = process.env.PI_MAX_COST_USD;
  try {
    delete process.env.PI_MAX_COST_USD;
    withSettings({});
    const probe = toolCtx({ answer: false });
    await toolByName("dispatch_set").execute("id", { key: "dailyCostUsd", value: "10" }, undefined, undefined, probe.ctx);
    assert.match(probe.shown[0].message, /\n\nWarning: dailyCostUsd needs maxCostUsd/);
    assert.match(probe.shown[0].message, /this session's environment \(not the worker's\)/);
    // The warning is shown BEFORE the write: declined, nothing is written; approved, the change is written as asked.
    const settingsFile = withSettings({ maxCostUsd: "2" });
    const declined = toolCtx({ answer: false });
    await toolByName("dispatch_set").execute("id", { key: "maxCostUsd" }, undefined, undefined, declined.ctx);
    assert.doesNotMatch(declined.shown[0].message, /Warning/);
    assert.deepEqual(read(settingsFile), { maxCostUsd: "2" }, "no warning without a window");
    writeFileSync(settingsFile, JSON.stringify({ maxCostUsd: "2", dailyCostUsd: "10" }));
    const no = toolCtx({ answer: false });
    const outNo = textOf(await toolByName("dispatch_set").execute("id", { key: "maxCostUsd" }, undefined, undefined, no.ctx));
    assert.match(no.shown[0].message, /\n\nWarning: dailyCostUsd needs maxCostUsd/);
    assert.equal(outNo.applied, false);
    assert.deepEqual(read(settingsFile), { maxCostUsd: "2", dailyCostUsd: "10" }, "declined: nothing written");
    const yes = toolCtx({ answer: true });
    const outYes = textOf(await toolByName("dispatch_set").execute("id", { key: "maxCostUsd" }, undefined, undefined, yes.ctx));
    assert.equal(outYes.applied, true, "never refused on the merged invariant");
    assert.deepEqual(read(settingsFile), { dailyCostUsd: "10" }, "approved: written");
    process.env.PI_MAX_COST_USD = "2";
    const fine = toolCtx({ answer: false });
    await toolByName("dispatch_set").execute("id", { key: "dailyCostUsd", value: "10" }, undefined, undefined, fine.ctx);
    assert.doesNotMatch(fine.shown[0].message, /Warning/);
  } finally {
    if (saved === undefined) delete process.env.PI_MAX_COST_USD;
    else process.env.PI_MAX_COST_USD = saved;
  }
});

// ── delegated allocation (issue #504 part C) ────────────────────────────────────────────────────────────────────────
//
// The three tools and the cross-checks against a real deployment folder and the fake Valkey of
// `helpers/fake-alloc-redis.mjs` (the worker's own Lua semantics), with an injected clock. Worked numbers, real ones
// (not the issue's 50/50 shorthand): $100 a week, floors $10 / $10 / $0, default weights shop 1, platform 1, _other 0,
// so neutral is $50 / $50 / $0, and 3:1 (with _other 0) is $70 / $30 / $0, a move of $20, inside the 25% step.

const ALLOC_NOW = Date.parse("2026-10-05T12:00:00Z");
const M = 1_000_000;
const ALLOC_ENV_KEYS = ["PI_PROJECTS_FILE", "PI_SCOPED_LIMITS_FILE", "PI_ENVELOPE_FILE", "PI_SETTINGS_FILE", "PI_LOGS_DIR", "PI_MAX_COST_USD", "VALKEY_URL", "PI_WORKER_NAME"];
const ALLOC_PROJECTS = [
  { id: "shop", members: ["github:acme/web", "github:acme/api"] },
  { id: "platform", members: ["github:acme/infra"] },
];
function envelopeBody(over = {}) {
  return {
    version: 1,
    window: "week",
    totalUsd: "100",
    floorsUsd: { shop: "10", platform: "10", _other: "0" },
    defaultWeights: { shop: 1, platform: 1, _other: 0 },
    delegation: { enabled: true, writers: ["operator-session", "portfolio-job"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 },
    ...over,
  };
}

/** A deployment with an envelope, the env pointed at it, and the allocation seams on the fake; restored after. */
async function withAllocation(fn, { envelope = envelopeBody(), limits = null, settings = { maxCostUsd: "2" }, redis = fakeAllocRedis() } = {}) {
  const saved = Object.fromEntries(ALLOC_ENV_KEYS.map((k) => [k, process.env[k]]));
  const dir = tempDir("pd-504c-");
  const files = {
    projects: join(dir, "projects.json"),
    limits: join(dir, "scoped-limits.json"),
    envelope: join(dir, "envelope.json"),
    settings: join(dir, "settings.json"),
    logs: join(dir, "logs"),
  };
  writeFileSync(files.projects, JSON.stringify({ version: 1, projects: ALLOC_PROJECTS }));
  if (limits) writeFileSync(files.limits, JSON.stringify({ version: 2, limits }));
  writeFileSync(files.envelope, typeof envelope === "string" ? envelope : JSON.stringify(envelope, null, 2));
  writeFileSync(files.settings, JSON.stringify(settings));
  process.env.PI_PROJECTS_FILE = files.projects;
  process.env.PI_SCOPED_LIMITS_FILE = files.limits;
  process.env.PI_ENVELOPE_FILE = files.envelope;
  process.env.PI_SETTINGS_FILE = files.settings;
  process.env.PI_LOGS_DIR = files.logs;
  process.env.VALKEY_URL = "redis://127.0.0.1:6390"; // never dialled: the fake answers every call
  process.env.PI_WORKER_NAME = "mini1";
  delete process.env.PI_MAX_COST_USD;
  let clock = ALLOC_NOW;
  indexMod._setAllocationSeamsForTests({ redisFn: () => redis, now: () => new Date(clock) });
  try {
    await fn({ dir, files, redis, advance: (ms) => (clock += ms) });
  } finally {
    indexMod._setAllocationSeamsForTests({});
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A headless ctx whose confirm, if anything ever called it, would be recorded. */
function headless() {
  const asked = [];
  return { asked, ctx: { hasUI: false, ui: { confirm: async (t, m) => (asked.push({ t, m }), true), select: async () => (asked.push("select"), undefined), input: async () => (asked.push("input"), undefined) } } };
}
const planOf = (redis) => JSON.parse(redis.store.get("alloc:plan"));
const auditRows = (files) => readFileSync(join(files.logs, "allocations", "2026-10.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("dispatch_priorities_set applies 3:1 with hasUI false, shows no dialog, and returns no reason text (#504)", async () => {
  await withAllocation(async ({ files, redis }) => {
    const { asked, ctx } = headless();
    const res = await toolByName("dispatch_priorities_set").execute("id", { projects: [{ id: "shop", weight: 3, reason: "launch on Friday" }, { id: "platform", weight: 1, reason: "maintenance only" }] }, undefined, undefined, ctx);
    const out = textOf(res);
    assert.deepEqual(asked, [], "no confirm, no dialog of any kind");
    assert.equal(out.outcome, "applied");
    assert.equal(out.reason, null);
    assert.equal(out.clamped, false, "a $20 move is inside the 25% ($25) step");
    assert.deepEqual(out.kept, ["_other"], "_other, left out, kept its current weight");
    assert.equal(out.basis, null, "the basis was filled in: the neutral split carries no plan id");
    assert.deepEqual(out.before.allocations, { _other: 0, platform: 50 * M, shop: 50 * M }, "neutral with _other at weight 0 is 50/50");
    assert.deepEqual(out.after.allocations, { _other: 0, platform: 30 * M, shop: 70 * M });
    assert.ok(!/launch|maintenance/.test(res.content[0].text), "the reasons never reach the tool result");
    // The plan's reasons are kept where the panel reads them, and the row names the session as its writer.
    assert.deepEqual(planOf(redis).reasons, { shop: "launch on Friday", platform: "maintenance only" });
    assert.equal(planOf(redis).writer, "operator-session");
    const applied = auditRows(files).filter((r) => r.outcome === "applied");
    assert.equal(applied.length, 1);
    assert.equal(applied[0].writer, "operator-session");
    assert.equal(applied[0].host, "mini1");
    assert.ok(!JSON.parse(redis.lists.get("alloc:log")[0]).reasons, "alloc:log carries no reasons");

    // At once again: refused by the interval, recorded, and nothing changes.
    const again = textOf(await toolByName("dispatch_priorities_set").execute("id", { projects: [{ id: "shop", weight: 1 }, { id: "platform", weight: 1 }] }, undefined, undefined, ctx));
    assert.equal(again.outcome, "refused");
    assert.equal(again.reason, "plan-too-soon");
    assert.deepEqual(again.after.allocations, { _other: 0, platform: 30 * M, shop: 70 * M }, "the split is unchanged");
    assert.equal(auditRows(files).at(-1).reason, "plan-too-soon");
  });
});

test("dispatch_priorities_set: a project left out (other than _other) is plan-incomplete, and an unknown id is plan-invalid", async () => {
  await withAllocation(async () => {
    const { ctx } = headless();
    const missing = textOf(await toolByName("dispatch_priorities_set").execute("id", { projects: [{ id: "shop", weight: 3 }] }, undefined, undefined, ctx));
    assert.equal(missing.outcome, "refused");
    assert.equal(missing.reason, "plan-incomplete");
    const unknown = textOf(await toolByName("dispatch_priorities_set").execute("id", { projects: [{ id: "shop", weight: 1 }, { id: "platform", weight: 1 }, { id: "ops", weight: 1 }] }, undefined, undefined, ctx));
    assert.equal(unknown.reason, "plan-invalid");
    assert.equal(unknown.field, "projects.id");
  });
});

test("dispatch_allocations: envelope numbers, the split, spend under the worker's keys, the history, and no reason text", async () => {
  await withAllocation(async ({ redis }) => {
    const { ctx } = headless();
    await toolByName("dispatch_priorities_set").execute("id", { projects: [{ id: "shop", weight: 3, reason: "launch on Friday" }, { id: "platform", weight: 1 }] }, undefined, undefined, ctx);
    assert.ok(redis.store.has("alloc:plan"));
    const res = await toolByName("dispatch_allocations").execute("id", {}, undefined, undefined, ctx);
    const text = res.content[0].text;
    assert.ok(!/launch|reasons/.test(text), "no reason text, and no reasons key at all");
    const out = JSON.parse(text);
    assert.equal(out.envelope.totalMicros, 100 * M);
    assert.equal(out.envelope.window, "week");
    assert.equal(out.state.writer, "operator-session");
    assert.deepEqual(out.state.allocations, { _other: 0, platform: 30 * M, shop: 70 * M });
    assert.match(out.spend.projects.shop.key, /^budget:usd:s:[0-9a-f]{16}:w:2026-10-05$/, "the envelope week's key, Monday-keyed");
    assert.equal(out.spend.projects.shop.micros, 0);
    assert.deepEqual(out.log.map((r) => r.outcome), ["applied", "neutral"], "newest first");
  });
});

test("dispatch_envelope_set is refused headless and writes nothing; a declined confirm writes nothing either (#504)", async () => {
  await withAllocation(async ({ files, redis }) => {
    const before = readFileSync(files.envelope, "utf8");
    await assert.rejects(() => toolByName("dispatch_envelope_set").execute("id", { minIntervalHours: 0 }, undefined, undefined, { hasUI: false, ui: {} }), /interactive operator/);
    assert.equal(readFileSync(files.envelope, "utf8"), before, "headless: the file is untouched");
    const no = toolCtx({ answer: false });
    const out = textOf(await toolByName("dispatch_envelope_set").execute("id", { minIntervalHours: 0 }, undefined, undefined, no.ctx));
    assert.equal(out.applied, false);
    assert.equal(readFileSync(files.envelope, "utf8"), before, "declined: the file is untouched");
    assert.deepEqual(redis.ops, [], "and alloc:envelope:expected was never written");
  });
});

test("dispatch_envelope_set: an approved change sets alloc:envelope:expected BEFORE the file, then writes it through the parser", async () => {
  let fileWhenExpectedSet = null;
  let files0 = null;
  const redis = fakeAllocRedis({ onSet: (key) => { if (key === "alloc:envelope:expected") fileWhenExpectedSet = readFileSync(files0.envelope, "utf8"); } });
  await withAllocation(async ({ files }) => {
    files0 = files;
    const before = readFileSync(files.envelope, "utf8");
    const { ctx, shown } = toolCtx({ answer: true });
    const out = textOf(await toolByName("dispatch_envelope_set").execute("id", { minIntervalHours: 0 }, undefined, undefined, ctx));
    assert.equal(out.applied, true);
    assert.match(shown[0].message, /minIntervalHours: 24 to 0/, "the confirm shows the before and after");
    assert.equal(fileWhenExpectedSet, before, "the expected digest was stored while the file still held the old envelope");
    const written = readFileSync(files.envelope, "utf8");
    const parsed = parseEnvelope(written, files.envelope, { projects: ALLOC_PROJECTS.map((p) => ({ ...p, name: null })), limits: [], maxCostMicros: 2 * M });
    assert.equal(parsed.delegation.minIntervalHours, 0);
    assert.equal(redis.store.get("alloc:envelope:expected"), envelopeDigest(parsed), "expected names the new file's digest");
    assert.equal(out.digest, envelopeDigest(parsed));
    assert.equal(JSON.parse(written).floorsUsd.shop, "10", "every other key is kept as written");
  }, { redis });
});

test("dispatch_envelope_set refuses BEFORE the confirm what the worker's parser would refuse", async () => {
  await withAllocation(async ({ files, redis }) => {
    const before = readFileSync(files.envelope, "utf8");
    const { ctx, shown } = toolCtx({ answer: true });
    await assert.rejects(() => toolByName("dispatch_envelope_set").execute("id", { floorsUsd: { shop: "95" } }, undefined, undefined, ctx), /floors add up to 105\.00, above totalUsd 100\.00/);
    await assert.rejects(() => toolByName("dispatch_envelope_set").execute("id", { floorsUsd: { ops: "1" } }, undefined, undefined, ctx), /floorsUsd\.ops names a project that is not in the projects file/);
    await assert.rejects(() => toolByName("dispatch_envelope_set").execute("id", {}, undefined, undefined, ctx), /nothing to change/);
    assert.equal(shown.length, 0, "the operator is never asked to approve an envelope the worker would refuse");
    assert.equal(readFileSync(files.envelope, "utf8"), before);
    assert.deepEqual(redis.ops, []);
  });
});

test("the project, limit and per-job cap writers refuse a change that would leave the live envelope invalid (#504)", async () => {
  await withAllocation(
    async ({ files }) => {
      const { ctx, shown } = toolCtx({ answer: true });
      const limitsBefore = readFileSync(files.limits, "utf8");
      // A floored project removed: the envelope's floor would name a project that is gone.
      await assert.rejects(() => toolByName("dispatch_project_delete").execute("id", { id: "platform" }, undefined, undefined, ctx), /allocation envelope invalid \(envelope file: floorsUsd\.platform names a project that is not in the projects file/);
      // A project row added, edited or left below its floor.
      await assert.rejects(() => toolByName("dispatch_limit_add").execute("id", { scope: "project:platform", weekUsd: "5" }, undefined, undefined, ctx), /floorsUsd\.platform \(10\.00\) is above the scoped-limits row project:platform weekUsd \(5\.00\)/);
      await assert.rejects(() => toolByName("dispatch_limit_edit").execute("id", { index: 0, weekUsd: "5" }, undefined, undefined, ctx), /floorsUsd\.shop \(10\.00\) is above the scoped-limits row project:shop weekUsd \(5\.00\)/);
      // The per-job cap removed: an envelope needs one.
      await assert.rejects(() => toolByName("dispatch_set").execute("id", { key: "maxCostUsd" }, undefined, undefined, ctx), /needs a per-job cost cap/);
      assert.equal(shown.length, 0, "every refusal comes before the confirm");
      assert.equal(readFileSync(files.limits, "utf8"), limitsBefore, "nothing was written");
      assert.deepEqual(read(files.settings), { maxCostUsd: "2" });
      assert.deepEqual(read(files.projects).projects.map((p) => p.id), ["shop", "platform"]);
      // A change that keeps the envelope loadable passes to the confirm as before.
      await toolByName("dispatch_limit_edit").execute("id", { index: 0, weekUsd: "40" }, undefined, undefined, ctx);
      assert.equal(shown.length, 1);
      assert.equal(read(files.limits).limits[0].weekUsd, "40.00");
    },
    { limits: [{ scope: "project:shop", weekUsd: "50" }] },
  );
});

test("an envelope that already fails to load does not block an unrelated write (the write is not what broke it)", async () => {
  await withAllocation(
    async ({ files }) => {
      const { ctx, shown } = toolCtx({ answer: true });
      const out = textOf(await toolByName("dispatch_limit_add").execute("id", { scope: "project:platform", weekUsd: "5" }, undefined, undefined, ctx));
      assert.equal(out.applied, true);
      assert.equal(shown.length, 1);
      assert.equal(read(files.limits).limits.length, 1);
    },
    { envelope: "{ not json" },
  );
});

/** A pi that records the command and what `sendMessage` carried, for `/dispatch priorities`. */
function commandPi() {
  const sent = [];
  let def = null;
  const pi = new Proxy({}, {
    get: (_t, k) => (k === "registerCommand" ? (_n, d) => (def = d) : k === "sendMessage" ? (m) => sent.push(m.content) : () => {}),
  });
  indexMod.default(pi);
  return { sent, run: (args) => { const notes = []; return def.handler(args, { hasUI: true, ui: { notify: (m, t) => notes.push({ m, t }) } }).then(() => notes); } };
}

// Issue #673: the overlay's model and provider are held to the trigger's id shape by the worker's `writeOverlay`, and
// every operator surface that writes a setting goes through it. Each one shows the refusal sentence, names the key
// and the shape, never the value, and leaves the file as it was. Review round 1: refused at PLAN time, by the worker's
// `modelIdProblem`/`providerIdProblem`, so no confirm is asked and no audited write is attempted (a write the worker
// refuses still leaves a row in the console-audit chain; none appears here).
test("a model or provider outside the id shape is refused with the shape's sentence on dispatch_set, /dispatch set and the panel dialog, nothing written (#673)", async () => {
  const MODEL_SAYS = "model must be a model id of 1 to 64 characters: letters, digits and . _ - : / @, starting with a letter or digit (or ~ or @ then one)";
  const PROVIDER_SAYS = "provider must be a provider id of 1 to 64 characters: letters, digits, dot, dash and underscore, starting with a letter or digit";
  await withAllocation(async ({ files }) => {
    const before = readFileSync(files.settings, "utf8");
    const auditDir = join(files.logs, "console-audit");
    const auditRowCount = () => (existsSync(auditDir) ? readdirSync(auditDir).filter((n) => n.endsWith(".jsonl")).reduce((n, f) => n + readFileSync(join(auditDir, f), "utf8").trim().split("\n").filter(Boolean).length, 0) : 0);
    const { run } = commandPi();
    for (const [key, bad, says] of [["model", "Claude Sonnet", MODEL_SAYS], ["model", "a+b", MODEL_SAYS], ["model", "x".repeat(65), MODEL_SAYS], ["model", "\u212aimi", MODEL_SAYS], ["provider", "a/b", PROVIDER_SAYS], ["provider", "Open AI", PROVIDER_SAYS]]) {
      const { ctx, shown } = toolCtx({ answer: true });
      await assert.rejects(() => toolByName("dispatch_set").execute("id", { key, value: bad }, undefined, undefined, ctx), (e) => e.message === `rejected: ${says}`, `dispatch_set ${key} ${bad}`);
      assert.equal(shown.length, 0, `dispatch_set ${key} ${bad}: no confirm is asked`);
      const ui = mockUi({ select: [key], input: [bad] });
      await handleDashboardAction({ action: "editSettings" }, { settingsFile: files.settings }, { ui });
      assert.deepEqual(ui.notes.at(-1), { m: `set: ${says}`, t: "error" }, `dialog ${key} ${bad}`);
      if (!/\s/.test(bad)) {
        const notes = await run(`set ${key} ${bad}`);
        assert.deepEqual(notes.at(-1), { m: `set: ${says}`, t: "error" }, `/dispatch set ${key} ${bad}`);
      }
      assert.equal(readFileSync(files.settings, "utf8"), before, "nothing written");
      assert.equal(auditRowCount(), 0, `${key} ${bad}: refused at plan time, no audited write attempted`);
    }
    const notes = await run("set model Claude-Sonnet-X");
    assert.match(notes.at(-1).m, /^set model = Claude-Sonnet-X/, "a good id is written, case kept");
    assert.equal(read(files.settings).model, "Claude-Sonnet-X");
  });
});

test("/dispatch priorities shows the split with no reason text; `priorities set` applies a plan as operator-session", async () => {
  await withAllocation(async ({ redis }) => {
    const { sent, run } = commandPi();
    const notes = await run("priorities set shop=3 platform=1");
    assert.match(notes.at(-1).m, /^applied [0-9a-f]{16}: _other \$0\.00, platform \$30\.00, shop \$70\.00$/);
    assert.equal(planOf(redis).writer, "operator-session");
    redis.store.set("alloc:plan", JSON.stringify({ ...planOf(redis), reasons: { shop: "secret plan text" } }));
    await run("priorities");
    const text = sent.at(-1);
    assert.match(text, /^ALLOCATION · week · total \$100\.00 · delegation on/);
    assert.match(text, /shop\s+floor \$10\.00\s+weight 3\s+allocation \$70\.00\s+spent \$0\.00/);
    assert.ok(!text.includes("secret plan text"), "the model-visible channel never carries a reason");
    const bad = await run("priorities set shop=three");
    assert.match(bad.at(-1).m, /^usage: \/dispatch priorities set/);
  });
});

test("a revert (operator-revert) skips the interval and the step, and is still recorded (#504)", async () => {
  const { revertAllocation } = await import("../src/read-model.mjs");
  await withAllocation(async ({ files, redis, advance }) => {
    const { ctx } = headless();
    const set = (weights) => toolByName("dispatch_priorities_set").execute("id", { projects: Object.entries(weights).map(([id, weight]) => ({ id, weight })) }, undefined, undefined, ctx).then(textOf);
    assert.deepEqual((await set({ shop: 3, platform: 1 })).after.allocations, { _other: 0, platform: 30 * M, shop: 70 * M });
    advance(25 * 3600000);
    assert.deepEqual((await set({ shop: 1, platform: 0 })).after.allocations, { _other: 0, platform: 10 * M, shop: 90 * M });
    // Back to the neutral row at once: a $40 move, above the 25% ($25) step, and inside the 24-hour interval.
    const neutral = JSON.parse(redis.lists.get("alloc:log").at(-1));
    assert.equal(neutral.outcome, "neutral");
    const envelope = parseEnvelope(readFileSync(files.envelope, "utf8"), files.envelope, { projects: ALLOC_PROJECTS.map((p) => ({ ...p, name: null })), limits: [], maxCostMicros: 2 * M });
    const res = await revertAllocation({ url: "redis://127.0.0.1:6390", envelope, target: neutral, host: "mini1", logsDir: files.logs, now: new Date(ALLOC_NOW + 25 * 3600000), redisFn: () => redis });
    assert.equal(res.outcome, "reverted");
    assert.deepEqual(planOf(redis).allocations, { _other: 0, platform: 50 * M, shop: 50 * M }, "the whole way back, no step");
    assert.equal(planOf(redis).writer, "operator-revert");
    assert.equal(auditRows(files).at(-1).outcome, "reverted");
  });
});

// Issue #642: the allocation writes land in the console's audit chain as the panel too, beside their own audit file.
test("dispatch_priorities_set and dispatch_envelope_set are audited as the panel in the deployment's console-audit chain (#642)", async () => {
  await withAllocation(async ({ files }) => {
    const { ctx } = headless();
    await toolByName("dispatch_priorities_set").execute("id", { projects: [{ id: "shop", weight: 3 }, { id: "platform", weight: 1 }] }, undefined, undefined, ctx);
    const confirm = toolCtx({ answer: true });
    await toolByName("dispatch_envelope_set").execute("id", { totalUsd: "120" }, undefined, undefined, confirm.ctx);
    const dir = join(files.logs, "console-audit");
    const rows = readFileSync(join(dir, readdirSync(dir).find((n) => n.endsWith(".jsonl"))), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((r) => [r.kind, r.outcome, r.actor.role]), [["priorities-set", "ok", "panel"], ["envelope-set", "ok", "panel"]]);
    assert.equal(rows[1].target, files.envelope);
    assert.notEqual(rows[1].beforeDigest, rows[1].afterDigest, "the envelope row carries the digests the confirm judged");
  });
});

test("the operator-typed paths refuse a change that would break the envelope too: the limit dialogs, /dispatch set and unset maxCostUsd (#504)", async () => {
  await withAllocation(
    async ({ files }) => {
      const before = readFileSync(files.limits, "utf8");
      // The panel's `m`: edit a repo row's scope into project:shop, whose week row would then sit below shop's $10 floor.
      const ui = mockUi({ select: ["Edit a scoped limit", "#1  github:acme/zzz  week $5.00"], input: ["project:shop", "", "", "", ""], confirm: [true] });
      await handleDashboardAction({ action: "manageLimits" }, { scopedLimitsPath: files.limits, projectsFile: files.projects, envelopeFile: files.envelope, settingsFile: files.settings }, { ui });
      assert.match(ui.notes.at(-1).m, /^edit rejected: this change would leave the allocation envelope invalid \(envelope file: floorsUsd\.shop \(10\.00\) is above the scoped-limits row project:shop weekUsd \(5\.00\)/);
      assert.equal(readFileSync(files.limits, "utf8"), before, "nothing written");
      // /dispatch unset maxCostUsd and a set to a value the worker cannot read: an envelope needs a per-job cap.
      const { run } = commandPi();
      const unset = await run("unset maxCostUsd");
      assert.match(unset.at(-1).m, /^unset: this change would leave the allocation envelope invalid .*needs a per-job cost cap/);
      const bad = await run("set maxCostUsd nope");
      assert.match(bad.at(-1).m, /^set: this change would leave the allocation envelope invalid/);
      assert.deepEqual(read(files.settings), { maxCostUsd: "2" }, "the settings file is untouched");
      const fine = await run("set maxCostUsd 3");
      assert.match(fine.at(-1).m, /^set maxCostUsd = 3/, "a cap the envelope can live with is written");
    },
    { limits: [{ scope: "github:acme/zzz", weekUsd: "5" }] },
  );
});
