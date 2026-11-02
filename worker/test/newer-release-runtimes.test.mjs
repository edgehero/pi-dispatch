import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { readOverlay, resolveSettings } from "../src/runtime-settings.mjs";
import { makeQuestionGroupRuntime, questionGroupConfigDigest } from "../src/question-group-runtime.mjs";
import { makeAnswerDraftRuntime } from "../src/answerer-runtime.mjs";
import { answerRuleConfigDigest } from "../src/answerer.mjs";

// The question grouping and answer draft runtimes read the triggers file (and the grouping the settings) themselves.
// A file a newer pi-dispatch wrote can land between the processor's head checks and that read (the watcher has not
// reloaded yet, or the settings turned newer after the head read them). Issue #761: the runtime then answers
// `{ newer }` before it sets or writes anything, and the processor defers the job (`newer-release`) exactly as it does
// at its head: no refusal is recorded, no grouping status set, no draft intent passed, no attempt used up.

// index.mjs imports bullmq; skip below the node floor / without deps, hard-fail in CI (mirrors pause-gate).
let mod;
let importError;
try {
	mod = await import("../src/index.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`newer-release runtime tests are REQUIRED here but bullmq could not import.\n${importError}`);
}
const skip = mod ? false : `bullmq not installed (node ${process.version} < 22.19.0); CI runs these`;

const NOW = Date.UTC(2026, 10, 2, 9, 0);
const DIGEST = "b".repeat(64);
// The env side of the settings (start.mjs's `config`); the overlay file on disk is merged over it by the real reader.
const ENV = { provider: "test", model: "chat", maxTurns: 1, dailyCap: 100, weeklyCap: null, monthlyCap: null, maxTokens: null, dailyTokenCap: null, concurrency: 1, softHoldPct: null, maxCostUsd: "0.05", dailyCostUsd: null, weeklyCostUsd: null, monthlyCostUsd: null };
const SETTINGS_TODAY = "{\n  \"maxTurns\": 1\n}\n";
const SETTINGS_NEWER = "{\n  \"version\": 2,\n  \"maxTurns\": 1\n}\n";
const ZERO_TOUCH = { capture: true, model: "test/classifier", maxCostUsd: "0.05", confidence: 0.9, names: {} };
const RULE = { id: "help", projects: ["web"], categories: ["how-to"], confidence: 0.9, mode: "draft", flow: "answer", model: "test/chat", decisionModel: "test/classifier", maxCostUsd: "0.10" };

/**
 * The two files on disk and the settings read start.mjs builds from them (`getSettings`: the overlay over env through
 * the real reader). `newerAfterHead` turns the settings file newer right after the processor's head read it, the race
 * the runtime's own answer exists for; `triggers` is the triggers document written as the file.
 */
function files({ settings = SETTINGS_TODAY, triggers }) {
	const root = tempDir("newer-release-runtimes-");
	const settingsPath = join(root, "settings.json");
	const triggersPath = join(root, "triggers.json");
	writeFileSync(settingsPath, settings);
	writeFileSync(triggersPath, `${JSON.stringify(triggers, null, 2)}\n`);
	const getSettings = () => resolveSettings(ENV, readOverlay(settingsPath));
	return { settingsPath, triggersPath, getSettings };
}

/** The real processor with every paid or observable seam a spy; `getSettings` is the processor's own read. */
function processorWith({ getSettings, deps }) {
	const seen = { calls: [], records: [], logs: [] };
	const spy = (name, value) => async () => {
		seen.calls.push(name);
		return value;
	};
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis: { get: async () => null, incr: async () => 1, decr: async () => 0, expire: async () => {}, del: async () => 0 },
		now: () => NOW,
		projects: () => [{ id: "web", members: ["github:acme/web"] }],
		getSettings,
		recordRun: (row) => seen.records.push(row),
		timeoutMs: 100000,
		deps: {
			imagePreflight: async () => ({ ok: true, piVersion: "1.4.0", capabilities: ["questionGrouping", "answerDraft", "exitAuth", "costCap", "modelPolicy", "modelFailover"] }),
			checkProviderCredential: async () => ({ ok: true }),
			checkModelsKnown: () => ({ ok: true }),
			mintToken: spy("mintToken", "tok"),
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: spy("prepareWorkspace", { workspace: "/internal-empty-workspace", workspaceDir: "/w", jobDir: "/j" }),
			runContainer: spy("runContainer", { code: 0, aborted: false, turns: 1, exitLineCode: 0, exitAuth: "verified" }),
			cleanup: async () => {},
			comment: spy("comment"),
			log: (event, fields) => seen.logs.push([event, fields]),
			...deps,
		},
	});
	return { processor, seen };
}

const delayedJob = (id, data) => {
	const moves = [];
	return { job: { id, attemptsMade: 0, opts: { attempts: 1 }, timestamp: NOW, name: data.kind, data, moveToDelayed: async (ts, token) => moves.push({ ts, token }) }, moves };
};
const holds = (seen) => seen.logs.filter(([event]) => event === "newer_release_hold").map(([, fields]) => fields);

// --- question grouping ---

function grouping({ settings, triggers = { triggers: [], zeroTouch: ZERO_TOUCH }, newerAfterHead = false, sourceStatus = "ready" }) {
	const f = files({ settings, triggers });
	const statuses = [];
	const store = {
		privateInput: async () => ({ status: sourceStatus, meta: { runId: "source", scopeId: "a".repeat(64), digest: DIGEST, project: "web" }, excerpt: "private source", revision: 0, candidates: [] }),
		setStatus: async (runId, status) => statuses.push([runId, status]),
		assign: async () => ({ status: "assigned" }),
	};
	const runtime = makeQuestionGroupRuntime({ store, triggersPath: f.triggersPath, getSettings: f.getSettings, resolveClassifier: () => ({ type: "classifier", contextWindow: 4096, cost: { input: 0, output: 0 } }) });
	let headRead = false;
	const getSettings = () => {
		const read = f.getSettings();
		if (newerAfterHead && !headRead) writeFileSync(f.settingsPath, SETTINGS_NEWER);
		headRead = true;
		return read;
	};
	const { processor, seen } = processorWith({ getSettings, deps: { questionGroupRuntime: runtime } });
	const data = { kind: "question-grouping", questionGrouping: { runId: "source", digest: DIGEST, configDigest: questionGroupConfigDigest(ZERO_TOUCH) } };
	return { processor, seen, statuses, runtime, data };
}

test("the question grouping runtime answers newer for a newer settings or triggers file, before any status is set", async () => {
	const settingsNewer = grouping({ settings: SETTINGS_NEWER });
	assert.deepEqual(await settingsNewer.runtime.resolve(settingsNewer.data, "grouping-job"), { newer: "the settings file" });
	const triggersNewer = grouping({ triggers: { version: 2, triggers: [], zeroTouch: ZERO_TOUCH } });
	assert.deepEqual(await triggersNewer.runtime.resolve(triggersNewer.data, "grouping-job"), { newer: "the triggers file" });
	assert.deepEqual([...settingsNewer.statuses, ...triggersNewer.statuses], [], "no grouping status is set: the source stays as it was");
	// A source that is not ready has its status set as the refusal is answered. A newer file is answered before that
	// too, so the source keeps the status it had for the release that can read the file.
	for (const [what, g] of [["the settings file", grouping({ settings: SETTINGS_NEWER, sourceStatus: "source-expired" })], ["the triggers file", grouping({ triggers: { version: 2, triggers: [], zeroTouch: ZERO_TOUCH }, sourceStatus: "source-expired" })]]) {
		assert.deepEqual(await g.runtime.resolve(g.data, "grouping-job"), { newer: what });
		assert.deepEqual(g.statuses, [], `${what}: no status set on a source that is not ready`);
	}
	const expired = grouping({ sourceStatus: "source-expired" });
	assert.equal((await expired.runtime.resolve(expired.data, "grouping-job")).result.reason, "question-group-source-expired", "with today's files it is refused as before");
	assert.deepEqual(expired.statuses, [["source", "source-expired"]]);
	// A broken (not newer) file keeps the refusals it always had.
	const broken = grouping({ settings: "{\n  \"maxTurns\": 0\n}\n" });
	assert.equal((await broken.runtime.resolve(broken.data, "grouping-job")).result.reason, "question-group-refused");
	const garbled = grouping({ triggers: { triggers: "nope", zeroTouch: ZERO_TOUCH } });
	assert.equal((await garbled.runtime.resolve(garbled.data, "grouping-job")).result.reason, "question-group-config-changed");
});

test("through the real processor, a grouping job that meets a newer settings or triggers file in its runtime waits ten minutes, never refused", { skip }, async () => {
	const cases = [
		["the settings file", grouping({ newerAfterHead: true })],
		// The watcher has not reloaded yet (`triggersNewer` is false), but the file on disk is already newer.
		["the triggers file", grouping({ triggers: { version: 2, triggers: [], zeroTouch: ZERO_TOUCH } })],
	];
	for (const [what, g] of cases) {
		const { job, moves } = delayedJob("grouping-job", g.data);
		await assert.rejects(() => g.processor(job, "the-token", new AbortController().signal), (err) => err.name === "DelayedError", what);
		assert.deepEqual(moves, [{ ts: NOW + 600_000, token: "the-token" }], what);
		assert.deepEqual(holds(g.seen), [{ jobId: "grouping-job", what, delayMs: 600_000 }], what);
		assert.deepEqual(g.seen.records, [], `${what}: no refusal recorded`);
		assert.deepEqual(g.statuses, [], `${what}: no grouping status set`);
		assert.deepEqual(g.seen.calls, [], `${what}: nothing minted, cloned, run or posted`);
		assert.equal(job.data, g.data, `${what}: the queued reference is kept as it was`);
	}
});

test("through the real processor, a grouping job with today's files runs as before", { skip }, async () => {
	const g = grouping({});
	const { job, moves } = delayedJob("grouping-job", g.data);
	const result = await g.processor(job, "tok", new AbortController().signal);
	assert.equal(result.outcome, "completed", JSON.stringify(result));
	assert.deepEqual(moves, []);
	assert.ok(g.seen.calls.includes("runContainer"));
	assert.deepEqual(holds(g.seen), []);
	assert.deepEqual(g.statuses[0], ["source", "pending"], "the runtime set the source pending, as it always did");
});

// --- answer draft ---

function draft({ triggers }) {
	const doc = triggers ?? { triggers: [], answerRules: [RULE], standingAnswers: [] };
	const f = files({ triggers: doc });
	const updates = [];
	const source = { kind: "github", repo: "acme/web", target: { type: "issue", number: 7 }, selfId: 99, apiUrl: "https://api.github.com", questionCommentId: "123", startedAt: NOW - 60000, parkedAt: NOW - 1000 };
	const input = { version: 1, runId: "parent-run", ruleId: "help", configDigest: answerRuleConfigDigest({ triggers: [], answerRules: [RULE], standingAnswers: [] }, RULE), project: "web", source };
	const store = {
		privateInput: async () => input,
		readMeta: async () => ({ runId: "parent-run", draftRunId: "draft-job", status: "queued" }),
		update: async (runId, fields) => updates.push([runId, fields]),
	};
	const runtime = makeAnswerDraftRuntime({
		store, triggersPath: f.triggersPath, now: () => NOW,
		identity: async () => ({ selfId: 99, apiUrl: "https://api.github.com" }),
		readParkedInfo: () => ({ runId: "parent-run", at: NOW - 1000 }),
		readApproval: async () => ({ ok: true, request: null }),
		readPendingAnswer: async () => ({ jobId: null }),
		enqueue: async () => assert.fail("a resolve enqueues nothing"),
	});
	const { processor, seen } = processorWith({ getSettings: f.getSettings, deps: { answerDraftRuntime: runtime } });
	const data = { kind: "github", purpose: "answer-draft", answerDraft: { runId: "parent-run", ruleId: "help" } };
	return { processor, seen, updates, runtime, data };
}

test("the answer draft runtime answers newer for a newer triggers file, never the throw that uses an attempt", async () => {
	const d = draft({ triggers: { version: 2, triggers: [], answerRules: [RULE], standingAnswers: [] } });
	assert.deepEqual(await d.runtime.resolve(d.data, "draft-job"), { newer: "the triggers file" });
	assert.deepEqual(d.updates, [], "the intent is not passed, failed or run");
	// A broken (not newer) file is still the infrastructure retry it always was.
	const broken = draft({ triggers: { triggers: "nope", answerRules: [RULE] } });
	await assert.rejects(broken.runtime.resolve(broken.data, "draft-job"), /answer draft inputs could not be read/);
});

test("through the real processor, an answer draft that meets a newer triggers file in its runtime waits ten minutes", { skip }, async () => {
	const d = draft({ triggers: { version: 2, triggers: [], answerRules: [RULE], standingAnswers: [] } });
	const { job, moves } = delayedJob("draft-job", d.data);
	await assert.rejects(() => d.processor(job, "the-token", new AbortController().signal), (err) => err.name === "DelayedError");
	assert.deepEqual(moves, [{ ts: NOW + 600_000, token: "the-token" }]);
	assert.deepEqual(holds(d.seen), [{ jobId: "draft-job", what: "the triggers file", delayMs: 600_000 }]);
	assert.deepEqual(d.seen.records, [], "no record");
	assert.deepEqual(d.updates, [], "the draft intent is untouched");
	assert.deepEqual(d.seen.calls, [], "nothing minted, cloned, run or posted");
	assert.equal(job.data, d.data);
});

test("through the real processor, an answer draft with today's files resolves and runs as before", { skip }, async () => {
	const d = draft({});
	const { job, moves } = delayedJob("draft-job", d.data);
	const result = await d.processor(job, "tok", new AbortController().signal);
	assert.deepEqual(moves, []);
	assert.deepEqual(holds(d.seen), []);
	assert.deepEqual(d.updates[0], ["parent-run", { status: "running" }], "the runtime resolved the intent, as it always did");
	assert.equal(job.data.purpose, "answer-draft");
	assert.equal(result.outcome, "completed", JSON.stringify(result));
	assert.deepEqual(d.seen.calls, ["mintToken", "prepareWorkspace", "runContainer"]);
});
