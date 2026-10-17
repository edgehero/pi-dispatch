import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseRunnerEnv } from "../src/config.mjs";
import { createJobModelRuntime } from "../src/model-runtime.mjs";
import { EXIT_POLICY } from "../src/outcome.mjs";
import { findOrphans, INTERRUPTED_TEXT, NOT_STARTED_TEXT, RECOVERY_KEY, RECOVERY_PROMPT, REPLAY_TOOLS, recoverSession, replayClass } from "../src/recover.mjs";
import { createReportProgress } from "../src/report-progress.mjs";
import { assistantMessage, sessionFixture, scriptedSession } from "./helpers/recover-session.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * Issue #645, the container's half of a durable run: the env that arms it, which interrupted calls are re-run and how
 * the rest are labelled, and a real job killed in the middle of a tool and resumed. The real-session tests skip where
 * pi cannot load, and fail instead under PI_DISPATCH_REQUIRE_LOADER_TESTS=1, like report-progress.test.mjs.
 */
let deps;
let importError;
try {
	deps = {
		pi: await import("@earendil-works/pi-coding-agent"),
		piAi: await import("@earendil-works/pi-ai"),
		agentCore: await import("@earendil-works/pi-agent-core"),
		transform: await import("@earendil-works/pi-ai/api/transform-messages"),
		loaderModule: await import("../src/loader.mjs"),
		createJobModelRuntime,
	};
} catch (error) {
	importError = error;
}
if (!deps && process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") throw new Error(`recover tests are REQUIRED here but pi could not be imported.\n${importError}`);
const skip = deps ? false : `pi not installed (node ${process.version}); CI runs these`;

const BASE = { PI_PROVIDER: "anthropic", PI_MODEL: "claude-sonnet-4-5-20250929", PI_MAX_TURNS: "10" };
const policy = (error) => error.piDispatchExit === EXIT_POLICY;

// ── The env ─────────────────────────────────────────────────────────────────────────────────────────────────────

test("PI_RECOVER and PI_RECOVERING: absent or empty is off, \"1\" is on, anything else is a config error", () => {
	assert.deepEqual([parseRunnerEnv(BASE).recover, parseRunnerEnv(BASE).recovering], [false, false]);
	assert.deepEqual([parseRunnerEnv({ ...BASE, PI_RECOVER: "" }).recover, parseRunnerEnv({ ...BASE, PI_RECOVERING: "" }).recovering], [false, false]);
	assert.equal(parseRunnerEnv({ ...BASE, PI_RECOVER: "1" }).recover, true);
	assert.equal(parseRunnerEnv({ ...BASE, PI_RECOVER: "1" }).recovering, false, "the first attempt of a recoverable job");
	const recovering = parseRunnerEnv({ ...BASE, PI_RECOVER: "1", PI_RECOVERING: "1", PI_SESSION_FILE: "/session/current.jsonl" });
	assert.deepEqual([recovering.recover, recovering.recovering], [true, true]);
	for (const bad of ["0", "true", "yes", " 1", "1 "]) {
		assert.throws(() => parseRunnerEnv({ ...BASE, PI_RECOVER: bad }), policy, `PI_RECOVER=${bad}`);
		assert.throws(() => parseRunnerEnv({ ...BASE, PI_RECOVER: "1", PI_RECOVERING: bad, PI_SESSION_FILE: "/session/current.jsonl" }), policy, `PI_RECOVERING=${bad}`);
	}
});

test("PI_RECOVERING is refused without PI_RECOVER, without PI_SESSION_FILE, and on a command job", () => {
	const file = { PI_SESSION_FILE: "/session/current.jsonl" };
	assert.throws(() => parseRunnerEnv({ ...BASE, ...file, PI_RECOVERING: "1" }), (error) => policy(error) && /PI_RECOVER is not/.test(error.message));
	assert.throws(() => parseRunnerEnv({ ...BASE, PI_RECOVER: "1", PI_RECOVERING: "1" }), (error) => policy(error) && /PI_SESSION_FILE is not/.test(error.message));
	assert.throws(() => parseRunnerEnv({ ...BASE, ...file, PI_RECOVER: "1", PI_RECOVERING: "1", PI_COMMAND: "wf run" }), (error) => policy(error) && /command job/.test(error.message));
	// The worker's run-record enum owns the reasons; these ride the plain one.
	assert.throws(() => parseRunnerEnv({ ...BASE, ...file, PI_RECOVERING: "1" }), (error) => error.piDispatchReason === "config");
	// PI_RECOVER alone needs neither: the first attempt may be a command job or keep no transcript.
	assert.equal(parseRunnerEnv({ ...BASE, PI_RECOVER: "1", PI_COMMAND: "wf run" }).recover, true);
});

// ── findOrphans ─────────────────────────────────────────────────────────────────────────────────────────────────

const call = (id, name, args = {}) => ({ type: "toolCall", id, name, arguments: args });
const result = (id, name = "read") => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1 });
const user = (text) => ({ role: "user", content: text, timestamp: 1 });
const system = { role: "system", content: "", timestamp: 1 };

test("findOrphans: the unanswered calls of the last usable assistant message, in order", () => {
	const a = assistantMessage([{ type: "text", text: "go" }, call("1", "read"), call("2", "edit"), call("3", "bash")]);
	assert.deepEqual(findOrphans([user("x"), a]).orphans.map((c) => c.id), ["1", "2", "3"], "nothing answered");
	assert.deepEqual(findOrphans([user("x"), a, result("1")]).orphans.map((c) => c.id), ["2", "3"], "a partial result suffix");
	assert.deepEqual(findOrphans([user("x"), a, result("1"), system, result("2")]).orphans.map((c) => c.id), ["3"], "a system message is transparent");
	assert.deepEqual(findOrphans([user("x"), a, result("1"), result("2"), result("3")]).orphans, [], "all answered");
	assert.equal(findOrphans([user("x"), a]).assistant, a);
});

test("findOrphans: error and aborted assistant messages are skipped; a closed batch and a plain reply have no orphans", () => {
	const good = assistantMessage([call("1", "read"), call("2", "bash")]);
	for (const stopReason of ["error", "aborted"]) {
		const bad = assistantMessage([call("9", "bash")], { stopReason });
		assert.deepEqual(findOrphans([user("x"), bad]), { assistant: null, orphans: [] }, `${stopReason} alone issued nothing the model sees`);
		assert.deepEqual(findOrphans([user("x"), good, result("1"), result("2"), bad]).assistant, good, `${stopReason} is skipped`);
		assert.deepEqual(findOrphans([user("x"), good, result("1"), result("2"), bad]).orphans, []);
		// pi-ai closes good's batch at the unusable message, so appending a result after it would be a second answer.
		assert.deepEqual(findOrphans([user("x"), good, result("1"), bad]).orphans, [], `a ${stopReason} message after the batch closed it`);
	}
	assert.deepEqual(findOrphans([user("x"), good, user("y")]).orphans, [], "a user tail: pi already answered the batch at the user turn");
	assert.deepEqual(findOrphans([user("x"), assistantMessage([{ type: "text", text: "done" }])]).orphans, [], "a reply with no calls");
	assert.deepEqual(findOrphans([user("x")]), { assistant: null, orphans: [] });
	assert.deepEqual(findOrphans([]), { assistant: null, orphans: [] });
});

// ── replayClass ─────────────────────────────────────────────────────────────────────────────────────────────────

const builtin = (name) => ({ name, sourceInfo: { path: `builtin:${name}`, source: "builtin", scope: "temporary", origin: "top-level" } });
const extension = (name, path = "/workspace/.pi/extensions/x.js") => ({ name, sourceInfo: { path, source: "local", scope: "project", origin: "top-level" } });

test("replayClass: only an active builtin file tool or the job's own report_progress replays", () => {
	const tools = [...REPLAY_TOOLS.map(builtin), builtin("bash"), extension("report_progress", "<inline:job-report-progress>"), extension("await_human_input", "<inline:job-await-input>"), extension("mcp__srv__x", "<inline:job-mcp>")];
	const active = tools.map((t) => t.name);
	for (const name of REPLAY_TOOLS) assert.equal(replayClass(call("1", name), { tools, active }), "replay", name);
	assert.equal(replayClass(call("1", "report_progress"), { tools, active }), "replay");
	for (const name of ["bash", "await_human_input", "mcp__srv__x", "codemode", "unknown"]) assert.equal(replayClass(call("1", name), { tools, active }), "hold", name);
	assert.equal(replayClass(call("1", "read"), { tools: [extension("read")], active: ["read"] }), "hold", "an extension shadowing read");
	assert.equal(replayClass(call("1", "read"), { tools: [{ name: "read", sourceInfo: { path: "builtin:mcp", source: "builtin" } }], active: ["read"] }), "hold", "a builtin EXTENSION's tool named read");
	for (const source of ["local", "inline", "sdk", undefined]) {
		assert.equal(replayClass(call("1", "read"), { tools: [{ name: "read", sourceInfo: { path: "builtin:read", source } }], active: ["read"] }), "hold", `path builtin:read with source ${source}`);
	}
	assert.equal(replayClass(call("1", "report_progress"), { tools: [extension("report_progress")], active: ["report_progress"] }), "hold", "another extension's report_progress");
	assert.equal(replayClass(call("1", "write"), { tools: tools.filter((t) => t.name !== "write"), active: active.filter((n) => n !== "write") }), "hold", "an excluded tool is in neither list");
	assert.equal(replayClass(call("1", "write"), { tools, active: active.filter((n) => n !== "write") }), "hold", "registered but inactive");
	assert.equal(replayClass({ type: "toolCall", id: "1" }, { tools, active }), "hold", "no name");
});

// ── recoverSession on fakes: the ordering rules ─────────────────────────────────────────────────────────────────

function fakeSession(messages, { tools = [...REPLAY_TOOLS.map(builtin), builtin("bash")] } = {}) {
	const appended = [];
	const ran = [];
	let stateMessages = messages.slice();
	const agentTools = tools.map((t) => ({ name: t.name }));
	const session = {
		agent: {
			state: {
				get messages() {
					return stateMessages;
				},
				set messages(next) {
					stateMessages = next.slice();
				},
				tools: agentTools,
			},
			beforeToolCall: () => undefined,
			afterToolCall: () => undefined,
		},
		getAllTools: () => tools,
		getActiveToolNames: () => tools.map((t) => t.name),
	};
	const sessionManager = { appendMessage: (message) => appended.push(message) };
	const runToolCall = async (toolCall, options) => {
		ran.push({ id: toolCall.id, options });
		return { toolCall, result: { content: [{ type: "text", text: `ran ${toolCall.id}` }], details: { kept: 1 } }, isError: false, durationMs: 3 };
	};
	return { session, sessionManager, runToolCall, appended, ran };
}

const labels = (messages) => messages.map((m) => [m.toolCallId, m.details[RECOVERY_KEY], m.isError]);

test("the first orphan held is interrupted; every orphan after a hold is not started, replayable or not", async () => {
	const a = assistantMessage([call("1", "bash"), call("2", "read"), call("3", "bash")]);
	const f = fakeSession([user("x"), a]);
	const counts = await recoverSession(f);
	assert.deepEqual(counts, { orphans: 3, replayed: 0, interrupted: 1, notStarted: 2 });
	assert.deepEqual(labels(f.appended), [["1", "interrupted", true], ["2", "not-started", true], ["3", "not-started", true]]);
	assert.deepEqual(f.ran, [], "nothing re-run after the first hold, not even the read");
	assert.equal(f.appended[0].content[0].text, INTERRUPTED_TEXT);
	assert.equal(f.appended[1].content[0].text, NOT_STARTED_TEXT);
});

test("[read answered, edit, bash, write]: edit is replayed, and bash, not the first orphan, never started", async () => {
	const a = assistantMessage([call("r", "read"), call("e", "edit"), call("b", "bash"), call("w", "write")]);
	const f = fakeSession([user("x"), a, result("r")]);
	const counts = await recoverSession(f);
	assert.deepEqual(counts, { orphans: 3, replayed: 1, interrupted: 0, notStarted: 2 });
	assert.deepEqual(labels(f.appended), [["e", "replayed", false], ["b", "not-started", true], ["w", "not-started", true]]);
	assert.deepEqual(f.appended[0].content, [{ type: "text", text: "ran e" }]);
	assert.deepEqual(f.appended[0].details, { kept: 1, [RECOVERY_KEY]: "replayed" }, "the tool's details survive beside the label");
	assert.equal(f.appended[0].durationMs, 3);
	// Each answer went to the file and to the agent, as the same object, in order.
	assert.deepEqual(f.session.agent.state.messages.slice(3), f.appended);
	f.appended.forEach((message, i) => assert.equal(f.session.agent.state.messages[3 + i], message));
	// runToolCall got the session's own hooks, its active tools, the assistant message and the transcript so far.
	const { options } = f.ran[0];
	assert.equal(options.beforeToolCall, f.session.agent.beforeToolCall);
	assert.equal(options.afterToolCall, f.session.agent.afterToolCall);
	assert.equal(options.tools, f.session.agent.state.tools);
	assert.equal(options.context.tools, f.session.agent.state.tools);
	assert.equal(options.assistantMessage, a);
	assert.equal(options.context.messages.length, 3);
});

test("replay runs in order until the first hold, and the counts are logged without content", async () => {
	const a = assistantMessage([call("1", "read"), call("2", "write"), call("3", "await_human_input")]);
	const lines = [];
	const f = fakeSession([user("x"), a]);
	const counts = await recoverSession({ ...f, log: (event, fields) => lines.push([event, fields]) });
	assert.deepEqual(counts, { orphans: 3, replayed: 2, interrupted: 0, notStarted: 1 });
	assert.deepEqual(f.ran.map((r) => r.id), ["1", "2"]);
	assert.deepEqual(lines, [["recovery_resolved", { orphans: 3, replayed: 2, interrupted: 0, notStarted: 1 }]]);
});

test("no orphans: nothing appended, nothing run, zero counts", async () => {
	const f = fakeSession([user("x"), assistantMessage([call("1", "read")]), result("1")]);
	assert.deepEqual(await recoverSession(f), { orphans: 0, replayed: 0, interrupted: 0, notStarted: 0 });
	assert.deepEqual([f.appended, f.ran], [[], []]);
});

test("an answer that does not reach the transcript is refused, never handed to the model", async () => {
	const f = fakeSession([user("x"), assistantMessage([call("1", "read")])]);
	// A messages setter that drops what it is given stands in for any way the answer could fail to land.
	const messages = f.session.agent.state.messages;
	Object.defineProperty(f.session.agent.state, "messages", { get: () => messages, set: () => {} });
	await assert.rejects(recoverSession(f), (error) => policy(error) && /left 1 tool call/.test(error.message));
});

test("RECOVERY_PROMPT and the two labels are fixed text with no dash used as punctuation", async () => {
	for (const text of [RECOVERY_PROMPT, INTERRUPTED_TEXT, NOT_STARTED_TEXT]) {
		assert.doesNotMatch(text, / - |\u2013|\u2014/, text);
	}
	// Pinned whole: the model acts on every clause, and the reset clause must say what worker/src/trust-paths.mjs does
	// (.pi/ and .agents/ whole, the root context files, to the run's base commit), not what an earlier draft said.
	assert.equal(
		RECOVERY_PROMPT,
		"This job was interrupted by an infrastructure failure and has been restored from its last checkpoint. " +
			"The workspace matches the transcript up to this point, with one exception: the `.pi/` and `.agents/` directories and the root AGENTS.override.md, AGENTS.md and CLAUDE.md files were reset to the commit this run started from, so re-apply any change you made to them. " +
			"Tool calls marked as interrupted may or may not have taken effect. " +
			"Before you repeat anything that acts outside the workspace (a push, a pull request, a comment, an MCP or forge call), check whether it already happened: " +
			"run `git fetch` and compare with the remote, push with `--force-with-lease`, run `gh pr list --head <branch>` (or this forge's equivalent) before creating a pull request, and read the issue's comments before posting one. " +
			"Then continue the task.",
	);
	assert.doesNotMatch(RECOVERY_PROMPT, /default branch/, "the reset is to the run's base commit, not the default branch as it is now");
	// And bolted to the worker's own list, so a path the reset gains is a path the prompt names (case folded: the reset
	// matches casings, the prompt names each file once).
	const { TRUST_ROOT_NAMES } = await import("../../../worker/src/trust-paths.mjs");
	for (const name of TRUST_ROOT_NAMES) assert.ok(RECOVERY_PROMPT.toLowerCase().includes(name.toLowerCase()), `the prompt does not name ${name}, which the worker resets`);
	assert.equal(INTERRUPTED_TEXT, "Interrupted by a crash: the effect may or may not have happened. Check before repeating.");
	assert.equal(NOT_STARTED_TEXT, "Not run: the job crashed while an earlier call in this message was running. Run it again if it is still needed.");
});

test("run-job: run.recover makes the tools sequential right after the session exists, and a recovering run's exit lines carry integer counts", () => {
	// Source guard, compose.test.mjs's tactic: the order is what matters, and the kill tests below drive the behaviour.
	const src = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	const created = src.indexOf("({ session } = await createAgentSession({");
	const sequential = src.indexOf('\tif (cfg.recover) session.agent.toolExecution = "sequential";\n');
	const firstPrompt = src.indexOf("await session.prompt(");
	assert.ok(created > 0 && sequential > created && sequential < firstPrompt, "sequential is set after createAgentSession and before any prompt");
	assert.ok(sequential < src.indexOf("await jobMcp.lifecycle.start("), "before anything else in the session runs");
	// A recovery with no checkpoint to resume is refused right after the session manager opens, before the meter or any
	// extension exists, so nothing has been spent.
	const refused = src.indexOf("if (cfg.recovering && !sessionResumed) throw configError(");
	assert.ok(refused > src.indexOf("openSessionManager({") && refused < src.indexOf("const meter = createUsageMeter({"), "an unresumable checkpoint is refused pre-spend");
	assert.match(src, /liveExitFields = \(\) => \(\{ [^\n]*\.\.\.recoveryField\(\)[^\n]*\}\);/, "the SIGTERM line carries the counts");
	assert.match(src, /session: \{ resumed: sessionResumed, reason: sessionReason \}, \.\.\.recoveryField\(\)[^\n]*\}\);\n\treturn outcome\.code;/, "the decided line carries the counts");
	assert.match(src, /const recoveryField = \(\) => \(recovery \? \{ recovery \} : \{\}\);/, "absent on every other run, so their exit lines are unchanged");
});

// ── Real sessions ───────────────────────────────────────────────────────────────────────────────────────────────

const readMessages = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.type === "message").map((entry) => entry.message);

/** A session on the persisted file, holding `turns` (messages appended before the session exists). */
async function sessionOn(f, { api, script = [[{ type: "text", text: "done" }]], turns = [], ...options }) {
	const { openSessionManager } = await import("../src/session.mjs");
	const { sessionManager } = openSessionManager({ sessionFile: f.sessionFile, cwd: f.workspace });
	for (const message of turns) sessionManager.appendMessage(message);
	const built = await scriptedSession(deps, f, { api, script, sessionManager, ...options });
	return { ...built, sessionManager };
}

test("a real session: replayClass reads pi's own registry (builtin read replays, a repository's read holds, an excluded tool holds, report_progress replays)", { skip }, async () => {
	const f = sessionFixture(tempDir("pi-dispatch-recover-"));
	const plain = await sessionOn(f, { api: "pi-dispatch-recover-class-1", extensionFactories: createReportProgress().factories, excludeTools: ["write"] });
	try {
		const view = { tools: plain.session.getAllTools(), active: plain.session.getActiveToolNames() };
		assert.equal(replayClass(call("1", "read"), view), "replay");
		assert.equal(replayClass(call("1", "edit"), view), "replay");
		assert.equal(replayClass(call("1", "bash"), view), "hold");
		assert.equal(replayClass(call("1", "write"), view), "hold", "excluded by the trigger");
		assert.equal(replayClass(call("1", "report_progress"), view), "replay");
	} finally {
		plain.session.dispose();
	}
	const g = sessionFixture(tempDir("pi-dispatch-recover-"));
	mkdirSync(join(g.workspace, ".pi", "extensions"), { recursive: true });
	writeFileSync(join(g.workspace, ".pi", "extensions", "read.js"), 'export default function (pi) { pi.registerTool({ name: "read", label: "r", description: "r", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) }); }\n');
	const shadowed = await sessionOn(g, { api: "pi-dispatch-recover-class-2" });
	try {
		const view = { tools: shadowed.session.getAllTools(), active: shadowed.session.getActiveToolNames() };
		assert.equal(view.tools.find((t) => t.name === "read")?.sourceInfo?.source === "builtin", false, "the repository's read replaced the builtin in the registry");
		assert.equal(replayClass(call("1", "read"), view), "hold");
	} finally {
		shadowed.session.dispose();
	}
});

test("a real session: an extension's tool_call hook that blocks write blocks the replayed write too", { skip }, async () => {
	const f = sessionFixture(tempDir("pi-dispatch-recover-"));
	const blocker = { name: "test-block-write", factory: (api) => api.on("tool_call", (event) => (event.toolName === "write" ? { block: true, reason: "writes are blocked here" } : undefined)) };
	const turns = [user("do it"), assistantMessage([call("w1", "write", { path: "blocked.txt", content: "x" })])];
	const { session, sessionManager } = await sessionOn(f, { api: "pi-dispatch-recover-block", extensionFactories: [blocker], turns });
	try {
		const counts = await recoverSession({ session, sessionManager, runToolCall: deps.agentCore.runToolCall });
		assert.deepEqual(counts, { orphans: 1, replayed: 1, interrupted: 0, notStarted: 0 });
		const answer = session.agent.state.messages.at(-1);
		assert.equal(answer.isError, true);
		assert.equal(answer.content[0].text, "writes are blocked here");
		assert.equal(answer.details[RECOVERY_KEY], "replayed");
		assert.equal(existsSync(join(f.workspace, "blocked.txt")), false, "the hook stopped the replay");
		assert.deepEqual(readMessages(f.sessionFile).at(-1), JSON.parse(JSON.stringify(answer)), "persisted as it was appended");
	} finally {
		session.dispose();
	}
});

test("a real session: a replayed read returns the file's real content and is persisted", { skip }, async () => {
	const f = sessionFixture(tempDir("pi-dispatch-recover-"));
	writeFileSync(join(f.workspace, "notes.txt"), "the real content\n");
	const turns = [user("read it"), assistantMessage([call("r1", "read", { path: "notes.txt" }), call("b1", "bash", { command: "true" })])];
	const { session, sessionManager } = await sessionOn(f, { api: "pi-dispatch-recover-read", turns });
	try {
		const counts = await recoverSession({ session, sessionManager, runToolCall: deps.agentCore.runToolCall });
		assert.deepEqual(counts, { orphans: 2, replayed: 1, interrupted: 0, notStarted: 1 });
		const [read, bash] = readMessages(f.sessionFile).slice(-2);
		assert.equal(read.toolCallId, "r1");
		assert.match(read.content[0].text, /the real content/);
		assert.equal(read.isError, false);
		assert.deepEqual([bash.toolCallId, bash.details[RECOVERY_KEY], bash.content[0].text], ["b1", "not-started", NOT_STARTED_TEXT]);
	} finally {
		session.dispose();
	}
});

// ── A real job, killed mid-tool ─────────────────────────────────────────────────────────────────────────────────

const CHILD = fileURLToPath(new URL("./fixtures/recover-child.mjs", import.meta.url));

/** Run the child job, wait until `ready(file)` holds and its bash recorded a pid, then SIGKILL it and its sleep. */
async function killMidTool(mode) {
	const root = tempDir("pi-dispatch-recover-kill-");
	const f = sessionFixture(root);
	const pidFile = join(root, "bash.pid");
	const child = spawn(process.execPath, [CHILD, JSON.stringify({ root, mode, pidFile })], { stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", (chunk) => (output += chunk));
	child.stderr.on("data", (chunk) => (output += chunk));
	const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
	const deadline = Date.now() + 30_000;
	let sleepPid = null;
	try {
		while (sleepPid === null) {
			if (child.exitCode !== null) throw new Error(`the child exited before its bash ran:\n${output}`);
			if (Date.now() > deadline) throw new Error(`the child's bash never started:\n${output}`);
			const text = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : "";
			if (/^\d+$/.test(text)) sleepPid = Number(text);
			else await new Promise((resolve) => setTimeout(resolve, 25));
		}
	} finally {
		child.kill("SIGKILL");
		if (sleepPid !== null) {
			try {
				process.kill(sleepPid, "SIGKILL");
			} catch {}
		}
	}
	assert.equal((await exited).signal, "SIGKILL");
	return f;
}

test("KILL MID-TOOL, sequential: the write's result is on disk, bash is answered as interrupted, and the model never sees \"No result provided\"", { skip }, async () => {
	const f = await killMidTool("sequential");
	const before = readMessages(f.sessionFile);
	assert.deepEqual(before.filter((m) => m.role === "toolResult").map((m) => m.toolCallId), ["call-write"], "sequential: the write's result was persisted before bash started");
	assert.equal(readFileSync(join(f.workspace, "written.txt"), "utf8"), "one\n");
	assert.deepEqual(findOrphans(before).orphans.map((c) => c.id), ["call-bash"]);

	const { session, sessionManager, contexts, model } = await sessionOn(f, { api: "pi-dispatch-recover-resume-seq" });
	// The control: resumed without recovery, pi-ai answers the orphan itself with the text this module replaces.
	assert.equal(JSON.stringify(deps.transform.transformMessages([...before, user("go on")], model)).includes("No result provided"), true);
	let after;
	try {
		session.agent.toolExecution = "sequential";
		const counts = await recoverSession({ session, sessionManager, runToolCall: deps.agentCore.runToolCall });
		assert.deepEqual(counts, { orphans: 1, replayed: 0, interrupted: 1, notStarted: 0 });
		await session.prompt(RECOVERY_PROMPT);
		assert.equal(contexts.length, 1, "one model call: the recovery prompt");
		// What a provider adapter sends: pi-ai's own transform, where the synthetic answer would be made.
		const sent = deps.transform.transformMessages(contexts[0].messages, model);
		const bash = sent.find((m) => m.role === "toolResult" && m.toolCallId === "call-bash");
		assert.ok(bash, "bash is answered in the request");
		assert.equal(bash.isError, true);
		assert.equal(bash.content[0].text, INTERRUPTED_TEXT);
		assert.equal(JSON.stringify(sent).includes("No result provided"), false);
		const last = sent.filter((m) => m.role === "user").at(-1);
		assert.equal(typeof last.content === "string" ? last.content : last.content[0].text, RECOVERY_PROMPT);
		after = JSON.parse(JSON.stringify(session.agent.state.messages));
	} finally {
		session.dispose();
	}
	// The file reopens to the messages the session held: nothing recovery appended lived only in memory.
	const reopened = deps.pi.SessionManager.open(f.sessionFile, join(f.root, "session"), f.workspace);
	assert.deepEqual(JSON.parse(JSON.stringify(reopened.buildSessionContext().messages)), after);
	assert.deepEqual(findOrphans(after).orphans, []);
});

test("KILL MID-BATCH, parallel (pi's default): no result reaches the disk, so every call is an orphan; sequential execution is required", { skip }, async () => {
	const f = await killMidTool("parallel");
	const before = readMessages(f.sessionFile);
	// The bash pid proves bash was running when the job died, yet the transcript cannot say so: under the parallel
	// executor the write's finished result waits for the whole batch, and a recovery reading this transcript would
	// label the running bash "not started". That is why run.recover sets toolExecution to sequential.
	assert.deepEqual(before.filter((m) => m.role === "toolResult"), []);
	assert.deepEqual(findOrphans(before).orphans.map((c) => c.id), ["call-write", "call-bash"]);
});

// ── The real run-job.mjs, recovering ────────────────────────────────────────────────────────────────────────────

const RUN_JOB = fileURLToPath(new URL("../run-job.mjs", import.meta.url));
const REMAP = fileURLToPath(new URL("./fixtures/remap-roots.mjs", import.meta.url));
const TASK_PROMPT = "THE ORIGINAL TASK PROMPT, which a recovering run must not send again";

/** An OpenAI-compatible endpoint that records each request body and answers with one short text reply. */
async function chatServer() {
	const { createServer } = await import("node:http");
	const bodies = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			bodies.push(JSON.parse(body));
			const chunk = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
			res.writeHead(200, { "content-type": "text/event-stream" });
			chunk({ id: "r", object: "chat.completion.chunk", created: 0, model: "m1", choices: [{ index: 0, delta: { role: "assistant", content: "recovered and done" }, finish_reason: null }] });
			chunk({ id: "r", object: "chat.completion.chunk", created: 0, model: "m1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } });
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { bodies, base: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("the real run-job, recovering: the interrupted batch is answered, the model is sent the recovery prompt and not the task prompt, and the exit line carries the counts", { skip }, async () => {
	const server = await chatServer();
	const root = tempDir("pi-dispatch-recover-runjob-");
	try {
		for (const dir of ["job/pi/skills", "workspace", "session", "outbox", "opt/pi-global", "opt/pi-dispatch", "home", "tmp"]) mkdirSync(join(root, dir), { recursive: true });
		writeFileSync(join(root, "job", "prompt.md"), `${TASK_PROMPT}\n`);
		for (const name of ["HARD_RULES.md", "OUTBOX_PROTOCOL.md", "PORTFOLIO_PROTOCOL.md"]) writeFileSync(join(root, "opt", "pi-dispatch", name), `## ${name}\n`);
		writeFileSync(join(root, "workspace", "notes.txt"), "the restored notes\n");
		const model = { id: "m1", name: "m1", api: "openai-completions", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000, compat: { maxTokensField: "max_tokens" } };
		writeFileSync(join(root, "opt", "pi-global", "models.json"), `${JSON.stringify({ providers: { "recover-fake": { baseUrl: server.base, apiKey: "recover-fake-key", api: "openai-completions", models: [model] } } })}\n`);
		// The checkpoint: the attempt that crashed asked for a read and a bash in one message, and neither answered.
		const sessionFile = join(root, "session", "current.jsonl");
		writeFileSync(sessionFile, "");
		const writer = deps.pi.SessionManager.open(sessionFile, join(root, "session"), "/workspace");
		writer.appendMessage(user("do the task"));
		writer.appendMessage({ ...assistantMessage([call("call-read", "read", { path: "notes.txt" }), call("call-bash", "bash", { command: "git push" })], { api: "openai-completions" }), provider: "recover-fake", model: "m1" });

		const env = {
			PATH: process.env.PATH,
			HOME: join(root, "home"),
			TMPDIR: join(root, "tmp"),
			PI_DISPATCH_TEST_ROOT: root,
			PI_JOB_ID: "recover-job-1",
			PI_PROVIDER: "recover-fake",
			PI_MODEL: "m1",
			PI_MAX_TURNS: "5",
			PI_SESSION_FILE: "/session/current.jsonl",
			PI_RECOVER: "1",
			PI_RECOVERING: "1",
		};
		const child = spawn(process.execPath, [`--import=${REMAP}`, RUN_JOB], { env, cwd: join(root, "workspace"), stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		const code = await new Promise((resolve) => child.on("exit", resolve));
		const lines = stdout.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
		const exit = lines.find((line) => line.event === "exit");
		assert.ok(exit, `no exit line:\n${stdout}\n${stderr}`);
		assert.equal(code, 0, `${JSON.stringify(exit)}\n${stderr}`);
		assert.equal(exit.code, 0);
		assert.deepEqual(exit.recovery, { orphans: 2, replayed: 1, interrupted: 0, notStarted: 1 }, "the exit line carries the counts");
		assert.deepEqual(lines.find((line) => line.event === "recovery_resolved"), { event: "recovery_resolved", jobId: "recover-job-1", orphans: 2, replayed: 1, interrupted: 0, notStarted: 1 });

		assert.equal(server.bodies.length, 1, "one model call: the recovery prompt");
		const sent = JSON.stringify(server.bodies[0].messages);
		assert.equal(sent.includes(TASK_PROMPT), false, "the task prompt is not sent again");
		const users = server.bodies[0].messages.filter((m) => m.role === "user");
		const lastUser = users.at(-1);
		assert.equal(typeof lastUser.content === "string" ? lastUser.content : lastUser.content.map((part) => part.text).join(""), RECOVERY_PROMPT);
		const tools = server.bodies[0].messages.filter((m) => m.role === "tool");
		const text = (m) => (typeof m.content === "string" ? m.content : m.content.map((part) => part.text ?? "").join(""));
		assert.deepEqual(tools.map((m) => m.tool_call_id), ["call-read", "call-bash"]);
		assert.match(text(tools[0]), /the restored notes/, "the replayed read carries the file's real content");
		assert.match(text(tools[1]), new RegExp(NOT_STARTED_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		assert.equal(sent.includes("No result provided"), false);
		// And it is all in the transcript the worker keeps.
		const persisted = readMessages(sessionFile);
		assert.deepEqual(persisted.filter((m) => m.role === "toolResult").map((m) => [m.toolCallId, m.details[RECOVERY_KEY]]), [["call-read", "replayed"], ["call-bash", "not-started"]]);
	} finally {
		await server.close();
	}
});
