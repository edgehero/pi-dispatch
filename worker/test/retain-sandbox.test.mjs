import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildLocalEventJob } from "../src/local-event.mjs";
import { localRunData } from "../src/local-job.mjs";
import { makeCleanup } from "../src/prepare.mjs";
import { runJob } from "../src/processor.mjs";
import { makeSandboxReaper, sandboxEntryName, SANDBOX_MANIFEST } from "../src/sandbox-store.mjs";
import { parseTriggers, TRIGGERS_FILE_VERSION, triggersFileVersionFor } from "../src/triggers.mjs";
import { checkTriggersText } from "../src/triggers-check.mjs";
import { makeCheckQuotaReserve, makeCheckRetainSandbox } from "../src/triggers-file.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #1023: `run.retainSandbox: false`, a local command trigger's way to say its runs keep no sandbox. The loader's
// rule, the worker's read of the flag when a run ends (from real triggers files), the cleanup that acts on it (on real
// directories) and the processor that hands it the job.

const flag = (value) => (value === undefined ? {} : { retainSandbox: value });
const cronCommand = (value, more = {}) => ({ on: { type: "cron", id: "sync", pattern: "*/5 * * * *" }, run: { kind: "local", folder: "/srv/app", command: "sync now", ...flag(value), ...more } });
const localEvent = (value, more = {}) => ({ on: { type: "pull_request", forge: "github", id: "maint", action: ["opened"] }, run: { kind: "local", worker: "owner", folder: "/srv/maint", command: "maintain", ...flag(value), ...more } });
const cronFlow = (value) => ({ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv/app", flow: "fix", task: "Fix the build", ...flag(value) } });
const WATCH_SOURCES = { watchSources: { prod: { verify: "hmac-sha256", secretEnv: "WATCH_SECRET" } } };
const watchRule = (value) => ({ on: { type: "watch", id: "errors", source: "prod", fingerprint: ["service"], minCount: 1, window: "1s", cooldown: "1m", maxPerDay: 1 }, run: { kind: "local", folder: "/srv/w", flow: "triage", task: "Investigate", maxCostUsd: "0.40", ...flag(value) } });
/** Every kind of trigger that is NOT a local command, each valid without the flag. */
const NOT_LOCAL_COMMANDS = [
	["a cron trigger that runs a flow", cronFlow],
	["a label trigger", (value) => ({ on: { type: "label", any: ["deploy"] }, run: { kind: "github", flow: "deploy", ...flag(value) } })],
	["a comment trigger", (value) => ({ on: { type: "comment", phrase: "@pi" }, run: { kind: "github", flow: "fix", ...flag(value) } })],
	["an issue trigger", (value) => ({ on: { type: "issue", action: ["closed"] }, run: { kind: "github", flow: "deploy", ...flag(value) } })],
	["a pull request trigger", (value) => ({ on: { type: "pull_request", action: ["opened", "synchronize"] }, run: { kind: "github", flow: "review", ...flag(value) } })],
	["a forge job that runs a command", (value) => ({ on: { type: "label", any: ["deploy"] }, run: { kind: "github", command: "deploy now", ...flag(value) } })],
	["a comment trigger on another forge", (value) => ({ on: { type: "comment", phrase: "@pi" }, run: { kind: "gitlab", flow: "fix", ...flag(value) } })],
];
const load = (entry, extra = {}) => parseTriggers(JSON.stringify({ version: TRIGGERS_FILE_VERSION, ...extra, triggers: [entry] }), "/t.json");

test("run.retainSandbox is taken on a local command trigger, a cron one and a forge event's, and is never part of a job (#1023)", () => {
	for (const entry of [cronCommand(false), cronCommand(true), localEvent(false), localEvent(true)]) {
		const [trigger] = load(entry);
		assert.equal(Object.hasOwn(trigger.run, "retainSandbox"), false, `${entry.on.type} ${entry.run.retainSandbox}: read live, never normalized`);
	}
	assert.deepEqual(load(cronCommand(false)), load(cronCommand()), "a flagged entry normalizes to exactly the unflagged one");
	assert.deepEqual(load(localEvent(false)), load(localEvent()));
	// So neither builder of a local command job can carry it.
	assert.doesNotMatch(JSON.stringify(localRunData(load(cronCommand(false))[0].run)), /retainSandbox/);
	assert.doesNotMatch(JSON.stringify(buildLocalEventJob(load(localEvent(false))[0], "b".repeat(32))), /retainSandbox/);
});

test("run.retainSandbox is a strict boolean: a string \"false\" is refused, not read as the flag (#1023)", () => {
	for (const value of ["false", "true", 0, 1, null, {}, []]) {
		assert.throws(() => load(cronCommand(value)), /trigger at index 0: run\.retainSandbox must be true or false/, `cron ${JSON.stringify(value)}`);
		assert.throws(() => load(localEvent(value)), /run\.retainSandbox must be true or false/, `local event ${JSON.stringify(value)}`);
	}
});

test("run.retainSandbox is refused, by key and with the reason, on every trigger that is not a local command (#1023)", () => {
	for (const [name, entry] of NOT_LOCAL_COMMANDS) {
		assert.doesNotThrow(() => load(entry()), `${name} loads without the flag`);
		for (const value of [false, true]) {
			assert.throws(() => load(entry(value)), /trigger at index 0: run\.retainSandbox is only available on a local command trigger \(run\.kind "local" with run\.command, on a cron trigger or a forge event\): a kept sandbox is what lets a flow's run or a forge job be reopened and continued/, `${name}, ${value}`);
		}
	}
	// A watch rule, the one kind where every loader, an older one too, refuses a run key it does not know.
	assert.doesNotThrow(() => load(watchRule(), WATCH_SOURCES));
	for (const value of [false, true]) assert.throws(() => load(watchRule(value), WATCH_SOURCES), /run\.retainSandbox is not available on a watch rule/, String(value));
});

test("a local command run can be none of the things that need a kept directory later (#1023)", () => {
	// The flag keeps nothing on any outcome, which is only sound because such a run can never be resumed, recovered,
	// steered through its trigger, parked for an answer or held for an approval. Each is refused by its own rule, in
	// that rule's own words; if one of those rules is ever relaxed, this is where the flag has to be thought through again.
	const refusals = [
		["resume", true, /combining run\.command and run\.resume is not yet covered/],
		["recover", true, /run\.recover is only available on a forge trigger/],
		["steer", true, /run\.steer cannot be set beside run\.command/],
		["awaitInput", true, /run\.awaitInput needs run\.resume: true beside it/],
		["gates", ["deploy"], /run\.gates requires a resumable forge flow/],
	];
	for (const [key, value, sentence] of refusals) {
		assert.throws(() => load(cronCommand(false, { [key]: value })), sentence, `a cron command with run.${key}`);
		assert.throws(() => load(localEvent(false, { [key]: value })), sentence, `a local event command with run.${key}`);
	}
});

test("a run key the loader does not know is dropped on a cron trigger and on a local event, and refused on a watch rule (#1023)", () => {
	// What "needs no version" rests on, held on today's loader: a release from before the field met it as exactly such
	// a key. It loads the file where the field may be written and leaves the key out of what it normalizes, so that
	// worker keeps the sandbox, the default. The one kind that refuses an unknown key is the one this field is refused on.
	const unknown = { someLaterField: false };
	for (const entry of [cronCommand(undefined, unknown), localEvent(undefined, unknown)]) {
		const [trigger] = load(entry);
		assert.equal(Object.hasOwn(trigger.run, "someLaterField"), false, `${entry.on.type}: dropped`);
		assert.deepEqual(trigger, load({ ...entry, run: { ...entry.run, someLaterField: undefined } })[0], "and the entry is what it is without the key");
	}
	assert.throws(() => load({ ...watchRule(), run: { ...watchRule().run, ...unknown } }, WATCH_SOURCES), /^Error: watch: unsupported run field/);
	// And the field raises no version: a file needs for it what it needs without it, so the same older loaders read it.
	assert.equal(triggersFileVersionFor({ triggers: [cronCommand(false)] }), 1);
	assert.equal(triggersFileVersionFor({ triggers: [localEvent(false)] }), triggersFileVersionFor({ triggers: [localEvent()] }));
	// The same rule is why a key in the wrong place, or misspelled, loads and does nothing: the sandbox is kept.
	const misplaced = [
		{ ...cronCommand(), on: { ...cronCommand().on, retainSandbox: false } },
		cronCommand(undefined, { retainsandbox: false }),
		cronCommand(undefined, { retainSandboxes: false }),
		{ ...cronCommand(), retainSandbox: false },
	];
	for (const entry of misplaced) {
		assert.doesNotThrow(() => load(entry), JSON.stringify(entry));
		assert.equal(makeCheckRetainSandbox({ triggersPath: triggersFile([entry]) })(cronJob()), true, `kept: ${JSON.stringify(entry)}`);
	}
});

test("pi-dispatch triggers check takes the flag where it belongs and reports a misplaced one like any refused key (#1023)", () => {
	const folder = tempDir("retain-sandbox-check-");
	const here = (entry) => ({ ...entry, run: { ...entry.run, folder } });
	const judge = (triggers) => checkTriggersText(JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers }), "/d/triggers.json", { env: { PI_TRIGGERS_FILE: "/d/triggers.json", GITHUB_INGEST: "poll" }, now: () => Date.parse("2026-11-23T12:00:00Z") });
	const good = judge([here(cronCommand(false)), here(localEvent(false))]);
	assert.deepEqual(good.refusals, [], "every reader takes it");
	const bad = judge([here(cronCommand(false)), here(cronFlow(false))]);
	assert.equal(bad.refusals.length, 1, "one refusal, said once for every reader");
	assert.ok(bad.refusals[0].readers.includes("worker") && bad.refusals[0].readers.includes("receiver"), "the worker and the receiver both refuse the file");
	assert.match(bad.refusals[0].reason, /trigger at index 1: run\.retainSandbox is only available on a local command trigger/);
	// A key in the wrong place, or misspelled, is not the field but a key the file does not know: the check answers
	// what it answers for the file without it, word for word. The trigger's page is where its absence shows.
	const plain = judge([here(cronCommand())]);
	assert.deepEqual([plain.ok, plain.refusals, plain.notes], [true, [], []]);
	const stray = [{ on: { retainSandbox: false } }, { run: { retainsandbox: false } }, { run: { retainSandboxes: false } }, { retainSandbox: false }];
	for (const { on = {}, run = {}, ...beside } of stray) {
		const entry = here(cronCommand());
		assert.deepEqual(judge([{ ...entry, ...beside, on: { ...entry.on, ...on }, run: { ...entry.run, ...run } }]), plain, JSON.stringify({ on, run, ...beside }));
	}
});

// ── the worker's read when a run ends ───────────────────────────────────────────────────────────────────────────────

function triggersFile(triggers, extra = {}) {
	const path = join(tempDir("retain-sandbox-"), "triggers.json");
	writeFileSync(path, `${JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers, ...extra }, null, 2)}\n`);
	return path;
}
const stored = (data) => JSON.parse(JSON.stringify(data));
/** The jobs as the worker's own builders make them from those entries, and as the queue stores them. */
const cronJob = (entry = cronCommand(false)) => stored({ ...localRunData(load(entry)[0].run), trigger: { id: entry.on.id, pattern: entry.on.pattern } });
const eventJob = (entry = localEvent(false)) => stored(buildLocalEventJob(load(entry)[0], "b".repeat(32)));
const keeps = (triggers, job, extra) => makeCheckRetainSandbox({ triggersPath: triggersFile(triggers, extra) })(job);

test("the worker reads run.retainSandbox from the job's own trigger when the run ends: false keeps nothing, true and absent keep (#1023)", () => {
	assert.equal(keeps([cronCommand(false), localEvent(false)], cronJob()), false, "a scheduled local command");
	assert.equal(keeps([cronCommand(false), localEvent(false)], eventJob()), false, "a forge event's local command");
	for (const value of [true, undefined]) {
		assert.equal(keeps([cronCommand(value), localEvent(value)], cronJob()), true, `cron, ${value}`);
		assert.equal(keeps([cronCommand(value), localEvent(value)], eventJob()), true, `local event, ${value}`);
	}
	// A run a person fires by hand from the trigger is the trigger's run: it is queued with the schedule's own data.
	assert.equal(keeps([cronCommand(false)], { ...cronJob(), enqueueNonce: "n-1" }), false);
	// The flag of ONE trigger is that trigger's: the other entry in the file keeps its sandbox.
	assert.equal(keeps([cronCommand(false), localEvent()], eventJob()), true);
	assert.equal(keeps([cronCommand(), localEvent(false)], cronJob()), true);
});

test("the flag is read when the run ends, so an edit takes effect for runs that end after it (#1023)", () => {
	const path = triggersFile([cronCommand()]);
	const check = makeCheckRetainSandbox({ triggersPath: path });
	const job = cronJob();
	assert.equal(check(job), true, "queued while the trigger kept its sandboxes");
	writeFileSync(path, JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [cronCommand(false)] }));
	assert.equal(check(job), false, "the flag was set while the job ran");
	writeFileSync(path, JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [cronCommand(false, { maxTurns: 3 })] }, null, 1));
	assert.equal(check(job), false, "an edit of another field of the same trigger changes nothing");
	writeFileSync(path, JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [cronCommand(true)] }, null, 3));
	assert.equal(check(job), true, "and taking it off keeps the next run");
});

test("every doubt about the file keeps the sandbox (#1023)", () => {
	const dir = tempDir("retain-sandbox-doubt-");
	const job = cronJob();
	const check = (triggersPath, fs) => makeCheckRetainSandbox({ triggersPath, ...(fs ? { fs } : {}) })(job);
	assert.equal(check(join(dir, "missing.json")), true, "no file");
	assert.equal(check(""), true, "no path");
	assert.equal(check(undefined), true);
	// Unreadable: a directory where the file should be (a read fails the same way for every account, root included).
	mkdirSync(join(dir, "a-directory.json"));
	assert.equal(check(join(dir, "a-directory.json")), true, "a file that cannot be read");
	const write = (name, text) => {
		writeFileSync(join(dir, name), text);
		return join(dir, name);
	};
	assert.equal(check(write("not-json.json", `{ "triggers": [`)), true, "a file that does not parse");
	assert.equal(check(write("no-list.json", JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: {} }))), true, "no trigger list");
	// One entry the loader refuses makes the whole file no evidence, the job's own valid entry included.
	assert.equal(check(write("refused.json", JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [cronCommand(false), cronFlow(false)] }))), true, "a file the loader refuses");
	assert.equal(check(write("string.json", JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [cronCommand("false")] }))), true, "a flag that is not a boolean");
	assert.equal(check(write("newer.json", JSON.stringify({ version: TRIGGERS_FILE_VERSION + 1, triggers: [cronCommand(false)] }))), true, "a file a newer pi-dispatch wrote");
	// The same job against the same entry in a file that loads: only then is the sandbox not kept.
	assert.equal(check(write("good.json", JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [cronCommand(false)] }))), false);
	// And a read that throws something odd is a doubt too: the check never throws.
	const broken = { statSync: () => { throw "not an error"; }, readFileSync: () => { throw null; } };
	assert.equal(check(join(dir, "good.json"), broken), true);
});

test("a trigger that is gone, edited or no longer a local command keeps the sandbox of a job it queued (#1023)", () => {
	const job = cronJob();
	assert.equal(keeps([localEvent(false)], job), true, "the trigger was deleted");
	assert.equal(keeps([], job), true, "the file has no trigger at all");
	for (const [key, value] of [["folder", "/srv/other"], ["command", "sync all"]]) assert.equal(keeps([cronCommand(false, { [key]: value })], job), true, `its ${key} was edited since the job was queued`);
	// A cron job is found by its trigger's id, folder and command, not by its worker: with the worker changed it is
	// still that trigger's run and follows its flag. (A forge event's listener is found by its worker too, below.)
	assert.equal(keeps([cronCommand(false, { worker: "another-host" })], job), false, "the same cron trigger, on another worker now");
	assert.equal(keeps([{ ...cronCommand(false), on: { ...cronCommand().on, id: "sync-2" } }], job), true, "another trigger with its folder and command");
	// The id now names a flow: the kind changed, and a flow may not carry the flag at all.
	assert.equal(keeps([{ on: cronCommand().on, run: { kind: "local", folder: "/srv/app", flow: "fix", task: "Fix" } }], job), true, "it runs a flow now");
	// A listener that shares a cron trigger's id, folder and command is another trigger: its flag is not the cron job's.
	const listener = { ...localEvent(false), on: { ...localEvent().on, id: "sync" }, run: { ...localEvent(false).run, folder: "/srv/app", command: "sync now" } };
	assert.doesNotThrow(() => load(listener));
	assert.equal(keeps([listener], job), true);
	assert.equal(keeps([listener, cronCommand(false)], job), false, "its own entry still decides");
	// A local event job, the same way: another forge, or an edited folder, command or worker.
	const event = eventJob();
	assert.equal(keeps([localEvent(false)], event), false);
	assert.equal(keeps([{ ...localEvent(false), on: { ...localEvent().on, forge: "forgejo" } }], event), true, "the same on.id on another forge");
	for (const [key, value] of [["folder", "/srv/other"], ["command", "maintain-all"], ["worker", "another-host"]]) assert.equal(keeps([localEvent(false, { [key]: value })], event), true, `local event ${key}`);
});

test("two forge event listeners that share forge, folder, command and worker are told apart by their id, in either file order (#1023)", () => {
	// The identity that guards against losing a sandbox: one listener keeps none, and its twin, which differs only in
	// its id and in what it listens to, keeps its own. Found by the first match on the rest, the unflagged listener's
	// run would lose its sandbox whenever the flagged one came first in the file.
	const flagged = { on: { type: "issue", forge: "github", id: "cleanup", action: ["closed"] }, run: { ...localEvent(false).run } };
	const plain = localEvent();
	assert.deepEqual([flagged.run.folder, flagged.run.command, flagged.run.worker, flagged.on.forge], [plain.run.folder, plain.run.command, plain.run.worker, plain.on.forge]);
	for (const [order, list] of [["the flagged one first", [flagged, plain]], ["the flagged one last", [plain, flagged]]]) {
		assert.doesNotThrow(() => parseTriggers(JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: list }), "/t.json"), order);
		assert.equal(keeps(list, eventJob(plain)), true, `${order}: the unflagged listener's run is kept`);
		assert.equal(keeps(list, eventJob(flagged)), false, `${order}: the flagged listener's run is not`);
	}
});

test("only the trigger's own local command run follows the flag: every other job keeps its sandbox (#1023)", () => {
	const check = makeCheckRetainSandbox({ triggersPath: triggersFile([cronCommand(false), localEvent(false)]) });
	const own = cronJob();
	assert.equal(check(own), false);
	// A job a person queued with a folder and a command belongs to no trigger.
	const { trigger: _none, ...adHoc } = own;
	assert.equal(check(adHoc), true, "pi-dispatch run with no trigger");
	// A chained child is an agent's request with a flow and a task of its own, whatever its parent was.
	assert.equal(check({ ...own, parentJobId: "repeat:sync:1700000000000", chainDepth: 1 }), true, "a chained child");
	assert.equal(check({ ...own, chainDepth: 1 }), true);
	assert.equal(check({ ...own, fork: { fromJob: "repeat:sync:1" } }), true, "a fork");
	assert.equal(check({ ...own, recoveryOf: "repeat:sync:1" }), true, "a recovery");
	assert.equal(check({ ...own, watch: { ruleId: "errors" } }), true, "a watch rule's job");
	// A forge job, even one whose matched index is the flagged entry's place in the file.
	assert.equal(check({ kind: "github", repo: "acme/web", flow: "deploy", trigger: { matched: { index: 0, type: "label", label: "deploy" } } }), true, "a forge job");
	// A local flow job is not a command run.
	assert.equal(check({ kind: "local", folder: "/srv/app", flow: "fix", task: "Fix", trigger: { id: "sync", pattern: "*/5 * * * *" } }), true, "a local flow");
	assert.equal(check({ ...own, kind: "github" }), true);
	for (const nothing of [null, undefined, "repeat:sync:1", 7, []]) assert.equal(check(nothing), true, `no job (${JSON.stringify(nothing)})`);
	// The check never throws: a job it cannot even read is a doubt like any other.
	const unreadable = Object.defineProperty({ ...own }, "command", { get() { throw new Error("no"); } });
	assert.equal(check(unreadable), true);
	// The quota reserve's read goes through the same lookup and is what it was.
	const reserve = makeCheckQuotaReserve({ triggersPath: triggersFile([cronCommand(false, { quotaReserve: true })]) });
	assert.equal(reserve(own), true);
	assert.equal(reserve(adHoc), false);
});

// ── the cleanup ─────────────────────────────────────────────────────────────────────────────────────────────────────

const JOB_ID = "repeat:sync:1700000000000";
/** A prepared local command job on disk: its job directory with what a run leaves there, the folder being the operator's own. */
function preparedRun(jobId = JOB_ID) {
	const jobDir = join(tempDir("retain-sandbox-jobs-"), "job");
	mkdirSync(join(jobDir, "outbox"), { recursive: true });
	writeFileSync(join(jobDir, "prompt.md"), "/sync now\n");
	writeFileSync(join(jobDir, "event.json"), "{}\n");
	return { jobDir, workspace: "/srv/app", sandbox: { jobId, kind: "local", image: "pi-job:test", backend: "local" } };
}
function retention({ hours = 24, retains } = {}) {
	const sandboxDir = join(tempDir("retain-sandbox-kept-"), "sandboxes");
	const logs = [];
	const asked = [];
	const cleanup = makeCleanup({ sandboxDir, retentionHours: hours, log: (event, fields) => logs.push([event, fields]), ...(retains ? { retains: (job) => (asked.push(job), retains(job)) } : {}) });
	const kept = () => (existsSync(sandboxDir) ? readdirSync(sandboxDir) : []);
	return { sandboxDir, logs, asked, cleanup, kept };
}

test("a run whose trigger keeps no sandbox leaves no directory, and one line says so; any other run is kept (#1023)", async () => {
	const job = cronJob();
	const gone = retention({ retains: () => false });
	const run = preparedRun();
	await gone.cleanup(run, { job });
	assert.equal(existsSync(run.jobDir), false, "the job directory is removed");
	assert.deepEqual(gone.kept(), [], "and nothing is kept for the sweep to find");
	assert.deepEqual(gone.logs, [["sandbox_not_kept", { jobId: JOB_ID }]]);
	assert.deepEqual(gone.asked, [job], "the reader is asked about the job it was handed, as it is");

	const kept = retention({ retains: () => true });
	const other = preparedRun();
	await kept.cleanup(other, { job });
	assert.equal(existsSync(other.jobDir), false, "moved, not left behind");
	assert.deepEqual(kept.kept(), [sandboxEntryName(JOB_ID)]);
	assert.equal(JSON.parse(readFileSync(join(kept.sandboxDir, sandboxEntryName(JOB_ID), SANDBOX_MANIFEST), "utf8")).jobId, JOB_ID);
	assert.equal(existsSync(join(kept.sandboxDir, sandboxEntryName(JOB_ID), "prompt.md")), true);
	assert.deepEqual(kept.logs.filter(([event]) => event === "sandbox_not_kept"), []);
});

test("every doubt keeps the run: a reader that throws, an answer that is not exactly false, no job, no reader (#1023)", async () => {
	const job = cronJob();
	const doubts = [
		["a reader that throws", { retains: () => { throw new Error("EIO"); } }, { job }],
		["undefined", { retains: () => undefined }, { job }],
		["null", { retains: () => null }, { job }],
		["zero", { retains: () => 0 }, { job }],
		["the string false", { retains: () => "false" }, { job }],
		["no job handed in", { retains: () => false }, {}],
		["a job of null", { retains: () => false }, { job: null }],
		["no second argument", { retains: () => false }, undefined],
		["no reader at all", {}, { job }],
	];
	for (const [name, options, bag] of doubts) {
		const r = retention(options);
		const run = preparedRun();
		await (bag === undefined ? r.cleanup(run) : r.cleanup(run, bag));
		assert.deepEqual(r.kept(), [sandboxEntryName(JOB_ID)], `${name}: kept`);
		assert.deepEqual(r.logs.filter(([event]) => event === "sandbox_not_kept"), [], name);
		if (!bag?.job) assert.deepEqual(r.asked, [], `${name}: with no job there is nothing to ask about`);
	}
	// With the window at 0 nothing is kept for any job, as always: that is not the flag, so its line is not said and
	// its reader is not asked.
	const off = retention({ hours: 0, retains: () => false });
	const run = preparedRun();
	await off.cleanup(run, { job });
	assert.equal(existsSync(run.jobDir), false);
	assert.deepEqual([off.kept(), off.logs, off.asked], [[], [], []]);
	// And a refusal that prepared no directory is nothing to clean either way.
	const none = retention({ retains: () => false });
	await none.cleanup({ outcome: "policy" }, { job });
	assert.deepEqual([none.logs, none.asked], [[], []]);
});

test("a job directory that will not go is not said to be gone: the removal rejects, and no line is written (#1023)", async () => {
	// The line is written after the removal, never before it. Here the removal cannot succeed on any host or account:
	// no path holds a NUL, so `rm` rejects. The cleanup rejects with it, as it does with the window at 0 (the
	// processor swallows that), and the log says nothing of the run.
	const r = retention({ retains: () => false });
	const run = { ...preparedRun(), jobDir: join(tempDir("retain-sandbox-stuck-"), "job\u0000dir") };
	await assert.rejects(r.cleanup(run, { job: cronJob() }), { code: "ERR_INVALID_ARG_VALUE" });
	assert.deepEqual(r.logs, [], "not sandbox_not_kept, and nothing else");
	assert.deepEqual(r.kept(), [], "and nothing was kept in its place");
});

// ── the processor ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The least a local job needs to run through `runJob`, with the real cleanup over a real triggers file. */
function processing({ triggers, runContainer }) {
	const r = retention({ retains: makeCheckRetainSandbox({ triggersPath: triggersFile(triggers) }) });
	const run = preparedRun();
	const cleanups = [];
	const deps = {
		redis: { incr: async () => 1, decr: async () => 0, expire: async () => {}, get: async () => null },
		caps: { day: 10, week: null, month: null },
		softHoldPct: null,
		mintToken: async () => "tok",
		isDefaultBranchProtected: async () => true,
		prepareWorkspace: async () => run,
		runContainer,
		collectChain: async () => ({ enqueued: 0, refused: 0 }),
		cleanup: (prepared, options) => (cleanups.push(options), r.cleanup(prepared, options)),
		comment: async () => {},
		now: new Date("2026-11-23T10:00:00Z"),
	};
	return { ...r, run, deps, cleanups };
}
const OUTCOMES = [
	["completed", async () => ({ code: 0, aborted: false })],
	["failed", async () => ({ code: 1, aborted: false })],
	["timed out", async () => ({ code: 137, aborted: true, abortReason: "job-timeout-30m" })],
	["stopped by the worker", async () => ({ code: 137, aborted: true })],
	["a container that never ran", async () => { throw new Error("spawn docker ENOENT"); }],
];

test("the processor hands the cleanup its job, so a flagged trigger's run keeps nothing on any outcome (#1023)", async () => {
	const job = { ...cronJob(), provider: "anthropic", model: "m", maxTurns: 5 };
	for (const [name, runContainer] of OUTCOMES) {
		const flagged = processing({ triggers: [cronCommand(false)], runContainer });
		await runJob(job, flagged.deps).catch(() => {});
		assert.deepEqual(flagged.cleanups, [{ job }], `${name}: the cleanup is handed the job that ran`);
		assert.equal(existsSync(flagged.run.jobDir), false, `${name}: the job directory is gone`);
		assert.deepEqual(flagged.kept(), [], `${name}: nothing kept`);
		assert.deepEqual(flagged.logs.filter(([event]) => event === "sandbox_not_kept"), [["sandbox_not_kept", { jobId: JOB_ID }]], name);

		const plain = processing({ triggers: [cronCommand()], runContainer });
		await runJob(job, plain.deps).catch(() => {});
		assert.deepEqual(plain.kept(), [sandboxEntryName(JOB_ID)], `${name}: without the flag the run is kept, as before`);
		assert.deepEqual(plain.logs.filter(([event]) => event === "sandbox_not_kept"), [], name);
	}
});

// ── the sweep afterwards ────────────────────────────────────────────────────────────────────────────────────────────

test("the sweep meets nothing of a run that was not kept, and a kept run whose directories are gone is swept like any other (#1023)", async () => {
	const job = cronJob();
	// The pass's own clock is a fixed one. Its result says how long the pass took (`ms`), and on the real clock that is
	// 0 or 1 by how busy the machine is: compared whole, it failed a run in twelve beside eight busy processes.
	const sweepOf = (sandboxDir, at) => makeSandboxReaper({ sandboxDir, retentionHours: 24, now: () => at, clock: () => 0, sleep: async () => {} });
	// Not kept: the retention root holds no entry for the run. On a host whose every run is such a run it does not
	// even exist. A pass finds nothing, says nothing is left, and never throws.
	const gone = retention({ retains: () => false });
	await gone.cleanup(preparedRun(), { job });
	assert.equal(existsSync(gone.sandboxDir), false);
	for (let pass = 0; pass < 2; pass++) assert.deepEqual(await sweepOf(gone.sandboxDir, Date.now())(), { more: false, reaped: 0, held: 0, ms: 0, restedMs: 0, slowestCheckMs: 0 });

	// Kept, and then emptied by hand down to its manifest, which still names a workspace that is no longer there.
	const kept = retention({ retains: () => true });
	const run = preparedRun();
	mkdirSync(join(run.jobDir, "workspace"));
	await kept.cleanup({ ...run, workspace: join(run.jobDir, "workspace") }, { job });
	const entry = join(kept.sandboxDir, sandboxEntryName(JOB_ID));
	const manifest = JSON.parse(readFileSync(join(entry, SANDBOX_MANIFEST), "utf8"));
	for (const name of readdirSync(entry)) if (name !== SANDBOX_MANIFEST) rmSync(join(entry, name), { recursive: true, force: true });
	assert.equal(existsSync(manifest.workspace), false, "the workspace its manifest names is gone");
	const created = Date.parse(manifest.createdAt);
	const inside = await sweepOf(kept.sandboxDir, created + 3600_000)();
	assert.deepEqual([inside.reaped, inside.more], [0, false], "inside its window it is left alone, and the pass ends");
	assert.deepEqual(kept.kept(), [sandboxEntryName(JOB_ID)]);
	const past = await sweepOf(kept.sandboxDir, created + 25 * 3600_000)();
	assert.deepEqual([past.reaped, past.held, past.more], [1, 0, false], "past it, removed, in one pass");
	assert.deepEqual(kept.kept(), []);
	assert.deepEqual(await sweepOf(kept.sandboxDir, created + 26 * 3600_000)(), { more: false, reaped: 0, held: 0, ms: 0, restedMs: 0, slowestCheckMs: 0 });
});
