// What the card and the pages beside it read of `run.excludeExtensions` and `run.excludeExtensionTools` (issue #800): the real page over a real file, what the hosts published
// through the real publisher and reader, runs through the real pipeline, and the real script over the page's own markup, its body handed to the real planner.
import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildHostLoads, hostLoadsKey } from "@edgehero/pi-dispatch/host-loads";
import { overlayEntryNamed } from "@edgehero/pi-dispatch/loaded-record";
import { CONSOLE_SCRIPT } from "../src/console/script.mjs";
import { readHostLoadsView } from "../src/host-loads-view.mjs";
import { sandboxFreshLine, toolNamesOfRuns, triggerLastRun, wordsText } from "../src/loaded-words.mjs";
import { readTriggerEditor, normalizeTriggerForDisplay } from "../src/read-model.mjs";
import { triggerEntryDigest } from "../src/trigger-edit-core.mjs";
import { createTriggerEnvironmentActions } from "../src/trigger-environment-plans.mjs";
import { TRIGGER_GETS_WORDS as W, triggerGetsOf } from "../src/trigger-gets-view.mjs";
import { canaryTriggersFor, readUpdates } from "../src/updates-view.mjs";
import { recordThroughPipeline } from "./helpers/loaded-pipeline.mjs";
import { LOADED_SAMPLES as S, loadedField, loadedRecord, source } from "./helpers/loaded-samples.mjs";
import { Event, runConsoleScript } from "./helpers/script-dom.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { GETS_ENTRY, getsFile, getsHostLoads, triggerGetsPage } from "./helpers/trigger-gets-goldens.mjs";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const HOUR = 3_600_000;
const COMMENT = Object.freeze({ index: 2, type: "comment", flow: "fix", packages: true, forge: "github" });
const panelOf = (page, id) => {
  const at = page.indexOf(`<section id="${id}" data-panel>`);
  assert.ok(at >= 0, `the page draws ${id}`);
  return page.slice(at, page.indexOf("</section>", at));
};
const textOf = (markup) => markup.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const withRun = (over) => ({ ...GETS_ENTRY, run: { ...GETS_ENTRY.run, ...over } });
const card = async (over = {}, options = {}) => panelOf(await triggerGetsPage({ entry: withRun(over), ...options }), "p-trigger-gets");
const PI_LINT = Object.freeze({ name: "pi-lint", version: "1.4.2" });
const GUARD = Object.freeze({ name: "git-guard.ts", kind: "file" });

async function published(hosts, { live = Object.keys(hosts) } = {}) {
  const strings = new Map(Object.entries(hosts).filter(([, row]) => row !== null).map(([name, row]) => [hostLoadsKey(name), JSON.stringify(buildHostLoads({ at: NOW - HOUR, every: 24, by: { uid: 1000, worker: true }, ...row }))]));
  const redis = { smembers: async () => Object.keys(hosts), mget: async (...keys) => keys.map((key) => strings.get(key) ?? null) };
  return readHostLoadsView(redis, { now: () => NOW, readHosts: async () => ({ hosts: live.map((name) => ({ name, image: "pi-job:4.3.1", piVersion: "1.5.0" })) }) });
}
const view = async (hosts, trigger = COMMENT, options = {}) => triggerGetsOf({ trigger, hostLoads: await published(hosts), liveHosts: Object.keys(hosts), ...options });
const pills = async (hosts, trigger = COMMENT) => Object.fromEntries((await view(hosts, trigger)).pills.map((pill) => [pill.name, pill.word]));
const answered = (tier, pkg = null, repo = "unknown") => ({ flows: [{ trigger: 2, flow: "fix", tier, package: pkg, repo }] });

// ---- the pills and the rows are of what a job gets -------------------------------------------------------------------------

test("a package or an overlay entry the file leaves out is no difference between hosts, and no part of what a job gets", async () => {
  const hosts = { a: { ...answered("repository"), packages: [PI_LINT], extensions: [GUARD] }, b: answered("repository") };
  assert.deepEqual(await pills(hosts, { ...COMMENT, excludeExtensions: ["pi-lint", "git-guard"] }), { a: "the same", b: "the same" });
  assert.equal((await pills(hosts, { ...COMMENT, excludeExtensions: ["pi-lint"] })).a, "also git-guard.ts, from its overlay", "what it still loads is still said");
  assert.equal((await pills(hosts, { ...COMMENT, excludeExtensions: ["pi-lint"] })).b, "without git-guard.ts");
  assert.equal((await pills(hosts)).a, "also pi-lint 1.4.2 and git-guard.ts, from its overlay", "and with none left out, both");
  // By each of the spellings the runner reads, and no other.
  assert.equal((await pills(hosts, { ...COMMENT, excludeExtensions: ["pi-lint", "git-guard.ts"] })).a, "the same");
  assert.notEqual((await pills(hosts, { ...COMMENT, excludeExtensions: ["pi-lint", "git"] })).a, "the same");
});

test("doctor's answer naming a package the file now leaves out is no answer for the file as it is", async () => {
  const out = await view({ a: { packages: [PI_LINT], ...answered("package", "pi-lint") } }, { ...COMMENT, excludeExtensions: ["pi-lint"] });
  assert.equal(out.flow.doctor, "a has no answer for it yet.");
  const beside = await view({ a: { packages: [PI_LINT], ...answered("package", "pi-lint") }, b: { packages: [PI_LINT], ...answered("package", "pi-lint") } }, { ...COMMENT, excludeExtensions: ["pi-lint"] });
  assert.deepEqual(beside.pills.map((pill) => pill.word), ["no answer for its flow", "no answer for its flow"], "not known to differ, and not the same");
  const kept = await view({ a: { packages: [PI_LINT], ...answered("package", "pi-lint") } });
  assert.equal(kept.flow.doctor, "a finds fix from pi-lint.");
  const other = await view({ a: { packages: [PI_LINT], ...answered("package", "pi-lint") } }, { ...COMMENT, excludeExtensions: ["other"] });
  assert.equal(other.flow.doctor, "a finds fix from pi-lint.", "another name changes nothing");
});

test("one row per name: a package and an overlay entry of one name share it, two entries of a stem share it, and a name the file holds keeps its row and its spelling", async () => {
  const items = async (hosts, trigger = COMMENT) => (await view(hosts, trigger)).extensions.items;
  const both = await items({ a: { packages: [{ name: "shared", version: "1.0.0" }], extensions: [{ name: "shared.ts", kind: "file" }] } });
  assert.deepEqual(both.map((row) => [row.value, row.name, row.sub]), [["shared", "shared 1.0.0", "staged on a · in the overlay on a"]]);
  const stems = await items({ a: { extensions: [{ name: "guard.ts", kind: "file" }] }, b: { extensions: [{ name: "guard.js", kind: "file" }] }, c: { extensions: [{ name: "guard", kind: "dir" }] } });
  assert.deepEqual(stems.map((row) => row.value), ["guard"], "every entry that name means, on each host");
  for (const segment of ["guard.ts", "guard.js", "guard"]) assert.equal(overlayEntryNamed("guard", segment), true, segment);
  const spelled = await items({ a: { extensions: [GUARD] } }, { ...COMMENT, excludeExtensions: ["git-guard.ts"] });
  assert.deepEqual(spelled.map((row) => [row.value, row.on]), [["git-guard.ts", false]], "turned back on, it takes the file's own word off the list");
  const ghost = await items({ a: { packages: [PI_LINT] }, blind: { unread: ["packages"] }, shut: { unread: ["extensions"] }, silent: null }, { ...COMMENT, excludeExtensions: ["ghost"] });
  const row = ghost.find((entry) => entry.value === "ghost");
  assert.equal(row.on, false);
  assert.equal(row.sub, "named in the file; not on a, unknown on blind, shut and silent");
  assert.equal((await items({}, { ...COMMENT, excludeExtensions: ["ghost"] }))[0].sub, "named in the file");
  // What a run had of an extension is no part of a row the file now leaves out.
  const off = triggerGetsOf({ trigger: { ...COMMENT, excludeExtensions: ["pi-lint"] }, records: [S.everything()], hostLoads: await published({ a: { packages: [PI_LINT] } }), liveHosts: ["a"] }).extensions.items[0];
  assert.equal(off.sub, "staged on a");
  assert.match(triggerGetsOf({ trigger: COMMENT, records: [S.everything()], hostLoads: await published({ a: { packages: [PI_LINT] } }), liveHosts: ["a"] }).extensions.items[0].sub, /as gh-9575 loaded it/);
});

test("under the file's false a package has no switch of its own, an overlay entry keeps one, and a name in the file keeps its place in the list", async () => {
  const off = await card({ packages: false, excludeExtensions: ["pi-lint"] });
  assert.ok(off.includes('<input type="checkbox" disabled data-gets-list="excludeExtensions" data-gets-value="pi-lint"'), "named and moot: its box stays, disabled and off");
  assert.ok(!off.includes('data-gets-value="pi-test-runner"'), "not named and moot: nothing to send, and no switch");
  assert.ok(off.includes('<input type="checkbox" checked data-gets-list="excludeExtensions" data-gets-value="git-guard"'), "the overlay is another switch");
  assert.ok(textOf(off).includes(W.extensionsMoot));
  assert.ok(!textOf(await card()).includes(W.extensionsMoot));
  const seen = textOf(await card({ packages: false }, { role: "viewer" }));
  assert.ok(seen.includes("pi-lint 1.4.2: off"), seen.slice(0, 2500));
  assert.ok(!seen.includes(W.extensionsMoot), "a viewer can turn nothing on");
  assert.ok(seen.includes("git-guard: on"));
});

test("a viewer and a read-only console read the same rows, no control, and each extension and tool says which it is", async () => {
  for (const options of [{ role: "viewer" }, { readOnly: true }]) {
    const panel = await card({ excludeExtensions: ["pi-lint"], excludeExtensionTools: ["run_tests"] }, options);
    assert.doesNotMatch(panel, /<(?:input|select|textarea|form|button)\b/);
    assert.ok(textOf(panel).includes("pi-lint 1.4.2: off"));
    assert.ok(textOf(panel).includes("pi-test-runner 0.9.0: on"));
    assert.ok(panel.includes('<span class="te-chip te-chip--ro te-chip--off">run_tests</span>'));
    assert.ok(panel.includes('<span class="te-chip te-chip--ro">test_report</span>'));
    assert.ok(textOf(panel).includes(W.packagesLoadLess), "and what it loads is not all that is staged");
    assert.ok(!textOf(panel).includes(W.extensionSwitch));
  }
  assert.ok(textOf(await card({}, { role: "viewer" })).includes(W.packagesLoad));
});

test("a watch rule's card has no form, and a row the file did not give back draws no switch", async () => {
  const watch = panelOf(await triggerGetsPage({ entry: { on: { type: "watch", id: "w", source: "s" }, run: { kind: "local", folder: "/x", flow: "fix", task: "T", mode: "investigate" } } }), "p-trigger-gets");
  assert.doesNotMatch(watch, /data-gets-list/);
  const gone = panelOf(await triggerGetsPage({ deps: { fs: { readFileSync: () => { throw new Error("gone"); } } } }), "p-trigger-gets");
  assert.doesNotMatch(gone, /data-gets-list/);
});

// ---- the Tools row --------------------------------------------------------------------------------------------------------

test("a chip is from what a run recorded, by its id and host, and goes where what brought it goes", async () => {
  const tools = (trigger) => triggerGetsOf({ trigger, records: [S.everything()], liveHosts: [] }).tools;
  const names = (row) => row.fromExtensions.flatMap((group) => group.chips.map((chip) => chip.name));
  assert.deepEqual(names(tools(COMMENT)), ["lint_file", "lint_fix", "run_tests", "test_coverage", "test_report"]);
  assert.deepEqual(names(tools({ ...COMMENT, excludeExtensions: ["pi-lint"] })), ["run_tests", "test_coverage", "test_report"], "an extension left out brings no tool");
  assert.deepEqual(names(tools({ ...COMMENT, packages: false })), []);
  const overlay = loadedRecord({ jobId: "gh-t1", loaded: loadedField({ sources: [source("overlay", { names: ["git-guard.ts"], extensions: 1, tools: 1, namedTools: [{ name: "git-guard.ts", tools: ["guard_push"] }] }), source("repository"), source("trigger"), source("other")] }) });
  const fromOverlay = (trigger) => names(triggerGetsOf({ trigger, records: [overlay], liveHosts: [] }).tools);
  assert.deepEqual(fromOverlay(COMMENT), ["guard_push"]);
  assert.deepEqual(fromOverlay({ ...COMMENT, packages: false }), ["guard_push"], "the overlay is another switch");
  assert.deepEqual(fromOverlay({ ...COMMENT, excludeExtensions: ["git-guard"] }), [], "by the stem");
  assert.deepEqual(fromOverlay({ ...COMMENT, excludeExtensions: ["git-guard.ts"] }), [], "and by the whole name");
  // A tool the file names and nothing still brings stays listed, or an edit of the rest would drop it, and a record of a run with it off shows none.
  assert.deepEqual(tools({ ...COMMENT, excludeExtensions: ["pi-lint"], excludeExtensionTools: ["lint_fix"] }).otherTools, [{ name: "lint_fix", label: "lint_fix", on: false }]);
  assert.deepEqual(tools({ ...COMMENT, excludeExtensionTools: ["lint_fix"] }).otherTools, []);
  assert.equal(tools({ ...COMMENT, excludeExtensionTools: ["lint_fix"] }).fromExtensions[0].chips.find((chip) => chip.name === "lint_fix").on, false);
  assert.deepEqual(triggerGetsOf({ trigger: { ...COMMENT, excludeExtensionTools: ["lint_fix"] }, liveHosts: [] }).tools.otherTools.map((chip) => chip.name), ["lint_fix"], "with no run at all, too");
});

test("what the file would refuse is shown and not switched, and one name has one box wherever two extensions register it", () => {
  const record = loadedRecord({ jobId: "gh-t2", host: "build3", loaded: loadedField({ sources: [source("package", { name: "a", version: "1.0.0", extensions: 1, tools: 3, toolNames: ["shared_tool", "report_progress", "read"] }), source("package", { name: "b", version: "1.0.0", extensions: 1, tools: 1, toolNames: ["shared_tool"] }), source("overlay"), source("repository"), source("trigger"), source("other")] }) });
  const [first, second] = triggerGetsOf({ trigger: COMMENT, records: [record], liveHosts: [] }).tools.fromExtensions;
  assert.deepEqual(first.chips.map((chip) => [chip.name, chip.switched]), [["shared_tool", true], ["report_progress", false], ["read", false]]);
  assert.deepEqual(second.chips.map((chip) => [chip.name, chip.switched]), [["shared_tool", false]]);
  // Drawn so: a box only where one is switched, for an operator's form.
  return triggerGetsPage({ records: [record] }).then((page) => {
    const panel = panelOf(page, "p-trigger-gets");
    assert.ok(panel.includes('data-gets-list="excludeExtensionTools" data-gets-value="shared_tool"'));
    assert.equal(panel.split('data-gets-list="excludeExtensionTools" data-gets-value="shared_tool"').length, 2, "one box for one name");
    assert.ok(!panel.includes('data-gets-list="excludeExtensionTools" data-gets-value="read"'));
    assert.ok(!panel.includes('data-gets-list="excludeExtensionTools" data-gets-value="report_progress"'));
    assert.ok(panel.includes('<span class="te-chip te-chip--ro">report_progress</span>'));
  });
});

test("the run's own list is what a preview can confirm: a package's and an overlay entry's, and a run that could not say holds nothing", () => {
  assert.deepEqual(toolNamesOfRuns([S.everything()]).sort(), ["lint_file", "lint_fix", "run_tests", "test_coverage", "test_report"]);
  const overlay = loadedRecord({ jobId: "gh-t1", loaded: loadedField({ sources: [source("overlay", { names: ["git-guard"], extensions: 1, tools: 1, namedTools: [{ name: "git-guard", tools: ["guard_push"] }] }), source("repository"), source("trigger"), source("other")] }) });
  assert.deepEqual(toolNamesOfRuns([overlay]), ["guard_push"]);
  assert.deepEqual(toolNamesOfRuns([S.refused()]), []);
  assert.deepEqual(toolNamesOfRuns([]), []);
  assert.equal(toolNamesOfRuns(undefined), null);
  assert.equal(toolNamesOfRuns(null), null);
  assert.deepEqual(triggerLastRun([S.everything()]).quoted.tools.flatMap((group) => group.names).sort(), toolNamesOfRuns([S.everything()]).sort(), "what a chip is drawn from is what confirms it");
});

test("a run through the real pipeline that left a tool out reads as such, and the card still lists the name", async () => {
  const record = await recordThroughPipeline({ exit: { code: 0, reason: "stop" }, turnsOnLine: 3, jobFields: { excludeExtensionTools: ["lint_run"] } });
  const out = triggerGetsOf({ trigger: { ...COMMENT, excludeExtensionTools: ["lint_run"] }, records: [record], liveHosts: [] });
  assert.deepEqual(out.tools.otherTools.map((chip) => chip.name), ["lint_run"]);
  assert.ok(wordsText(out.last.Tools).includes("lint_run"), wordsText(out.last.Tools));
});

// ---- the form, through the real script and the real planner ------------------------------------------------------------------

/** A real file, the planner over it, and the real script over the page drawn from the same file. */
async function form(over = {}, options = {}) {
  const entry = withRun(over);
  const dir = tempDir("pd-800-exclude-form-");
  const paths = { triggersPath: join(dir, "triggers.json"), settingsFile: join(dir, "settings.json"), projectsFile: null, globalPiDir: join(dir, "overlay") };
  const narrows = over.excludeExtensions !== undefined || over.excludeExtensionTools !== undefined;
  const text = () => { const doc = JSON.parse(getsFile(entry)); return `${JSON.stringify(narrows ? { version: 2, ...doc } : doc, null, 2)}\n`; };
  nodeFs.writeFileSync(paths.triggersPath, text());
  nodeFs.writeFileSync(paths.settingsFile, "{}");
  nodeFs.mkdirSync(paths.globalPiDir);
  const service = createTriggerEnvironmentActions({ paths, env: { PI_PROVIDER: "anthropic", PI_MODEL: "claude-sonnet-5-5", PI_EGRESS: "0" }, now: () => NOW, deploymentDir: dir, readHosts: async () => ({ hosts: ["build3", "mini1", "mini2"].map((name) => ({ name, triggersVersion: "2", jobDataVersion: "2" })) }), readHostLoads: async () => getsHostLoads(), readRunRecords: async () => [S.everything()] });
  const w = runConsoleScript(CONSOLE_SCRIPT, await triggerGetsPage({ entry, ...options }));
  const element = w.document.querySelector('form[data-action="trigger-environment-edit"]');
  const operator = { surface: "console", role: "operator", name: "ops" };
  const toggle = (selector, checked) => {
    const box = element.querySelector(selector);
    assert.ok(box, selector);
    box.checked = checked;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    return box;
  };
  const send = () => { w.submit(element); return w.fetch.calls.at(-1).body; };
  const read = () => nodeFs.readFileSync(paths.triggersPath, "utf8");
  return { w, form: element, toggle, send, read, service, operator };
}
const barOf = (f) => f.form.querySelector("[data-gets-bar]");
const barWords = (f) => [barOf(f).querySelector("[data-gets-count]").textContent, barOf(f).querySelector("[data-gets-words]").textContent];

test("a switch off sends the name, the bar says it, Preview judges it, Confirm writes it and Undo puts the bytes back", async () => {
  const f = await form();
  const before = f.read();
  assert.equal(barOf(f).hidden, true);
  f.toggle('[data-gets-list="excludeExtensions"][data-gets-value="pi-lint"]', false);
  assert.equal(barOf(f).hidden, false);
  assert.deepEqual(barWords(f), ["1 change, not written yet:", "pi-lint left out."]);
  const body = f.send();
  assert.deepEqual(Object.keys(body).sort(), ["excludeExtensions", "index", "pageDigest"], "only what moved");
  assert.deepEqual(body.excludeExtensions, ["pi-lint"]);
  const out = await f.service.preview(body, f.operator);
  assert.ok(out.plan, JSON.stringify(out));
  assert.deepEqual(await f.service.apply(out, f.operator), { ok: true });
  assert.deepEqual(JSON.parse(f.read()).triggers[2].run.excludeExtensions, ["pi-lint"]);
  assert.equal(JSON.parse(f.read()).version, 2);
  const back = await f.service.preview(out.plan.inverse.body, f.operator);
  assert.deepEqual(await f.service.apply(back, f.operator), { ok: true });
  assert.equal(f.read(), before, "byte for byte");
});

test("a chip off the same way, and a chip for each list goes to its own key", async () => {
  const f = await form();
  f.toggle('[data-gets-list="excludeExtensionTools"][data-gets-value="lint_file"]', false);
  f.toggle('[data-gets-list="excludeTools"][data-gets-value="bash"]', false);
  assert.deepEqual(barWords(f), ["2 changes, not written yet:", "bash off, lint_file off."]);
  const body = f.send();
  assert.deepEqual(body.excludeExtensionTools, ["lint_file"]);
  assert.deepEqual(body.excludeTools, ["bash"]);
  const out = await f.service.preview(body, f.operator);
  assert.ok(out.plan, JSON.stringify(out));
  assert.deepEqual(out.plan.changes.map((change) => change.key).sort(), ["excludeExtensionTools", "excludeTools"]);
});

test("turning the last one back on removes the key, a name left in the list keeps its spelling, and one no host shows can be turned back on", async () => {
  const f = await form({ excludeExtensions: ["ghost", "git-guard"], excludeExtensionTools: ["gone_tool"] });
  assert.equal(f.form.querySelector('[data-gets-value="ghost"]').checked, false);
  f.toggle('[data-gets-value="ghost"]', true);
  assert.deepEqual(f.send().excludeExtensions, ["git-guard"], "the other name stays, and an unsent list is not sent");
  assert.equal(f.send().excludeExtensionTools, undefined);
  f.toggle('[data-gets-value="git-guard"]', true);
  assert.equal(f.send().excludeExtensions, null, "none left, so the key goes");
  f.toggle('[data-gets-list="excludeExtensionTools"][data-gets-value="gone_tool"]', true);
  const body = f.send();
  assert.equal(body.excludeExtensionTools, null);
  const out = await f.service.preview(body, f.operator);
  assert.ok(out.plan, JSON.stringify(out));
  assert.deepEqual(await f.service.apply(out, f.operator), { ok: true });
  const after = JSON.parse(f.read());
  assert.equal(after.version, undefined, "and with neither key, no stamp");
  assert.ok(!Object.hasOwn(after.triggers[2].run, "excludeExtensions") && !Object.hasOwn(after.triggers[2].run, "excludeExtensionTools"));
});

test("a moot package's name stays in the list an edit of the rest sends, and the Staged packages switch keeps its own key", async () => {
  const f = await form({ packages: false, excludeExtensions: ["pi-lint"] });
  const before = JSON.parse(f.read()).triggers[2].run;
  f.toggle('[data-gets-list="excludeExtensions"][data-gets-value="git-guard"]', false);
  assert.deepEqual(new Set(f.send().excludeExtensions), new Set(["pi-lint", "git-guard"]));
  f.toggle('[data-gets-list="excludeExtensions"][data-gets-value="git-guard"]', true);
  assert.equal(f.send().excludeExtensions, undefined, "back as drawn is no change");
  f.toggle('[data-gets-flag="packages"]', true);
  const body = f.send();
  assert.equal(body.packages, null);
  assert.equal(body.excludeExtensions, undefined);
  const out = await f.service.preview(body, f.operator);
  assert.deepEqual(await f.service.apply(out, f.operator), { ok: true });
  assert.deepEqual(JSON.parse(f.read()).triggers[2].run.excludeExtensions, before.excludeExtensions, "turning the packages on keeps what it names");
});

test("any move of a new control closes an open preview, Discard clears the bar and the mark, and a stale page is refused", async () => {
  const f = await form();
  const box = f.toggle('[data-gets-list="excludeExtensions"][data-gets-value="pi-lint"]', false);
  const row = box.closest("[data-gets-item]");
  assert.ok(row.classList.contains("te-changed"));
  assert.equal(row.querySelector(".te-pend").hidden, false);
  f.toggle('[data-gets-list="excludeExtensions"][data-gets-value="pi-lint"]', true);
  assert.ok(!row.classList.contains("te-changed"));
  assert.equal(barOf(f).hidden, true, "back as drawn");
  f.toggle('[data-gets-list="excludeExtensions"][data-gets-value="pi-lint"]', false);
  const body = f.send();
  // The file moved under the page: its digest is of what the person saw.
  const other = await form({ flow: "review" });
  const stale = await other.service.preview({ ...body, pageDigest: triggerEntryDigest(JSON.parse(getsFile(withRun({}))).triggers[2]) }, other.operator);
  assert.match(stale.refusal, /^This trigger changed since the page drew it/);
  assert.equal(stale.state, "changed");
});

// ---- the pages beside it ------------------------------------------------------------------------------------------------------

test("a fresh sandbox says what a job of that trigger would load, less what it leaves out by name, by the runner's reading of a name", async () => {
  const hostLoads = await published({ mini1: { packages: [PI_LINT, { name: "pi-test-runner", version: "0.9.0" }], extensions: [GUARD, { name: "other", kind: "dir" }] } });
  const line = (over) => wordsText(sandboxFreshLine({ hostLoads, host: "mini1", triggerIndex: 2, image: "pi-job:4.3.1", ...over }));
  assert.match(line({}), /would load pi-lint 1\.4\.2, pi-test-runner 0\.9\.0, git-guard\.ts and other, from/);
  assert.match(line({ excludes: ["pi-lint", "git-guard"] }), /would load pi-test-runner 0\.9\.0 and other, from/);
  assert.match(line({ excludes: ["git-guard.ts"] }), /would load pi-lint 1\.4\.2, pi-test-runner 0\.9\.0 and other, from/);
  assert.match(line({ withholdsPackages: true, excludes: ["other"] }), /would load git-guard\.ts, from/);
  assert.match(line({ excludes: ["pi-lint", "pi-test-runner", "git-guard", "other"] }), /would load no staged package or overlay extension, from/);
  // A list past its cap: what it did not name may be what is left out, so the count is a bound.
  const cut = await published({ mini1: { packages: Array.from({ length: 70 }, (_, at) => ({ name: `p${at}`, version: "1.0.0" })) } });
  const shown = (over) => wordsText(sandboxFreshLine({ hostLoads: cut, host: "mini1", triggerIndex: 2, ...over }));
  assert.match(shown({}), /and 6 more, from/);
  assert.match(shown({ excludes: ["p1"] }), /and up to 6 more, from/);
});

test("what a sandbox's trigger leaves out comes from the file, as its other facts do", async () => {
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(new URL("../src/sandbox-data.mjs", import.meta.url), "utf8"), /excludes: Array\.isArray\(rawTrigger\?\.excludeExtensions\)/);
  assert.match(readFileSync(new URL("../src/console/panels/sandboxes.mjs", import.meta.url), "utf8"), /excludes: data\?\.excludes \?\? \[\]/);
});

test("a canary is offered as a trigger that loads that package: one that leaves it out is no choice for it, and is for another", async () => {
  const read = await readUpdates({ staged: { packages: [] }, triggersDocument: { triggers: [
    { on: { type: "cron", id: "keeps" }, run: {} },
    { on: { type: "cron", id: "leaves" }, run: { excludeExtensions: ["pi-lint"] } },
    { on: { type: "comment" }, run: { excludeExtensions: ["pi-lint"] } },
  ] } });
  assert.deepEqual(read.triggers, [{ index: 0, id: "keeps", capUsd: null }, { index: 1, id: "leaves", capUsd: null, excludes: ["pi-lint"] }]);
  assert.deepEqual(canaryTriggersFor(read.triggers, "pi-lint").map((row) => row.id), ["keeps"]);
  assert.deepEqual(canaryTriggersFor(read.triggers, "other").map((row) => row.id), ["keeps", "leaves"]);
  assert.deepEqual(canaryTriggersFor(undefined, "x"), []);
});

test("the editor's defaults say none for both, so a page that lists them says a fact", () => {
  const absent = () => { throw Object.assign(new Error("absent"), { code: "ENOENT" }); };
  const editor = readTriggerEditor({ paths: { settingsFile: "/none/s.json", triggersPath: "/none/t.json", globalPiDir: "/none/pi" }, env: {}, fs: { readFileSync: absent, existsSync: () => false, readdirSync: absent, statSync: absent }, folderSkillsFn: () => ({ skills: [] }), overlaySkillsFn: () => ({ skills: [] }), stagedSkillsFn: () => ({ skills: [] }) });
  assert.equal(editor.defaults.excludeExtensions, "none");
  assert.equal(editor.defaults.excludeExtensionTools, "none");
  assert.ok(normalizeTriggerForDisplay(withRun({ excludeExtensions: ["x"] })).excludeExtensions);
});
