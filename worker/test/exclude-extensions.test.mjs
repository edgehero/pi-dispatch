import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { enqueueForgeJob, enqueueLateForgeJob, enqueueLocalJob } from "../src/queue.mjs";
import { JOB_DATA_FIELD_VERSIONS, jobDataNewer, jobDataVersionFor, withJobDataVersion } from "../src/job-data-version.mjs";
import { extensionsNotHere, LEFT_OUT_NAMES_MAX, LOADED_JOB_TOOLS, leftOutOf, overlayEntryNamed, recordedLoaded, leavesOut } from "../src/loaded-record.mjs";
import { TERMINAL_COMMENTS } from "../src/comment-tables.mjs";
import { dollarSettlement, FLOOR_COUNTERS } from "../src/dollar-budget.mjs";
import { CAPABILITY_GATES } from "../src/image-preflight.mjs";
import { flowTierOf } from "../src/host-loads.mjs";
import { explainReason } from "../src/reason-catalog.mjs";
import { RUNNER_POLICY_REASONS } from "../src/run-history.mjs";
import { parseAuthConnections } from "../src/auth-policy.mjs";
import { COMMUNITY_AUTH_ADAPTERS } from "../src/community-auth-metadata.mjs";
import { makeSubscriptionRuntime } from "../src/subscription-runtime.mjs";
import { isSubscriptionAdapter } from "../src/updates-subscription-adapters.mjs";
import { EXCLUDABLE_TOOL_NAMES, MCP_EXCLUDABLE_TOOL_NAMES, TRIGGER_RUN_FIELD_VERSIONS, TRIGGERS_FILE_VERSION, excludeExtensionToolsNearMiss, excludeExtensionsNearMiss, excludeToolsNearMiss, parseTriggers, triggersFileVersionFor, withoutMcpExclusions } from "../src/triggers.mjs";
import { AUTHORED_NARROWING_FIELDS, makeCheckWaitSkew, writeTriggers } from "../src/triggers-file.mjs";
import { overlayEntryNamed as runnerNamed } from "../../image/runner/src/loaded.mjs";
import { CARD_FIELDS } from "../../admin/src/trigger-edit-core.mjs";
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

test("a file directly in extensions/ with a space in its name has no name in the key, as the docs say", () => {
	for (const name of ["my ext", "my ext.js"]) assert.throws(() => parse([KINDS[1][1]({ excludeExtensions: [name] })]), /is neither a package's manifest name nor an overlay extension's file stem or folder name/, name);
	assert.ok(readFileSync(new URL("../../docs/exclude-tools.md", import.meta.url), "utf8").replace(/\s+/g, " ").includes("**A file directly in `extensions/` with a space in its name cannot be named.** `extensions/my ext.js` loads, and no name in `run.excludeExtensions` reaches it until it is renamed."));
});

test("a name this key would mistake refuses, saying which way out does what", () => {
	const load = (name) => () => parse([KINDS[1][1]({ excludeExtensionTools: [name] })]);
	for (const name of ["bash", "read", "powershell", "codemode", "tool_search", "list_mcp_resources", "mcp__linear__search", "mcp__x"]) assert.throws(load(name), /run\.excludeTools removes/, name);
	for (const name of ["report_progress", "await_human_input", "request_approval", "subagent", "query_logs"]) assert.throws(load(name), /a tool pi-dispatch gives some jobs/, name);
	// A name that differs only in case: pi compares exactly, so it would match nothing and read as though the tool were gone. run.excludeTools refuses `Bash` by membership, and this list has none to refuse it by.
	assert.throws(() => parse([KINDS[1][1]({ excludeTools: ["Bash"] })]), /is not a tool the pinned pi knows/, "the premise");
	for (const name of ["Bash", "BASH", "Write", "bAsH", "Read", "Powershell", "Codemode", "Tool_Search", "LIST_MCP_RESOURCES", "MCP__linear__search", "Mcp__x"]) assert.throws(load(name), /run\.excludeTools removes/, name);
	for (const name of ["Report_Progress", "REPORT_PROGRESS", "Await_Human_Input", "Subagent", "Query_Logs", "SUBMIT_ANSWER_DRAFT"]) assert.throws(load(name), /a tool pi-dispatch gives some jobs/, name);
	for (const tool of [...EXCLUDABLE_TOOL_NAMES, ...MCP_EXCLUDABLE_TOOL_NAMES]) assert.throws(load(tool.toUpperCase()), /run\.excludeTools removes/, `${tool}, in any case`);
	// The refusal names the spelling the other list takes: as written, `BASH` is a second refusal there, and the spelling it names is not.
	const excludeTools = (name) => () => parseTriggers(JSON.stringify({ triggers: [{ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "f", mcp: ["linear"], excludeTools: [name] } }] }), "/t");
	for (const tool of [...EXCLUDABLE_TOOL_NAMES, ...MCP_EXCLUDABLE_TOOL_NAMES]) {
		assert.throws(load(tool.toUpperCase()), (e) => e.message.includes(`run.excludeTools removes ${EXCLUDABLE_TOOL_NAMES.has(tool) ? "pi's" : "those"}, spelled "${tool}"`), tool);
		assert.throws(excludeTools(tool.toUpperCase()), /is not a tool the pinned pi knows/, `${tool}: the premise`);
		assert.doesNotThrow(excludeTools(tool), tool);
	}
	assert.throws(load("MCP__linear__search"), /run\.excludeTools removes its tools all at once, as mcp__<server>__\*/);
	assert.doesNotThrow(excludeTools("mcp__linear__*"));
	// A server's tools are taken only beside run.mcp, so the refusal says so: bare, the place it names refuses them too.
	for (const name of MCP_EXCLUDABLE_TOOL_NAMES) {
		assert.throws(load(name), (e) => e.message.includes("on a trigger with run.mcp, run.excludeTools removes those"), name);
		assert.throws(() => parse([KINDS[1][1]({ excludeTools: [name] })]), /is not a tool the pinned pi knows/, `${name}: the premise`);
	}
	assert.throws(load("mcp__linear__search"), /on a trigger whose run\.mcp names that server/);
	// Whole sentences, since a pattern over the tail passes whatever stands in front of it.
	const wayOut = "to remove a staged package's or an overlay extension's tool of that name, put that package's or extension's name in run.excludeExtensions";
	for (const [name, words] of [
		["BASH", `"BASH" matches, ignoring case, one of pi's own tools, which this key does not take: run.excludeTools removes pi's, spelled "bash"; ${wayOut}`],
		["Codemode", `"Codemode" matches, ignoring case, one of the MCP tools, which this key does not take: on a trigger with run.mcp, run.excludeTools removes those, spelled "codemode"; ${wayOut}`],
		["MCP__X__Y", `"MCP__X__Y" starts, ignoring case, like a server's tool, which this key does not take: on a trigger whose run.mcp names that server, run.excludeTools removes its tools all at once, as mcp__<server>__*; ${wayOut}`],
		["Report_Progress", `"Report_Progress" matches, ignoring case, the name of a tool pi-dispatch gives some jobs, which this key does not take; ${wayOut}`],
	]) assert.throws(load(name), (e) => e.message.includes(words), name);
	// A job's own tool: none of these says a run field arms it, since a role map arms `subagent` and a label trigger's draft arms `decide` and `read_repository`.
	for (const name of ["subagent", "decide", "read_repository", "report_progress"]) assert.throws(load(name), (e) => e.message.includes("matches, ignoring case, the name of a tool pi-dispatch gives some jobs, which this key does not take; to remove a staged package's or an overlay extension's tool of that name, put that package's or extension's name in run.excludeExtensions") && !/run field|turn that field off/.test(e.message), name);
	for (const tool of LOADED_JOB_TOOLS.filter((name) => !MCP_EXCLUDABLE_TOOL_NAMES.has(name))) assert.throws(load(tool.toUpperCase()), /a tool pi-dispatch gives some jobs/, `${tool}, in any case`);
	assert.deepEqual(parse([KINDS[1][1]({ excludeExtensionTools: ["lint_run", "Search-Web", "Bashful", "read_all"] })])[0].run.excludeExtensionTools, ["lint_run", "Search-Web", "Bashful", "read_all"], "a name of its own, in any case, is an extension's");
});

test("a near miss of either key refuses under run, every spelling refuses under on, and neither reads as a near miss of the other or of run.excludeTools", () => {
	for (const [field, misses] of [
		// Case and separators, then a plural or a participle, the word cut short, and a slip of a letter, of two letters and of the two crossed.
		["excludeExtensions", ["exclude_extensions", "exclude-extensions", "EXCLUDEEXTENSIONS", "excludeExtension", "excludedExtensions", "excludeExtensiоns", "excludedExtension", "excludeExt", "excludeExts", "exclude_ext", "excludedExt", "excludeExtentions", "exludeExtensions", "excludeExtensoins", "excludesExtensions", "excludeExtensionss", "exludeExtentions", "excludedExtentions"]],
		["excludeExtensionTools", ["exclude_extension_tools", "exclude-extension-tools", "EXCLUDEEXTENSIONTOOLS", "excludeExtensionTool", "excludedExtensionTools", "excludeExtensionsTools", "excludedExtensionTool", "excludedExtensionsTools", "excludeExtTools", "excludeExtTool", "excludeExtsTools", "exclude_ext_tools", "excludeExtensionTols", "exludeExtensionTools", "excludeExtentionTools", "exludeExtentionTools"]],
	]) {
		for (const miss of misses) assert.throws(() => parse([KINDS[1][1]({ [miss]: ["x"] })]), new RegExp(`did you mean run\\.${field}`), miss);
		assert.throws(() => parse([KINDS[1][1]({}, { [field]: ["x"] })]), new RegExp(`on\\.${field} is not a field`));
	}
	assert.equal(excludeToolsNearMiss("excludeExtensionTools"), false);
	assert.equal(excludeExtensionsNearMiss("excludeExtensionTools"), false);
	assert.equal(excludeExtensionToolsNearMiss("excludeExtensions"), false);
	assert.equal(excludeExtensionsNearMiss("excludeTools"), false);
	assert.equal(excludeExtensionToolsNearMiss("excludeTools"), false);
	assert.equal(excludeToolsNearMiss("excludeToolz"), false, "run.excludeTools' sweep takes no slips: a file of that key loads today, and must load tomorrow");
	for (const key of ["exclude", "excluded", "excludes", "extensions", "tools", "excludeList", "excludeFiles", "excluder", "extensionTools", "denyExtensions"]) {
		assert.equal(excludeExtensionsNearMiss(key), false, key);
		assert.equal(excludeExtensionToolsNearMiss(key), false, key);
	}
	assert.deepEqual(parse([KINDS[1][1]({ excludeTools: ["bash"], excludeExtensions: ["a"], excludeExtensionTools: ["b"] })])[0].run.excludeTools, ["bash"], "all three together");
});

test("no key the loader or a worker reads is a near miss of an exclusion's: every run and on key, against all three sweeps", () => {
	// Every `run.<key>` and `on.<key>` any worker or receiver module reads, the lenient superset store-versions-files.test.mjs uses for the version tables, and the console's own list of what it edits.
	const keys = new Set(CARD_FIELDS);
	for (const dir of ["worker", "receiver"]) {
		for (const name of readdirSync(new URL(`../../${dir}/src/`, import.meta.url))) {
			if (!name.endsWith(".mjs")) continue;
			for (const m of readFileSync(new URL(`../../${dir}/src/${name}`, import.meta.url), "utf8").matchAll(/\b(?:run|on)\??\.(\w+)/g)) keys.add(m[1]);
		}
	}
	for (const key of ["excludeTools", "excludeExtensions", "excludeExtensionTools", "models", "fallbackModels", "maxCostUsd", "packages", "image", "skillsDir", "type", "action"]) assert.ok(keys.has(key), `${key} was found`);
	const sweeps = { excludeTools: excludeToolsNearMiss, excludeExtensions: excludeExtensionsNearMiss, excludeExtensionTools: excludeExtensionToolsNearMiss };
	for (const key of keys) {
		for (const [field, sweep] of Object.entries(sweeps)) assert.equal(sweep(key), key === field, `${key} against run.${field}'s sweep`);
	}
	// And in the file: a real key beside either exclusion loads, rather than reading as a misspelling of it.
	const [entry] = parse([KINDS[1][1]({ excludeTools: ["bash"], excludeExtensions: ["a"], excludeExtensionTools: ["b"], packages: false, image: "pi-job:x", models: ["anthropic/claude-haiku-4-5"] })]);
	assert.deepEqual(entry.run.excludeExtensions, ["a"]);
});

test("each field needs file version 2 by itself: an older loader would drop it, so one written by hand with no stamp refuses, and the writer stamps it", () => {
	assert.equal(TRIGGERS_FILE_VERSION, 3, "issue #888's three limits need 3; these two still need 2 by themselves");
	assert.deepEqual(TRIGGER_RUN_FIELD_VERSIONS, { excludeExtensions: 2, excludeExtensionTools: 2, idleTimeoutMinutes: 3, stallTimeoutMinutes: 3, maxMinutes: 3 });
	for (const field of ["excludeExtensions", "excludeExtensionTools"]) {
		const entry = KINDS[1][1]({ [field]: ["x"] });
		assert.throws(() => parseTriggers(JSON.stringify({ triggers: [entry] }), "/t"), (e) => e.newer === undefined && e.message === `trigger at index 0: run.${field} needs triggers file version 2, and the file declares 1: /t`);
		assert.equal(triggersFileVersionFor({ triggers: [entry] }), 2);
		assert.ok(AUTHORED_NARROWING_FIELDS.some((row) => row.key === field), field);
		assert.equal(AUTHORED_NARROWING_FIELDS.find((row) => row.key === field).authored(["x"]), true);
		assert.equal(AUTHORED_NARROWING_FIELDS.find((row) => row.key === field).authored([]), false, "an empty list narrows nothing");
		assert.equal(JOB_DATA_FIELD_VERSIONS[field], 3);
		const path = join(tempDir("exclude-extensions-"), "triggers.json");
		writeFileSync(path, JSON.stringify({ triggers: [] }));
		assert.deepEqual(writeTriggers({ triggersPath: path, mutate: () => [entry] }), { ok: true });
		assert.equal(JSON.parse(readBack(path)).version, 2, "the writer's own stamp");
		assert.deepEqual(writeTriggers({ triggersPath: path, mutate: () => [KINDS[1][1]()] }), { ok: true });
		assert.equal(Object.hasOwn(JSON.parse(readBack(path)), "version"), false, "and a file that no longer needs it goes back to its old bytes");
	}
	assert.equal(triggersFileVersionFor({ triggers: [KINDS[1][1]({ excludeTools: ["bash"] })] }), 1, "run.excludeTools needs nothing, so no existing file moves");
});
test("a job that arrived without a field its entry authors is refused by name, each field alone, and an empty list authors nothing", async () => {
	const fileOf = (run) => ({ readFileSync: () => JSON.stringify({ version: 2, triggers: [{ on: { type: "label", any: ["pi"] }, run: { kind: "github", flow: "f", ...run } }] }) });
	const arrived = (extra = {}) => ({ trigger: { matched: { index: 0, type: "label" } }, kind: "github", flow: "f", ...extra });
	for (const field of ["excludeExtensions", "excludeExtensionTools"]) {
		const check = makeCheckWaitSkew({ triggersPath: "/t.json", fs: fileOf({ [field]: ["x"] }) });
		assert.deepEqual(await check(arrived()), { skewed: true, field }, "a stale receiver or a dead inode dropped it");
		assert.deepEqual(await check(arrived({ [field]: null })), { skewed: true, field });
		assert.deepEqual(await check(arrived({ [field]: ["x"] })), { ok: true });
	}
	// Where the docs say "where it can read the file": a worker that cannot runs what a receiver queued without the field, and one that reads less waits on a stamped file.
	const unreadable = makeCheckWaitSkew({ triggersPath: "/t.json", fs: { readFileSync: () => { throw new Error("ENOENT"); } } });
	assert.deepEqual(await unreadable(arrived()), { ok: true });
	const newer = makeCheckWaitSkew({ triggersPath: "/t.json", fs: { readFileSync: () => JSON.stringify({ version: TRIGGERS_FILE_VERSION + 1, triggers: [] }) } });
	assert.deepEqual(await newer(arrived()), { newer: true });
});

test("a watch rule refuses both keys by the rule it always had: its data is built by name, and a watch job never carries them", () => {
	const doc = (extra) => JSON.stringify({ version: 2, watchSources: { prod: { verify: "hmac-sha256", secretEnv: "WATCH_SECRET" } }, triggers: [{ on: { type: "watch", id: "errors", source: "prod", fingerprint: ["service"], window: "10m", cooldown: "6h", maxPerDay: 4 }, run: { kind: "local", mode: "investigate", folder: "/p", flow: "f", task: "t", maxCostUsd: "1", ...extra } }] });
	assert.equal(parseTriggers(doc({}), "/t").length, 1, "the premise: the rule loads without them");
	for (const field of ["excludeExtensions", "excludeExtensionTools"]) assert.throws(() => parseTriggers(doc({ [field]: ["x"] }), "/t"), /unsupported run field/, field);
});

test("job data: each field rides conditionally, stamps version 3, and an unflagged job's bytes do not move", async () => {
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
	assert.deepEqual([ext.excludeExtensions, ext.dataVersion, "excludeExtensionTools" in ext], [["pi-lint"], 3, false], "one alone is not folded into the other's conditional");
	assert.deepEqual([tool.excludeExtensionTools, tool.dataVersion, "excludeExtensions" in tool], [["lint_run"], 3, false]);
	assert.deepEqual([local.excludeExtensions, local.excludeExtensionTools, local.dataVersion], [["pi-lint"], ["lint_run"], 3]);
	assert.ok(!JSON.stringify(ext.trigger).includes("pi-lint"), "at job level, never in `trigger`, which becomes /job/event.json");
	assert.equal(jobDataVersionFor({ excludeTools: ["bash"] }), 1);
});

/**
 * What a host on a release that reads job data 2 holds of the job data table. Written out, because the point is the bytes of that release and not this one's:
 * a later row moving the real table must leave this standing for that host.
 */
const READS_JOB_DATA_2 = Object.freeze({ supported: 2, table: Object.freeze({ packageCanary: 2 }) });

test("a host that reads only version 2 knows a canary and not these two: such a job waits there, and a stored message is not rebuilt without them", async () => {
	const fake = () => {
		const adds = [];
		return { adds, add: async (_name, data, opts) => (adds.push(data), { id: opts.jobId }) };
	};
	const forge = { repo: "acme/web", target: { type: "issue", number: 7 }, flow: "fix", trigger: { deliveryId: "d-reads-2", sender: { id: 1 } } };
	assert.equal(jobDataNewer({ ...forge, excludeExtensions: ["pi-lint"], excludeExtensionTools: ["lint_run"], dataVersion: 2 }, READS_JOB_DATA_2), null, "the premise: stamped 2, that host reads such a job as its own, and ignores both fields");
	for (const [field, value] of [["excludeExtensions", ["pi-lint"]], ["excludeExtensionTools", ["lint_run"]]]) {
		const q = fake();
		await enqueueForgeJob(q, "github", { ...forge, [field]: value });
		const stored = q.adds[0];
		assert.deepEqual(jobDataNewer(stored, READS_JOB_DATA_2), { version: 3 }, `${field}: it waits, spending nothing, for a worker that can read it`);
		assert.equal(jobDataNewer(stored), null, `${field}: and this build reads what it wrote`);
		// A message stored for later, picked up by that host: its builder refuses, and the caller answers with a reply rather than a job with the field gone.
		await assert.rejects(enqueueLateForgeJob(q, "github", stored, { dataVersions: READS_JOB_DATA_2 }), (e) => e.code === "newer-release", field);
		assert.equal(q.adds.length, 1, `${field}: nothing was queued there`);
	}
	const canary = withJobDataVersion({ ...forge, packageCanary: { name: "a", version: "1.0.0" } });
	assert.equal(canary.dataVersion, 2, "a canary is still what that host reads");
	assert.equal(jobDataNewer(canary, READS_JOB_DATA_2), null);
	assert.equal(withJobDataVersion({ ...canary, excludeExtensions: ["pi-lint"] }).dataVersion, 3, "and beside one of these, the higher need is the job's");
	assert.equal(jobDataVersionFor({ excludeTools: ["bash"], packages: false }), 1, "and a job of what that host already knows stays unstamped");
});

test("a job data field added after that release takes a version that host cannot read", () => {
	// The whole of the defect in one line: a row at or below what a running host reads turns that host's gate off for exactly the field it would drop.
	for (const [field, version] of Object.entries(JOB_DATA_FIELD_VERSIONS)) {
		if (Object.hasOwn(READS_JOB_DATA_2.table, field)) assert.equal(version, READS_JOB_DATA_2.table[field], `${field} keeps the version that host reads it at`);
		else assert.ok(version > READS_JOB_DATA_2.supported, `${field} is at ${version}, which that host reads as its own and then drops`);
	}
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

test("doctor's flow tier: a package with glob entries a trigger leaves out is no doubt, and one it keeps still is", async () => {
	const world = { fileExists: () => false, overlay: "/overlay", staged: { skills: [], unenumerable: ["@acme/glob", "@acme/other"] }, repoFlowAtHead: async () => "absent" };
	const kept = await flowTierOf({ flow: "fix", folder: "/srv" }, world);
	assert.equal(kept.tier, "unknown", "the premise: its globs might hold the flow");
	assert.deepEqual(kept.unknown, ["staged package(s) @acme/glob, @acme/other (manifest patterns, not enumerable here)"]);
	const one = await flowTierOf({ flow: "fix", folder: "/srv", excludeExtensions: ["@acme/glob"] }, world);
	assert.equal(one.tier, "unknown");
	assert.deepEqual(one.unknown, ["staged package(s) @acme/other (manifest patterns, not enumerable here)"], "only the one it keeps");
	const both = await flowTierOf({ flow: "fix", folder: "/srv", excludeExtensions: ["@acme/glob", "@acme/other"] }, world);
	assert.equal(both.tier, "none", "a flow nothing this trigger loads can hold is found in no tier, as a staged skill it leaves out is");
	assert.deepEqual(both.unknown, []);
	assert.ok(both.checked.includes("staged packages"));
	const hit = await flowTierOf({ flow: "fix", folder: "/srv", excludeExtensions: ["@acme/glob"] }, { ...world, staged: { skills: [{ name: "fix", package: "pi-lint" }], unenumerable: ["@acme/glob"] } });
	assert.deepEqual([hit.tier, hit.package], ["package", "pi-lint"]);
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
	assert.ok(labels.some((label) => /^mini2 reads the jobs this host's triggers queue only below version 3/.test(label)), JSON.stringify(labels));
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

test("excluding a subscription connection's adapter refuses for free at the pickup, as withholding the packages does, read off the real policy", async () => {
	const community = Object.entries(COMMUNITY_AUTH_ADAPTERS).filter(([, adapter]) => adapter.provider === "anthropic");
	assert.ok(community.length >= 2, "the premise: more than one to tell apart");
	for (const [key, adapter] of community) {
		// What the real parser hands the auth service for a connection, so the row's `adapter` is the shape production has: the policy's key.
		const policy = parseAuthConnections({ version: 1, connections: [{ id: "c", provider: "anthropic", adapter: key, ownerHost: "h", root: `/overlay/packages/${adapter.package}`, digest: "a".repeat(64) }], bindings: { anthropic: "c" } });
		const [connection] = policy.connections;
		assert.equal(connection.adapter, key);
		const row = { ok: true, managed: true, ...connection };
		const runtime = makeSubscriptionRuntime({
			auth: { check: async () => row },
			quota: { admit: async () => { throw new Error("nothing past this refusal may run"); } },
			lookup: () => ({ api: "anthropic-messages", baseUrl: "https://x" }),
			packageRootFor: () => { throw new Error("nothing past this refusal may run"); },
		});
		const job = { provider: "anthropic", model: "m", models: ["anthropic/m"] };
		assert.deepEqual(await runtime.check({ ...job, packages: false }), { ok: false, managed: true, reason: "auth-adapter-disabled" }, "the premise");
		// What a trigger can write: the loader takes the package's name and refuses the policy's key, so the second is no way to name it.
		assert.deepEqual(parse([KINDS[1][1]({ excludeExtensions: [adapter.package] })])[0].run.excludeExtensions, [adapter.package]);
		assert.throws(() => parse([KINDS[1][1]({ excludeExtensions: [key] })]), /run\.excludeExtensions/, key);
		assert.deepEqual(await runtime.check({ ...job, excludeExtensions: ["pi-lint", adapter.package] }), { ok: false, managed: true, reason: "auth-adapter-disabled" }, adapter.package);
		await assert.rejects(runtime.check({ ...job, excludeExtensions: ["another"] }), /nothing past this refusal may run/, "another name is not this package");
		for (const [otherKey, other] of community) {
			if (otherKey !== key) await assert.rejects(runtime.check({ ...job, excludeExtensions: [other.package] }), /nothing past this refusal may run/, "another connection's adapter is not this connection's");
		}
		await assert.rejects(runtime.check({ ...job, excludeExtensions: [] }), /nothing past this refusal may run/);
		// The console's sentence on the same names, so the two cannot come apart: it says a job on that connection is refused, and this is the refusal.
		assert.equal(isSubscriptionAdapter(adapter.package), true);
	}
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
	// The boundary, in every place that promises what exclusion does, and said in full in one of them. "With a shell" undersold it: `write` alone reaches pi's settings.
	for (const path of ["docs/exclude-tools.md", "docs/global-pi-overlay.md", "docs/triggers.md", "SECURITY.md", "specs/requirements.md", "specs/interfaces.md", "specs/design.md"]) {
		const said = flat(path);
		assert.ok(said.includes("an agent that can write or edit files, or run commands"), path);
		assert.doesNotMatch(said, /an agent with a shell|also removes its shell/, path);
	}
	for (const path of ["docs/global-pi-overlay.md", "docs/triggers.md", "SECURITY.md"]) assert.ok(flat(path).includes("exclude-tools.md#what-exclusion-does-not-stop"), path);
	const boundary = doc.slice(doc.indexOf("## What exclusion does not stop"), doc.indexOf("## Versions and older hosts"));
	assert.ok(flat("docs/exclude-tools.md").includes("A correct name can stop a job too, in four ways"), "the fourth is a canary whose candidate no longer brings the tool");
	assert.ok(flat("docs/exclude-tools.md").includes("A package canary stops when its candidate no longer brings the tool"));
	assert.ok(flat("docs/exclude-tools.md").includes("$0 if no call was made, and what the calls cost if the line holds their usage. Otherwise at least the reservation stands."));
	for (const said of ["**An extension baked into an image cannot be named.**", "`~/.pi/agent/settings.json`", "`~/.pi/agent/extensions/`", "`write` alone, with no shell", "Removing `bash` is not enough", "neither is removing `bash`, `powershell` and `write`", "(`bash`, `powershell`, `write`, `edit`)", "`~/.pi/agent/auth.json`", "`/opt/pi-global`", "A third-party subagent package's own child", "A person's re-run of a chained child", "`tools: [bash]`", "`../outside.js`", "`import`"]) assert.ok(boundary.includes(said), said);
	// `image/runner/test/role-child-exclusions.integration.test.mjs` runs each route on the real tools, and with all four removed.
	assert.doesNotMatch(boundary, /\(`bash`, `powershell`, `write`\)/, "the three that leave `edit` holding a route");
	assert.doesNotMatch(flat("specs/design.md"), /Removing the tools that run commands and write files does/);
	// "Stops what a job loads" is true of one key: removing a tool leaves its extension's code running.
	assert.ok(boundary.includes("`run.excludeExtensionTools` and `run.excludeTools` take tools out of the session and stop nothing from loading"));
	assert.doesNotMatch(doc, /Both of these keys stop what a job loads/);
	// The versions, wherever a sentence said no file needs one yet, and what a fleet needs, off the tables themselves.
	assert.doesNotMatch(flat("docs/triggers.md"), /Nothing needs one yet/);
	assert.doesNotMatch(flat("docs/multi-host.md"), /Today no file needs more than version 1/);
	const upgrading = flat("docs/upgrading.md");
	assert.doesNotMatch(upgrading, /No field needs one yet|No file needs more than version 1 yet/);
	const fleet = readFileSync(new URL("../../docs/upgrading.md", import.meta.url), "utf8");
	const section = fleet.slice(fleet.indexOf("### What a fleet needs before a trigger leaves something out"), fleet.indexOf("## Valkey and BullMQ"));
	assert.ok(section.includes(`\`triggers.json\` at version ${TRIGGER_RUN_FIELD_VERSIONS.excludeExtensions} and job data at version ${JOB_DATA_FIELD_VERSIONS.excludeExtensions}`), "the versions the section opens with");
	assert.equal(TRIGGER_RUN_FIELD_VERSIONS.excludeExtensions, TRIGGER_RUN_FIELD_VERSIONS.excludeExtensionTools);
	assert.equal(JOB_DATA_FIELD_VERSIONS.excludeExtensions, JOB_DATA_FIELD_VERSIONS.excludeExtensionTools);
	const fleetRows = section.split("\n").filter((line) => line.startsWith("| ")).slice(1).map((line) => line.split(" | ")[0].slice(2));
	assert.deepEqual(fleetRows, ["Worker", "Receiver", "Panel, console, `/dispatch`"], "who a fleet upgrades, each with what an older one does");
	for (const said of ["`trigger-skew`", "`fleet.store-versions`", "`job-image-load-exclusions-unsupported`", "`loadExclusions`", "role map"]) assert.ok(section.includes(said), said);
	// Which release reads both is this section's to say, and it has to be true of the packages. No release reads `version` and less than these, since both arrive in 5.0.0;
	// a build from `main` between #761 and #800 does, and what it does is held off the real parsers in the test above and below.
	assert.ok(section.includes("5.0.0 is the first release that reads both"), "the section names the release");
	assert.ok(Number(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version.split(".")[0]) >= 5, "and the worker is at least that release");
	const flatSection = section.replace(/\s+/g, " ");
	for (const key of ["excludeTools", "packages"]) assert.equal(triggersFileVersionFor({ triggers: [KINDS[1][1]({ [key]: key === "packages" ? false : ["bash"] })] }), 1, `${key}: what the section offers until then needs no version`);
	for (const said of ["Until then leave both out of the file: `\"packages\": false` and `run.excludeTools` need neither version.", "**Once either is used, no 4.3.1 writer may touch the file**", "**A file that lost its stamp.**", "one-shot disarm", "A 4.3.1 host loads it and drops both keys", "5.0.0 refuses that file (`run.excludeExtensions needs triggers file version 2`, or the other key's name)", "A write from the 5.0.0 console or `/dispatch` puts the stamp back", "No release this old has a console", "It reads live workers alone: a receiver has no row in the worker registry and a stopped worker's row expires", "where it can read the file", "whoever maintains it rebuilds it from 5.0.0 or later"]) assert.ok(flatSection.includes(said), said);
	for (const wrong of ["so deliveries in between match nothing", "a release that reads `version` then refuses the file", "reads `version` and less", "The release after 5.0.0", "comes after 5.0.0"]) assert.ok(!flatSection.includes(wrong), wrong);
	assert.doesNotMatch(upgrading, /Deliveries in between match nothing/);
	assert.ok(flat("docs/multi-host.md").includes("job data at version 3, and a live peer reads less or publishes nothing"));
	assert.doesNotMatch(flat("docs/triggers.md"), /which a writer stamps/);
	assert.doesNotMatch(flat("docs/exclude-tools.md"), /another run field arms/);
	assert.ok(flat("docs/exclude-tools.md").includes("`subagent` and the rest). To remove a staged package's or an overlay extension's tool of such a name, put that package's or extension's name in `run.excludeExtensions`"));
	assert.doesNotMatch(flat("specs/interfaces.md"), /which another run field arms/);
	assert.ok(flat("docs/reasons.md").includes("What to do: This job goes without the connection's adapter, so reconnecting cannot help."));
	// What the design says of the same, and where its variables are: a job's inputs hold neither.
	const designText = flat("specs/design.md");
	assert.ok(designText.includes("ship in 5.0.0 with #761 and are used only once every host reads them"));
	assert.ok(designText.includes("must not be used until every host, and every panel and console that writes the store, runs issue #761's release or later"));
	assert.ok(designText.includes("On a file that lost its stamp it loads the file and drops both, and 5.0.0 refuses that shape."));
	assert.doesNotMatch(designText, /a 4\.3\.1 panel, console or disarm|every file today/);
	assert.match(designText, /Traces to\*\*: `REQ-PER-TRIGGER-TOOL-EXCLUSIONS`, `INT-TRIGGERS-FILE-CONTRACT`, `INT-CONTAINER-RUNTIME-CONTRACT`/);
	const interfacesText = flat("specs/interfaces.md");
	assert.doesNotMatch(interfacesText, /before a table has a row|a worker at the tag|`INT-CONTAINER-JOB-INPUTS` AMENDED\*\*: `PI_EXCLUDE_EXTENSIONS`/);
	assert.ok(interfacesText.slice(interfacesText.indexOf("## INT-CONTAINER-RUNTIME-CONTRACT"), interfacesText.indexOf("## INT-CONTAINER-RUNTIME-CONTRACT") + 60000).includes("`PI_EXCLUDE_EXTENSIONS`"), "the variables are in the contract the spec names");
	assert.match(upgrading, /3\. \*\*Upgrade the job image\.\*\* Pull the release's image and point `PI_JOB_IMAGE` at it\. An image a trigger names in `run\.image` moves too/, "the order's own step, which said PI_JOB_IMAGE alone");
		assert.match(doc, /\| 5\.0\.0 or later \| It runs the job as the file says \| It refuses the file: `run\.excludeExtensions needs triggers file version 2` \|/);
	assert.doesNotMatch(doc, /every writer stamps|the file refuses to load/);
	const requirement = flat("specs/requirements.md");
	assert.ok(requirement.includes("5.0.0 refuses a file that lost its stamp (a 4.3.1 writer's or disarm's, or a hand edit)"));
	assert.ok(requirement.includes("no 4.3.1 writer may touch the file once either is used"));
	assert.ok(fleet.indexOf("### What a fleet needs before a trigger leaves something out") > fleet.indexOf("## Mixed versions: what is safe"));
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
	// The one refusal these words are of, each shape that reaches it: a file's exclusion or `packages: false`, and no other (`subscription-runtime.mjs`). Reconnecting mends neither.
	const adapter = explainReason("auth-adapter-disabled");
	for (const way of ["`run.excludeExtensions`", '`"packages": false`', "reconnecting cannot help"]) assert.ok(adapter.next.includes(way), way);
	// Of a job with no role map on an image with no role machinery, too: the sentence names neither the keys nor a child.
	const image = explainReason("job-image-load-exclusions-unsupported");
	assert.ok(image.sentence.includes("this job's exclusions, so its runner would not honour them"));
	assert.doesNotMatch(image.sentence, /role child|run\.exclude/);
	const gate = CAPABILITY_GATES.find((row) => row.token === "loadExclusions");
	assert.doesNotMatch(gate.comment("pi-job:old", "lacks it"), /role child|run\.exclude/);
	assert.ok(gate.comment("pi-job:old", "lacks it").includes("this job's exclusions"));
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
	// A trusted line that holds a call's usage is believed too: the docs' "what the calls cost", from the worker's own function.
	assert.deepEqual(dollarSettlement({ tokens: cleanTokens({ ...meter, calls: 1, cost: 0.25 }), usage: { models: {} }, reservedMicros, trusted: true }), { settledMicros: 250_000, basis: "metered" });
});
