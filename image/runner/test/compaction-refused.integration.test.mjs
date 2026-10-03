import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
// All pure: no static pi import anywhere in their module graph, so they load unconditionally and the gate below
// applies only to pi itself. session.mjs DOES import pi, so it is loaded dynamically with it.
import { createJobModelRuntime } from "../src/model-runtime.mjs";
import { createCostGuard, createUsageMeter, installProcessUsageMeter, makeHardStopStream, resolvePiAiCompat, STOP_MESSAGES } from "../src/usage-meter.mjs";
import { COST_CAP, decideExit, EXIT_POLICY, TOKEN_BUDGET } from "../src/outcome.mjs";
import { compactionSummaryIsEmpty, fileListSuffix, hasEmptyCompaction, makeSessionStore, SESSION_FILE_NAME } from "../../../worker/src/session-store.mjs";
import { sessionKeyFor } from "../../../worker/src/session-key.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { trackPiRefreshes } from "./helpers/track-pi-refreshes.mjs";

/**
 * Issue #535: what pi writes when the runner's brake refuses a compaction's summary call, and the host check
 * that keeps such a transcript from being resumed (INT-SESSION-STORE-CONTRACT, `compaction-summary-empty`).
 *
 * Driven through the REAL pieces: pi's own session, compaction and file-backed SessionManager (opened the way
 * the runner opens /session/current.jsonl), the runner's process-wide meter and brake, and an offline provider
 * registered on the job's ModelRuntime (the fixture shape of usage-meter.integration.test.mjs, whose port-1
 * baseUrl is never dialled). The stored file is then read back three ways: as bytes, as pi reopens it for a
 * resumed job, and through the worker's own read path. So a pin bump that changes the shape pi writes fails
 * here, against the check that has to recognise it, rather than leaving the check matching an old shape.
 *
 * Gated like loader.test.mjs: a skip is NOT a pass, and CI sets PI_DISPATCH_REQUIRE_LOADER_TESTS=1.
 */
let pi;
let openSessionManager;
let importError;
try {
	pi = await import("@earendil-works/pi-coding-agent");
	trackPiRefreshes(pi.ModelRuntime);
	({ openSessionManager } = await import("../src/session.mjs"));
} catch (error) {
	importError = error;
}
if (!pi && process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") {
	throw new Error(`the #535 compaction proof is REQUIRED here but pi could not be imported.\n${importError}`);
}
const skip = pi ? false : `pi not installed (node ${process.version} < 22.19.0); CI runs these`;

const PROVIDER = "pi-dispatch-fake";
const MODEL_ID = "fake-1";
const SPLIT = "\n\n---\n\n**Turn Context (split turn):**\n\n";
/** 4242 billed tokens a call, so a token cap is crossed at a known call. */
const TOKEN_USAGE = { input: 3000, output: 1000, cacheRead: 242, cacheWrite: 0, totalTokens: 4242, cost: { input: 0.003, output: 0.001, cacheRead: 0.0002, cacheWrite: 0, total: 0.0042 } };
/** $0.40 a call on the priced model below, whose per-call bound is just over $1 (see usage-meter.integration.test.mjs). */
const FORTY_CENTS = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100, cost: { input: 0.001, output: 0.399, cacheRead: 0, cacheWrite: 0, total: 0.4 } };

/**
 * One job's worth of pi: a models.json declaring the offline provider, the runner's ModelRuntime, the meter (with
 * a guard for a cost cap), and a session on a FILE, so what pi persists is what a promotion would copy.
 */
async function job({ api, priced = false, maxTokens = null, capMicros = null, keepRecentTokens }) {
	const root = tempDir("pi-dispatch-535-");
	const modelsPath = join(root, "models.json");
	const cost = priced ? { input: 1, output: 100, cacheRead: 0, cacheWrite: 0 } : { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
	writeFileSync(modelsPath, `${JSON.stringify({ providers: { [PROVIDER]: { apiKey: "pi-dispatch-fake-key-sentinel", baseUrl: "http://127.0.0.1:1", api, models: [{ id: MODEL_ID, name: "pi-dispatch fake", api, reasoning: false, input: ["text"], cost, contextWindow: 100000, maxTokens: priced ? 10000 : 4096 }] } } })}\n`);
	const modelRuntime = await createJobModelRuntime({ ModelRuntime: pi.ModelRuntime, agentDir: root, modelsPath });
	const model = modelRuntime.getModel(PROVIDER, MODEL_ID);

	// The runner's own opener on a 0-byte file: exactly what a cold-started job is handed at /session.
	const sessionFile = join(root, SESSION_FILE_NAME);
	writeFileSync(sessionFile, "");
	const { sessionManager } = openSessionManager({ sessionFile, cwd: root });

	const meter = createUsageMeter({ maxTokens, maxCostMicros: capMicros, rootSessionId: sessionManager.getSessionId() });
	const guard = capMicros === null ? null : createCostGuard({ capMicros, log: () => {} });
	const installed = await installProcessUsageMeter({ ModelRuntime: pi.ModelRuntime, runtime: modelRuntime, meter, ...(guard ? { guard } : {}), log: () => {} });
	assert.equal(installed.ok, true);
	assert.equal(installed.brake, true, "the brake is the subject: a cap without one is enforced only after the fact");

	const calls = [];
	modelRuntime.registerProvider(PROVIDER, {
		api,
		streamSimple(m) {
			calls.push(m.id);
			const stream = installed.module.createAssistantMessageEventStream();
			const message = { role: "assistant", content: [{ type: "text", text: `answer ${calls.length}` }], api: m.api, provider: m.provider, model: m.id, usage: priced ? FORTY_CENTS : TOKEN_USAGE, stopReason: "stop", timestamp: Date.now() };
			stream.push({ type: "done", reason: "stop", message });
			return stream;
		},
	});
	await modelRuntime.refresh({ allowNetwork: false });

	// keepRecentTokens decides where pi cuts, and so which of the measured shapes the compaction takes.
	const settingsManager = pi.SettingsManager.inMemory({ compaction: { keepRecentTokens, reserveTokens: 20_000 } });
	const resourceLoader = new pi.DefaultResourceLoader({ cwd: root, agentDir: pi.getAgentDir(), settingsManager, noContextFiles: true, noSkills: true, noExtensions: true });
	await resourceLoader.reload();
	const { session } = await pi.createAgentSession({ cwd: root, agentDir: pi.getAgentDir(), modelRuntime, model, settingsManager, sessionManager, resourceLoader, noTools: "all" });
	return { root, sessionFile, session, meter, calls, done: () => (session.dispose(), installed.uninstall()) };
}

/** The stored file's entries, as a promotion would copy them. */
const entriesOf = (file) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));

/** What a resumed job would be handed: pi reopening the file, as the runner does for /session/current.jsonl. */
function resumedContext(file, root) {
	return pi.SessionManager.open(file, root, root).buildSessionContext().messages.map((m) => (m.role === "compactionSummary" ? { role: m.role, summary: m.summary } : { role: m.role }));
}

/** The worker's read path on a store holding exactly this transcript, as a promotion would have left it. */
function resolveStored(file) {
	const root = tempDir("pi-dispatch-535-store-");
	const sessionsDir = join(root, "sessions");
	const job = { kind: "github", repo: "o/r", target: { type: "issue", number: 535 } };
	const keyDir = join(sessionsDir, sessionKeyFor(job));
	mkdirSync(keyDir, { recursive: true });
	copyFileSync(file, join(keyDir, SESSION_FILE_NAME));
	writeFileSync(join(keyDir, "pi-version"), "0.99.1");
	const logs = [];
	// No TTL and no age bound, so no clock is read: the arm under test is the only one that can refuse here.
	const store = makeSessionStore({ sessionsDir, ttlDays: 0, maxBytes: 0, defaultBackend: "local", log: (event, fields) => logs.push([event, fields]) });
	const jobDir = join(root, "job");
	mkdirSync(jobDir);
	const verdict = store.resolveSession(job, { jobDir, piVersion: "0.99.1" });
	return { verdict, logs, stagedBytes: statSync(join(verdict.hostDir, SESSION_FILE_NAME)).size };
}

/** Every refused compaction is the same story after the call: the brake answered, pi recorded, the host refuses. */
function assertRefusedAndRefused({ run, stop, summary, kept }) {
	const entries = entriesOf(run.sessionFile);
	const last = entries.at(-1);
	assert.equal(last.type, "compaction", "pi recorded the compaction rather than failing it");
	assert.equal(last.summary, summary, "the measured summary: pi's own text around an empty answer");
	assert.equal(last.usage.totalTokens, 0, "the brake's answer carries zero usage");
	assert.equal(last.fromHook, false);
	assert.equal(fileListSuffix(last.details), "", "pi recorded its (empty) lists in details, and the summary ends with their suffix");
	assert.equal(run.meter.state.stopReason, stop);

	// What a resumed job sees: the empty summary in pi's wrapper, then only what the compaction kept.
	assert.deepEqual(resumedContext(run.sessionFile, run.root), [{ role: "system" }, { role: "compactionSummary", summary }, ...kept]);

	// The runner's exit for this run is a policy stop, so the worker never promotes this transcript.
	const exit = decideExit({ budgetAborted: false, budgetTurns: 0, meterStop: run.meter.state.stopReason, tokenAborted: false, terminal: null });
	assert.deepEqual(exit, { code: EXIT_POLICY, reason: stop });

	// And had a completed run left the same transcript in the store, the read path refuses it by name.
	assert.equal(compactionSummaryIsEmpty(summary), true);
	assert.equal(hasEmptyCompaction(readFileSync(run.sessionFile, "utf8")), true);
	const { verdict, logs, stagedBytes } = resolveStored(run.sessionFile);
	assert.deepEqual([verdict.resume, verdict.reason, stagedBytes], [false, "compaction-summary-empty", 0]);
	assert.deepEqual(logs.find(([event]) => event === "session_resolved")[1].reason, "compaction-summary-empty");
}

test("token cap crossed, then session.compact() on a split turn: pi stores the empty split-turn summary, and the host refuses it", { skip }, async () => {
	// One call of 4242 tokens crosses a 4000 cap; the compaction's call is the next one, so the brake answers it.
	const run = await job({ api: "pi-dispatch-535-token-split", maxTokens: 4000, keepRecentTokens: 1 });
	try {
		await run.session.prompt("prompt 0");
		assert.equal(run.meter.state.stopReason, TOKEN_BUDGET);
		await run.session.compact();
		assert.deepEqual(run.calls, [MODEL_ID], "the compaction's call never reached the provider");
		assertRefusedAndRefused({ run, stop: TOKEN_BUDGET, summary: `No prior history.${SPLIT}`, kept: [{ role: "assistant" }] });
	} finally {
		run.done();
	}
});

test("token cap crossed after two exchanges, then session.compact(): both calls refused on a split turn, or the one call on a whole turn", { skip }, async () => {
	// Two calls cross a cap one token below their sum. keepRecentTokens 1 cuts inside the last turn, so pi asks for
	// a history summary AND a turn summary, and the brake answers both. keepRecentTokens 3 keeps the last exchange
	// whole, so the cut falls on a user message, there is no split turn, and the one summary call is refused.
	for (const [keepRecentTokens, summary, kept] of [
		[1, SPLIT, [{ role: "assistant" }]],
		[3, "", [{ role: "user" }, { role: "assistant" }]],
	]) {
		const run = await job({ api: `pi-dispatch-535-token-keep${keepRecentTokens}`, maxTokens: 2 * 4242 - 1, keepRecentTokens });
		try {
			await run.session.prompt("prompt 0");
			await run.session.prompt("prompt 1");
			assert.equal(run.meter.state.stopReason, TOKEN_BUDGET);
			await run.session.compact();
			assert.equal(run.calls.length, 2, "neither summary call reached the provider");
			assertRefusedAndRefused({ run, stop: TOKEN_BUDGET, summary, kept });
		} finally {
			run.done();
		}
	}
});

test("cost cap: the compaction's call is the one refused, and pi stores the empty split-turn summary the host refuses", { skip }, async () => {
	// One turn fits under $1.30 (about $1.01 bound, $0.40 settled); the compaction's call (0.40 + about 1.01) does
	// not, so the cost guard refuses it before dispatch and the brake answers it. openai-completions is a priced api,
	// so the guard bounds the call from the model's catalog row.
	const run = await job({ api: "openai-completions", priced: true, capMicros: 1_300_000, keepRecentTokens: 1 });
	try {
		await run.session.prompt("prompt 0");
		assert.equal(run.meter.state.stopReason, null, "the first call fits under the cap");
		await run.session.compact();
		assert.deepEqual(run.calls, [MODEL_ID], "the compaction's call never reached the provider");
		assertRefusedAndRefused({ run, stop: COST_CAP, summary: `No prior history.${SPLIT}`, kept: [{ role: "assistant" }] });
	} finally {
		run.done();
	}
});

test("pi's own compact() appends the file lists after a refused summary, and the check still sees it as empty", { skip }, async () => {
	// The sessions above run with no tools, so no files are listed. pi's exported compact() is the function
	// session.compact() calls, so it is driven directly with the file operations a tool-using job would carry and
	// the brake's hard stop as the stream. The control answers the same call with text.
	const model = { id: MODEL_ID, provider: PROVIDER, api: "pi-dispatch-535-files", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 };
	// The copy the installer accepts first at the pin (pi's nested pi-ai), which supplies the brake's stream factory.
	const [accepted] = resolvePiAiCompat();
	const createStream = (await import(accepted.url)).createAssistantMessageEventStream;
	assert.equal(typeof createStream, "function");
	const hardStop = makeHardStopStream({ createStream });
	const answering = () => {
		const stream = createStream();
		const message = { role: "assistant", content: [{ type: "text", text: "## Goal\nFix the bug." }], api: model.api, provider: model.provider, model: model.id, usage: TOKEN_USAGE, stopReason: "stop", timestamp: Date.now() };
		stream.push({ type: "done", reason: "stop", message });
		return stream;
	};
	const preparation = () => ({
		firstKeptEntryId: "kept",
		messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "fix the bug" }], timestamp: 1 }],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 4242,
		previousSummary: undefined,
		fileOps: { read: new Set(["src/a.mjs"]), written: new Set(["src/b.mjs"]), edited: new Set() },
		settings: { enabled: true, reserveTokens: 20_000, keepRecentTokens: 1 },
	});

	const refused = await pi.compact(preparation(), model, "key", undefined, undefined, undefined, undefined, (m) => hardStop(m, STOP_MESSAGES[TOKEN_BUDGET]));
	assert.equal(refused.summary, "\n\n<read-files>\nsrc/a.mjs\n</read-files>\n\n<modified-files>\nsrc/b.mjs\n</modified-files>");
	assert.equal(compactionSummaryIsEmpty(refused.summary), true, "the file lists are pi's, not a summary");
	assert.equal(fileListSuffix(refused.details), refused.summary, "the suffix rebuilt from details is exactly what pi appended");
	assert.equal(compactionSummaryIsEmpty(refused.summary, refused.details), true);

	const answered = await pi.compact(preparation(), model, "key", undefined, undefined, undefined, undefined, answering);
	assert.equal(answered.summary, "## Goal\nFix the bug.\n\n<read-files>\nsrc/a.mjs\n</read-files>\n\n<modified-files>\nsrc/b.mjs\n</modified-files>");
	assert.equal(compactionSummaryIsEmpty(answered.summary), false, "the control: a real summary with the same lists is kept");
	assert.equal(compactionSummaryIsEmpty(answered.summary, answered.details), false);
});

test("fileListSuffix is pi's own formatFileOperations, for every combination of lists", { skip }, async () => {
	// formatFileOperations is not on pi's root; reached by file URL, the way pinned-api.test.mjs reaches allToolNames.
	const distDir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
	const { formatFileOperations } = await import(pathToFileURL(join(distDir, "core", "compaction", "utils.js")).href);
	for (const [readFiles, modifiedFiles] of [
		[[], []],
		[["src/a.mjs"], []],
		[[], ["src/b.mjs"]],
		[["src/a.mjs", "src/c.mjs"], ["src/b.mjs", "src/d.mjs"]],
		[["x\n\n<read-files>\ny"], ["z</modified-files>"]],
	]) {
		assert.equal(fileListSuffix({ readFiles, modifiedFiles }), formatFileOperations(readFiles, modifiedFiles), JSON.stringify([readFiles, modifiedFiles]));
	}
});

// ── PR #541's review: a split turn with no new history reuses the previous summary, file lists and all ─────────
//
// pi's compact() takes `previousSummary ?? "No prior history."` as the history when there is nothing new to
// summarise (compaction.js), so the history part can END in the previous compaction's own file lists. The first
// strip matched the leftmost list and cut from there across the split-turn marker, so this empty turn summary
// read as a real one. Both probes use pi's own functions and the brake's own stream.

/** The brake's stream factory, from the compat copy the installer accepts first. */
function brake() {
	const [accepted] = resolvePiAiCompat();
	return import(accepted.url).then((compat) => makeHardStopStream({ createStream: compat.createAssistantMessageEventStream }));
}
const probeModel = { id: MODEL_ID, provider: PROVIDER, api: "pi-dispatch-535-reuse", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096 };

test("a split turn with no new history and a refused turn summary is empty, whatever lists the reused summary carries", { skip }, async () => {
	const hardStop = await brake();
	for (const [previousSummary, fileOps] of [
		["## Goal\nPrior work.\n\n<read-files>\nsrc/a.mjs\n</read-files>", { read: new Set(["src/a.mjs"]), written: new Set(), edited: new Set() }],
		["## Goal\nPrior work.\n\n<read-files>\nsrc/a.mjs\n</read-files>\n\n<modified-files>\nsrc/b.mjs\n</modified-files>", { read: new Set(["src/a.mjs"]), written: new Set(["src/b.mjs"]), edited: new Set() }],
	]) {
		const preparation = {
			firstKeptEntryId: "kept",
			messagesToSummarize: [],
			turnPrefixMessages: [{ role: "user", content: [{ type: "text", text: "one long prompt" }], timestamp: 1 }],
			isSplitTurn: true,
			tokensBefore: 4242,
			previousSummary,
			fileOps,
			settings: { enabled: true, reserveTokens: 20_000, keepRecentTokens: 1 },
		};
		const out = await pi.compact(preparation, probeModel, "key", undefined, undefined, undefined, undefined, (m) => hardStop(m, STOP_MESSAGES[TOKEN_BUDGET]));
		assert.ok(out.summary.startsWith(`${previousSummary}${SPLIT}`), "pi reused the previous summary, lists included, as the history");
		assert.equal(compactionSummaryIsEmpty(out.summary), true, JSON.stringify(out.summary));
		assert.equal(compactionSummaryIsEmpty(out.summary, out.details), true, "and with pi's details, the exact strip");
	}
});

test("pi's own prepareCompaction reaches that shape: a turn that outlives one compaction, then a refused second one", { skip }, async () => {
	const hardStop = await brake();
	// prepareCompaction is not on pi's root; reached by file URL, the way pinned-api.test.mjs reaches allToolNames.
	const distDir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
	const { prepareCompaction } = await import(pathToFileURL(join(distDir, "core", "compaction", "compaction.js")).href);
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const assistant = (content, stopReason = "stop") => ({ role: "assistant", content, api: probeModel.api, provider: PROVIDER, model: MODEL_ID, usage, stopReason, timestamp: 1 });
	const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });

	const manager = pi.SessionManager.inMemory(tempDir("pi-dispatch-535-reuse-"));
	manager.appendMessage(user("prompt 0"));
	manager.appendMessage(assistant([{ type: "toolCall", id: "c1", name: "read", arguments: { path: "src/a.mjs" } }], "toolUse"));
	manager.appendMessage({ role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "x".repeat(400) }], isError: false, timestamp: 1 });
	manager.appendMessage(assistant([{ type: "text", text: "read it" }]));
	const turn = manager.appendMessage(user("prompt 1, a long agentic turn"));
	// The first compaction, answered, keeps the turn from its user message; its summary ends in pi's file list.
	manager.appendCompaction("## Goal\nPrior work.\n\n<read-files>\nsrc/a.mjs\n</read-files>", turn, 1000, { readFiles: ["src/a.mjs"], modifiedFiles: [] }, false);
	// The same turn goes on past it.
	for (let i = 0; i < 3; i++) {
		manager.appendMessage(assistant([{ type: "toolCall", id: `d${i}`, name: "bash", arguments: { command: `ls ${"y".repeat(300)}` } }], "toolUse"));
		manager.appendMessage({ role: "toolResult", toolCallId: `d${i}`, toolName: "bash", content: [{ type: "text", text: "z".repeat(400) }], isError: false, timestamp: 1 });
	}
	manager.appendMessage(assistant([{ type: "text", text: "still going" }]));

	const preparation = prepareCompaction(manager.getBranch(), { enabled: true, reserveTokens: 20_000, keepRecentTokens: 50 });
	assert.deepEqual([preparation.isSplitTurn, preparation.messagesToSummarize.length], [true, 0], "a split turn with no new history");
	const out = await pi.compact(preparation, probeModel, "key", undefined, undefined, undefined, undefined, (m) => hardStop(m, STOP_MESSAGES[TOKEN_BUDGET]));
	manager.appendCompaction(out.summary, out.firstKeptEntryId, out.tokensBefore, out.details, false);
	assert.ok(out.summary.includes(`</read-files>${SPLIT}`), "the reused summary's list sits right before the marker");
	assert.equal(compactionSummaryIsEmpty(out.summary), true, JSON.stringify(out.summary));
	assert.equal(compactionSummaryIsEmpty(out.summary, out.details), true, "and with pi's details, the exact strip");
	const jsonl = [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n");
	assert.equal(hasEmptyCompaction(jsonl), true);
});
