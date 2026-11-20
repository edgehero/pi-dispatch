import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createJobModelRuntime } from "../src/model-runtime.mjs";
import { promptAdditionsOf } from "../src/prompt-additions.mjs";
import { excludableToolNames } from "../src/tools.mjs";
import { watchToolOptions } from "../src/watch.mjs";
import { createWatchTools } from "../src/watch-tools.mjs";
import { sessionFixture, scriptedRuntime, scriptedSession } from "./helpers/recover-session.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

let deps;
let importError;
try {
	deps = {
		pi: await import("@earendil-works/pi-coding-agent"),
		piAi: await import("@earendil-works/pi-ai"),
		loaderModule: await import("../src/loader.mjs"),
		sessionModule: await import("../src/session.mjs"),
		forkModule: await import("../src/fork.mjs"),
		createJobModelRuntime,
	};
} catch (error) { importError = error; }
if (!deps && process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") throw new Error(`persona context tests require pinned pi: ${importError}`);
const skip = deps ? false : "pi not installed; CI runs the pinned tests";

// Synthetic text only. The runner deliberately knows neither the operator's private words nor a tag grammar.
const persona = (revision) => `<operator_persona version="1">\nPERSONA-CONTEXT-${revision}\n</operator_persona>\n`;
const project = (revision) => `PROJECT-APPEND-${revision}\n`;
const floor = "PERSONA-CONTEXT-GUARDRAILS";
const shadow = "PERSONA-CONTEXT-WORKSPACE-SHADOW";
const conventions = "PERSONA-CONTEXT-REPO-CONVENTIONS";
const script = [[{ type: "text", text: "checked" }]];
const digest = (text) => createHash("sha256").update(text).digest("hex");
const occurrences = (text, needle) => text.split(needle).length - 1;

function fixture({ identical = false } = {}) {
	const f = sessionFixture(tempDir("persona-context-"));
	f.globalPiDir = join(f.root, "global");
	mkdirSync(f.globalPiDir);
	mkdirSync(join(f.workspace, ".pi"));
	writeFileSync(f.guardrailsPath, `${floor}\n`);
	writeFileSync(join(f.workspace, "AGENTS.md"), `${conventions}\n`);
	writeFileSync(join(f.workspace, ".pi", "APPEND_SYSTEM.md"), `${shadow}\n`);
	writeAdditions(f, "FIRST", { identical });
	return f;
}

function writeAdditions(f, revision, { identical = false } = {}) {
	writeFileSync(join(f.globalPiDir, "APPEND_SYSTEM.md"), persona(revision));
	writeFileSync(join(f.jobPi, "APPEND_SYSTEM.md"), identical ? persona(revision) : project(revision));
}

function assertContext(context, revision, { identical = false } = {}) {
	// At the 1.5.2 pin providers receive transcript system sections, not Context.systemPrompt.
	// Use pi's own replay to judge the current instructions; a resumed transcript can keep an older patch.
	const normalized = deps.piAi.normalizeContext(context);
	const system = deps.piAi.getCurrentSystemPrompt(normalized.messages);
	assert.equal(occurrences(system, persona(revision).trim()), 1, "the effective instructions have one exact persona block");
	assert.equal(occurrences(system, "<operator_persona"), 1);
	assert.equal(occurrences(system, floor), 1);
	assert.ok(system.indexOf(floor) < system.indexOf(persona(revision).trim()));
	assert.ok(system.includes(conventions), "repository conventions still reach the provider");
	assert.ok(!system.includes(shadow), "workspace discovery cannot replace the staged append files");
	if (!identical) {
		assert.equal(occurrences(system, project(revision).trim()), 1);
		assert.ok(system.indexOf(persona(revision).trim()) < system.indexOf(project(revision).trim()));
	}
	for (const other of ["FIRST", "UPDATED", "FORKED"]) {
		if (other !== revision) assert.ok(!system.includes(`PERSONA-CONTEXT-${other}`), "an older or newly edited persona is not current");
	}
	assert.ok(!system.includes("VOLATILE-REQUEST"), "task text remains user data");
	return { system, tools: deps.piAi.getCurrentTools(normalized.messages).map((tool) => tool.name).sort() };
}

test("provider context keeps cold-start additions through later turns and reload, then a resumed job reads the new snapshot", { skip }, async () => {
	const f = fixture();
	const opened = deps.sessionModule.openSessionManager({ sessionFile: f.sessionFile, cwd: f.workspace });
	assert.equal(opened.resumed, false);
	const active = await scriptedSession(deps, f, {
		api: "pi-dispatch-persona-cold", script, sessionManager: opened.sessionManager,
		loaderOptions: { globalPiDir: f.globalPiDir },
		onCall(n) { if (n === 1) writeAdditions(f, "UPDATED"); },
	});
	try {
		await active.session.prompt("VOLATILE-REQUEST first");
		await active.session.prompt("VOLATILE-REQUEST second");
		await active.session.reload();
		await active.session.prompt("VOLATILE-REQUEST after reload");
		assert.equal(active.contexts.length, 3);
		const systems = active.contexts.map((context) => assertContext(context, "FIRST").system);
		assert.equal(systems[1], systems[0]);
		assert.equal(systems[2], systems[0], "reload preserves the same cached instruction text");
		for (const context of active.contexts) {
			const rawSystem = JSON.stringify(context.messages.filter((message) => message.role === "system"));
			assert.equal(occurrences(rawSystem, "PERSONA-CONTEXT-FIRST"), 1, "a later turn does not append the persona again");
		}
		assert.deepEqual(promptAdditionsOf(active.loader), { overlay: digest(persona("FIRST")), repository: digest(project("FIRST")) });
	} finally { active.session.dispose(); }
	const resumed = deps.sessionModule.openSessionManager({ sessionFile: f.sessionFile, cwd: f.workspace });
	assert.equal(resumed.resumed, true);
	const next = await scriptedSession(deps, f, { api: "pi-dispatch-persona-resume", script, sessionManager: resumed.sessionManager, loaderOptions: { globalPiDir: f.globalPiDir } });
	try {
		await next.session.prompt("VOLATILE-REQUEST resumed");
		assert.equal(next.contexts.length, 1);
		assertContext(next.contexts[0], "UPDATED");
		assert.ok(JSON.stringify(next.contexts[0].messages).includes("VOLATILE-REQUEST first"), "the reopened session keeps its conversation");
		assert.deepEqual(promptAdditionsOf(next.loader), { overlay: digest(persona("UPDATED")), repository: digest(project("UPDATED")) });
	} finally { next.session.dispose(); }
});

test("a fork's provider context uses its fresh append snapshot and selected history without changing the source session", { skip }, async () => {
	const source = fixture();
	const opened = deps.sessionModule.openSessionManager({ sessionFile: source.sessionFile, cwd: source.workspace });
	const initial = await scriptedSession(deps, source, { api: "pi-dispatch-persona-fork-source", script, sessionManager: opened.sessionManager, loaderOptions: { globalPiDir: source.globalPiDir } });
	let entry;
	try {
		await initial.session.prompt("VOLATILE-REQUEST retained fork history");
		assertContext(initial.contexts[0], "FIRST");
		entry = opened.sessionManager.getLeafId();
		await initial.session.prompt("VOLATILE-REQUEST discarded future");
	} finally { initial.session.dispose(); }
	const sourceBytes = readFileSync(source.sessionFile);
	const f = fixture();
	writeAdditions(f, "FORKED");
	copyFileSync(source.sessionFile, f.sessionFile);
	const branched = deps.forkModule.openForkSessionManager({ sessionFile: f.sessionFile, cwd: f.workspace, fork: { entry, position: "at" } });
	assert.equal(branched.reason, "forked");
	const active = await scriptedSession(deps, f, { api: "pi-dispatch-persona-fork", script, sessionManager: branched.sessionManager, loaderOptions: { globalPiDir: f.globalPiDir } });
	try {
		await active.session.prompt("VOLATILE-REQUEST fork attempt");
		assert.equal(active.contexts.length, 1);
		assertContext(active.contexts[0], "FORKED");
		const sent = JSON.stringify(active.contexts[0].messages);
		assert.ok(sent.includes("VOLATILE-REQUEST retained fork history"));
		assert.ok(!sent.includes("VOLATILE-REQUEST discarded future"));
		assert.deepEqual(readFileSync(source.sessionFile), sourceBytes);
	} finally { active.session.dispose(); }
});

test("identical overlay and repository additions reach an ordinary provider once while retaining both source hashes", { skip }, async () => {
	const f = fixture({ identical: true });
	const { sessionManager } = deps.sessionModule.openSessionManager({ sessionFile: f.sessionFile, cwd: f.workspace });
	const active = await scriptedSession(deps, f, { api: "pi-dispatch-persona-identical", script, sessionManager, loaderOptions: { globalPiDir: f.globalPiDir } });
	try {
		await active.session.prompt("VOLATILE-REQUEST identical sources");
		assert.equal(active.contexts.length, 1);
		assertContext(active.contexts[0], "FIRST", { identical: true });
		assert.deepEqual(promptAdditionsOf(active.loader), { overlay: digest(persona("FIRST")), repository: digest(persona("FIRST")) });
	} finally { active.session.dispose(); }
});

test("watch provider context has the immutable deduplicated persona and only its reviewed read-only tools", { skip }, async () => {
	const f = fixture({ identical: true });
	const marker = join(f.root, "extension-executed");
	const malicious = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "executed"); export default function () { throw new Error("unreviewed extension"); }`;
	for (const dir of [join(f.workspace, ".pi", "extensions"), join(f.globalPiDir, "extensions")]) {
		mkdirSync(dir);
		writeFileSync(join(dir, "index.js"), malicious);
	}
	const watch = createWatchTools({ config: { version: 1 }, runtime: {} });
	const loader = await deps.loaderModule.buildLoadedResourceLoader({ cwd: f.workspace, jobPiDir: f.jobPi, globalPiDir: f.globalPiDir, guardrailsPath: f.guardrailsPath, watchReadOnly: true, watchExtensionFactories: watch.factories });
	const runtime = await scriptedRuntime(deps, f.root, "pi-dispatch-persona-watch", script, { onCall(n) { if (n === 1) writeAdditions(f, "UPDATED", { identical: true }); } });
	const { session } = await deps.pi.createAgentSession({ cwd: f.workspace, agentDir: runtime.agentDir, modelRuntime: runtime.modelRuntime, model: runtime.model, settingsManager: deps.pi.SettingsManager.inMemory({}), sessionManager: deps.pi.SessionManager.inMemory(f.workspace), resourceLoader: loader, ...watchToolOptions([], excludableToolNames(), watch.names) });
	try {
		await session.prompt("VOLATILE-REQUEST watch evidence");
		await session.reload();
		session.setActiveToolsByName(["read", "grep", "find", "ls", "board_write", "bash", "write", "edit", "codemode"]);
		await session.prompt("VOLATILE-REQUEST watch after reload");
		assert.equal(runtime.contexts.length, 2);
		for (const context of runtime.contexts) {
			const { tools } = assertContext(context, "FIRST", { identical: true });
			assert.deepEqual(tools, ["board_write", "find", "grep", "ls", "read"], "the actual provider declarations retain the read-only tool boundary");
		}
		assert.equal(existsSync(marker), false, "neither initial loading nor reload executed an unreviewed module");
		assert.deepEqual(promptAdditionsOf(loader), { overlay: digest(persona("FIRST")), repository: digest(persona("FIRST")) });
	} finally { session.dispose(); }
});
