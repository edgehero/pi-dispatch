// What the card and the pages beside it read of `run.excludeExtensions` and `run.excludeExtensionTools` (issue #800): the real page over a real file, what the hosts published
// through the real publisher and reader, runs through the real pipeline, and the real script over the page's own markup, its body handed to the real planner.
import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { overlayEntryNamed as runnerEntryNamed } from "../../image/runner/src/loaded.mjs";
import { buildHostLoads, hostLoadsKey } from "@edgehero/pi-dispatch/host-loads";
import { extensionsNotHere, leftOutOf, overlayEntryNamed } from "@edgehero/pi-dispatch/loaded-record";
import { parseTriggers } from "@edgehero/pi-dispatch/triggers";
import { agentReadProjection } from "../src/agent-read.mjs";
import { WATCH_READ_TOOLS, watchToolOptions } from "../../image/runner/src/watch.mjs";
import { CONSOLE_SCRIPT } from "../src/console/script.mjs";
import { readHostLoadsView } from "../src/host-loads-view.mjs";
import { sandboxFreshLine, toolNamesOfRuns, triggerLastRun, wordsText } from "../src/loaded-words.mjs";
import { readTriggerEditor, readTriggers, normalizeTriggerForDisplay } from "../src/read-model.mjs";
import { triggerEntryDigest } from "../src/trigger-edit-core.mjs";
import { createTriggerEnvironmentActions } from "../src/trigger-environment-plans.mjs";
import { TRIGGER_GETS_WORDS as W, alsoNaming, overlayStem, readTriggerGetsEntry, triggerGetsOf } from "../src/trigger-gets-view.mjs";
import { canaryTriggersFor, readUpdates } from "../src/updates-view.mjs";
import { recordThroughPipeline } from "./helpers/loaded-pipeline.mjs";
import { LOADED_SAMPLES as S, loadedField, loadedRecord, source } from "./helpers/loaded-samples.mjs";
import { Event, runConsoleScript } from "./helpers/script-dom.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { GETS_ENTRY, TRIGGER_GETS_DRAW, TRIGGER_GETS_PATH, WATCH_INVESTIGATE, fileOnlyFs, getsFile, getsHostLoads, triggerGetsPage, watchRuleFile } from "./helpers/trigger-gets-goldens.mjs";

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

test("two names in the file that mean one entry: a row each, each says where it is as the worker reads it, and that the file also names the other", async () => {
  const names = ["git-guard", "git-guard.ts"];
  assert.deepEqual(extensionsNotHere(names, { packages: [], overlay: [GUARD.name] }), [], "the worker: both are on this host");
  const out = await view({ mini1: { extensions: [GUARD] }, mini2: { extensions: [GUARD] } }, { ...COMMENT, excludeExtensions: names });
  assert.deepEqual(out.extensions.items.map((row) => [row.value, row.name, row.on, row.sub, row.backOn]), [
    ["git-guard", "git-guard", false, "in the overlay on mini1 and mini2 · the file also names git-guard.ts", "git-guard off the list"],
    ["git-guard.ts", "git-guard.ts", false, "in the overlay on mini1 and mini2 · the file also names git-guard", "git-guard.ts off the list"],
  ]);
  // Beside a host that lists whole and holds neither, and one that cannot say, the same words any other row reads.
  const beside = await view({ mini1: { extensions: [GUARD] }, bare: {}, blind: { unread: ["extensions"] } }, { ...COMMENT, excludeExtensions: names });
  assert.equal(beside.extensions.items[1].sub, "in the overlay on mini1, not on bare, unknown on blind · the file also names git-guard");
  // One name stays one row, in its own words, and an entry of another stem is its own row whatever the file spells.
  const one = await view({ mini1: { extensions: [GUARD, { name: "git-guard.js", kind: "file" }] } }, { ...COMMENT, excludeExtensions: ["git-guard.ts"] });
  assert.deepEqual(one.extensions.items.map((row) => [row.value, row.name, row.on, row.sub, row.backOn]), [
    ["git-guard", "git-guard.js", true, "in the overlay on mini1", "git-guard back on"],
    ["git-guard.ts", "git-guard.ts", false, "in the overlay on mini1", "git-guard.ts back on"],
  ]);
  // On the page: the word the bar repeats is the row's.
  const panel = await card({ excludeExtensions: names });
  assert.ok(panel.includes('data-gets-value="git-guard" data-gets-inverse data-gets-on="git-guard off the list"'), panel.slice(0, 400));
  assert.ok(panel.includes('data-gets-value="git-guard.ts" data-gets-inverse data-gets-on="git-guard.ts off the list"'));
  assert.ok((await card({ excludeExtensions: ["git-guard"] })).includes('data-gets-value="git-guard" data-gets-inverse data-gets-on="git-guard back on"'));
});

test("the name a row switches is the shortest the worker's and the runner's own rule read as that entry: there is no second regex here", () => {
  const shortest = (rule, segment) => { for (let end = 1; end <= segment.length; end += 1) if (rule(segment.slice(0, end), segment)) return segment.slice(0, end); return null; };
  for (const [segment, stem] of [["guard.ts", "guard"], ["guard.js", "guard"], ["guard", "guard"], ["a.b.ts", "a.b"], ["x.ts.ts", "x.ts"], [".ts", ".ts"], ["guard.mjs", "guard.mjs"], ["guard.tsx", "guard.tsx"]]) {
    assert.equal(overlayStem(segment), stem, segment);
    for (const rule of [overlayEntryNamed, runnerEntryNamed]) assert.equal(shortest(rule, segment), stem, `${segment}, by ${rule === overlayEntryNamed ? "the worker's" : "the runner's"} rule`);
  }
  assert.deepEqual(alsoNaming(["a", "a.ts", "a.js", "b"], "a"), ["a.ts", "a.js"]);
  assert.deepEqual(alsoNaming(["a", "a.ts", "a.js", "b"], "a.ts"), ["a"], "a.ts and a.js share no entry");
  assert.deepEqual(alsoNaming(["a", "a.ts", "a.js", "b"], "b"), []);
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

// ---- a file the worker refuses ---------------------------------------------------------------------------------------------

/** Two hosts that publish one thing: over a file that loads these pills say the same, so anything else they say is the file's doing. */
const SAME_HOSTS = () => {
  const row = (name) => ({ name, state: "current", at: NOW - HOUR, ageMs: HOUR, every: 24, by: { uid: 1000, worker: true }, overlayExtensionsAllowed: true, packages: [PI_LINT], extensions: [GUARD], skills: [], flows: [{ trigger: 2, flow: "fix", tier: "package", package: "pi-lint", repo: "unknown" }], mcp: [], unread: [], more: {}, image: "pi-job:4.3.1", piVersion: "1.5.0" });
  return { more: 0, hosts: [row("mini1"), row("mini2")] };
};
const SAME_LIVE = [{ name: "mini1" }, { name: "mini2" }];
const LABEL_ROW = { on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "triage" } };
const REFUSED_FILES = [
  ["a field with no stamp", getsFile({ ...GETS_ENTRY, run: { ...GETS_ENTRY.run, excludeExtensions: ["pi-lint"] } }), /needs triggers file version 2/],
  ["a row that is no trigger", `${JSON.stringify({ triggers: [null, LABEL_ROW, GETS_ENTRY] }, null, 2)}\n`, /trigger at index 0: must be an object/],
  ["a value it refuses", getsFile({ ...GETS_ENTRY, run: { ...GETS_ENTRY.run, maxTurns: "many" } }), /run\.maxTurns must be a positive integer/],
  ["a duplicate key", getsFile().replace('"triggers"', '"version": 1,\n  "version": 1,\n  "triggers"'), /duplicate key/],
];
const LOADS = "This console loads the triggers file.";
const REFUSED = "The triggers file does not load; run pi-dispatch doctor for the reason.";

test("a file the worker's own parser refuses: the page says so, each pill reads unknown and never the same, and the form stays, so it can be fixed here", async () => {
  // The control: the same hosts over a file that loads.
  const good = await triggerGetsPage({ loads: SAME_HOSTS(), live: SAME_LIVE, records: [] });
  assert.ok(textOf(panelOf(good, "p-trigger-change")).includes(LOADS));
  assert.match(textOf(panelOf(good, "p-trigger-gets")), /mini1 the same .*mini2 the same/);
  assert.ok(textOf(panelOf(good, "p-trigger-gets")).includes(W.fileSays));
  for (const [what, text, says] of REFUSED_FILES) {
    assert.throws(() => parseTriggers(text, TRIGGER_GETS_PATH), says, what);
    for (const options of [{}, { role: "viewer" }, { readOnly: true }]) {
      const page = await triggerGetsPage({ text, loads: SAME_HOSTS(), live: SAME_LIVE, records: [], ...options });
      const change = textOf(panelOf(page, "p-trigger-change"));
      assert.ok(change.includes(REFUSED), `${what}: ${change}`);
      assert.ok(!change.includes(LOADS), what);
      const gets = textOf(panelOf(page, "p-trigger-gets"));
      assert.match(gets, /mini1 unknown .*mini2 unknown/, what);
      assert.doesNotMatch(gets, /the same \S|\bthe only\b/, what);
      assert.ok(gets.includes(W.fileRefused), `${what}: ${gets.slice(0, 900)}`);
      assert.ok(!gets.includes(W.fileSays), what);
      assert.ok(!gets.includes("as a job of trigger"), `${what}: the card's own heading does not say it either`);
    }
    const operator = panelOf(await triggerGetsPage({ text, loads: SAME_HOSTS(), live: SAME_LIVE, records: [] }), "p-trigger-gets");
    assert.ok(operator.includes('data-action="trigger-environment-edit"'), `${what}: the row that needs fixing can be reached`);
  }
});

test("the card asks of its one read, so a file the worker refuses says so with the rest of the page unread, and a good file adds no key anywhere", () => {
  const [[, refused]] = REFUSED_FILES;
  assert.equal(readTriggerGetsEntry({ triggersPath: TRIGGER_GETS_PATH, index: 2, fs: fileOnlyFs(refused) }).fileRefused, true);
  assert.equal(Object.hasOwn(readTriggerGetsEntry({ triggersPath: TRIGGER_GETS_PATH, index: 2, fs: fileOnlyFs(getsFile()) }), "fileRefused"), false);
  assert.equal(readTriggers({ triggersPath: TRIGGER_GETS_PATH, fs: fileOnlyFs(refused) }).doesNotLoad, true);
  assert.deepEqual(Object.keys(readTriggers({ triggersPath: TRIGGER_GETS_PATH, fs: fileOnlyFs(getsFile()) })), ["triggers", "count"], "every other read stays key-identical");
  // What an agent's copy holds of it is that yes or no, and what the page draws for an agent is the same sentence.
  assert.equal(agentReadProjection(readTriggers({ triggersPath: TRIGGER_GETS_PATH, fs: fileOnlyFs(refused) })).doesNotLoad, true);
});

test("a file the worker refuses reads so with Valkey down, where only the card's read speaks, and with the card's read gone, where only the snapshot's does", async () => {
  const [[, refused]] = REFUSED_FILES;
  const down = panelOf(await triggerGetsPage({ text: refused, deps: { fleet: { snapshot: async () => { throw new Error("down"); }, parkedCount: async () => 0 } } }), "p-trigger-gets");
  assert.ok(textOf(down).includes(W.fileRefused), textOf(down).slice(0, 400));
  assert.ok(!textOf(down).includes(W.fileSays));
  const raced = panelOf(await triggerGetsPage({ text: refused, loads: SAME_HOSTS(), live: SAME_LIVE, deps: { fs: { readFileSync: () => { throw new Error("gone"); } } } }), "p-trigger-gets");
  assert.ok(textOf(raced).includes(W.fileRefused), textOf(raced).slice(0, 400));
  assert.match(textOf(raced), /mini1 unknown .*mini2 unknown/);
});

test("a hand-written version 2 file beside a host that publishes it reads less: that host holds the file's jobs, its pill does not read the same, and a line says so", async () => {
  // Through the real reader, from what each worker's registry row publishes. A worker's gate reads the same number (`start.mjs`, `TRIGGERS_FILE_VERSION`).
  const redis = { smembers: async () => ["mini1", "mini2"], mget: async (...keys) => keys.map(() => null), pipeline: () => { throw new Error("unused"); } };
  const beats = (mini2) => ({ hosts: [{ name: "mini1", image: "pi-job:4.3.1", piVersion: "1.5.0", triggersVersion: "2", jobDataVersion: "3" }, { name: "mini2", image: "pi-job:4.3.1", piVersion: "1.5.0", ...mini2 }] });
  const published = async (mini2) => {
    const read = await readHostLoadsView(redis, { now: () => NOW, readHosts: async () => beats(mini2), readLoads: async () => SAME_HOSTS() });
    return read;
  };
  const stamped = `${JSON.stringify({ version: 2, ...JSON.parse(getsFile()) }, null, 2)}\n`;
  parseTriggers(stamped, TRIGGER_GETS_PATH);
  const draw = async (text, mini2) => textOf(panelOf(await triggerGetsPage({ text, loads: await published(mini2), live: SAME_LIVE, records: [] }), "p-trigger-gets"));
  const SAYS = "mini2 reads this file only below version 2, so it holds this file’s jobs until it is upgraded.";
  const older = await draw(stamped, { triggersVersion: "1", jobDataVersion: "2" });
  assert.ok(older.includes(`mini2 ${W.pillHolds}`), older.slice(0, 500));
  assert.ok(older.includes(SAYS), older.slice(0, 700));
  assert.doesNotMatch(older, /mini1 the same|mini2 the same/);
  assert.ok(older.includes("mini1 the only one known"), older.slice(0, 500));
  // The same host once it reads the file: nothing held, and the two compare again.
  const reads = await draw(stamped, { triggersVersion: "2", jobDataVersion: "3" });
  assert.match(reads, /mini1 the same .*mini2 the same/);
  assert.ok(!reads.includes(W.pillHolds) && !reads.includes(SAYS));
  // A worker that publishes no version: unknown, by that reason, never said to hold what it may run.
  const silent = await draw(stamped, {});
  assert.ok(silent.includes("mini2 unknown"), silent.slice(0, 500));
  assert.ok(silent.includes("Unknown, because nothing says which version of this file it reads: mini2."), silent.slice(0, 700));
  assert.ok(!silent.includes(W.pillHolds));
  // Two of each: the same sentences, of both.
  const both = (versions) => triggerGetsOf({ trigger: { index: 2, type: "comment", flow: "fix", packages: true, forge: "github" }, hostLoads: { hosts: Object.entries(versions).map(([name, triggersVersion]) => ({ ...SAME_HOSTS().hosts[0], name, triggersVersion })) }, liveHosts: Object.keys(versions), fileVersion: 2 }).hostsNote.filter((part) => typeof part === "string").join("");
  assert.ok(both({ a: "1", b: "1" }).includes("a and b read this file only below version 2, so they hold this file’s jobs until they are upgraded."));
  assert.ok(both({ a: null, b: null }).includes("Unknown, because nothing says which version of this file they read: a and b."));
  // A file at 1: every release reads it, so the same hosts ask nothing of a version.
  for (const mini2 of [{ triggersVersion: "1" }, {}]) assert.match(await draw(getsFile(), mini2), /mini1 the same .*mini2 the same/);
  // A file the worker refuses says what it said: its pills unknown, whatever each publishes.
  assert.match(await draw(getsFile({ ...GETS_ENTRY, run: { ...GETS_ENTRY.run, excludeExtensions: ["pi-lint"] } }), { triggersVersion: "1" }), /mini1 unknown .*mini2 unknown/);
});

test("each golden of this card is drawn over a file the worker loads, or its pills and its sentences say nothing of a real file", async () => {
  for (const [state, draw] of Object.entries(TRIGGER_GETS_DRAW)) assert.ok(textOf(panelOf(await draw(), "p-trigger-change")).includes(state === "trigger-gets-file-refused.operator" ? REFUSED : LOADS), state);
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

// ---- a watch rule -----------------------------------------------------------------------------------------------------------

const watchFile = watchRuleFile;
const INVESTIGATE = WATCH_INVESTIGATE;
const ISSUE = Object.freeze({ kind: "local", mode: "issue", issue: { kind: "github", repo: "acme/shop" } });
const GOT = ["pi-lint", "git-guard", "linear", "Staged packages", "the same", "the only", "Open Updates", "Doctor’s answer", "as a job of trigger"];

test("a watch rule's job loads nothing a host publishes, so its card names none of it, for whoever reads it, and what it does say is the worker's and the runner's", async () => {
  // A real rule, in a file the worker loads, on hosts that publish a package, an overlay entry, a server and an answer for its flow.
  const text = watchFile(INVESTIGATE);
  const [, , rule] = parseTriggers(text, TRIGGER_GETS_PATH);
  assert.equal(rule.run.packages, false, "the loader's own word");
  const loads = SAME_HOSTS();
  for (const row of loads.hosts) Object.assign(row, { flows: [{ trigger: 2, flow: "triage", tier: "overlay", package: null, repo: "unknown" }], skills: ["triage"], mcp: [{ name: "linear", transport: "http", where: "mcp.example.com", exposure: "codemode", enabled: true, keys: ["LINEAR_API_KEY"] }] });
  for (const options of [{}, { role: "viewer" }, { readOnly: true }]) {
    const page = await triggerGetsPage({ text, loads, live: SAME_LIVE, records: [], ...options });
    const panel = panelOf(page, "p-trigger-gets");
    const words = textOf(panel);
    for (const never of GOT) assert.ok(!words.includes(never), `${JSON.stringify(options)}: ${never}: ${words}`);
    assert.ok(words.includes(W.watchLoads), words);
    assert.ok(words.includes("triage"), "its flow");
    assert.ok(words.includes("pi-job:4.3.1"), "its image");
    assert.doesNotMatch(panel, /<form\b|data-gets-list|te-hosts/);
    assert.ok(textOf(panelOf(page, "p-trigger-gets-how")).includes(W.watch), "and How a change applies does not offer one");
    assert.ok(!textOf(panelOf(page, "p-trigger-gets-how")).includes("Change it in place"));
    assert.ok(textOf(panelOf(page, "p-trigger-change")).includes(LOADS));
    const how = textOf(panelOf(page, "p-trigger-gets-how"));
    assert.ok(how.includes("This card only reads."), how);
    assert.ok(!how.includes("Read only here"), "the page's Edit form still writes what a rule takes");
    const runs = textOf(panelOf(page, "p-trigger-run"));
    assert.ok(runs.includes(W.holdsWatch), runs.slice(0, 300));
    assert.ok(!runs.includes(W.holdsRows), "the card has no row for the packages, the servers or the tools");
    // A watch job carries no `trigger`, so the worker's bundle read passes it over as manual.
    assert.ok(words.includes("Secrets: none named on this trigger."), words);
    assert.doesNotMatch(words, /project’s bundle|project's bundle/);
  }
  // A doctor's answer that the flow is nowhere is an answer about tiers this job does not read: no warning from it either.
  const nowhere = SAME_HOSTS();
  for (const row of nowhere.hosts) row.flows = [{ trigger: 2, flow: "triage", tier: "none", package: null, repo: "absent" }];
  assert.ok(!textOf(panelOf(await triggerGetsPage({ text, loads: nowhere, live: SAME_LIVE, records: [] }), "p-trigger-gets")).includes("would not find"));
  // What the sentence says, of what a job of it is given, by each side's own function.
  assert.ok(W.watchLoads.includes(`Its tools are ${WATCH_READ_TOOLS.slice(0, -1).join(", ")} and ${WATCH_READ_TOOLS.at(-1)}, less what the file removes`));
  assert.deepEqual(watchToolOptions(["read"], ["read", "bash"], ["query_logs"]), { tools: [...WATCH_READ_TOOLS, "query_logs"], excludeTools: ["read", "bash", "codemode"] }, "what the file removes comes off, and the watch's own stay");
  assert.equal(leftOutOf({ watch: { findingId: "f" }, packages: false }).packages, true);
  assert.equal(leftOutOf({ watch: { findingId: "f" }, packages: false }).restricted, true);
  // What the file removes is its own line, with the loader's four it cannot add back left to the sentence.
  const removes = textOf(panelOf(await triggerGetsPage({ text: watchFile({ ...INVESTIGATE, excludeTools: ["grep"] }), loads, live: SAME_LIVE, records: [] }), "p-trigger-gets"));
  assert.ok(removes.includes("The file removes grep."), removes);
  assert.equal(parseTriggers(watchFile({ ...INVESTIGATE, excludeTools: ["grep"] }), TRIGGER_GETS_PATH)[2].run.excludeTools.includes("grep"), true);
  // The display says the same wherever a trigger's reach is read.
  assert.equal(normalizeTriggerForDisplay(JSON.parse(text).triggers[2]).packages, false);
});

test("a watch rule that only files an issue starts no job, so it has none of the rows", async () => {
  const text = watchFile(ISSUE);
  assert.equal(parseTriggers(text, TRIGGER_GETS_PATH)[2].run.mode, "issue");
  const page = await triggerGetsPage({ text, loads: SAME_HOSTS(), live: SAME_LIVE, records: [] });
  const words = textOf(panelOf(page, "p-trigger-gets"));
  assert.ok(words.includes(W.watchIssue), words);
  for (const never of [...GOT, "Model", "Image and secrets", "What it can use", W.fileSays]) assert.ok(!words.includes(never), `${never}: ${words}`);
  const runs = textOf(panelOf(page, "p-trigger-run"));
  assert.ok(runs.includes(W.holdsIssue), runs.slice(0, 300));
  assert.ok(!runs.includes(W.holdsWatch) && !runs.includes(W.holdsRows), "the card has none of those rows");
  assert.ok(textOf(panelOf(page, "p-trigger-gets-how")).includes("This card only reads."));
});

test("a row the file did not give back draws no switch", async () => {
  const gone = panelOf(await triggerGetsPage({ deps: { fs: { readFileSync: () => { throw new Error("gone"); } } } }), "p-trigger-gets");
  assert.doesNotMatch(gone, /data-gets-list/);
});

// ---- the Tools row --------------------------------------------------------------------------------------------------------

test("a tool an extension registers under a name of pi's own goes with run.excludeTools, by the name pi matches", async () => {
  const record = await recordThroughPipeline({ jobId: "gh-grep", exit: { code: 0, reason: "stop" }, tools: [{ name: "grep", path: "/opt/pi-global/packages/pi-lint/ext.js" }] });
  const chips = (trigger) => triggerGetsOf({ trigger, records: [record], liveHosts: [] }).tools.fromExtensions.flatMap((group) => group.chips);
  assert.deepEqual(chips(COMMENT).map((chip) => [chip.name, chip.on, chip.switched]), [["grep", true, false]], "pi's name: shown, and not this chip's to switch");
  assert.deepEqual(chips({ ...COMMENT, excludeTools: ["grep"] }).map((chip) => [chip.name, chip.on, chip.switched]), [["grep", false, false]]);
});

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
  assert.ok(wordsText(out.last.Tools).includes("lint_run removed"), wordsText(out.last.Tools));
  // A name no package or overlay extension brought, under the row: the run's words, and the chip stays, since the file still holds it.
  const typo = await recordThroughPipeline({ exit: { code: 0, reason: "stop" }, jobFields: { packages: false, excludeExtensionTools: ["deploy_previw"] }, unmatched: [0], packages: [] });
  const quoted = triggerGetsOf({ trigger: { ...COMMENT, excludeExtensionTools: ["deploy_previw"] }, records: [typo], liveHosts: [] });
  assert.ok(wordsText(quoted.last.Tools).endsWith("read; deploy_previw: no package or overlay extension brought it."), wordsText(quoted.last.Tools));
  assert.deepEqual(quoted.tools.otherTools.map((chip) => [chip.name, chip.on]), [["deploy_previw", false]]);
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
  const service = createTriggerEnvironmentActions({ paths, env: { PI_PROVIDER: "anthropic", PI_MODEL: "claude-sonnet-5-5", PI_EGRESS: "0" }, now: () => NOW, deploymentDir: dir, readHosts: async () => ({ hosts: ["build3", "mini1", "mini2"].map((name) => ({ name, triggersVersion: "2", jobDataVersion: "3" })) }), readHostLoads: async () => getsHostLoads(), readRunRecords: async () => [S.everything()] });
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
