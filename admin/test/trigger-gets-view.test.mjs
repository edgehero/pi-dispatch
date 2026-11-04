// What a trigger's jobs get, in words (issue #800, `trigger-gets-view.mjs`): each sentence against every real shape that reaches it. Records
// come through the real runner, worker and record builder (`loaded-pipeline.mjs`), and what the hosts published through the real publisher
// and reader, because a shape written by hand can hide the defect it stands in for.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHostLoads, hostLoadsKey } from "@edgehero/pi-dispatch/host-loads";
import { readHostLoadsView } from "../src/host-loads-view.mjs";
import { triggerLastRun, wordsText } from "../src/loaded-words.mjs";
import { TRIGGER_GETS_WORDS as W, triggerGetsOf } from "../src/trigger-gets-view.mjs";
import { recordThroughPipeline } from "./helpers/loaded-pipeline.mjs";
import { LOADED_SAMPLES as S, loadedField, loadedRecord, source } from "./helpers/loaded-samples.mjs";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const HOUR = 3_600_000;
const COMMENT = Object.freeze({ index: 2, type: "comment", flow: "fix", packages: true, forge: "github" });
const lineOf = (parts) => wordsText(parts);

/** What the hosts published, each written by the real builder and read back by the real reader beside what its host beats out. */
async function published(hosts, { live = Object.keys(hosts) } = {}) {
  const strings = new Map(Object.entries(hosts).filter(([, row]) => row !== null && typeof row === "object").map(([name, row]) => [hostLoadsKey(name), JSON.stringify(buildHostLoads({ at: NOW - HOUR, every: 24, by: { uid: 1000, worker: true }, ...row }))]));
  for (const [name, row] of Object.entries(hosts)) if (typeof row === "string") strings.set(hostLoadsKey(name), row);
  const redis = { smembers: async () => Object.keys(hosts), mget: async (...keys) => keys.map((key) => strings.get(key) ?? null) };
  return readHostLoadsView(redis, { now: () => NOW, readHosts: async () => ({ hosts: live.map((name) => ({ name, image: "pi-job:4.3.1", piVersion: "1.5.0" })) }) });
}
const PACKAGES = Object.freeze([{ name: "pi-lint", version: "1.4.2" }]);
const pills = async (hosts, trigger = COMMENT, options = {}) => Object.fromEntries(triggerGetsOf({ trigger, hostLoads: await published(hosts, options), liveHosts: options.live ?? Object.keys(hosts) }).pills.map((pill) => [pill.name, pill.word]));

/** The quote under each row, for a real record, beside a file that says something else. */
function quoted(record, trigger = COMMENT) {
  const out = triggerGetsOf({ trigger, records: [record], hostLoads: null, liveHosts: [] });
  return { out, last: Object.fromEntries(Object.entries(out.last).map(([label, parts]) => [label, lineOf(parts)])), quote: lineOf(out.quote) };
}

test("a host absent, old, newer or cut reads unknown, never the same, and takes no one else's word with it", async () => {
  const known = { packages: PACKAGES };
  const words = await pills({ mini1: known, mini2: known, absent: null, newer: JSON.stringify({ v: 99, at: NOW }), broken: "{", cut: { packages: PACKAGES, unread: ["packages"] } }, COMMENT);
  assert.equal(words.mini1, "the same");
  assert.equal(words.mini2, "the same");
  for (const name of ["absent", "newer", "broken", "cut"]) assert.equal(words[name], "unknown", name);
  // Old: past two of its own intervals.
  const old = await published({ mini1: known, stale: { ...known, at: NOW - 100 * HOUR } });
  const oldPills = Object.fromEntries(triggerGetsOf({ trigger: COMMENT, hostLoads: old, liveHosts: ["mini1", "stale"] }).pills.map((pill) => [pill.name, pill.word]));
  assert.equal(oldPills.stale, "unknown");
  assert.equal(oldPills.mini1, "the only one known", "one host that can say has nothing to be the same as");
  const note = lineOf(triggerGetsOf({ trigger: COMMENT, hostLoads: old, liveHosts: ["mini1", "stale"] }).hostsNote);
  assert.ok(note.includes("stale’s is old, so it reads unknown."), note);
  // A list past its cap cannot prove a lack, and nor can a read that failed.
  const capped = await published({ mini1: known, wide: { packages: Array.from({ length: 70 }, (_, at) => ({ name: `p${at}`, version: "1.0.0" })) } });
  assert.equal(triggerGetsOf({ trigger: COMMENT, hostLoads: capped, liveHosts: ["mini1", "wide"] }).pills.find((pill) => pill.name === "wide").word, "unknown");
  // Each kind of silence is said in its own words, and only a part this trigger loads from makes a host silent.
  const noted = await published({ mini1: known, absent: null, newer: "{", cut: { packages: PACKAGES, unread: ["packages"] } });
  const said = lineOf(triggerGetsOf({ trigger: COMMENT, hostLoads: { ...noted, more: 2 }, liveHosts: ["mini1", "absent", "newer", "cut"] }).hostsNote);
  assert.ok(said.includes("absent has published none, so it reads unknown, never the same."), said);
  assert.ok(said.includes("newer’s could not be read, or a newer release wrote it, so it reads unknown."), said);
  assert.ok(said.includes("cut left out part of what it can load, so it reads unknown."), said);
  assert.ok(said.includes("2 more hosts were not read."), said);
  assert.ok(said.includes(W.repositoryPart), said);
  const partlyDown = { unreachable: false, hosts: [{ name: "mini1", state: "unknown", why: "unreachable" }], more: 0 };
  assert.ok(lineOf(triggerGetsOf({ trigger: COMMENT, hostLoads: partlyDown, liveHosts: ["mini1"] }).hostsNote).includes("mini1 could not be read, so it reads unknown."));
  const down = await readHostLoadsView({ smembers: async () => { throw new Error("no"); }, mget: async () => [] }, { now: () => NOW, readHosts: async () => ({ hosts: [{ name: "mini1" }, { name: "mini2" }] }) });
  const read = triggerGetsOf({ trigger: COMMENT, hostLoads: down, liveHosts: ["mini1", "mini2"] });
  assert.deepEqual(read.pills.map((pill) => pill.word), ["unknown", "unknown"]);
  assert.deepEqual(read.hostsNote, [W.hostsUnread]);
  assert.deepEqual(triggerGetsOf({ trigger: COMMENT, hostLoads: null, liveHosts: [] }).hostsNote, [W.noHost]);
});

test("a part the trigger would not load from says nothing: a host cut there is no unknown, and its differences are no difference", async () => {
  const withheld = { ...COMMENT, packages: false };
  const a = { packages: PACKAGES, extensions: [] };
  const b = { packages: [{ name: "pi-lint", version: "1.4.3" }], extensions: [] };
  assert.equal((await pills({ a, b }, COMMENT)).a, "also pi-lint 1.4.2; without pi-lint 1.4.3");
  assert.deepEqual(await pills({ a, b }, withheld), { a: "the same", b: "the same" }, "a trigger that withholds the packages gets the same on both");
  assert.equal((await pills({ a, cut: { unread: ["packages"] } }, withheld)).cut, "the same", "what it cannot read is what this trigger leaves out");
  // The overlay's switch is the host's: off, its extensions do not load.
  const overlay = { extensions: [{ name: "git-guard", kind: "dir" }] };
  assert.deepEqual(await pills({ on: overlay, off: { ...overlay, overlayExtensionsAllowed: false } }), { on: "also git-guard, from its overlay", off: "without git-guard" });
  // A part only counts where this trigger would load from it.
  const shut = { overlayExtensionsAllowed: false, unread: ["extensions"] };
  assert.equal((await pills({ a: {}, shut })).shut, "the same", "a host's overlay extensions are off, so what it could not read of them reaches no job");
  assert.equal((await pills({ a: {}, blind: { unread: ["extensions"] } })).blind, "unknown");
  assert.equal((await pills({ a: {}, blind: { unread: ["mcp"] } })).blind, "the same", "this trigger names no server");
  assert.equal((await pills({ a: {}, blind: { unread: ["mcp"] } }, { ...COMMENT, mcp: ["linear"] })).blind, "unknown");
  assert.deepEqual(await pills({ a: {}, blind: { unread: ["mcp"] } }, { ...COMMENT, mcp: ["forge"] }), { a: "the same", blind: "the same" }, "`forge` is the job's own, on no host's list");
  assert.deepEqual(await pills({ a: { mcp: [{ name: "linear", transport: "http", where: "x.example", exposure: "codemode", enabled: false, keys: [] }] }, b: {} }, { ...COMMENT, mcp: ["linear"] }), { a: "the same", b: "the same" }, "a server off on a host is one its jobs do not get");
  // A server only counts when this trigger names it.
  const server = { mcp: [{ name: "linear", transport: "http", where: "x.example", exposure: "codemode", enabled: true, keys: [] }] };
  assert.deepEqual(await pills({ with: server, none: {} }), { with: "the same", none: "the same" }, "a server it does not name is no difference to it");
  assert.deepEqual(await pills({ with: server, none: {} }, { ...COMMENT, mcp: ["linear"] }), { with: "also linear", none: "without linear" });
  // Where the flow resolved is what its jobs get too, and a host with no answer for this flow does not count.
  const flow = (tier) => ({ flows: [{ trigger: 2, flow: "fix", tier, package: null, repo: "unknown" }] });
  assert.deepEqual(await pills({ a: flow("overlay"), b: flow("unknown") }), { a: "its flow from the overlay", b: "its flow in no tier a host can see" });
  assert.deepEqual(await pills({ a: flow("overlay"), b: {} }), { a: "the same", b: "the same" });
  assert.deepEqual(await pills({ a: { flows: [{ trigger: 9, flow: "fix", tier: "overlay", package: null, repo: "unknown" }] }, b: flow("unknown") }), { a: "the same", b: "the same" }, "another trigger's answer, for a flow of the same name, is not this one's");
  assert.deepEqual(await pills({ a: { flows: [{ trigger: 2, flow: "other", tier: "overlay", package: null, repo: "unknown" }] }, b: flow("unknown") }), { a: "the same", b: "the same" }, "a doctor run from before the flow changed has no answer for it");
});

test("a record says what that run had and the file what the next job gets: no word under a row reads as today's file", async () => {
  const clean = await recordThroughPipeline({ exit: { code: 0, reason: "stop" }, turnsOnLine: 3 });
  // The file names a server, and the run named none: the record must not say the trigger names none.
  const { last, quote } = quoted(clean, { ...COMMENT, mcp: ["linear"] });
  assert.ok(last.MCP.startsWith("Last run on mini1, gh-1c40: none"), last.MCP);
  assert.ok(last.MCP.includes("it named no server"), last.MCP);
  assert.doesNotMatch(last.MCP, /names no server/);
  assert.ok(quote.startsWith(W.fileSays), quote);
  // Withheld then, and the file loads them now.
  const { last: withheld } = quoted(S.leftOut());
  assert.ok(withheld.Extensions.includes("it withheld the staged packages"), withheld.Extensions);
  assert.doesNotMatch(withheld.Extensions, /withholds/);
  const noFlowWithheld = loadedRecord({ jobId: "gh-w1", loaded: loadedField({ flow: { tier: "none", package: null }, sources: [source("overlay"), source("repository"), source("trigger"), source("other")], leftOut: { tools: [], packages: true, overlayExtensions: false, restricted: false } }) });
  const said = quoted(noFlowWithheld).out.problems.Skills.rest;
  assert.ok(said.endsWith("That run withheld the staged packages."), said);
  // A run that named no flow, under a trigger that names one now.
  const flowless = loadedRecord({ jobId: "gh-w2", flow: null, loaded: loadedField({ flow: null }) });
  assert.ok(quoted(flowless).last.Skills.includes("it named no flow"));
  // The run page keeps its own words: there the sentence is about the trigger the record kept.
  assert.ok(triggerLastRun([clean]).quoted.rows.MCP.more.includes("it named"));
});

test("which run is quoted, and why, for every kind of record a trigger's history holds", async () => {
  const good = await recordThroughPipeline({ jobId: "gh-good", exit: { code: 0, reason: "stop" }, turnsOnLine: 3 });
  // Refused before its container: the worker's own record, no container, no exit code.
  const refused = S.refused();
  const { loaded: _gone, ...older } = S.everything();
  const cases = [
    { newest: refused, says: "Nothing loaded: it was refused before its container started." },
    { newest: { ...older, jobId: "gh-older" }, says: "Not recorded: an older release wrote this run’s record." },
    { newest: { ...S.absent() }, says: "Not recorded: this run’s runner did not say what it loaded." },
    { newest: { ...S.invalid() }, says: "Could not be read" },
    { newest: { ...S.noRoom() }, says: "Cut to fit" },
    { newest: { ...S.noAgent() }, says: "Nothing to load" },
    { newest: { ...S.everything(), jobId: "gh-newer", v: 2 }, says: "Written by a newer pi-dispatch" },
    { newest: await recordThroughPipeline({ jobId: "gh-early", stages: ["start"], exit: { code: 1, reason: "crash", message: "x" } }), says: "It stopped before anything loaded." },
  ];
  for (const { newest, says } of cases) {
    const out = triggerGetsOf({ trigger: COMMENT, records: [newest, good], liveHosts: [] });
    const quote = lineOf(out.quote);
    assert.ok(quote.includes("gh-good, its newest run that says what it loaded, had on mini1."), `${says}: ${quote}`);
    assert.ok(quote.includes(`The last it started, ${newest.jobId}: `) && quote.includes(says), `${says}: ${quote}`);
    assert.ok(lineOf(out.last.Model).includes("gh-good"), says);
    // And alone in the history, it has nothing to put under a row, and says that rather than a run it does not have.
    const alone = triggerGetsOf({ trigger: COMMENT, records: [newest], liveHosts: [] });
    assert.ok(lineOf(alone.quote).includes(says), says);
    assert.deepEqual(alone.last.Tools, [W.noRecord], says);
  }
  const newestGood = lineOf(triggerGetsOf({ trigger: COMMENT, records: [good, refused], liveHosts: [] }).quote);
  assert.ok(newestGood.includes("gh-good, its last run, had on mini1."), newestGood);
  assert.ok(!newestGood.includes("The last it started"), newestGood);
  const none = triggerGetsOf({ trigger: COMMENT, records: [], liveHosts: [] });
  assert.deepEqual(none.last.Model, [W.noRun]);
  // A history that could not be read is not a trigger with no runs.
  const unread = triggerGetsOf({ trigger: COMMENT, records: [], historyUnread: true, liveHosts: [] });
  assert.deepEqual(unread.last.Tools, [W.historyUnread]);
  assert.ok(lineOf(unread.quote).includes(W.historyUnread) && !lineOf(unread.quote).includes(W.noRun));
  assert.ok(lineOf(none.quote).includes(W.noRun));
  assert.ok(!JSON.stringify(none).includes("No run yet"), "a trigger whose runs aged out has had runs");
});

test("the pickers offer the catalog of the providers in use, bounded, and a person can still name anything else", () => {
  const catalog = ["anthropic/a", "anthropic/b", "openai/c", "kimi/d", "other/e", "x"];
  const m = triggerGetsOf({ trigger: { ...COMMENT, provider: "openai", models: ["kimi/d"] }, liveHosts: [], defaults: { provider: "anthropic", model: "a", maxCostUsd: "2", models: "unrestricted" }, modelChoices: catalog }).model;
  assert.deepEqual(m.refs, ["anthropic/a", "anthropic/b", "openai/c", "kimi/d"]);
  assert.deepEqual(m.models, ["a", "b", "c", "d"]);
  assert.deepEqual(m.providers, ["anthropic", "openai", "kimi", "other"], "any provider may be picked; only the models of those in use are listed");
  assert.equal(triggerGetsOf({ trigger: COMMENT, liveHosts: [], defaults: { provider: "anthropic" }, modelChoices: Array.from({ length: 900 }, (_, at) => `anthropic/m${at}`) }).model.refs.length, 200);
  assert.equal(triggerGetsOf({ trigger: { ...COMMENT, flow: "fix" }, liveHosts: [], editor: { flows: Array.from({ length: 900 }, (_, at) => ({ name: `s${at}`, tier: "overlay" })) } }).flow.choices.length, 200);
  // What a viewer reads, which is the same facts as words.
  const read = (trigger, defaults = {}) => triggerGetsOf({ trigger: { ...COMMENT, ...trigger }, liveHosts: [], defaults }).model.read;
  assert.equal(read({}, { provider: "anthropic", model: "a", maxCostUsd: "2" }), "the deployment’s model, anthropic / a · any model allowed · no fallback · the deployment’s $2 cap");
  assert.equal(read({ provider: "kimi", model: "k", models: ["kimi/k"], fallbackModels: ["kimi/l"], maxCostUsd: "1.5" }), "kimi / k · allowed: kimi/k · fallbacks: kimi/l · $1.5 cap");
  assert.equal(read({}, { models: ["a/b"] }), "the deployment’s model · the deployment’s allowed list · no fallback · no cap");
  // What the deployment's cap and list mean, or that it has none.
  const none = triggerGetsOf({ trigger: COMMENT, liveHosts: [], defaults: {} }).model;
  assert.equal(none.capHint, "Blank means no cap of its own, and the deployment sets none.");
  assert.equal(none.allowedNone, "Any model is allowed.");
  assert.equal(triggerGetsOf({ trigger: COMMENT, liveHosts: [], defaults: { models: ["a/b"] } }).model.allowedNone, "The deployment’s list applies: a/b.");
});

test("the image row: each host's own, what the file names instead, and unknown where nothing beats", async () => {
  const loads = await published({ a: {}, b: {} });
  assert.equal(lineOf(triggerGetsOf({ trigger: COMMENT, hostLoads: loads, liveHosts: ["a", "b"] }).image.words), "pi-job:4.3.1 with pi 1.5.0 on a and b");
  assert.equal(lineOf(triggerGetsOf({ trigger: { ...COMMENT, image: "pi-job:4.3.1" }, hostLoads: loads, liveHosts: ["a", "b"] }).image.words), "pi-job:4.3.1, as run.image names it, with pi 1.5.0");
  assert.equal(lineOf(triggerGetsOf({ trigger: { ...COMMENT, image: "mine:1" }, hostLoads: loads, liveHosts: ["a", "b"] }).image.words), "mine:1, as run.image names it", "a host's pi is of its own image");
  assert.equal(lineOf(triggerGetsOf({ trigger: COMMENT, hostLoads: { unreachable: true, hosts: [] }, liveHosts: ["z"] }).image.words), "unknown on z");
  assert.equal(lineOf(triggerGetsOf({ trigger: COMMENT, liveHosts: [] }).image.words), "each host’s own PI_JOB_IMAGE; no host says which");
});

test("where each extension is: a list cut short proves what is on it and no lack, and a record's counts are of its own version", async () => {
  const pkg = (name, version = "1.4.2") => ({ name, version });
  const wide = Array.from({ length: 70 }, (_, at) => pkg(`p${at}`));
  const loads = await published({ a: { packages: [pkg("pi-lint")] }, b: { packages: [pkg("pi-lint", "1.4.3")] }, wide: { packages: wide }, none: {}, silent: null });
  const item = (name, records = []) => triggerGetsOf({ trigger: COMMENT, hostLoads: loads, liveHosts: ["a", "b", "wide", "none", "silent"], records }).extensions.items.find((row) => row.name === name);
  assert.equal(item("pi-lint 1.4.2").sub, "staged on a, not on b and none, unknown on wide and silent");
  const record = loadedRecord({ jobId: "gh-r1", loaded: loadedField({ sources: [source("package", { name: "pi-lint", version: "1.4.3", extensions: 1, tools: 2, toolNames: ["lint_file", "lint_fix"] }), source("overlay"), source("repository"), source("trigger"), source("other")] }) });
  assert.ok(item("pi-lint 1.4.3", [record]).sub.endsWith("2 tools, as gh-r1 loaded it"));
  assert.ok(!item("pi-lint 1.4.2", [record]).sub.includes("gh-r1"), "what 1.4.3 brought says nothing of 1.4.2");
  const off = await published({ a: { extensions: [{ name: "git-guard", kind: "dir" }], overlayExtensionsAllowed: false } });
  assert.equal(triggerGetsOf({ trigger: COMMENT, hostLoads: off, liveHosts: ["a"] }).extensions.items[0].sub, "in the overlay on a · its overlay extensions off on a");
});
