// A person leaving an extension or its tool out of a trigger's jobs (issue #800, `run.excludeExtensions`, `run.excludeExtensionTools`), through the real planner, this
// build's real version tables, the real writer and the worker's own readers, on real files read back byte for byte. Nothing here injects a table: the earlier gate's
// tests did, so each sentence of the version gate is tried here on the path a host takes.
import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseAuthConnections } from "../../worker/src/auth-policy.mjs";
import { COMMUNITY_AUTH_ADAPTERS } from "../../worker/src/community-auth-metadata.mjs";
import { CAPABILITIES_LABEL, CAPABILITY_GATES } from "../../worker/src/image-preflight.mjs";
import { flowTierOf } from "@edgehero/pi-dispatch/host-loads";
import { extensionsNotHere, overlayEntryNamed } from "@edgehero/pi-dispatch/loaded-record";
import { loadSchedules } from "@edgehero/pi-dispatch/schedules";
import { TRIGGERS_FILE_VERSION, parseTriggers } from "@edgehero/pi-dispatch/triggers";
import { makeCheckWaitSkew } from "@edgehero/pi-dispatch/triggers-file";
import { agentReadProjection } from "../src/agent-read.mjs";
import { createFleetReader, normalizeTriggerForDisplay, readHosts, readTriggerSkew } from "../src/read-model.mjs";
import { triggerEntryDigest } from "../src/trigger-edit-core.mjs";
import { createTriggerEnvironmentActions } from "../src/trigger-environment-plans.mjs";
import { recordThroughPipeline } from "./helpers/loaded-pipeline.mjs";
import { LOADED_SAMPLES as S } from "./helpers/loaded-samples.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const operator = { surface: "console", role: "operator", name: "ops" };
const comment = (run = {}) => ({ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix", ...run } });
const FOLDER = tempDir("pd-800-exclude-folder-");
const cron = (run = {}) => ({ on: { type: "cron", id: "daily", pattern: "0 6 * * *" }, run: { kind: "local", folder: FOLDER, flow: "tidy", task: "Tidy it.", ...run } });
const writerText = (doc) => `${JSON.stringify(doc, null, 2)}\n`;
/** A host that reads what these two fields need, the triggers file at 2 and job data at 3, or one that reads `older` of each. */
const reads = (name, older = null) => ({ name, triggersVersion: older ?? "2", jobDataVersion: older ?? "3" });
const host = (name, over = {}) => ({ name, state: "current", overlayExtensionsAllowed: true, packages: [], extensions: [], skills: [], flows: [], mcp: [], unread: [], more: {}, ...over });
const PI_LINT = Object.freeze({ name: "pi-lint", version: "1.4.2" });
const FILE_GUARD = Object.freeze({ name: "git-guard.ts", kind: "file" });

function world({ text = null, doc = null, entry = comment(), loads = [host("mini1", { packages: [PI_LINT], extensions: [FILE_GUARD] })], live = ["mini1"], records = [], deps = {} } = {}) {
  const dir = tempDir("pd-800-exclude-");
  const paths = { triggersPath: join(dir, "triggers.json"), settingsFile: join(dir, "settings.json"), projectsFile: null, globalPiDir: join(dir, "overlay") };
  // A file that uses either field is stamped, as every writer stamps one: this helper writes what a host's own file holds.
  const narrows = entry.run.excludeExtensions !== undefined || entry.run.excludeExtensionTools !== undefined;
  nodeFs.writeFileSync(paths.triggersPath, text ?? writerText(doc ?? { ...(narrows ? { version: 2 } : {}), triggers: [cron(), entry] }));
  nodeFs.writeFileSync(paths.settingsFile, "{}");
  nodeFs.mkdirSync(paths.globalPiDir);
  const service = createTriggerEnvironmentActions({ paths, env: { PI_PROVIDER: "anthropic", PI_MODEL: "claude-haiku-4-5", PI_EGRESS: "0" }, now: () => NOW, deploymentDir: dir, readHosts: async () => ({ hosts: live.map((name) => reads(name)) }), readHostLoads: async () => ({ hosts: loads }), readRunRecords: async () => records, ...deps });
  const read = () => nodeFs.readFileSync(paths.triggersPath, "utf8");
  const raw = (index = 1) => JSON.parse(read()).triggers[index];
  const ask = (change, index = 1) => ({ index, pageDigest: triggerEntryDigest(raw(index)), ...change });
  const preview = (change, index = 1) => service.preview(ask(change, index), operator);
  const write = async (change, index = 1) => {
    const out = await preview(change, index);
    assert.ok(out.plan, JSON.stringify(out));
    assert.deepEqual(await service.apply(out, operator), { ok: true });
    return out;
  };
  const undo = async (out) => {
    const back = await service.preview(out.plan.inverse.body, operator);
    assert.ok(back.plan, JSON.stringify(back));
    assert.deepEqual(await service.apply(back, operator), { ok: true });
    return back;
  };
  return { paths, service, read, raw, ask, preview, write, undo };
}
const lineOf = (out, start) => out.summary.find((line) => line.startsWith(start));
/** What a change warns of, less the one line every change that first gives a job either list says, which has a test of its own below. */
const besideImage = (lines) => lines.filter((line) => !line.includes("job-image-load-exclusions-unsupported"));
const NO_LIVE_HOST = (names) => `No host is live right now, so no running host says whether it holds ${names}; the card's rows read what each one last published.`;

// ---- what a change says ------------------------------------------------------------------------------------------------

test("leaving an extension out says what comes off, and what a package takes with it, of a name that is whichever it is on each host", async () => {
  const out = await world().preview({ excludeExtensions: ["pi-lint", "git-guard"] });
  assert.deepEqual(out.plan.changes, [{ key: "excludeExtensions", line: "Extensions: pi-lint left out, git-guard left out." }]);
  assert.ok(out.summary.includes("Where a name is a staged package, its tools, skills, prompt templates and themes go with it. Where it is an overlay extension, its code does not run."));
});

test("an extension coming back is said as a widening, and under the file's false, as only what that leaves it", async () => {
  const w = world({ entry: comment({ excludeExtensions: ["pi-lint"] }), doc: null });
  const out = await w.preview({ excludeExtensions: null });
  assert.equal(out.plan.changes[0].line, "Extensions: pi-lint back on.");
  assert.equal(out.plan.changes[0].widening, "This widens what its jobs load: pi-lint back on each host that holds it.");
  assert.ok(!out.summary.some((line) => line.startsWith("Where a name is a staged package")), "nothing comes off");
  const off = await world({ entry: comment({ packages: false, excludeExtensions: ["pi-lint", "other"] }) }).preview({ excludeExtensions: ["other"] });
  assert.equal(off.plan.changes[0].widening, `This widens what its jobs load: pi-lint back on each host that holds it, as an overlay extension, since the file's "packages": false keeps staged packages out.`);
  const two = await world({ entry: comment({ excludeExtensions: ["pi-lint", "git-guard"] }) }).preview({ excludeExtensions: null });
  assert.equal(two.plan.changes[0].widening, "This widens what its jobs load: pi-lint and git-guard back on each host that holds them.");
});

test("a name taken off beside another that means one of its entries: never \"back on\" alone, and the runner's rule says what stays out", async () => {
  const held = [host("mini1", { extensions: [FILE_GUARD] }), host("mini2", { extensions: [FILE_GUARD, { name: "git-guard.js", kind: "file" }] })];
  const both = () => world({ entry: comment({ excludeExtensions: ["git-guard", "git-guard.ts"] }), loads: held, live: ["mini1", "mini2"] });
  const short = await both().preview({ excludeExtensions: ["git-guard.ts"] });
  assert.deepEqual(short.plan.changes, [{ key: "excludeExtensions", line: "Extensions: git-guard off the list.", widening: "This widens what its jobs load: git-guard back on each host that holds it, less what git-guard.ts still leaves out." }]);
  // What a job does with the list as it will be: on mini1 nothing comes back, and on mini2 the entry only the first name meant does.
  assert.deepEqual(short.plan.inverse.body.excludeExtensions, ["git-guard", "git-guard.ts"], "the way back is the list as it was");
  const out = (list, segment) => list.some((name) => overlayEntryNamed(name, segment));
  assert.equal(out(["git-guard.ts"], "git-guard.ts"), true, "still out");
  assert.equal(out(["git-guard.ts"], "git-guard.js"), false, "back");
  const long = await both().preview({ excludeExtensions: ["git-guard"] });
  assert.deepEqual(long.plan.changes, [{ key: "excludeExtensions", line: "Extensions: git-guard.ts off the list.", widening: "This widens what its jobs load: git-guard.ts back on each host that holds it, less what git-guard still leaves out." }]);
  // Both taken off: nothing is left to take them, so the plain words are true again.
  const gone = await both().preview({ excludeExtensions: null });
  assert.deepEqual(gone.plan.changes, [{ key: "excludeExtensions", line: "Extensions: git-guard back on, git-guard.ts back on.", widening: "This widens what its jobs load: git-guard and git-guard.ts back on each host that holds them." }]);
  // Under the file's false, both clauses, each still true.
  const off = await world({ entry: comment({ packages: false, excludeExtensions: ["git-guard", "git-guard.ts"] }), loads: held, live: ["mini1", "mini2"] }).preview({ excludeExtensions: ["git-guard.ts"] });
  assert.equal(off.plan.changes[0].widening, `This widens what its jobs load: git-guard back on each host that holds it, as an overlay extension, since the file's "packages": false keeps staged packages out, less what git-guard.ts still leaves out.`);
  // Three names, two of them left: each said once, and in the plural.
  const three = await world({ entry: comment({ excludeExtensions: ["a", "a.ts", "a.js"] }), loads: [host("mini1", { extensions: [{ name: "a.ts", kind: "file" }, { name: "a.js", kind: "file" }] })] }).preview({ excludeExtensions: ["a.ts", "a.js"] });
  assert.equal(three.plan.changes[0].widening, "This widens what its jobs load: a back on each host that holds it, less what a.ts and a.js still leave out.");
  const twoOff = await world({ entry: comment({ excludeExtensions: ["a", "a.ts", "a.js"] }), loads: [host("mini1", { extensions: [{ name: "a.ts", kind: "file" }, { name: "a.js", kind: "file" }] })] }).preview({ excludeExtensions: ["a"] });
  assert.equal(twoOff.plan.changes[0].widening, "This widens what its jobs load: a.ts and a.js back on each host that holds them, less what a still leaves out.", "the one name that stays, said once");
});

test("staged packages back on over a list of names says the list still holds", async () => {
  const out = await world({ entry: comment({ packages: false, excludeExtensions: ["pi-lint"] }) }).preview({ packages: null });
  assert.equal(out.plan.changes[0].widening, "This widens what its jobs load: every package staged on the host that runs them, less what run.excludeExtensions leaves out.");
  const plain = await world({ entry: comment({ packages: false }) }).preview({ packages: null });
  assert.equal(plain.plan.changes[0].widening, "This widens what its jobs load: every package staged on the host that runs them.");
});

test("a tool off and a tool back on, the second a widening; a reorder and the same list are not changes to a job", async () => {
  const w = world({ entry: comment({ excludeExtensionTools: ["lint_fix", "lint_file"] }), records: [S.everything()] });
  const out = await w.preview({ excludeExtensionTools: ["lint_file", "run_tests"] });
  assert.equal(out.plan.changes[0].line, "Extension tools: run_tests off, lint_fix on.");
  assert.equal(out.plan.changes[0].widening, "This widens what its jobs can do: lint_fix back on, wherever something a job loads brings it.");
  const order = await w.preview({ excludeExtensionTools: ["lint_file", "lint_fix"] });
  assert.equal(order.plan.changes[0].line, "Extension tools: the same removals in a new order.");
  assert.equal(order.plan.changes[0].widening, undefined);
  assert.match((await w.preview({ excludeExtensionTools: ["lint_fix", "lint_file"] })).unchanged, /already says this/);
  const names = world({ entry: comment({ excludeExtensions: ["b", "a"] }), loads: [host("mini1", { packages: [{ name: "a", version: "1.0.0" }, { name: "b", version: "1.0.0" }] })] });
  assert.equal((await names.preview({ excludeExtensions: ["a", "b"] })).plan.changes[0].line, "Extensions: the same names left out, in a new order.");
});

test("a value the loader refuses is the funnel's to name, in the loader's words, with nothing written", async () => {
  for (const [change, words] of [
    [{ excludeExtensionTools: ["bash"] }, /one of pi's own tools, which this key does not take: run\.excludeTools removes pi's/],
    [{ excludeExtensionTools: ["report_progress"] }, /the name of a tool pi-dispatch gives some jobs/],
    [{ excludeExtensionTools: ["mcp__x__*"] }, /is not a tool's name/],
    [{ excludeExtensions: ["has space"] }, /is neither a package's manifest name nor an overlay extension's/],
    [{ excludeExtensions: [] }, /must be a non-empty array/],
    [{ excludeExtensions: ["a", "a"] }, /names "a" twice/],
    [{ excludeExtensionTools: Array.from({ length: 17 }, (_, at) => `tool_${at}`) }, /names 17, and it takes at most 16/],
  ]) {
    const w = world();
    const before = w.read();
    const out = await w.preview(change);
    assert.match(out.refusal, words, JSON.stringify(change));
    assert.equal(w.read(), before);
  }
  assert.match((await world().preview({ excludeExtensions: "pi-lint" })).refusal, /excludeExtensions must be a list of names, or null to remove it/);
  assert.match((await world().preview({ excludeExtensionTools: [1] })).refusal, /excludeExtensionTools must be a list of names, or null to remove it/);
});

// ---- a name on no host ---------------------------------------------------------------------------------------------------

test("a name every live host answers for and none holds refuses, with nothing written, and each of the host's own spellings counts as held", async () => {
  const loads = [host("a", { packages: [PI_LINT] }), host("b", { extensions: [FILE_GUARD, { name: "folder-ext", kind: "dir" }] })];
  const w = world({ loads, live: ["a", "b"] });
  const before = w.read();
  const out = await w.preview({ excludeExtensions: ["pi-linter"] });
  assert.equal(out.refusal, "No live host holds pi-linter, as each one's last doctor run published it, so leaving it out would keep nothing out. Check the name, or run pi-dispatch doctor on the host that has it.");
  assert.equal(w.read(), before);
  assert.match((await w.preview({ excludeExtensions: ["pi-lint", "x", "y"] })).refusal, /^No live host holds x and y, .*leaving them out/);
  for (const name of ["pi-lint", "git-guard", "git-guard.ts", "folder-ext"]) {
    const held = await w.preview({ excludeExtensions: [name] });
    assert.ok(held.plan, `${name}: ${JSON.stringify(held)}`);
    assert.ok(!held.summary.some((line) => line.includes("that can say")), name);
    // The planner's reading of a name is the worker's own.
    assert.deepEqual(extensionsNotHere([name], { packages: [PI_LINT], overlay: [FILE_GUARD.name, "folder-ext"] }), [], name);
  }
  assert.deepEqual(extensionsNotHere(["pi-linter"], { packages: [PI_LINT], overlay: [FILE_GUARD.name] }), ["pi-linter"], "and the worker says the refused name is not there");
});

test("a host with its overlay switched off still holds what is in it, as the worker reads it", async () => {
  const out = await world({ loads: [host("a", { extensions: [FILE_GUARD], overlayExtensionsAllowed: false })], live: ["a"] }).preview({ excludeExtensions: ["git-guard"] });
  assert.ok(out.plan, JSON.stringify(out));
});

for (const [what, row] of [
  ["published nothing", { name: "silent", state: "unknown", why: "absent" }],
  ["whose record could not be read", { name: "silent", state: "unknown", why: "unreadable" }],
  ["whose record is old", host("silent", { state: "old" })],
  ["whose packages it could not read", host("silent", { unread: ["packages"] })],
  ["whose overlay it could not read", host("silent", { unread: ["extensions"] })],
  ["whose list of packages was cut", host("silent", { more: { packages: 3 } })],
  ["whose list of overlay entries was cut", host("silent", { more: { extensions: 1 } })],
]) {
  test(`beside a host ${what}, a name no host that answered holds warns and does not refuse`, async () => {
    const w = world({ loads: [host("mini1", { packages: [PI_LINT] }), row], live: ["mini1", "silent"] });
    const out = await w.preview({ excludeExtensions: ["pi-linter"] });
    assert.ok(out.plan, JSON.stringify(out));
    assert.ok(out.plan.warnings.includes("No host that can say holds pi-linter, and silent reads unknown. A name no host holds leaves nothing out, so check it."), JSON.stringify(out.plan.warnings));
    assert.deepEqual(await w.service.apply(out, operator), { ok: true });
    assert.ok(!(await world({ loads: [host("mini1", { packages: [PI_LINT] }), row], live: ["mini1", "silent"] }).preview({ excludeExtensions: ["pi-lint"] })).plan.warnings.some((line) => line.includes("that can say")), "a name a host holds is no question, whoever else cannot say");
  });
}

test("a package missing on one host: nothing to refuse, and nothing loads for it there; a tool it brings stops only the job that held nothing back", async () => {
  const loads = [host("a", { packages: [PI_LINT] }), host("b")];
  const left = await world({ loads, live: ["a", "b"] }).preview({ excludeExtensions: ["pi-lint"] });
  assert.ok(left.plan, JSON.stringify(left));
  assert.deepEqual(besideImage(left.plan.warnings), [], "held on one host: no question of the name");
  assert.deepEqual(extensionsNotHere(["pi-lint"], { packages: [PI_LINT], overlay: [] }), [], "a");
  assert.deepEqual(extensionsNotHere(["pi-lint"], { packages: [], overlay: [] }), ["pi-lint"], "b: the worker's record says so, and the job runs");
  // The tool's half: its sentence is of whichever host a job lands on, and it names no host, since the page cannot see which brings it.
  const tool = await world({ loads, live: ["a", "b"], records: [S.everything()] }).preview({ excludeExtensionTools: ["lint_file"] });
  assert.deepEqual(besideImage(tool.plan.warnings), ["A job that reaches its container with nothing held back from it, no parent job and every extension loaded stops before its prompt as exclude-tool-not-loaded if no staged package or overlay extension registered lint_file when it loaded."]);
});

test("an old record is no proof a host holds a name, as it is no proof it lacks one", async () => {
  const out = await world({ loads: [host("mini1"), host("old", { state: "old", packages: [PI_LINT] })], live: ["mini1", "old"] }).preview({ excludeExtensions: ["pi-lint"] });
  assert.ok(out.plan.warnings.includes("No host that can say holds pi-lint, and old reads unknown. A name no host holds leaves nothing out, so check it."), JSON.stringify(out.plan.warnings));
});

test("a live host with no row at all cannot say, a stopped host's row does not count, and no live host or no read at all warns in its own words", async () => {
  const noRow = await world({ loads: [host("mini1")], live: ["mini1", "mini2"] }).preview({ excludeExtensions: ["pi-linter"] });
  assert.ok(noRow.plan.warnings.includes("No host that can say holds pi-linter, and mini2 reads unknown. A name no host holds leaves nothing out, so check it."));
  const stopped = await world({ loads: [host("mini1"), host("stopped", { packages: [{ name: "pi-linter", version: "1.0.0" }] })], live: ["mini1"] }).preview({ excludeExtensions: ["pi-linter"] });
  assert.match(stopped.refusal, /^No live host holds pi-linter/, "the hosts that can run its jobs are the question");
  const none = await world({ loads: [], live: [] }).preview({ excludeExtensions: ["pi-linter"] });
  assert.ok(none.plan.warnings.includes(NO_LIVE_HOST("pi-linter")));
  for (const readHostLoads of [async () => ({ unreachable: true, hosts: [{ name: "mini1", state: "unknown", why: "unreachable" }] }), async () => { throw new Error("down"); }, async () => null]) {
    const unread = await world({ deps: { readHostLoads } }).preview({ excludeExtensions: ["pi-linter"] });
    assert.ok(unread.plan, JSON.stringify(unread));
    assert.ok(unread.plan.warnings.includes("What the hosts published could not be read, so which of them hold pi-linter is unknown."), JSON.stringify(unread.plan.warnings));
  }
});

test("only a name this change adds is asked about: one the file already holds is the file's, and doctor's to warn of", async () => {
  const w = world({ entry: comment({ excludeExtensions: ["ghost"] }) });
  const out = await w.preview({ flow: "review" });
  assert.ok(out.plan, JSON.stringify(out));
  assert.deepEqual(out.plan.warnings.filter((line) => line.includes("ghost")), []);
  const more = await w.preview({ excludeExtensions: ["ghost", "pi-lint"] });
  assert.ok(more.plan, JSON.stringify(more));
});

test("taking a name no host holds back out previews, and its Undo is said by hand, since the page would refuse to write that name again", async () => {
  const w = world({ entry: comment({ excludeExtensions: ["ghost"] }) });
  const out = await w.preview({ excludeExtensions: null });
  assert.ok(out.plan, JSON.stringify(out));
  assert.equal(out.plan.inverse, null);
  assert.match(out.plan.undo, /^Edit trigger row 2 back by hand: this page would refuse what it said before\. No live host holds ghost/);
  // A host that holds it, or one that cannot say, leaves the button: the Undo's own preview then takes it.
  const held = await world({ entry: comment({ excludeExtensions: ["pi-lint"] }) }).preview({ excludeExtensions: null });
  assert.ok(held.plan.inverse);
  const unknown = await world({ entry: comment({ excludeExtensions: ["ghost"] }), deps: { readHostLoads: async () => { throw new Error("down"); } } }).preview({ excludeExtensions: null });
  assert.ok(unknown.plan.inverse, "a read that failed says no name is on no host");
});

// ---- exclusions meet the other fields --------------------------------------------------------------------------------------

test("a package that is doctor's only answer for the flow warns, of each real shape that holds it, in the flow's own words", async () => {
  const row = (tier, pkg, repo = "unknown", flow = "fix", trigger = 1) => ({ flows: [{ trigger, flow, tier, package: pkg, repo }] });
  const say = (name) => `${name}, which this change leaves out. A job there runs without its flow unless something else it loads holds it, such as its repository.`;
  const lost = async (loads, change = { excludeExtensions: ["pi-lint"] }, entry = comment()) => (await world({ entry, loads, live: loads.map((h) => h.name) }).preview(change)).plan.warnings.filter((line) => line.includes("which this change leaves out"));
  assert.deepEqual(await lost([host("a", { packages: [PI_LINT], ...row("package", "pi-lint") }), host("b", { packages: [PI_LINT], ...row("package", "pi-lint") })]), [`a and b find fix in ${say("pi-lint")}`]);
  assert.deepEqual(await lost([host("a", { packages: [PI_LINT], ...row("package", "pi-lint") }), host("b", { packages: [PI_LINT], ...row("repository", null, "present") })]), [`a finds fix in ${say("pi-lint")}`], "a host that finds it higher up is not named");
  assert.deepEqual(await lost([host("a", { packages: [PI_LINT], ...row("overlay", null) })]), [], "a tier above the packages holds it");
  assert.deepEqual(await lost([host("a", { packages: [PI_LINT], ...row("package", "other") })]), [], "another package holds it");
  assert.deepEqual(await lost([host("a", { packages: [PI_LINT], ...row("package", "pi-lint", "unknown", "other") })]), [], "another flow's answer");
  assert.deepEqual(await lost([host("a", { packages: [PI_LINT], ...row("package", "pi-lint", "unknown", "fix", 7) })]), [], "another row's answer");
  assert.deepEqual(await lost([host("a", { state: "old", packages: [PI_LINT], ...row("package", "pi-lint") }), host("b", { packages: [PI_LINT] })]), [], "an old record says nothing");
  assert.deepEqual(await lost([host("a", { packages: [PI_LINT], ...row("package", "pi-lint") })], { excludeExtensions: ["pi-lint"], packages: false }), [], "it was withheld in the same change");
  assert.deepEqual(await lost([host("a", { packages: [PI_LINT], ...row("package", "pi-lint") })], { excludeExtensions: ["pi-lint"] }, comment({ packages: false })), [], "or before it");
  assert.deepEqual(await lost([host("a", { packages: [PI_LINT], ...row("package", "pi-lint") })], { excludeExtensions: ["pi-lint"] }, { on: { type: "comment", phrase: "@pi" }, run: { kind: "github", command: "ship" } }), [], "a command names no flow");
  assert.deepEqual(await lost([host("a", { packages: [PI_LINT], ...row("package", "pi-lint") })], { excludeExtensions: ["pi-lint"], flow: "review" }), [], "the flow moved away from it in the same change");
  // The tier the warning reads is first-hit: what doctor would say with the name in the file, the worker's own function.
  const staged = { skills: [{ name: "fix", package: "pi-lint" }], unenumerable: [] };
  const seams = { repoFlowAtHead: async () => "absent", fileExists: () => false, overlay: "/o", staged };
  assert.equal((await flowTierOf({ flow: "fix", folder: "/r" }, seams)).package, "pi-lint");
  assert.equal((await flowTierOf({ flow: "fix", folder: "/r", excludeExtensions: ["pi-lint"] }, seams)).tier, "none");
});

test("a new flow only an excluded package holds reads as a host without it, which it did not while the package still loaded", async () => {
  const loads = [host("a", { packages: [PI_LINT], flows: [{ trigger: 0, flow: "review", tier: "package", package: "pi-lint", repo: "unknown" }] })];
  const named = (out) => out.plan.warnings.filter((line) => line.startsWith("a has no skill named review"));
  assert.equal(named(await world({ loads, live: ["a"], entry: comment({ excludeExtensions: ["pi-lint"] }) }).preview({ flow: "review" })).length, 1);
  assert.equal(named(await world({ loads, live: ["a"] }).preview({ flow: "review" })).length, 0);
});

test("a tool chip off: the sentence says what a job that held nothing back does, and only such a job, and how that reads on the file's own shapes", async () => {
  const records = [S.everything()];
  const strict = "A job that reaches its container with nothing held back from it, no parent job and every extension loaded stops before its prompt as exclude-tool-not-loaded if no staged package or overlay extension registered lint_file when it loaded.";
  const reported = "A name in run.excludeExtensionTools that no staged package or overlay extension brought stops no job of this trigger while it holds extensions back: the job runs, and its log and record name it, so a misspelled name removes nothing.";
  const asked = async (entry, change) => besideImage((await world({ entry, records }).preview(change)).plan.warnings);
  assert.deepEqual(await asked(comment(), { excludeExtensionTools: ["lint_file"] }), [strict]);
  assert.deepEqual(await asked(comment({ packages: false }), { excludeExtensionTools: ["lint_file"] }), [], "a name a run shows, and a trigger that cannot stop over it");
  assert.deepEqual(await asked(comment({ excludeExtensions: ["other"] }), { excludeExtensionTools: ["lint_file"] }), []);
  // A name no run shows.
  const cannot = "No run of this trigger this page can read names lint_typo, so it cannot confirm that name.";
  assert.deepEqual(await asked(comment(), { excludeExtensionTools: ["lint_typo"] }), [cannot, strict.replace("lint_file", "lint_typo")]);
  assert.deepEqual(await asked(comment({ packages: false }), { excludeExtensionTools: ["lint_typo"] }), [cannot, reported]);
  assert.deepEqual(await asked(comment({ excludeExtensions: ["other"] }), { excludeExtensionTools: ["lint_typo"] }), [cannot, reported]);
  // The change is what moves the stop: on, for every name it holds, and off.
  assert.deepEqual(await asked(comment({ packages: false, excludeExtensionTools: ["lint_file", "lint_fix"] }), { packages: null }), ["A job that reaches its container with nothing held back from it, no parent job and every extension loaded stops before its prompt as exclude-tool-not-loaded if no staged package or overlay extension registered one of lint_file and lint_fix when it loaded."]);
  assert.deepEqual(await asked(comment({ excludeExtensions: ["pi-lint"], excludeExtensionTools: ["lint_file"] }), { excludeExtensions: null }), [strict]);
  assert.deepEqual(await asked(comment({ excludeExtensionTools: ["lint_file"] }), { packages: false }), [reported]);
  assert.deepEqual((await asked(comment({ excludeExtensionTools: ["lint_file"] }), { excludeExtensions: ["pi-lint"] })).filter((line) => line.includes("run.excludeExtensionTools")), [reported]);
  // Nothing moved it, nothing to say.
  assert.deepEqual(await asked(comment({ excludeExtensionTools: ["lint_file"] }), { excludeTools: ["bash"] }), []);
  assert.deepEqual(await asked(comment({ excludeExtensionTools: ["lint_file"] }), { excludeExtensionTools: null }), [], "a name off the list stops nothing");
  assert.deepEqual(await asked(comment({ excludeExtensionTools: ["lint_file", "lint_fix"] }), { excludeExtensionTools: ["lint_file"] }), []);
  // Two names, in the sentence that is true of either.
  assert.deepEqual(await asked(comment(), { excludeExtensionTools: ["lint_file", "lint_fix"] }), ["A job that reaches its container with nothing held back from it, no parent job and every extension loaded stops before its prompt as exclude-tool-not-loaded if no staged package or overlay extension registered one of lint_file and lint_fix when it loaded."]);
});

test("a run's record is what confirms a name, and a read that cannot say confirms nothing and costs no preview", async () => {
  const seen = async (deps) => (await world({ deps }).preview({ excludeExtensionTools: ["lint_file"] })).plan.warnings.some((line) => line.startsWith("No run of this trigger this page can read names lint_file"));
  assert.equal(await seen({ readRunRecords: async () => [S.everything()] }), false);
  for (const readRunRecords of [async () => [], async () => null, async () => undefined, async () => { throw new Error("down"); }, async () => [S.refused()], () => new Promise(() => {})]) {
    assert.equal(await seen({ readRunRecords, jobsReadMs: 5 }), true);
  }
  // Asked only for a name this change adds.
  let asked = 0;
  await world({ entry: comment({ excludeExtensionTools: ["lint_file"] }), deps: { readRunRecords: async () => { asked += 1; return []; } } }).preview({ packages: false });
  assert.equal(asked, 0);
});

test("what a preview says of an adapter is of the name a job leaves out, read through the real policy parser: the package, never the policy's key", async () => {
  // Every reviewed community adapter: a connection on it parses, and the name that keeps its package out of a job is the one the sentence is said of.
  const community = Object.entries(COMMUNITY_AUTH_ADAPTERS).filter(([, row]) => row.community === true);
  assert.ok(community.length >= 2, "the reviewed adapters");
  for (const [key, row] of community) {
    const policy = parseAuthConnections({ version: 1, connections: [{ id: "sub", provider: row.provider, adapter: key, ownerHost: "mini1", root: "/srv/auth", digest: "a".repeat(64) }], bindings: { [row.provider]: "sub" } });
    const name = COMMUNITY_AUTH_ADAPTERS[policy.connections[0].adapter].package;
    assert.equal(name, row.package, key);
    assert.notEqual(name, key, "the policy's key is not a name a file leaves out");
    const said = `${name} is a subscription connection's adapter, so a job on that connection is refused as auth-adapter-disabled, before it spends.`;
    const out = await world({ loads: [host("mini1", { packages: [{ name, version: row.version }] })] }).preview({ excludeExtensions: [name] });
    assert.ok(out.plan.warnings.includes(said), JSON.stringify(out.plan.warnings));
    // The key, with its version in it, is no name a file can hold, so the sentence cannot be said of it.
    assert.match((await world().preview({ excludeExtensions: [key] })).refusal, /is neither a package's manifest name nor an overlay extension's/, key);
  }
  // An adapter with no package of its own has nothing a file could leave out.
  const own = Object.entries(COMMUNITY_AUTH_ADAPTERS).filter(([, row]) => row.community !== true);
  assert.ok(own.every(([, row]) => row.package === undefined), "the built-in adapters have no package");
});

test("an image: said once, where this change starts asking it of a job, and of no host in particular, and what it says is what the real gate does", async () => {
  const said = (out) => out.plan.warnings.filter((line) => line.includes("job-image-load-exclusions-unsupported"));
  const SENTENCE = "A job of this trigger on an image whose dev.pi-dispatch.capabilities label does not list loadExclusions is refused as job-image-load-exclusions-unsupported, before it spends. The Image row says which image each host runs.";
  assert.deepEqual(said(await world().preview({ excludeExtensions: ["pi-lint"] })), [SENTENCE], "either field");
  assert.deepEqual(said(await world().preview({ excludeExtensionTools: ["lint_file"] })), [SENTENCE]);
  assert.deepEqual(said(await world({ entry: comment({ excludeExtensionTools: ["lint_file"] }) }).preview({ excludeExtensions: ["pi-lint"] })), [], "a job that had one already met this");
  assert.deepEqual(said(await world({ entry: comment({ excludeExtensions: ["pi-lint"] }) }).preview({ excludeExtensions: ["pi-lint", "git-guard"] })), []);
  assert.deepEqual(said(await world({ entry: comment({ excludeExtensions: ["pi-lint"] }) }).preview({ excludeExtensions: null })), [], "taking it off needs nothing of an image");
  assert.deepEqual(said(await world().preview({ flow: "review" })), [], "neither field");
  // No live host, and a host's name nowhere in it.
  assert.deepEqual(said(await world({ live: [], loads: [] }).preview({ excludeExtensions: ["pi-lint"] })), [SENTENCE]);
  // The sentence's words are the gate's: its token, its reason, its label, and when the worker asks.
  const gate = CAPABILITY_GATES.find((row) => row.token === "loadExclusions");
  assert.ok(SENTENCE.includes(gate.reason) && SENTENCE.includes(gate.token) && SENTENCE.includes(CAPABILITIES_LABEL));
  for (const job of [{}, { excludeTools: ["bash"] }, { excludeExtensions: ["a"] }, { excludeExtensionTools: ["b"] }, { excludeExtensions: ["a"], excludeExtensionTools: ["b"] }]) {
    const out = await world({ entry: comment(job) }).preview({ flow: "review" });
    assert.ok(out.plan, JSON.stringify(out));
    const carries = job.excludeExtensions !== undefined || job.excludeExtensionTools !== undefined;
    assert.equal(gate.needed(job), carries, JSON.stringify(job));
  }
  // And what the worker does with such an image, through the real gate and the real record.
  for (const jobFields of [{ excludeExtensions: ["pi-lint"] }, { excludeExtensionTools: ["lint_run"] }]) {
    const refused = await recordThroughPipeline({ exit: { code: 0, reason: "stop" }, hostImage: "pi-job:old", jobFields });
    assert.equal(refused.reason, gate.reason);
    assert.equal(refused.budgetReserved, false, "before it spends");
    const fine = await recordThroughPipeline({ exit: { code: 0, reason: "stop" }, hostImage: "pi-job:new", imageCapabilities: gate.token, jobFields });
    assert.equal(fine.outcome, "completed");
  }
});

test("a subscription's adapter left out says what the worker refuses, and a canary's package on a schedule says the same, each free", async () => {
  const adapter = Object.values(COMMUNITY_AUTH_ADAPTERS).find((row) => row.package !== undefined).package;
  const out = await world({ loads: [host("mini1", { packages: [{ name: adapter, version: "1.0.0" }] })] }).preview({ excludeExtensions: [adapter] });
  assert.ok(out.plan, JSON.stringify(out));
  assert.ok(out.plan.warnings.includes(`${adapter} is a subscription connection's adapter, so a job on that connection is refused as auth-adapter-disabled, before it spends.`), JSON.stringify(out.plan.warnings));
  assert.ok(!(await world().preview({ excludeExtensions: ["pi-lint"] })).plan.warnings.some((line) => line.includes("auth-adapter-disabled")));
  const canary = "A package canary of pi-lint run as this trigger from now on is refused as package-canary-excluded, before it spends.";
  const schedule = await world().preview({ excludeExtensions: ["pi-lint"] }, 0);
  assert.ok(schedule.plan, JSON.stringify(schedule));
  assert.ok(schedule.plan.warnings.includes(canary), JSON.stringify(schedule.plan.warnings));
  assert.ok(!(await world().preview({ excludeExtensions: ["pi-lint"] })).plan.warnings.some((line) => line.includes("package canary")), "only a schedule runs a canary");
  assert.ok(!(await world().preview({ excludeExtensions: ["git-guard"] }, 0)).plan.warnings.some((line) => line.includes("package canary")), "an overlay entry is no canary's package");
});

// ---- the version gate, on this build's tables ----------------------------------------------------------------------------

test("a file with neither field reads no host and keeps its bytes: on a mixed fleet, nothing about it moves", async () => {
  const w = world({ deps: { readHosts: async () => assert.fail("no host is read") } });
  const out = await w.write({ flow: "review" });
  assert.deepEqual(out.plan.need, { triggersVersion: 1, jobDataVersion: 1 });
  assert.equal(JSON.parse(w.read()).version, undefined);
  assert.ok(!out.summary.some((line) => /version \d/.test(line)), out.summary.join("\n"));
});

for (const [key, value] of [["excludeExtensions", ["pi-lint"]], ["excludeExtensionTools", ["lint_file"]]]) {
  test(`${key}: a file at version 1 gains the stamp first, and an Undo leaves its bytes as they were`, async () => {
    const w = world({ records: [S.everything()] });
    const before = w.read();
    assert.equal(JSON.parse(before).version, undefined);
    const out = await w.write({ [key]: value });
    assert.deepEqual(out.plan.need, { triggersVersion: 2, jobDataVersion: 3 });
    assert.ok(out.summary.includes("Stamps the file version 2: a host reading less waits on every trigger's jobs, not only this one's."), out.summary.join("\n"));
    assert.ok(out.summary.includes("mini1 reads what this change needs."));
    const stamped = w.read();
    assert.deepEqual(Object.keys(JSON.parse(stamped)), ["version", "triggers"], "first in the file");
    assert.equal(JSON.parse(stamped).version, TRIGGERS_FILE_VERSION);
    const trail = parseTriggers(stamped, "t")[1].run;
    assert.deepEqual(trail[key], value, "and the loader keeps it");
    assert.equal(out.plan.undo, "Put trigger row 2 back as it was");
    const back = await w.undo(out);
    assert.ok(back.summary.includes("The file no longer needs version 2, so this write takes the stamp off."), back.summary.join("\n"));
    assert.deepEqual(back.plan.need, { triggersVersion: 1, jobDataVersion: 1 });
    assert.equal(w.read(), before, "byte for byte");
  });

  test(`${key}: taking the last such field off takes the stamp off, and its Undo puts both back, byte for byte`, async () => {
    const w = world({ doc: { version: 2, triggers: [cron(), comment({ [key]: value, resume: true })] }, records: [S.everything()] });
    const before = w.read();
    const out = await w.write({ [key]: null });
    assert.equal(JSON.parse(w.read()).version, undefined);
    assert.ok(out.summary.includes("The file no longer needs version 2, so this write takes the stamp off."));
    assert.deepEqual(out.plan.need, { triggersVersion: 1, jobDataVersion: 1 });
    assert.deepEqual(out.plan.inverse.body.keyOrder, ["kind", "flow", key, "resume"], "the key goes back in its place");
    const back = await w.undo(out);
    assert.ok(back.summary.includes("Stamps the file version 2: a host reading less waits on every trigger's jobs, not only this one's."));
    assert.equal(w.read(), before, "byte for byte");
  });

  test(`${key}: a host on an older release, one with no version, or a registry that cannot be read refuses, with nothing written`, async () => {
    const refused = async (readHosts) => {
      const w = world({ deps: { readHosts } });
      const before = w.read();
      const out = await w.preview({ [key]: value });
      assert.equal(w.read(), before);
      return out;
    };
    assert.equal((await refused(async () => ({ hosts: [reads("mini1"), reads("mini2", "1")] }))).refusal, "This change needs the triggers file at version 2 and the job data at version 3. mini2 reads less, and would hold every job this file touches. Upgrade that host first.");
    assert.equal((await refused(async () => ({ hosts: [reads("mini1"), { name: "old" }] }))).refusal, "This change needs the triggers file at version 2 and the job data at version 3. old publishes no version, and would drop what it does not know, which can run a job wider on a clean record. Upgrade that host first.");
    // A host on a release that reads job data 2 reads a canary's job data, and neither of these: 2 is not enough, whatever it says of the file.
    assert.equal((await refused(async () => ({ hosts: [reads("mini1"), { name: "older", triggersVersion: "1", jobDataVersion: "2" }] }))).refusal, "This change needs the triggers file at version 2 and the job data at version 3. older reads less, and would hold every job this file touches. Upgrade that host first.");
    assert.match((await refused(async () => ({ hosts: [{ name: "half", triggersVersion: "2", jobDataVersion: "2" }] }))).refusal, /^This change needs the triggers file at version 2 and the job data at version 3\. half reads less/);
    assert.equal((await refused(async () => { throw new Error("down"); })).refusal, "The live hosts could not be read, so nothing says each reads what this change needs. Nothing was written; try again.");
    // The Confirm asks again: a host that moved between the two refuses there.
    let hosts = [reads("mini1")];
    const w = world({ deps: { readHosts: async () => ({ hosts }) } });
    const out = await w.preview({ [key]: value });
    assert.ok(out.plan);
    hosts = [reads("mini1", "1")];
    assert.match((await w.service.apply(out, operator)).invalid, /mini1 reads less/);
  });

  test(`${key}: the worker's own loader takes the file as written, a schedule included, and what it keeps is on the schedule's job`, async () => {
    const w = world({ records: [S.everything()] });
    await w.write({ [key]: value }, 0);
    const [schedule] = loadSchedules({ triggersFile: w.paths.triggersPath });
    assert.deepEqual(schedule.data[key], value);
    assert.equal(schedule.data.dataVersion, 3, "the job says what it needs");
    await w.write({ [key]: null }, 0);
    const [plain] = loadSchedules({ triggersFile: w.paths.triggersPath });
    assert.equal(plain.data[key], undefined);
    assert.equal(plain.data.dataVersion, undefined, "and with the field gone, says nothing");
  });
}

test("the file stays at version 2 while another row needs it, and says so, and a change there still asks each host", async () => {
  const w = world({ doc: { version: 2, triggers: [cron({ excludeExtensions: ["pi-lint"] }), comment({ excludeExtensionTools: ["lint_file"] })] } });
  const out = await w.write({ excludeExtensionTools: null });
  assert.ok(out.summary.includes("The file stays at version 2."));
  assert.ok(out.summary.includes("mini1 reads what this change needs."));
  assert.ok(!out.summary.some((line) => line.startsWith("Stamps") || line.startsWith("The file no longer")));
  assert.equal(JSON.parse(w.read()).version, 2);
});

test("planTriggerEditCore reads the real file at version 2: a flow and a list in one edit, both written, and the core's own reader does not refuse", async () => {
  const w = world({ doc: { version: 2, triggers: [cron(), comment({ excludeExtensions: ["git-guard"], provider: "anthropic", model: "claude-haiku-4-5" })] } });
  const before = w.read();
  const out = await w.write({ flow: "review", model: "claude-sonnet-5-5", excludeExtensions: ["pi-lint", "git-guard"], excludeExtensionTools: ["lint_file"] });
  assert.deepEqual(out.plan.changes.map((change) => change.key).sort(), ["excludeExtensionTools", "excludeExtensions", "flow", "model"]);
  const run = w.raw().run;
  assert.deepEqual([run.flow, run.model, run.excludeExtensions, run.excludeExtensionTools], ["review", "claude-sonnet-5-5", ["pi-lint", "git-guard"], ["lint_file"]]);
  await w.undo(out);
  assert.equal(w.read(), before, "byte for byte, a key it added gone and a list back as it was");
});

test("no host is live: the sentence holds beside rows that read last publications, whichever they say", async () => {
  const lint = [host("mini1", { packages: [PI_LINT] }), host("mini2", { packages: [PI_LINT] })];
  for (const [what, loads, name] of [["published as held", lint, "pi-lint"], ["published as not held", lint, "pi-linter"], ["nothing published", [], "pi-lint"]]) {
    const out = await world({ loads, live: [] }).preview({ excludeExtensions: [name] });
    assert.ok(out.plan, `${what}: ${JSON.stringify(out)}`);
    assert.ok(out.plan.warnings.includes(NO_LIVE_HOST(name)), `${what}: ${JSON.stringify(out.plan.warnings)}`);
    assert.ok(out.summary.includes("No host is live right now, so no host's release could be checked."), what);
    assert.doesNotMatch(out.plan.warnings.join(" "), /nothing says/, what);
  }
});

// What the writer does to a file in its own layout, each shape on the real writer: a stamp's line is the only one that moves, so nothing says the whole file does.
const LAYOUT_LINE = "This file is not in the writer's layout";
const VALUES_BACK = "Put trigger row 1's values back; the file stays in the form the writer gives it";
const AS_IT_WAS = "Put trigger row 1 back as it was";
const stampSaid = (out) => out.summary.filter((line) => /^(Stamps the file|The file (no longer needs|stays at)|This write also takes)/.test(line));

test("the version refusal reads live workers alone: a stopped worker and a receiver stop nothing, whatever they read, and each page that promises the refusal says so", async () => {
  // Through the reader the console wires (`cli.mjs`), on a registry as a fleet leaves it: a stopped worker's member can outlive its row, whose fields have expired, and a receiver writes neither.
  const rows = { mini1: { name: "mini1", beatAt: String(NOW), triggersVersion: "2", jobDataVersion: "3" }, stopped: {} };
  const redisFn = () => ({ smembers: async () => Object.keys(rows), hgetall: async (key) => rows[key.replace("host:h:", "")] ?? {}, srem: async () => {}, disconnect() {} });
  const preview = () => world({ deps: { readHosts: () => readHosts({ url: "redis://x", redisFn, now: () => NOW }) } }).preview({ excludeExtensions: ["pi-lint"] });
  const passes = await preview();
  assert.equal(passes.refusal, undefined, JSON.stringify(passes.refusal));
  assert.ok(passes.summary.length > 0);
  // The same reader does see a worker that is running and reads less, so the pass above is the expired row's and not a reader that sees nobody.
  rows.running = { name: "running", beatAt: String(NOW), triggersVersion: "1", jobDataVersion: "2" };
  assert.match((await preview()).refusal, /running reads less/);
  const said = (path) => nodeFs.readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").replace(/\s+/g, " ");
  for (const [path, sentence] of [["docs/upgrading.md", "It reads live workers alone: a receiver publishes no version and a stopped worker's row expires"], ["docs/exclude-tools.md", "It reads live workers alone, not receivers or stopped workers"], ["docs/console.md", "It reads live workers alone, not receivers or stopped workers"], ["specs/requirements.md", "it asks no receiver and no stopped worker"]]) assert.ok(said(path).includes(sentence), path);
});

test("a file in the writer's layout whose stamp says more or less than it needs: no line says the whole file moves, and one says what the stamp does", async () => {
  // A stamp nothing needs: a flow edit takes it off, and the Undo has no way to put it back.
  const over = writerText({ version: 2, triggers: [comment()] });
  const a = world({ text: over, deps: { readHosts: async () => assert.fail("nothing needs a host read") } });
  const off = await a.write({ flow: "review" }, 0);
  assert.equal(lineOf(off, LAYOUT_LINE), undefined, off.summary.join("\n"));
  assert.deepEqual(stampSaid(off), ["The file no longer needs version 2, so this write takes the stamp off."]);
  assert.equal(off.plan.undo, VALUES_BACK);
  await a.undo(off);
  assert.equal(a.read(), writerText({ triggers: [comment()] }), "the row back, and no stamp");
  // The same stamp, and a change that does need it: it stays, and the Undo takes it off.
  const b = world({ text: over });
  const needs = await b.write({ excludeExtensions: ["pi-lint"] }, 0);
  assert.equal(lineOf(needs, LAYOUT_LINE), undefined, needs.summary.join("\n"));
  assert.deepEqual(stampSaid(needs), ["The file stays at version 2."]);
  assert.equal(needs.plan.undo, VALUES_BACK);
  await b.undo(needs);
  assert.equal(b.read(), writerText({ triggers: [comment()] }));
  // A field with no stamp: the loader refuses it, and either way this page writes it right, with no line about a layout it already has.
  const under = writerText({ triggers: [comment({ excludeExtensions: ["pi-lint"] })] });
  assert.throws(() => parseTriggers(under, "t"), /needs triggers file version 2/);
  const stamps = await world({ text: under }).preview({ flow: "review" }, 0);
  assert.equal(lineOf(stamps, LAYOUT_LINE), undefined, stamps.summary.join("\n"));
  assert.deepEqual(stampSaid(stamps), ["Stamps the file version 2: a host reading less waits on every trigger's jobs, not only this one's."]);
  const clears = await world({ text: under }).preview({ excludeExtensions: null }, 0);
  assert.equal(lineOf(clears, LAYOUT_LINE), undefined, clears.summary.join("\n"));
  assert.deepEqual(stampSaid(clears), []);
  // A "version": 1, and one the loader cannot read: only that line goes, and it is said, since no sentence of a version above 1 speaks of either.
  for (const version of [1, "two"]) {
    const text = writerText({ version, triggers: [comment()] });
    const c = world({ text });
    const out = await c.preview({ flow: "review" }, 0);
    assert.equal(lineOf(out, LAYOUT_LINE), undefined, `${version}: ${out.summary.join("\n")}`);
    assert.deepEqual(stampSaid(out), ["This write also takes the file's \"version\" line off: a file that needs no more than version 1 is written without one."], String(version));
    assert.deepEqual(await c.service.apply(out, operator), { ok: true });
    assert.deepEqual(Object.keys(JSON.parse(c.read())), ["triggers"], "the line it said goes");
    assert.notEqual(out.plan.undo, AS_IT_WAS, String(version));
  }
  // And spacing is still spacing, with the stamp the same.
  const spaced = world({ text: `${JSON.stringify({ version: 2, triggers: [comment({ excludeExtensions: ["pi-lint"] })] })}\n` });
  assert.ok(lineOf(await spaced.preview({ flow: "review" }, 0), LAYOUT_LINE));
});

test("a stamp placed by hand: the Undo says as it was only where it writes the bytes it found", async () => {
  const atEnd = writerText({ triggers: [comment({ excludeExtensions: ["pi-lint"] })], version: 2 });
  // The stamp goes with the last field and comes back first, so the row is back and the bytes are not.
  const moved = world({ text: atEnd });
  const off = await moved.write({ excludeExtensions: null }, 0);
  assert.equal(lineOf(off, LAYOUT_LINE), undefined, off.summary.join("\n"));
  assert.equal(off.plan.undo, VALUES_BACK);
  const back = await moved.undo(off);
  assert.deepEqual(stampSaid(back), ["Stamps the file version 2: a host reading less waits on every trigger's jobs, not only this one's."]);
  assert.deepEqual(JSON.parse(moved.read()), JSON.parse(atEnd), "every value back");
  assert.notEqual(moved.read(), atEnd, "and not the bytes, as the page said");
  assert.deepEqual(Object.keys(JSON.parse(moved.read())), ["version", "triggers"]);
  // An edit the stamp stays under: it does not move, and those are the bytes.
  const kept = world({ text: atEnd });
  const flow = await kept.write({ flow: "review" }, 0);
  assert.equal(flow.plan.undo, AS_IT_WAS);
  await kept.undo(flow);
  assert.equal(kept.read(), atEnd);
  // The writer's own stamp, first: as it was, byte for byte, both ways.
  const first = writerText({ version: 2, triggers: [comment({ excludeExtensions: ["pi-lint"] })] });
  const own = world({ text: first });
  const cleared = await own.write({ excludeExtensions: null }, 0);
  assert.equal(cleared.plan.undo, AS_IT_WAS);
  await own.undo(cleared);
  assert.equal(own.read(), first);
});

test("a hand-written file: the stamp and the layout move together, and each sentence says so of what it moved", async () => {
  // Not the writer's layout, with `"version": 1` and a version the fields do not need.
  const handWritten = `{"version":1,\n  "triggers":[${JSON.stringify(comment())}]}\n`;
  const w = world({ text: handWritten });
  const out = await w.preview({ excludeExtensions: ["pi-lint"] }, 0);
  assert.equal(out.plan.undo, "Put trigger row 1's values back; the file stays in the form the writer gives it");
  assert.ok(lineOf(out, "This file is not in the writer's layout"), out.summary.join("\n"));
  assert.deepEqual(stampSaid(out), ["Stamps the file version 2: a host reading less waits on every trigger's jobs, not only this one's."], "one sentence for the one thing it does");
  assert.deepEqual(await w.service.apply(out, operator), { ok: true });
  assert.deepEqual(Object.keys(JSON.parse(w.read())), ["version", "triggers"], "in place");
  assert.equal(JSON.parse(w.read()).version, 2);
  // At 2 with neither field: it loads, a reader waits on nothing, and the next write says the stamp goes.
  const overStamped = writerText({ version: 2, triggers: [comment()] });
  const stamped = world({ text: overStamped, deps: { readHosts: async () => assert.fail("nothing needs a host read") } });
  assert.equal(parseTriggers(overStamped, "t").length, 1, "the loader takes a file stamped above what it needs");
  // And the worker's own schedule loader takes it the same, with neither field: a job of it carries no stamp, since no key on it needs one.
  const overStampedCron = world({ text: writerText({ version: 2, triggers: [cron()] }) });
  const [plainJob] = loadSchedules({ triggersFile: overStampedCron.paths.triggersPath });
  assert.equal(plainJob.data.dataVersion, undefined);
  assert.equal(plainJob.data.excludeExtensions, undefined);
  const lowered = await stamped.preview({ flow: "review" }, 0);
  assert.ok(lowered.summary.includes("The file no longer needs version 2, so this write takes the stamp off."), lowered.summary.join("\n"));
  assert.deepEqual(lowered.plan.need, { triggersVersion: 1, jobDataVersion: 1 });
  // A stamp written by hand elsewhere in the file: the row comes back as it was, the file's key stays where the writer leaves it.
  const atEnd = writerText({ triggers: [comment({ excludeExtensions: ["pi-lint"] })], version: 2 });
  const end = world({ text: atEnd });
  const off = await end.write({ flow: "review" }, 0);
  assert.equal(off.plan.need.triggersVersion, 2);
  assert.deepEqual(Object.keys(JSON.parse(end.read())), ["triggers", "version"]);
  // A hand-written file with no stamp at all and either field refuses to load, and this page writes the stamp that fixes it.
  const unstamped = writerText({ triggers: [comment({ excludeExtensions: ["pi-lint"] })] });
  assert.throws(() => parseTriggers(unstamped, "t"), /version/);
  const fixed = world({ text: unstamped });
  const repaired = await fixed.preview({ excludeExtensions: null }, 0);
  assert.ok(repaired.plan, JSON.stringify(repaired));
  assert.match(repaired.plan.undo, /^Edit trigger row 1 back by hand: the file did not load as it was/);
});

// ---- the jobs in line -----------------------------------------------------------------------------------------------------

for (const [key, value] of [["excludeExtensions", ["pi-lint"]], ["excludeExtensionTools", ["lint_file"]]]) {
  test(`${key}: a job in line without it is refused as trigger-skew, named on the proposed entry, and the worker's own check says so of the written file`, async () => {
    const job = { kind: "github", flow: "fix", trigger: { matched: { index: 1, type: "comment" } } };
    const waiting = { rows: [{ jobId: "gh-1", queue: "pi-jobs" }, { jobId: "gh-2", queue: "pi-jobs" }] };
    const jobs = { "gh-1": job, "gh-2": { ...job, [key]: value } };
    const w = world({ records: [S.everything()], deps: { readSkew: (index, fs) => readTriggerSkew({ index, waiting, triggersPath: w.paths.triggersPath, fs, lookupJob: async (_queue, id) => ({ data: jobs[id] }) }) } });
    const out = await w.preview({ [key]: value });
    assert.deepEqual(out.plan.skew.rows, [{ jobId: "gh-1", queue: "pi-jobs", field: key }], "the job that carries it stands");
    assert.ok(out.summary.includes(`With this change, a host reading this file refuses 1 of this trigger's jobs in line, before it spends: gh-1 as trigger-skew (run.${key}).`), out.summary.join("\n"));
    const check = makeCheckWaitSkew({ triggersPath: w.paths.triggersPath });
    assert.deepEqual(await check(job), { ok: true }, "the file on disk refuses nothing yet");
    assert.deepEqual(await w.service.apply(out, operator), { ok: true });
    assert.deepEqual(await makeCheckWaitSkew({ triggersPath: w.paths.triggersPath })(job), { skewed: true, field: key });
    assert.deepEqual(await makeCheckWaitSkew({ triggersPath: w.paths.triggersPath })(jobs["gh-2"]), { ok: true });
  });
}

test("the fleet reader's skew, on the proposed file, names a job that lacks either, and a schedule's job is not read", async () => {
  const w = world();
  const reader = createFleetReader({ valkeyUrl: "redis://unused", logsDir: tempDir("pd-800-exclude-logs-"), triggersPath: w.paths.triggersPath }, { makeQueueFn: () => ({ close: async () => {} }) });
  assert.deepEqual(await reader.triggerSkew(1, { rows: [] }), { rows: [], queued: [], incomplete: false });
  await reader.dispose?.();
  let reads = 0;
  const schedule = world({ deps: { readSkew: async () => { reads += 1; return { rows: [], incomplete: false }; } } });
  const out = await schedule.preview({ excludeExtensions: ["pi-lint"] }, 0);
  assert.equal(reads, 0);
  assert.ok(out.summary.includes("A job already in line keeps what it was queued with and runs without this change. A running job is not touched."));
  await schedule.service.apply(out, operator);
  assert.deepEqual(await makeCheckWaitSkew({ triggersPath: schedule.paths.triggersPath })({ kind: "local", flow: "tidy", trigger: { id: "daily" } }), { ok: true }, "the worker's own check says the sentence is true of it");
});

// ---- who reads them -------------------------------------------------------------------------------------------------------

test("the display carries both where the file names something, each a copy, and a name reaches no agent through it", () => {
  const entry = comment({ excludeExtensions: ["pi-lint"], excludeExtensionTools: ["lint_file"] });
  const shown = normalizeTriggerForDisplay(entry);
  assert.deepEqual([shown.excludeExtensions, shown.excludeExtensionTools], [["pi-lint"], ["lint_file"]]);
  shown.excludeExtensions.push("x");
  assert.deepEqual(entry.run.excludeExtensions, ["pi-lint"]);
  const plain = normalizeTriggerForDisplay(comment());
  assert.ok(!Object.hasOwn(plain, "excludeExtensions") && !Object.hasOwn(plain, "excludeExtensionTools"), "no key where the file has none");
  assert.ok(!Object.hasOwn(normalizeTriggerForDisplay(comment({ excludeExtensions: [1] })), "excludeExtensions"), "junk reads as none, the display's rule");
  for (const type of [cron(), { on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "fix" } }, { on: { type: "pull_request", action: ["opened"] }, run: { kind: "github", flow: "fix" } }, { on: { type: "issue", action: ["opened"] }, run: { kind: "github", flow: "fix" } }]) {
    const named = { ...type, run: { ...type.run, excludeExtensions: ["pi-lint"], excludeExtensionTools: ["lint_file"] } };
    assert.deepEqual(normalizeTriggerForDisplay(named).excludeExtensions, ["pi-lint"], type.on.type);
    assert.deepEqual(normalizeTriggerForDisplay(named).excludeExtensionTools, ["lint_file"], type.on.type);
  }
  const projected = agentReadProjection({ triggers: { triggers: [normalizeTriggerForDisplay(entry)] } });
  const row = projected.triggers.triggers[0];
  assert.deepEqual([row.excludeExtensions, row.excludeExtensionTools], [[], []], "set, and no name");
  assert.ok(!JSON.stringify(projected).includes("pi-lint") && !JSON.stringify(projected).includes("lint_file"));
});

test("an overlay entry named by its stem is the entry the worker means: the planner reads names through its function", () => {
  assert.equal(overlayEntryNamed("git-guard", "git-guard.ts"), true);
  assert.equal(overlayEntryNamed("git-guard.ts", "git-guard.ts"), true);
  assert.equal(overlayEntryNamed("git-guard.ts", "git-guard"), false);
});
