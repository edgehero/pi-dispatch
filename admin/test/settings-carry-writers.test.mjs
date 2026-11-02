// Every writer of the settings overlay keeps what it does not know (issue #761): a key a later release added and a
// `secretBundles` block survive a write from each entry point that writes the file, byte for byte in their places. One
// test per writer family: `writeSettings` itself, `/dispatch set|unset`, the panel's settings dialog, `/dispatch
// secrets` (profiles and bundles), the console's setting and secret actions, and the model-callable `dispatch_set`.
// Each compares the file's whole text, so a reordered, dropped or rewritten key fails, not just a missing one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { withOperatorDiagnosis } from "./helpers/tool-diagnosis.mjs";
import { blankSettingsFile, overlayInvalidRefusal, readSettingsView, writeSettings } from "../src/read-model.mjs";
import * as RM from "../src/read-model.mjs";
import * as WP from "../src/write-plans.mjs";
import { ACTIONS } from "../src/console/actions.mjs";

const piRequire = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const indexMod = await jiti.import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
const { runSecretsCommand } = await jiti.import(fileURLToPath(new URL("../src/secrets-command.ts", import.meta.url)));
// Every write below is audited into PI_LOGS_DIR's console-audit chain, so it lands in a directory of its own.
process.env.PI_LOGS_DIR = tempDir("settings-carry-logs-");

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const text = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The file a newer release left: `futureCap`, a key this build does not know, between two it does, and a
 * `secretBundles` block (an operator-only table no tool can set). Built as text so the expectations below are text.
 */
const BUNDLES = { shop: { path: "/opt/pi/bundle-shop.sh", format: "dotenv" } };
const FILE = { model: "m1", futureCap: { perHost: 3 }, maxTurns: 30, secretBundles: BUNDLES, maxCostUsd: "2" };
/** The same file with `over` applied in the file's own order (a key set to undefined is gone, a new key goes last). */
function fileWith(over) {
  const out = {};
  for (const [k, v] of Object.entries(FILE)) if (!Object.hasOwn(over, k)) out[k] = v;
  else if (over[k] !== undefined) out[k] = over[k];
  for (const [k, v] of Object.entries(over)) if (!Object.hasOwn(FILE, k) && v !== undefined) out[k] = v;
  return text(out);
}

/** A deployment folder holding that file, with PI_SETTINGS_FILE pointed at it for the extension's own reads. */
function seeded() {
  const dir = tempDir("settings-carry-");
  const settingsFile = join(dir, "settings.json");
  writeFileSync(settingsFile, text(FILE));
  process.env.PI_SETTINGS_FILE = settingsFile;
  return { dir, settingsFile };
}

test("writeSettings keeps every overlay key it does not know (a key from a later release) and a secretBundles block (#761)", () => {
  const { settingsFile } = seeded();
  const res = writeSettings({ settingsFile, mutate: (o) => ({ ...o, maxTurns: 40 }) });
  // `mutate` and the result still see the known keys only: no caller can read or set a carried one.
  assert.deepEqual(res, { ok: true, overlay: { model: "m1", maxTurns: 40, secretBundles: BUNDLES, maxCostUsd: "2" } });
  assert.equal(readFileSync(settingsFile, "utf8"), fileWith({ maxTurns: 40 }));
  // An unset removes the key from its place and keeps the rest; a candidate's own unknown key is never carried.
  const unset = writeSettings({ settingsFile, mutate: (o) => { delete o.maxTurns; return { ...o, smuggled: "x" }; } });
  assert.equal(unset.ok, true);
  assert.equal(readFileSync(settingsFile, "utf8"), fileWith({ maxTurns: undefined }));
});

test("writeSettings refuses a file a newer pi-dispatch wrote, names the upgrade, and leaves it untouched (#761)", () => {
  const { settingsFile } = seeded();
  const newer = text({ version: 2, ...FILE });
  writeFileSync(settingsFile, newer);
  let mutated = 0;
  const res = writeSettings({ settingsFile, mutate: (o) => (mutated++, { ...o, maxTurns: 40 }) });
  assert.deepEqual(res, { invalid: "the settings file was written by a newer pi-dispatch (version 2; this build understands 1), so nothing was written and no key in it was lost. Upgrade this panel or console to the release that wrote it" });
  assert.equal(mutated, 0, "the newer file is never handed to mutate");
  assert.equal(readFileSync(settingsFile, "utf8"), newer);
  // The view carries `newer`, so the tool's pre-confirm refusal says the same; a broken file keeps the fix-it words.
  const view = readSettingsView({ settingsFile });
  assert.equal(view.newer, true);
  assert.equal(overlayInvalidRefusal(view.invalid, { newer: view.newer }), res.invalid);
  writeFileSync(settingsFile, text({ version: "2", ...FILE }));
  const broken = readSettingsView({ settingsFile });
  assert.equal(broken.newer, undefined);
  assert.match(writeSettings({ settingsFile, mutate: (o) => o }).invalid, /^the settings file is invalid \(settings file "version" must be an integer of 1 or more\), so nothing was written and no key in it was lost\. Fix the file/);
  assert.equal(blankSettingsFile(settingsFile), false);
});

test("writeSettings re-checks against its OWN read when no expect is given: a write landing in between refuses, a first write never refuses itself (#761)", () => {
  const { settingsFile } = seeded();
  // Another session writes the file after this call read it (inside `mutate`, which runs between the read and the
  // write): the carried keys would roll that write back, so it is a refusal, not a silent loss.
  const other = text({ ...FILE, maxTurns: 99 });
  const res = writeSettings({ settingsFile, mutate: (o) => { writeFileSync(settingsFile, other); return { ...o, maxTurns: 40 }; } });
  assert.match(res.invalid, /changed after this change was built from it \(another session wrote it\); nothing was written/);
  assert.equal(readFileSync(settingsFile, "utf8"), other);
  // A missing file is read as `null`, `fileSnapshot`'s encoding, so its first write goes through; a blank one too.
  const dir = tempDir("settings-carry-first-");
  const fresh = join(dir, "settings.json");
  assert.deepEqual(writeSettings({ settingsFile: fresh, mutate: (o) => ({ ...o, maxTurns: 5 }) }), { ok: true, overlay: { maxTurns: 5 } });
  assert.equal(readFileSync(fresh, "utf8"), text({ maxTurns: 5 }));
  writeFileSync(fresh, "﻿ \n");
  assert.deepEqual(writeSettings({ settingsFile: fresh, mutate: (o) => ({ ...o, maxTurns: 6 }) }), { ok: true, overlay: { maxTurns: 6 } });
  // A file created between a missing read and the rename is a write this call did not see: refused.
  const raced = join(tempDir("settings-carry-race-"), "settings.json");
  assert.match(writeSettings({ settingsFile: raced, mutate: (o) => { writeFileSync(raced, text({ dailyCap: 9 })); return { ...o, maxTurns: 5 }; } }).invalid, /changed after this change was built from it/);
  // The caller's own `expect` still wins over the default (the console passes its preview's).
  const { settingsFile: second } = seeded();
  assert.match(writeSettings({ settingsFile: second, expect: [{ path: second, text: "{}" }], mutate: (o) => o }).invalid, /changed after this change was built from it/);
});

/** The extension's `/dispatch` command handler, with `notify` recorded. */
function commandPi() {
  let def = null;
  const pi = new Proxy({}, { get: (_t, k) => (k === "registerCommand" ? (_n, d) => (def = d) : () => {}) });
  indexMod.default(pi);
  return (args) => {
    const notes = [];
    return def.handler(args, { hasUI: true, ui: { notify: (m, t) => notes.push({ m, t }) } }).then(() => notes);
  };
}

test("/dispatch set and unset keep a later release's key and the secretBundles block in place (#761)", async () => {
  const { settingsFile } = seeded();
  const run = commandPi();
  assert.match((await run("set maxTurns 41")).at(-1).m, /^set maxTurns = 41/);
  assert.equal(readFileSync(settingsFile, "utf8"), fileWith({ maxTurns: 41 }));
  assert.match((await run("unset maxTurns")).at(-1).m, /^unset maxTurns/);
  assert.equal(readFileSync(settingsFile, "utf8"), fileWith({ maxTurns: undefined }));
  // A newer file: refused in the upgrade's words, nothing written.
  const newer = text({ version: 2, ...FILE });
  writeFileSync(settingsFile, newer);
  assert.deepEqual((await run("set maxTurns 42")).at(-1), { m: "set: the settings file was written by a newer pi-dispatch (version 2; this build understands 1), so nothing was written and no key in it was lost. Upgrade this panel or console to the release that wrote it", t: "error" });
  assert.equal(readFileSync(settingsFile, "utf8"), newer);
});

/** A pi `ctx.ui` whose dialogs answer in order. */
function mockUi({ select = [], input = [], confirm = [] } = {}) {
  const notes = [];
  return { notes, select: async () => select.shift(), input: async () => input.shift(), confirm: async () => confirm.shift(), notify: (m, t) => notes.push({ m, t }) };
}

test("the panel's settings dialog keeps a later release's key and the secretBundles block in place (#761)", async () => {
  const { settingsFile } = seeded();
  await indexMod.handleDashboardAction({ action: "editSettings" }, { settingsFile }, { ui: mockUi({ select: ["maxTurns"], input: ["43"] }) });
  assert.equal(readFileSync(settingsFile, "utf8"), fileWith({ maxTurns: 43 }));
  await indexMod.handleDashboardAction({ action: "editSettings" }, { settingsFile }, { ui: mockUi({ select: ["model"], input: [""] }) });
  assert.equal(readFileSync(settingsFile, "utf8"), fileWith({ maxTurns: 43, model: undefined }), "a blank value unsets the key, the rest stay");
});

test("/dispatch secrets add and remove keep a later release's key and the secretBundles block in place (#761)", async () => {
  const { settingsFile } = seeded();
  const audit = { append: (row) => ({ ...row, seq: 1 }) };
  const answers = (map) => async (title) => map[Object.keys(map).find((k) => title.startsWith(k))];
  const ctx = (map) => ({ ui: { input: answers(map), confirm: async () => true, notify: () => {} } });
  await runSecretsCommand({ settingsFile }, ctx({ "profile name": "prod", resolver: "/opt/pi/resolve.sh" }), () => {}, ["add"], { env: {}, audit });
  assert.equal(readFileSync(settingsFile, "utf8"), fileWith({ secretProfiles: { prod: "/opt/pi/resolve.sh" } }));
  await runSecretsCommand({ settingsFile }, ctx({ "bundle profile name": "ops", resolver: "/opt/pi/ops.mjs", format: "json" }), () => {}, ["add", "--bundle"], { env: {}, audit });
  const both = { ...BUNDLES, ops: { path: "/opt/pi/ops.mjs", format: "json" } };
  assert.equal(readFileSync(settingsFile, "utf8"), fileWith({ secretBundles: both, secretProfiles: { prod: "/opt/pi/resolve.sh" } }), "the bundle joins the block in its place");
  await runSecretsCommand({ settingsFile }, ctx({}), () => {}, ["remove", "prod"], { env: {}, audit });
  await runSecretsCommand({ settingsFile }, ctx({}), () => {}, ["remove", "--bundle", "ops"], { env: {}, audit });
  assert.equal(readFileSync(settingsFile, "utf8"), fileWith({ secretProfiles: {} }));
  // A newer file is not "unreadable, fix it": the command names the upgrade and asks nothing.
  const newer = text({ version: 2, ...FILE });
  writeFileSync(settingsFile, newer);
  const notes = [];
  let asked = 0;
  await runSecretsCommand({ settingsFile }, { ui: { input: async () => (asked++, "x"), confirm: async () => (asked++, true), notify: () => {} } }, (m) => notes.push(m), ["add"], { env: {}, audit });
  assert.equal(asked, 0);
  assert.deepEqual(notes, ["the settings file was written by a newer pi-dispatch (version 2; this build understands 1), so nothing was written and no key in it was lost. Upgrade this panel or console to the release that wrote it"]);
  assert.equal(readFileSync(settingsFile, "utf8"), newer);
});

/** One console file action, previewed and applied as the confirm applies it: the preview's own `expect` and run. */
async function consoleAct(name, body, paths) {
  const action = ACTIONS.find((a) => a.name === name);
  const ctx = { a: { rm: RM, plans: WP, paths, env: {} }, fs: nodeFs, config: { pauseWindowsPath: null, dir: null }, session: { role: "operator", name: "alice" }, deps: {} };
  const preview = await action.preview(body, ctx);
  assert.equal(preview.refusal, undefined, `${name}: ${preview.refusal}`);
  const applied = await action.apply(preview, ctx);
  return { preview, applied };
}

test("the console's setting and secret actions keep a later release's key and the secretBundles block, and each preview's after digest is the written file's (#761)", async () => {
  const { dir, settingsFile } = seeded();
  const paths = { settingsFile, triggersPath: join(dir, "triggers.json"), envelopeFile: null, projectsFile: null, scopedLimitsPath: null, logsDir: join(dir, "logs") };
  writeFileSync(paths.triggersPath, text({ triggers: [] }));
  const steps = [
    ["setting-set", { key: "maxTurns", value: "44" }, fileWith({ maxTurns: 44 })],
    ["setting-unset", { key: "maxTurns" }, fileWith({ maxTurns: undefined })],
    ["secret-profile-add", { name: "prod", path: "/opt/resolve-prod" }, fileWith({ maxTurns: undefined, secretProfiles: { prod: "/opt/resolve-prod" } })],
    ["secret-bundle-add", { name: "ops", path: "/opt/bundle-ops", format: "json" }, fileWith({ maxTurns: undefined, secretBundles: { ...BUNDLES, ops: { path: "/opt/bundle-ops", format: "json" } }, secretProfiles: { prod: "/opt/resolve-prod" } })],
    ["secret-profile-remove", { name: "prod" }, fileWith({ maxTurns: undefined, secretBundles: { ...BUNDLES, ops: { path: "/opt/bundle-ops", format: "json" } }, secretProfiles: {} })],
    ["secret-bundle-remove", { name: "ops" }, fileWith({ maxTurns: undefined, secretProfiles: {} })],
  ];
  for (const [name, body, want] of steps) {
    const { preview, applied } = await consoleAct(name, body, paths);
    assert.deepEqual(applied, { ok: true }, name);
    const after = readFileSync(settingsFile, "utf8");
    assert.equal(after, want, name);
    assert.equal(preview.afterDigest, sha256(after), `${name}: the preview's after digest is the digest of what was written`);
  }
  // A newer file is refused at the preview, in the upgrade's words.
  writeFileSync(settingsFile, text({ version: 2, ...FILE }));
  const refused = await ACTIONS.find((a) => a.name === "setting-set").preview({ key: "maxTurns", value: "45" }, { a: { rm: RM, plans: WP, paths, env: {} }, fs: nodeFs, config: {}, session: { role: "operator" }, deps: {} });
  assert.equal(refused.refusal, "rejected: the settings file was written by a newer pi-dispatch (version 2; this build understands 1), so nothing was written and no key in it was lost. Upgrade this panel or console to the release that wrote it");
});

test("dispatch_set keeps a later release's key and the secretBundles block in place (#761)", async () => {
  const { settingsFile } = seeded();
  const tools = [];
  const pi = new Proxy({}, { get: (_t, k) => (k === "registerTool" ? (t) => tools.push(t) : () => {}) });
  indexMod.default(pi);
  const tool = withOperatorDiagnosis(tools.find((t) => t.name === "dispatch_set"));
  const ctx = { hasUI: true, ui: { confirm: async () => true } };
  const set = JSON.parse((await tool.execute("id", { key: "maxTurns", value: "46" }, undefined, undefined, ctx)).content[0].text);
  assert.equal(set.applied, true);
  assert.equal(readFileSync(settingsFile, "utf8"), fileWith({ maxTurns: 46 }));
  const unset = JSON.parse((await tool.execute("id", { key: "maxTurns", value: "" }, undefined, undefined, ctx)).content[0].text);
  assert.equal(unset.applied, true);
  assert.equal(readFileSync(settingsFile, "utf8"), fileWith({ maxTurns: undefined }));
});
