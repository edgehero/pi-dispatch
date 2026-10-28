import assert from "node:assert/strict";
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseRunnerEnv } from "../src/config.mjs";
import { createJobModelRuntime } from "../src/model-runtime.mjs";
import { EXIT_POLICY } from "../src/outcome.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { assistantMessage, sessionFixture, scriptedSession } from "./helpers/recover-session.mjs";

let deps;
let forkModule;
let importError;
try {
	deps = { pi: await import("@earendil-works/pi-coding-agent"), piAi: await import("@earendil-works/pi-ai"), loaderModule: await import("../src/loader.mjs"), createJobModelRuntime };
	forkModule = await import("../src/fork.mjs");
} catch (error) { importError = error; }
if (!deps && process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") throw new Error(`fork tests require pinned pi: ${importError}`);
const skip = deps ? false : "pi not installed; CI runs the pinned tests";
const base = { PI_PROVIDER: "anthropic", PI_MODEL: "claude-x", PI_MAX_TURNS: "10" };
const policy = (error) => error.piDispatchExit === EXIT_POLICY;

test("fork env requires a complete, bounded request and refuses command/recovery combinations", () => {
	assert.equal(parseRunnerEnv(base).fork, null);
	const request = { ...base, PI_FORK_ENTRY: "abc12345", PI_FORK_POSITION: "before", PI_SESSION_FILE: "/session/current.jsonl" };
	assert.deepEqual(parseRunnerEnv(request).fork, { entry: "abc12345", position: "before" });
	for (const override of [{ PI_FORK_ENTRY: "" }, { PI_FORK_ENTRY: "../path" }, { PI_FORK_ENTRY: "x".repeat(129) }, { PI_FORK_POSITION: "after" }, { PI_FORK_POSITION: undefined }, { PI_SESSION_FILE: undefined }, { PI_COMMAND: "workflow" }, { PI_RECOVER: "1", PI_RECOVERING: "1" }]) assert.throws(() => parseRunnerEnv({ ...request, ...override }), policy);
	assert.throws(() => parseRunnerEnv({ ...base, PI_FORK_POSITION: "at" }), policy);
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) assert.equal(parseRunnerEnv({ ...base, PI_THINKING_LEVEL: level }).thinkingLevel, level);
	for (const level of ["", "HIGH", " high", "auto"]) assert.throws(() => parseRunnerEnv({ ...base, PI_THINKING_LEVEL: level }), policy);
});

function fixture() {
	const f = sessionFixture(tempDir("fork-"));
	const manager = deps.pi.SessionManager.open(f.sessionFile, join(f.root, "session"), f.workspace);
	manager.appendModelChange("old-provider", "old-model");
	const first = manager.appendMessage({ role: "user", content: "kept first request", timestamp: 1 });
	const answer = manager.appendMessage(assistantMessage([{ type: "text", text: "kept answer" }]));
	const second = manager.appendMessage({ role: "user", content: "discard this future request", timestamp: 2 });
	manager.appendMessage(assistantMessage([{ type: "text", text: "discard this future answer" }]));
	const sourceFile = join(f.root, "source.jsonl");
	copyFileSync(f.sessionFile, sourceFile);
	return { f, first, answer, second, sourceFile, source: readFileSync(sourceFile) };
}

test("a real fork discards later entries from model context, persists the selected model, and preserves the source", { skip }, async () => {
	const { f, answer, sourceFile, source } = fixture();
	const { sessionManager } = forkModule.openForkSessionManager({ sessionFile: f.sessionFile, cwd: f.workspace, fork: { entry: answer, position: "at" } });
	assert.equal(sessionManager.getSessionFile(), f.sessionFile);
	assert.equal(sessionManager.getHeader().parentSession, undefined, "a reused mounted filename must not point to itself as its parent");
	const active = await scriptedSession(deps, f, { api: "pi-dispatch-fork-test", script: [[{ type: "text", text: "new attempt" }]], sessionManager, reasoning: true, thinkingLevel: "high" });
	try {
		forkModule.assertThinkingLevel(active.model, "high");
		forkModule.recordForkSettings(sessionManager, active.model, "high");
		await active.session.prompt("try a different approach");
		const sent = JSON.stringify(active.contexts[0].messages);
		assert.match(sent, /kept first request/);
		assert.match(sent, /kept answer/);
		assert.doesNotMatch(sent, /discard this future/);
		assert.match(sent, /try a different approach/);
		assert.equal(active.contexts[0].model.id, active.model.id);
		assert.equal(active.contexts[0].reasoning, "high", "the provider receives the requested thinking level");
		const reopened = deps.pi.SessionManager.open(f.sessionFile, join(f.root, "session"), f.workspace);
		assert.deepEqual(reopened.buildSessionContext().model, { provider: active.model.provider, modelId: active.model.id });
		assert.equal(reopened.buildSessionContext().thinkingLevel, "high");
		assert.deepEqual(readFileSync(sourceFile), source);
	} finally { active.session.dispose(); }
});

test("before arbitrary entries selects their parent; before the first message persists a valid empty conversation", { skip }, () => {
	const { f, answer, first } = fixture();
	const branched = forkModule.openForkSessionManager({ sessionFile: f.sessionFile, cwd: f.workspace, fork: { entry: answer, position: "before" } });
	assert.deepEqual(branched.sessionManager.buildSessionContext().messages.map((message) => message.role), ["user"]);
	const empty = forkModule.openForkSessionManager({ sessionFile: f.sessionFile, cwd: f.workspace, fork: { entry: first, position: "before" } });
	assert.deepEqual(empty.sessionManager.buildSessionContext().messages, []);
	assert.equal(empty.resumed, false);
	assert.equal(empty.sessionManager.getSessionFile(), f.sessionFile);
	assert.equal(JSON.parse(readFileSync(f.sessionFile, "utf8").split("\n")[0]).type, "session");
});

test("a nested fork follows tree parents and never selects an unrelated physical branch", { skip }, () => {
	const { f, first, second } = fixture();
	const manager = deps.pi.SessionManager.open(f.sessionFile, join(f.root, "session"), f.workspace);
	manager.branch(first);
	const alternate = manager.appendMessage(assistantMessage([{ type: "text", text: "alternate branch" }]));
	const result = forkModule.openForkSessionManager({ sessionFile: f.sessionFile, cwd: f.workspace, fork: { entry: alternate, position: "at" } });
	assert.equal(result.sessionManager.getEntry(second), undefined);
	const nested = forkModule.openForkSessionManager({ sessionFile: f.sessionFile, cwd: f.workspace, fork: { entry: alternate, position: "before" } });
	assert.equal(nested.sessionManager.buildSessionContext().messages.length, 1);
});

test("missing entries and incomplete tool calls refuse without modifying the staged transcript", { skip }, () => {
	const { f } = fixture();
	const manager = deps.pi.SessionManager.open(f.sessionFile, join(f.root, "session"), f.workspace);
	const call = manager.appendMessage(assistantMessage([{ type: "toolCall", id: "unanswered", name: "write", arguments: { path: "x", content: "y" } }]));
	const before = readFileSync(f.sessionFile);
	for (const entry of [call, "missing"]) assert.throws(() => forkModule.openForkSessionManager({ sessionFile: f.sessionFile, cwd: f.workspace, fork: { entry, position: "at" } }), policy);
	assert.deepEqual(readFileSync(f.sessionFile), before);
});

test("unsupported explicit thinking is refused rather than silently clamped", { skip }, () => {
	forkModule.assertThinkingLevel({ reasoning: false }, "off");
	assert.throws(() => forkModule.assertThinkingLevel({ reasoning: false }, "high"), policy);
	forkModule.assertThinkingLevel({ reasoning: false }, null);
});

test("the true root cut creates an empty mounted session even when pi would lazily persist it", { skip }, () => {
	const { f } = fixture();
	const manager = deps.pi.SessionManager.open(f.sessionFile, join(f.root, "session"), f.workspace);
	const root = manager.getEntries()[0];
	assert.equal(root.parentId, null);
	const branched = forkModule.openForkSessionManager({ sessionFile: f.sessionFile, cwd: f.workspace, fork: { entry: root.id, position: "before" } });
	assert.equal(branched.sessionManager.getEntries().length, 0);
	assert.deepEqual(deps.pi.SessionManager.open(f.sessionFile, join(f.root, "session"), f.workspace).buildSessionContext().messages, []);
});

test("compaction and labels survive a tree-aware fork with valid retained-entry references", { skip }, () => {
	const { f, first, second } = fixture();
	const manager = deps.pi.SessionManager.open(f.sessionFile, join(f.root, "session"), f.workspace);
	manager.branch(first);
	manager.appendLabelChange(first, "retained request");
	const kept = manager.appendMessage({ role: "user", content: "request after label", timestamp: 2 });
	const compact = manager.appendCompaction("summary of kept history", kept, 30);
	manager.appendMessage({ role: "user", content: "future after compaction", timestamp: 3 });
	const branched = forkModule.openForkSessionManager({ sessionFile: f.sessionFile, cwd: f.workspace, fork: { entry: compact, position: "at" } });
	assert.equal(branched.sessionManager.getEntry(second), undefined);
	assert.equal(branched.sessionManager.getLabel(first), "retained request");
	assert.equal(branched.sessionManager.getEntry(compact).firstKeptEntryId, kept);
	assert.match(JSON.stringify(branched.sessionManager.buildSessionContext().messages), /summary of kept history/);
	assert.doesNotMatch(JSON.stringify(branched.sessionManager.buildSessionContext().messages), /future after compaction/);
});

test("a completed tool boundary forks with both its call and result intact", { skip }, () => {
	const { f } = fixture();
	const manager = deps.pi.SessionManager.open(f.sessionFile, join(f.root, "session"), f.workspace);
	manager.appendMessage(assistantMessage([{ type: "toolCall", id: "answered", name: "read", arguments: { path: "x" } }]));
	const result = manager.appendMessage({ role: "toolResult", toolCallId: "answered", toolName: "read", content: [{ type: "text", text: "snapshot file content" }], isError: false, timestamp: 3 });
	const branched = forkModule.openForkSessionManager({ sessionFile: f.sessionFile, cwd: f.workspace, fork: { entry: result, position: "at" } });
	assert.equal(branched.sessionManager.buildSessionContext().messages.at(-1).toolCallId, "answered");
});
