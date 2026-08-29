import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// The command-side CRUD driver (index.ts `handleDashboardAction`) runs pi's ctx.ui dialogs and calls the
// validated/atomic writeTriggers/writeSettings. Loaded through pi's jiti (the extension is erasable TS).
const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const indexMod = await jiti.import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
const { handleDashboardAction } = indexMod;

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
  const dir = mkdtempSync(join(tmpdir(), "pi-crud-"));
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
  const dir = mkdtempSync(join(tmpdir(), "pi-crud-"));
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
  const settingsFile = join(mkdtempSync(join(tmpdir(), "pi-set-")), "settings.json");
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

test("dispatch_set: a declined confirm applies nothing, and the confirm shows before->after", async () => {
  const settingsFile = withSettings({ dailyCap: 25 });
  const { ctx, shown } = toolCtx({ answer: false });
  const out = textOf(await toolByName("dispatch_set").execute("id", { key: "dailyCap", value: "99" }, undefined, undefined, ctx));
  assert.equal(out.applied, false);
  assert.equal(read(settingsFile).dailyCap, 25, "a decline leaves the value untouched");
  assert.match(shown[0].message, /dailyCap: 25 -> 99/, "the operator saw the concrete change");
});

test("dispatch_set: an approved confirm writes the coerced value", async () => {
  const settingsFile = withSettings({ dailyCap: 25 });
  const { ctx } = toolCtx({ answer: true });
  const out = textOf(await toolByName("dispatch_set").execute("id", { key: "dailyCap", value: "30" }, undefined, undefined, ctx));
  assert.equal(out.applied, true);
  assert.equal(read(settingsFile).dailyCap, 30, "written as a coerced JSON number");
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

test("dispatch_trigger_edit: an approved confirm changes the flow and shows old->new", async () => {
  const path = tmpTriggers({ triggers: [{ on: { type: "label", any: ["a"] }, run: { kind: "github", flow: "old" } }] });
  process.env.PI_TRIGGERS_FILE = path;
  const { ctx, shown } = toolCtx({ answer: true });
  await toolByName("dispatch_trigger_edit").execute("id", { index: 0, flow: "new" }, undefined, undefined, ctx);
  assert.equal(read(path).triggers[0].run.flow, "new");
  assert.match(shown[0].message, /old -> new/);
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
  const path = join(mkdtempSync(join(tmpdir(), "pi-pw-")), "pause-windows.json");
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
  assert.match(shown[0], /EXECUTES this script/, "the operator is told what they are granting");
  assert.match(shown[0], /PI_SECRET_RESOLVER_ROOTS/, "and that the worker still has to admit it");
  assert.deepEqual(JSON.parse(files["/s/settings.json"]), { secretProfiles: { prod: "/opt/pi/resolve.sh" } });
  assert.ok(notes.some((n) => /triggers\.json/.test(n)), "and the operator is told binding it is still a file edit");
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
  assert.ok(notes.some((n) => /ABSOLUTE/.test(n)));
});

test("a profile name carrying a list separator is refused -- it could not round-trip its declaration", async () => {
  const { runSecretsCommand } = await jiti.import("../src/secrets-command.ts");
  const notes = [];
  const ctx = { ui: { input: async () => "pro,d", confirm: async () => assert.fail("must not reach the confirm"), notify: () => {} } };
  await runSecretsCommand({ settingsFile: "/s/settings.json" }, ctx, (m) => notes.push(m), ["add"]);
  assert.ok(notes.some((n) => /letters, digits/.test(n)));
});
