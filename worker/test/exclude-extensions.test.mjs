import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { enqueueForgeJob, enqueueLocalJob } from "../src/queue.mjs";
import { JOB_DATA_FIELD_VERSIONS, jobDataVersionFor } from "../src/job-data-version.mjs";
import { extensionsNotHere, LEFT_OUT_NAMES_MAX, leftOutOf, overlayEntryNamed, recordedLoaded, leavesOut } from "../src/loaded-record.mjs";
import { TERMINAL_COMMENTS } from "../src/comment-tables.mjs";
import { dollarSettlement, FLOOR_COUNTERS } from "../src/dollar-budget.mjs";
import { flowTierOf } from "../src/host-loads.mjs";
import { explainReason } from "../src/reason-catalog.mjs";
import { RUNNER_POLICY_REASONS } from "../src/run-history.mjs";
import { makeSubscriptionRuntime } from "../src/subscription-runtime.mjs";
import { TRIGGER_RUN_FIELD_VERSIONS, TRIGGERS_FILE_VERSION, excludeExtensionToolsNearMiss, excludeExtensionsNearMiss, excludeToolsNearMiss, parseTriggers, triggersFileVersionFor, withoutMcpExclusions } from "../src/triggers.mjs";
import { AUTHORED_NARROWING_FIELDS, writeTriggers } from "../src/triggers-file.mjs";
import { overlayEntryNamed as runnerNamed } from "../../image/runner/src/loaded.mjs";
import { secretValuesOf } from "../src/redact-secrets.mjs";
import { collectChecks } from "./helpers/doctor.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * `run.excludeExtensions` and `run.excludeExtensionTools` (issue #800): the file's half, the record's shape and the free refusals. A dropped
 * or misspelled one runs a job with what the file reads as gone, so this suite is mostly the ways that could happen.
 */

const readBack = (path) => readFileSync(path, "utf8");
/** A `tokens` object every floor counter of which is 0, so the only thing the settlement can read is what the test sets. */
const cleanTokens = (over) => Object.fromEntries([...FLOOR_COUNTERS.map((key) => [key, 0]), ...Object.entries(over)]);
const parse = (entries) => parseTriggers(JSON.stringify({ version: 2, triggers: entries }), "/x/triggers.json");
const KINDS = [
	["cron", (run = {}, on = {}) => ({ on: { type: "cron", id: "n", pattern: "0 3 * * *", ...on }, run: { kind: "local", folder: "/p", flow: "f", task: "t", ...run } })],
	["label", (run = {}, on = {}) => ({ on: { type: "label", any: ["pi"], ...on }, run: { kind: "github", flow: "f", ...run } })],
	["comment", (run = {}, on = {}) => ({ on: { type: "comment", phrase: "@pi", ...on }, run: { kind: "github", flow: "f", ...run } })],
	["issue", (run = {}, on = {}) => ({ on: { type: "issue", action: ["closed"], ...on }, run: { kind: "github", flow: "f", ...run } })],
	["pull_request", (run = {}, on = {}) => ({ on: { type: "pull_request", action: ["opened"], ...on }, run: { kind: "github", flow: "f", ...run } })],
];

test("both fields survive normalization on all five kinds, and a trigger with neither has no key at all", () => {
	for (const [kind, make] of KINDS) {
		const [plain] = parse([make()]);
		assert.equal("excludeExtensions" in plain.run, false, kind);
		assert.equal("excludeExtensionTools" in plain.run, false, kind);
		const names = ["@acme/lint", "git-guard"];
		const [t] = parse([make({ excludeExtensions: names, excludeExtensionTools: ["lint_run"] })]);
		assert.deepEqual(t.run.excludeExtensions, names, kind);
		assert.deepEqual(t.run.excludeExtensionTools, ["lint_run"], kind);
	}
});

test("what a host's list spells is what the field takes: a scoped package, a folder, a stem, a file's whole name", () => {
	for (const name of ["pi-lint", "@acme/pi.lint", "guard", "guard.ts", "Mixed_Case-1.0", "index"]) assert.deepEqual(parse([KINDS[1][1]({ excludeExtensions: [name] })])[0].run.excludeExtensions, [name], name);
});

test("a shape that is no list of names refuses, by the field's name, on all five kinds", () => {
	const shapes = {
		excludeExtensions: ["lint", {}, [], [1], [""], [null], ["a,b"], ["../up"], [".."], ["has space"], ["@a/b/c"], [`${"x".repeat(215)}`], Array.from({ length: LEFT_OUT_NAMES_MAX + 1 }, (_, i) => `n${i}`)],
		excludeExtensionTools: ["t", {}, [], [1], [""], [null], ["a,b"], ["a*"], ["*"], ["has space"], ["9start"], [`${"x".repeat(49)}`], Array.from({ length: LEFT_OUT_NAMES_MAX + 1 }, (_, i) => `n${i}`)],
	};
	for (const [field, bad] of Object.entries(shapes)) {
		for (const [kind, make] of KINDS) {
			for (const value of bad) assert.throws(() => parse([make({ [field]: value })]), (e) => e.piDispatchConfig === true && e.message.includes(`run.${field}`), `${kind}: ${field}=${JSON.stringify(value)}`);
		}
		assert.throws(() => parse([KINDS[1][1]({ [field]: ["a", "a"] })]), /twice/);
		assert.deepEqual(parse([KINDS[1][1]({ [field]: Array.from({ length: LEFT_OUT_NAMES_MAX }, (_, i) => `n${i}`) })])[0].run[field].length, LEFT_OUT_NAMES_MAX, "and the cap itself loads");
	}
});

test("a tool with another key or no extension behind it refuses, saying where it belongs", () => {
	const load = (name) => () => parse([KINDS[1][1]({ excludeExtensionTools: [name] })]);
	for (const name of ["bash", "read", "powershell", "codemode", "tool_search", "list_mcp_resources", "mcp__linear__search", "mcp__x"]) assert.throws(load(name), /belongs on run\.excludeTools/, name);
	for (const name of ["report_progress", "await_human_input", "request_approval", "subagent", "query_logs"]) assert.throws(load(name), /tool the job itself offers/, name);
	assert.deepEqual(parse([KINDS[1][1]({ excludeExtensionTools: ["lint_run", "Search-Web"] })])[0].run.excludeExtensionTools, ["lint_run", "Search-Web"]);
});

test("a near miss of either key refuses under run, every spelling refuses under on, and neither reads as a near miss of the other or of run.excludeTools", () => {
	for (const [field, misses] of [
		["excludeExtensions", ["exclude_extensions", "exclude-extensions", "EXCLUDEEXTENSIONS", "excludeExtension", "excludedExtensions", "excludeExtensiоns"]],
		["excludeExtensionTools", ["exclude_extension_tools", "exclude-extension-tools", "EXCLUDEEXTENSIONTOOLS", "excludeExtensionTool", "excludedExtensionTools"]],
	]) {
		for (const miss of misses) assert.throws(() => parse([KINDS[1][1]({ [miss]: ["x"] })]), new RegExp(`did you mean run\\.${field}`), miss);
		assert.throws(() => parse([KINDS[1][1]({}, { [field]: ["x"] })]), new RegExp(`on\\.${field} is not a field`));
	}
	assert.equal(excludeToolsNearMiss("excludeExtensionTools"), false);
	assert.equal(excludeExtensionsNearMiss("excludeExtensionTools"), false);
	assert.equal(excludeExtensionToolsNearMiss("excludeExtensions"), false);
	assert.equal(excludeExtensionsNearMiss("excludeTools"), false);
	assert.deepEqual(parse([KINDS[1][1]({ excludeTools: ["bash"], excludeExtensions: ["a"], excludeExtensionTools: ["b"] })])[0].run.excludeTools, ["bash"], "all three together");
});

test("each field needs file version 2 by itself: an older loader would drop it, so one written by hand with no stamp refuses, and the writer stamps it", () => {
	assert.equal(TRIGGERS_FILE_VERSION, 2);
	assert.deepEqual(TRIGGER_RUN_FIELD_VERSIONS, { excludeExtensions: 2, excludeExtensionTools: 2 });
	for (const field of ["excludeExtensions", "excludeExtensionTools"]) {
		const entry = KINDS[1][1]({ [field]: ["x"] });
		assert.throws(() => parseTriggers(JSON.stringify({ triggers: [entry] }), "/t"), (e) => e.newer === undefined && e.message === `trigger at index 0: run.${field} needs triggers file version 2, and the file declares 1: /t`);
		assert.equal(triggersFileVersionFor({ triggers: [entry] }), 2);
		assert.ok(AUTHORED_NARROWING_FIELDS.some((row) => row.key === field), field);
		assert.equal(AUTHORED_NARROWING_FIELDS.find((row) => row.key === field).authored(["x"]), true);
		assert.equal(AUTHORED_NARROWING_FIELDS.find((row) => row.key === field).authored([]), false, "an empty list narrows nothing");
		assert.equal(JOB_DATA_FIELD_VERSIONS[field], 2);
		const path = join(tempDir("exclude-extensions-"), "triggers.json");
		writeFileSync(path, JSON.stringify({ triggers: [] }));
		assert.deepEqual(writeTriggers({ triggersPath: path, mutate: () => [entry] }), { ok: true });
		assert.equal(JSON.parse(readBack(path)).version, 2, "the writer's own stamp");
		assert.deepEqual(writeTriggers({ triggersPath: path, mutate: () => [KINDS[1][1]()] }), { ok: true });
		assert.equal(Object.hasOwn(JSON.parse(readBack(path)), "version"), false, "and a file that no longer needs it goes back to its old bytes");
	}
	assert.equal(triggersFileVersionFor({ triggers: [KINDS[1][1]({ excludeTools: ["bash"] })] }), 1, "run.excludeTools needs nothing, so no existing file moves");
});
test("a watch rule refuses both keys by the rule it always had: its data is built by name, and a watch job never carries them", () => {
	const doc = (extra) => JSON.stringify({ version: 2, watchSources: { prod: { verify: "hmac-sha256", secretEnv: "WATCH_SECRET" } }, triggers: [{ on: { type: "watch", id: "errors", source: "prod", fingerprint: ["service"], window: "10m", cooldown: "6h", maxPerDay: 4 }, run: { kind: "local", mode: "investigate", folder: "/p", flow: "f", task: "t", maxCostUsd: "1", ...extra } }] });
	assert.equal(parseTriggers(doc({}), "/t").length, 1, "the premise: the rule loads without them");
	for (const field of ["excludeExtensions", "excludeExtensionTools"]) assert.throws(() => parseTriggers(doc({ [field]: ["x"] }), "/t"), /unsupported run field/, field);
});

test("job data: each field rides conditionally, stamps version 2, and an unflagged job's bytes do not move", async () => {
	const fake = () => {
		const adds = [];
		return { adds, add: async (_name, data, opts) => (adds.push(data), { id: opts.jobId }) };
	};
	const forge = { repo: "acme/web", target: { type: "issue", number: 7 }, flow: "fix", trigger: { deliveryId: "d-800", sender: { id: 1 } } };
	const q = fake();
	await enqueueForgeJob(q, "github", forge);
	await enqueueForgeJob(q, "github", { ...forge, trigger: { ...forge.trigger, deliveryId: "d-801" }, excludeExtensions: ["pi-lint"] });
	await enqueueForgeJob(q, "github", { ...forge, trigger: { ...forge.trigger, deliveryId: "d-802" }, excludeExtensionTools: ["lint_run"] });
	await enqueueLocalJob(q, { folder: "/srv", flow: "tidy", task: "t", excludeExtensions: ["pi-lint"], excludeExtensionTools: ["lint_run"] });
	const [plain, ext, tool, local] = q.adds.map((data) => JSON.parse(JSON.stringify(data)));
	assert.equal("excludeExtensions" in plain || "dataVersion" in plain, false);
	assert.deepEqual([ext.excludeExtensions, ext.dataVersion, "excludeExtensionTools" in ext], [["pi-lint"], 2, false], "one alone is not folded into the other's conditional");
	assert.deepEqual([tool.excludeExtensionTools, tool.dataVersion, "excludeExtensions" in tool], [["lint_run"], 2, false]);
	assert.deepEqual([local.excludeExtensions, local.excludeExtensionTools, local.dataVersion], [["pi-lint"], ["lint_run"], 2]);
	assert.ok(!JSON.stringify(ext.trigger).includes("pi-lint"), "at job level, never in `trigger`, which becomes /job/event.json");
	assert.equal(jobDataVersionFor({ excludeTools: ["bash"] }), 1);
});

test("an MCP tool name is what a chained child drops, and an extension's is never one", () => {
	assert.deepEqual(withoutMcpExclusions(["bash", "codemode", "mcp__linear__*"]), ["bash"], "the premise: the rule for run.excludeTools");
	assert.deepEqual(withoutMcpExclusions(["lint_run"]), ["lint_run"]);
});

test("a job built by name carries neither field: a watch, an answer draft, a question grouping and a model canary each list what they run with", () => {
	// Each has its own loader or its own closed list of fields, so a trigger's narrowing never arrives here by a spread. Whichever way a new one is added, this says it was thought about.
	for (const file of ["watch-runtime.mjs", "answerer-runtime.mjs", "question-group-runtime.mjs", "canary-runtime.mjs"]) {
		assert.doesNotMatch(readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8"), /excludeExtension/, file);
	}
	assert.equal(LEFT_OUT_NAMES_MAX, 16, "the helper's longest line (image/runner/test/helpers/maximal-loaded.mjs) is written to this");
});

test("the container's three variables are no secrets, so a name on them is no value the redactor would hide", () => {
	const values = secretValuesOf({ PI_EXCLUDE_EXTENSIONS: "git-guard", PI_EXCLUDE_EXTENSION_TOOLS: "guard_check", PI_EXCLUDE_TOOLS_STRICT: "1", SOME_KEY: "held-as-secret" }, []);
	assert.ok(values.includes("held-as-secret"), "the premise: any other variable is taken for a secret");
	for (const name of ["git-guard", "guard_check", "1"]) assert.ok(!values.includes(name), name);
});

test("the worker's rule for an overlay name is the runner's, on every shape of name", () => {
	const shapes = [["x", "x.ts"], ["x", "x.js"], ["x.ts", "x.ts"], ["x", "x"], ["x.ts", "x"], ["x", "x.mjs"], ["x", "x.ts.ts"], ["x.ts", "x.ts.ts"], ["my.tool", "my.tool.ts"], ["my", "my.tool.ts"], ["x", "xy.ts"], ["", "x.ts"], ["x.js", "x.ts"]];
	for (const [name, segment] of shapes) assert.equal(overlayEntryNamed(name, segment), runnerNamed(name, segment), `${name} against ${segment}`);
	assert.equal(overlayEntryNamed("x", "x.ts"), true);
	assert.equal(overlayEntryNamed("x", "xy.ts"), false);
	assert.equal(overlayEntryNamed("my", "my.tool.ts"), false);
	assert.equal(overlayEntryNamed("x", "x.md"), false, "a file pi would never load is no entry of that name");
});

test("which names a host holds neither way: packages by name, the overlay by its one rule", () => {
	const held = { packages: [{ name: "@acme/lint", version: "1.0.0" }, null], overlay: ["guard.ts", "folder"] };
	assert.deepEqual(extensionsNotHere(["@acme/lint", "guard", "guard.ts", "folder", "typo", "lint"], held), ["typo", "lint"]);
	assert.deepEqual(extensionsNotHere(["x"], {}), ["x"]);
});

test("leftOut: the names split by what this host holds, only when there are some, and a run with none keeps its bytes", () => {
	const base = { tools: [], packages: false, overlayExtensions: false, restricted: false };
	assert.deepEqual(leftOutOf({}), base, "no key at all, so every record from before these fields reads the same");
	assert.equal(leavesOut(leftOutOf({})), false);
	const both = leftOutOf({ excludeExtensions: ["pi-lint", "typo"], excludeExtensionTools: ["lint_run"] }, { excludedNotHere: ["typo"] });
	assert.deepEqual(both, { ...base, extensions: ["pi-lint"], extensionsNotHere: ["typo"], extensionTools: ["lint_run"] });
	assert.equal(leavesOut(both), true);
	for (const one of [{ excludeExtensions: ["a"] }, { excludeExtensionTools: ["a"] }]) assert.equal(leavesOut(leftOutOf(one)), true, JSON.stringify(one));
	assert.equal(leavesOut(leftOutOf({ excludeExtensions: ["a"] }, { excludedNotHere: ["a"] })), true);
	assert.deepEqual(leftOutOf({ excludeExtensions: ["a"] }, { excludedNotHere: ["other"] }), { ...base, extensions: ["a"] }, "a name it was not asked about is not said");
	assert.deepEqual(leftOutOf({ excludeExtensions: ["<b>", 7], excludeExtensionTools: ["a b"] }), base, "a hand-built job's junk is not a name");
});

test("the record holds those names by shape, and a value that fails it is no record", () => {
	const field = (leftOut, tools = null) => ({ v: 1, runner: tools ? "reported" : "absent", image: null, imageDigest: null, imagePi: null, at: tools ? "ready" : null, cut: null, pi: null, flow: null, sources: [], mcp: null, tools, problems: null, leftOut });
	const base = { tools: [], packages: false, overlayExtensions: false, restricted: false };
	const kept = recordedLoaded(field({ ...base, extensions: ["@a/b", "x.ts"], extensionsNotHere: ["typo"], extensionTools: ["t1"] }));
	assert.deepEqual(kept.leftOut, { ...base, extensions: ["@a/b", "x.ts"], extensionsNotHere: ["typo"], extensionTools: ["t1"] });
	assert.deepEqual(recordedLoaded(field(base)).leftOut, base);
	for (const bad of [{ extensions: "x" }, { extensions: ["<b>"] }, { extensions: [] }, { extensionsNotHere: ["a b"] }, { extensionTools: ["a*"] }, { extensionTools: Array(LEFT_OUT_NAMES_MAX + 1).fill("t") }]) assert.equal(recordedLoaded(field({ ...base, ...bad })), null, JSON.stringify(bad));
	const tools = { active: 1, own: [], job: [] };
	assert.deepEqual(recordedLoaded(field(base, { ...tools, unmatched: ["t1"] })).tools.unmatched, ["t1"]);
	assert.equal(Object.hasOwn(recordedLoaded(field(base, tools)).tools, "unmatched"), false);
	assert.equal(recordedLoaded(field(base, { ...tools, unmatched: ["a b"] })), null);
	assert.equal(recordedLoaded(field(base, { ...tools, unmatched: [] })), null);
});

test("doctor's flow tier: a package a trigger leaves out by name brings it no skill", async () => {
	const world = { fileExists: () => false, overlay: "/overlay", staged: { skills: [{ name: "fix", package: "pi-lint" }], unenumerable: [] }, repoFlowAtHead: async () => "absent" };
	assert.equal((await flowTierOf({ flow: "fix", folder: "/srv" }, world)).tier, "package", "the premise");
	assert.equal((await flowTierOf({ flow: "fix", folder: "/srv", excludeExtensions: ["other"] }, world)).tier, "package");
	assert.equal((await flowTierOf({ flow: "fix", folder: "/srv", excludeExtensions: ["pi-lint"] }, world)).tier, "none");
});

/** The seams a doctor run needs and this suite says nothing of. */
const doctorSeams = (dir) => ({ cwd: dir, home: tempDir("pi-800-doctor-home-"), out: () => {}, spawn: planSpawn(), probeValkey: async () => true, readHosts: async () => ({ hosts: [] }), dollarKeysExist: async () => false, fileExists: existsSync, readEnvFile: (path) => readFileSync(path), nodeVersion: "22.19.0" });
function planSpawn() {
	return () => {
		const stream = () => ({ on() { return this; } });
		const handlers = {};
		const child = { stdout: stream(), stderr: stream(), stdin: { on() { return this; }, end() {} }, kill() {}, on(ev, cb) { handlers[ev] = cb; return this; } };
		queueMicrotask(() => handlers.close?.(0));
		return child;
	};
}

function doctorOn({ triggers, ignoreFile = false }) {
	const dir = tempDir("pi-800-doctor-");
	const global = join(dir, "global");
	mkdirSync(join(global, "extensions", "folder"), { recursive: true });
	writeFileSync(join(global, "extensions", "guard.ts"), "export default function () {}\n");
	writeFileSync(join(global, "extensions", "folder", "index.ts"), "export default function () {}\n");
	// An ignore file is read by a job's matcher and not here, so this read cannot say what the overlay's entries are.
	if (ignoreFile) writeFileSync(join(global, "extensions", ".gitignore"), "skipped.ts\n");
	mkdirSync(join(global, "packages", "acme-lint", "skills", "packflow"), { recursive: true });
	writeFileSync(join(global, "packages", "packages.json"), JSON.stringify({ packages: [{ name: "@acme/lint", version: "1.0.0", dir: "acme-lint" }] }));
	writeFileSync(join(global, "packages", "acme-lint", "package.json"), JSON.stringify({ name: "@acme/lint", version: "1.0.0", pi: { skills: ["skills"] } }));
	writeFileSync(join(global, "packages", "acme-lint", "skills", "packflow", "SKILL.md"), '---\nname: "packflow"\ndescription: the skill\n---\nDo it.\n');
	const triggersFile = join(dir, "triggers.json");
	writeFileSync(triggersFile, JSON.stringify({ version: 2, triggers }));
	const env = { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", VALKEY_URL: "redis://x", PI_WORKER_NAME: "mini1", PI_TRIGGERS_FILE: triggersFile, PI_GLOBAL_PI_DIR: global };
	return collectChecks(env, doctorSeams(dir));
}
const namedLines = (checks) => checks.filter((c) => /run\.excludeExtensions names/.test(c.label));

test("doctor warns of a name this host holds neither way, by trigger, and is silent of what it holds", async () => {
	const label = (run) => ({ on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "f", ...run } });
	const lines = namedLines(await doctorOn({ triggers: [label({ excludeExtensions: ["@acme/lint", "guard", "guard.ts", "folder", "typo"] }), label({ excludeExtensions: ["typo"] }), label({ excludeExtensions: ["other"], packages: false })] }));
	assert.equal(lines.length, 1, JSON.stringify(lines));
	assert.equal(lines[0].ok, false);
	assert.equal(lines[0].warn, true, "a warning: no job is refused for it");
	assert.match(lines[0].label, /"typo"/);
	assert.doesNotMatch(lines[0].label, /other/, "a trigger withholding the packages never looks there, so its name is no finding");
	assert.match(lines[0].fix, /fix the name/);
});

test("doctor names a live host that cannot read the file's need, from this build's own tables", async () => {
	const dir = tempDir("pi-800-doctor-");
	const triggersFile = join(dir, "triggers.json");
	writeFileSync(triggersFile, JSON.stringify({ version: 2, triggers: [{ on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "f", excludeExtensionTools: ["lint_run"] } }] }));
	const seams = { ...doctorSeams(dir), readHosts: async () => ({ hosts: [{ name: "mini2", tz: Intl.DateTimeFormat().resolvedOptions().timeZone, settingsVersion: "1", pauseWindowsVersion: "1", triggersVersion: "1", jobDataVersion: "2" }, { name: "mini3", tz: Intl.DateTimeFormat().resolvedOptions().timeZone }] }) };
	const checks = await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", VALKEY_URL: "redis://x", PI_WORKER_NAME: "mini1", PI_TRIGGERS_FILE: triggersFile }, seams);
	const labels = checks.filter((c) => c.id?.startsWith("fleet.store-versions")).map((c) => c.label);
	assert.ok(labels.some((label) => /^mini2 reads the triggers file only below version 2/.test(label)), JSON.stringify(labels));
	assert.ok(labels.some((label) => /^mini3 publishes no version for the triggers file/.test(label)), JSON.stringify(labels));
	assert.ok(labels.some((label) => /^mini3 publishes no version for the jobs this host's triggers queue/.test(label)), JSON.stringify(labels));
});

test("doctor's flow line: a flow only an excluded package holds resolves for the trigger that keeps it, and not for the one that leaves it out", async () => {
	const entry = (extra) => ({ on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "packflow", ...extra } });
	const checks = await doctorOn({ triggers: [entry({}), entry({ excludeExtensions: ["@acme/lint"] })] });
	const lines = checks.filter((c) => /Trigger flow "packflow"/.test(c.label));
	assert.equal(lines.length, 2, JSON.stringify(lines.map((c) => c.label)));
	assert.ok(lines.some((c) => /resolves \(/.test(c.label) && /staged package @acme\/lint/.test(c.label)), JSON.stringify(lines));
	const missing = lines.find((c) => /resolves in NO tier/.test(c.label));
	assert.ok(missing, JSON.stringify(lines));
	assert.equal(missing.warn, true);
});

test("doctor says nothing of a name it cannot judge: an overlay folder it cannot list for a job, or a manifest that does not read", async () => {
	const label = { on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "f", excludeExtensions: ["typo"] } };
	assert.equal(namedLines(await doctorOn({ triggers: [label] })).length, 1, "the premise");
	assert.deepEqual(namedLines(await doctorOn({ triggers: [label], ignoreFile: true })), []);
	const dir = tempDir("pi-800-doctor-");
	const global = join(dir, "global");
	mkdirSync(join(global, "packages"), { recursive: true });
	writeFileSync(join(global, "packages", "packages.json"), "{ not json");
	const triggersFile = join(dir, "triggers.json");
	writeFileSync(triggersFile, JSON.stringify({ version: 2, triggers: [label] }));
	const unread = await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", VALKEY_URL: "redis://x", PI_WORKER_NAME: "mini1", PI_TRIGGERS_FILE: triggersFile, PI_GLOBAL_PI_DIR: global }, doctorSeams(dir));
	assert.deepEqual(namedLines(unread), []);
});

test("excluding the subscription adapter refuses for free at the pickup, as withholding the packages does", async () => {
	const adapter = "pi-anthropic-oauth";
	const row = { ok: true, managed: true, provider: "anthropic", id: "c", adapter, quotaWindows: [] };
	const runtime = makeSubscriptionRuntime({
		auth: { check: async () => row },
		quota: { admit: async () => { throw new Error("nothing past this refusal may run"); } },
		lookup: () => ({ api: "anthropic-messages", baseUrl: "https://x" }),
		packageRootFor: () => { throw new Error("nothing past this refusal may run"); },
	});
	const job = { provider: "anthropic", model: "m", models: ["anthropic/m"] };
	assert.deepEqual(await runtime.check({ ...job, packages: false }), { ok: false, managed: true, reason: "auth-adapter-disabled" }, "the premise");
	assert.deepEqual(await runtime.check({ ...job, excludeExtensions: [adapter] }), { ok: false, managed: true, reason: "auth-adapter-disabled" });
	await assert.rejects(runtime.check({ ...job, excludeExtensions: ["another"] }), /nothing past this refusal may run/, "another name is not this package");
});

test("the docs' numbers and lists are the code's", () => {
	const flat = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").replace(/\s+/g, " ");
	const doc = flat("docs/exclude-tools.md");
	assert.equal(LEFT_OUT_NAMES_MAX, 16);
	assert.ok(doc.includes("at most 48 characters, and at most 16 names") && doc.includes("At most 16 names."), "the cap, in each key's section");
	assert.ok(flat("specs/interfaces.md").includes("optional non-empty arrays of at most 16 names"));
	// What makes a job strict: the worker's clauses, each said in the row that says who stops, and the runner's two.
	const container = flat("worker/src/run-container.mjs");
	const strict = /const excludeToolsStrict = ([^;]+);/.exec(container)[1];
	for (const clause of ["job.packages !== false", "excludedNames.length === 0", "allowGlobalExtensions !== false", "job.parentJobId === undefined", "job.watch || job.answerDraft || job.questionGrouping"]) assert.ok(strict.includes(clause), clause);
	const row = /\| Nothing was held back from it: ([^|]+) \| It stops before its prompt, as `exclude-tool-not-loaded` \|/.exec(doc)?.[1];
	assert.ok(row, "the docs' row");
	for (const said of ['no `"packages": false`', "no `run.excludeExtensions`", "this host's overlay open", "no parent job", "every extension loaded"]) assert.ok(row.includes(said), said);
	const runner = flat("image/runner/run-job.mjs");
	assert.ok(runner.includes("if (cfg.excludeToolsStrict && loadTee.failures().length === 0 && loadTee.drops().length === 0) {"), "every extension loaded: none failed and none dropped");
	const spec = flat("specs/interfaces.md");
	for (const clause of ["`job.packages !== false`", "no `run.excludeExtensions`", "this host's overlay switch is open", "`job.parentJobId` is unset", "no restricted job"]) assert.ok(spec.includes(clause), clause);
	// Each reason's own paragraph opens with what the catalog says of it, as the comment and the page do.
	const reasons = flat("docs/reasons.md");
	for (const reason of ["exclude-tool-not-loaded", "package-canary-excluded", "job-image-load-exclusions-unsupported"]) {
		assert.ok(reasons.includes(`### ${reason} ${explainReason(reason).sentence}`), reason);
	}
	// The boundary, in every place that promises what exclusion does.
	for (const path of ["docs/exclude-tools.md", "docs/global-pi-overlay.md", "SECURITY.md"]) assert.ok(flat(path).includes("not what an agent") || flat(path).includes("an agent with a shell can write"), path);
	assert.ok(doc.includes("`~/.pi/agent/settings.json`"));
	// The label and the row name the capability the same.
	const label = /LABEL dev\.pi-dispatch\.capabilities="([^"]+)"/.exec(readFileSync(new URL("../../image/Dockerfile", import.meta.url), "utf8"))[1].split(",");
	assert.ok(label.includes("loadExclusions"));
	assert.ok(flat("image/verify-image.sh").includes("loadExclusions) #"), "and the conformance script proves the claim");
	assert.ok(flat("docs/job-image.md").includes("`loadExclusions`"));
});

test("what a stop for a name that matched nothing costs: only a trusted line with no calls reaches $0, and the reason has its own words", () => {
	assert.ok(RUNNER_POLICY_REASONS.has("exclude-tool-not-loaded"), "read off the line, so not folded into runner-policy");
	const words = explainReason("exclude-tool-not-loaded");
	assert.equal(words.sentence, TERMINAL_COMMENTS["exclude-tool-not-loaded"]);
	for (const cause of ["misspelled", "missing on this host", "register it later"]) assert.ok(words.sentence.includes(cause), cause);
	assert.match(words.next, /`run\.excludeExtensions`/, "the way out for a tool registered late");
	assert.doesNotMatch(words.sentence, /nothing was spent|free/i, "an extension may have called a model as it loaded");
	const reservedMicros = 2_000_000;
	const meter = { metered: true, costCapMicros: reservedMicros, calls: 0, cost: 0 };
	const zero = (tokens, trusted = true) => dollarSettlement({ tokens, usage: null, reservedMicros, trusted });
	const clean = zero(cleanTokens(meter));
	assert.deepEqual(clean, { settledMicros: 0, basis: "metered" }, "a line the worker trusts, that made no call, on a job with a cap");
	assert.equal(zero(cleanTokens(meter), false).settledMicros, reservedMicros, "not trusted: the reservation stands");
	assert.equal(zero(cleanTokens({ ...meter, calls: 1 })).settledMicros, reservedMicros, "a call at load with no ledger: the reservation stands");
	assert.equal(zero(null).settledMicros, reservedMicros, "no tokens on the line");
	const { costCapMicros: _noCap, ...uncapped } = meter;
	assert.equal(zero(cleanTokens(uncapped)).settledMicros, reservedMicros, "a job with no cap of its own keeps the reservation, whatever its line says");
});
