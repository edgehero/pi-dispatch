import assert from "node:assert/strict";
import { test } from "node:test";
import { makeInFlight, rowScopeFor } from "../src/scoped-limits.mjs";
import { deferFieldsOf, withDeferRecords } from "./helpers/defer-redis.mjs";

// The newer-release waits through the processor (issue #761): a settings overlay, a pause windows file or a triggers
// file written by a newer pi-dispatch DEFERS the job (`newer-release`), never refuses it, and nothing is settled,
// recorded, posted, minted, cloned, run or reserved on the way, while every hold the pickup took is given back.

// index.mjs imports bullmq; skip below the node floor / without deps, hard-fail in CI (mirrors pause-gate).
let mod;
let importError;
try {
	mod = await import("../src/index.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`newer-release hold tests are REQUIRED here but bullmq could not import.\n${importError}`);
}
const skip = mod ? false : `bullmq not installed (node ${process.version} < 22.19.0); CI runs these`;

const NOW = Date.UTC(2026, 10, 2, 9, 0);
const SETTINGS = { provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null };
const NEWER_SETTINGS = { invalid: "settings file written by a newer pi-dispatch (version 2; this build understands 1)", newer: true };

/**
 * A processor whose every paid or observable seam is a spy: `calls` names each seam that ran, `records` counts run
 * records, `incr` counts budget reservations, `logs` keeps the log lines. `settleHeld` is the settle every final outcome
 * of an awaitInput job reaches (index.mjs `settleSteer`), so a job armed with it proves no settle happened. The redis
 * keeps the reason each deferral recorded (`deferFieldsOf`), which is what the console shows for a waiting job.
 */
function harness({ settings = SETTINGS, pauseWindowsNewer = () => false, triggersNewer = () => false, pauseUntil = () => null, deps = {} } = {}) {
	const seen = { calls: [], records: 0, incr: 0, logs: [] };
	const spy = (name, value) => async () => {
		seen.calls.push(name);
		return typeof value === "function" ? value() : value;
	};
	const redis = withDeferRecords({ incr: async () => (seen.incr++, 1), decr: async () => 0, expire: async () => {} });
	const inFlight = makeInFlight();
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis,
		inFlight,
		getSettings: () => {
			seen.calls.push("getSettings");
			return typeof settings === "function" ? settings() : settings;
		},
		pauseUntil: (...args) => {
			seen.calls.push("pauseUntil");
			return pauseUntil(...args);
		},
		pauseWindowsNewer,
		triggersNewer,
		projects: () => {
			seen.calls.push("projects");
			return [];
		},
		now: () => NOW,
		recordRun: () => {
			seen.records++;
		},
		timeoutMs: 100000,
		deps: {
			mintToken: spy("mintToken", "tok"),
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: spy("prepareWorkspace", { workspaceDir: "/w", jobDir: "/j" }),
			runContainer: spy("runContainer", { code: 0, aborted: false, turns: 1 }),
			cleanup: async () => {},
			comment: spy("comment"),
			settleHeld: spy("settleHeld", null),
			log: (event, fields) => seen.logs.push([event, fields]),
			...deps,
		},
	});
	return { processor, seen, inFlight, redis };
}

function spyJob(data) {
	const moves = [];
	return { job: { id: "gh-761", attemptsMade: 0, name: data.kind, data, moveToDelayed: async (ts, tok) => moves.push({ ts, tok }) }, moves };
}

const LOCAL = { kind: "local", folder: "/srv/site", flow: "tidy", task: "t", awaitInput: true };
const forgeJob = (matched, extra = {}) => ({ kind: "github", repo: "acme/web", target: { type: "issue", number: 7 }, flow: "fix", awaitInput: true, trigger: { deliveryId: "d-761", sender: { id: 1 }, matched }, ...extra });
const PAID = ["mintToken", "prepareWorkspace", "runContainer", "comment", "settleHeld"];
const deferred = (err) => err?.name === "DelayedError";

function assertNothingSpent(seen, what) {
	assert.deepEqual(seen.calls.filter((c) => PAID.includes(c)), [], `${what}: nothing minted, cloned, run, posted or settled`);
	assert.equal(seen.records, 0, `${what}: no record, a deferral is not an outcome`);
	assert.equal(seen.incr, 0, `${what}: no budget slot`);
}

// The head gate for the settings: every kind of job, including the ones a refusal before the pickup's own settings read
// would end (a console draft answer whose source does not check out, a question grouping whose project is gone, a size
// that never fits, a wait condition this build cannot read), waits at the processor's head, right after the triggers
// file's gate, before any branch reads anything, and its deferral records `newer-release` as the reason.
test("a settings overlay a newer pi-dispatch wrote defers EVERY kind of job at the processor's head, before any runtime, read, hold or spend", { skip }, async () => {
	const kinds = [
		["forge", forgeJob({ type: "issue", index: 0 })],
		["local", LOCAL],
		["watch", { kind: "watch", watch: { findingId: "a".repeat(64), ruleId: "r", phase: "dispatch" } }],
		["answer draft", { kind: "answer-draft", purpose: "answer-draft", answerDraft: { runId: "gh-1", ruleId: "faq" } }],
		// Refused by the console draft source check (`checkDraftAnswerSource`, the first check after the head) when it gets
		// that far: its provenance does not parse, and no draft store is wired anyway.
		["console draft answer", forgeJob({ type: "comment", index: 0 }, { parkedReply: true, console: { draftRunId: "draft-1", draftDigest: "not-a-digest", draftSourceRunId: "gh-1" } })],
		// Refused before the pickup's settings read when it gets that far: its source project is not in projects.json.
		["question grouping", { kind: "local", purpose: "zero-touch-grouping", questionGrouping: { project: "gone" } }],
		// A wait condition this build cannot read is refused at the wait gate, also before the pickup's read.
		["unreadable wait", { kind: "local", folder: "/srv/site", flow: "tidy", task: "t", waitFor: [{ someday: "x" }] }],
	];
	for (const [label, data] of kinds) {
		const runtimes = [];
		const runtime = (name) => ({ resolve: async () => (runtimes.push(name), { result: { outcome: "policy", reason: "x", budgetReserved: false } }), refused: async () => runtimes.push(`${name}.refused`) });
		const { processor, seen, inFlight, redis } = harness({
			settings: NEWER_SETTINGS,
			deps: { watchRuntime: runtime("watch"), answerDraftRuntime: runtime("answerDraft"), questionGroupRuntime: runtime("grouping"), checkSandboxWorkspace: async () => (runtimes.push("sandbox"), null) },
		});
		const { job, moves } = spyJob(data);
		await assert.rejects(() => processor(job, "the-token", new AbortController().signal), deferred, label);
		assert.deepEqual(moves, [{ ts: NOW + mod.NEWER_RELEASE_RECHECK_MS, tok: "the-token" }], label);
		assert.equal(deferFieldsOf(redis, "gh-761")?.why, "newer-release", `${label}: the reason the console shows`);
		assert.deepEqual(runtimes, [], `${label}: no runtime resolved, no sandbox boundary read`);
		assert.deepEqual(seen.calls, ["getSettings"], `${label}: the head's read and nothing after it: no projects or pause read, nothing minted, cloned, run, posted or settled`);
		assertNothingSpent(seen, label);
		assert.equal(inFlight.count(rowScopeFor(data, [])), 0, `${label}: no slot was taken`);
		assert.deepEqual(seen.logs.filter(([event]) => event === "newer_release_hold").map(([, fields]) => fields), [{ jobId: "gh-761", what: "the settings file", delayMs: mod.NEWER_RELEASE_RECHECK_MS }], `${label}: the store is named, never the reason's words`);
	}
	// The triggers file's gate is asked first, and says so; the settings' is the next one.
	const both = harness({ settings: NEWER_SETTINGS, triggersNewer: () => true });
	const { job } = spyJob(LOCAL);
	await assert.rejects(() => both.processor(job, "tok", new AbortController().signal), deferred);
	assert.deepEqual(both.seen.logs.filter(([event]) => event === "newer_release_hold").map(([, fields]) => fields.what), ["the triggers file"]);
	assert.deepEqual(both.seen.calls, [], "the settings are not even read");
});

test("a settings file that turns newer between the head's read and the pickup's waits at the pickup, with every hold given back", { skip }, async () => {
	let reads = 0;
	const { processor, seen, inFlight } = harness({ settings: () => (++reads === 1 ? SETTINGS : NEWER_SETTINGS) });
	const { job, moves } = spyJob(LOCAL);
	await assert.rejects(() => processor(job, "the-token", new AbortController().signal), deferred);
	assert.equal(reads, 2, "the head read today's file; the pickup read it again and found it newer");
	assert.deepEqual(moves, [{ ts: NOW + mod.NEWER_RELEASE_RECHECK_MS, tok: "the-token" }]);
	assertNothingSpent(seen, "settings at the pickup");
	assert.ok(seen.calls.includes("pauseUntil"), "this job got past the pause gate before the pickup's read");
	assert.equal(inFlight.count(rowScopeFor(LOCAL, [])), 0, "the folder slot taken before the pickup's read went back");
	assert.deepEqual(seen.logs.filter(([event]) => event === "newer_release_hold").map(([, fields]) => fields), [{ jobId: "gh-761", what: "the settings file", delayMs: mod.NEWER_RELEASE_RECHECK_MS }]);
});

test("a settings read that throws at the head is left to the pickup, which records and raises it as it always did", { skip }, async () => {
	let reads = 0;
	const { processor, seen } = harness({ settings: () => { reads++; throw new Error("overlay boom"); } });
	const { job, moves } = spyJob(LOCAL);
	await assert.rejects(() => processor(job, "tok", new AbortController().signal), (err) => err.name === "UnrecoverableError" && err.message === "overlay boom");
	assert.equal(reads, 2, "the head's throw fell through to the pickup's own read");
	assert.equal(moves.length, 0);
	assert.equal(seen.records, 1, "the pickup's record of the throw, as before");
	assert.equal(seen.logs.some(([event]) => event === "newer_release_hold"), false);
});

test("a BROKEN overlay still refuses as settings-overlay-invalid: only a newer one waits", { skip }, async () => {
	const { processor, seen } = harness({ settings: { invalid: "maxTurns must be an integer of 1 or more" } });
	const { job, moves } = spyJob(LOCAL);
	const result = await processor(job, "tok", new AbortController().signal);
	assert.equal(result.reason, "settings-overlay-invalid");
	assert.equal(moves.length, 0);
	assert.equal(seen.records, 1);
});

test("a pause windows file a newer pi-dispatch wrote defers every job right before the pause gate, before the pickup's settings read", { skip }, async () => {
	for (const data of [LOCAL, forgeJob({ type: "issue", index: 0 })]) {
		const { processor, seen, inFlight } = harness({ pauseWindowsNewer: () => true });
		const { job, moves } = spyJob(data);
		await assert.rejects(() => processor(job, "tok", new AbortController().signal), deferred);
		assert.deepEqual(moves, [{ ts: NOW + mod.NEWER_RELEASE_RECHECK_MS, tok: "tok" }]);
		assert.deepEqual(seen.calls, ["getSettings", "projects"], "the head's newer check only; the last good windows are not asked (they may not pause what the file pauses), and no pickup settings read");
		assertNothingSpent(seen, data.kind);
		assert.equal(inFlight.count(rowScopeFor(data, [])), 0, "no slot was taken");
		assert.equal(seen.logs.find(([event]) => event === "newer_release_hold")?.[1].what, "the pause windows file");
	}
	// Cleared (a good reload), the same job meets the pause gate as before.
	const { processor, seen } = harness({ pauseWindowsNewer: () => false });
	const { job, moves } = spyJob(LOCAL);
	await processor(job, "tok", new AbortController().signal);
	assert.equal(moves.length, 0);
	assert.ok(seen.calls.includes("pauseUntil") && seen.calls.includes("runContainer"));
});

test("a watch job waits on a newer pause windows file BEFORE its runtime resolves, so no finding is taken", { skip }, async () => {
	let resolved = 0;
	const watchRuntime = { resolve: async () => (resolved++, { result: { outcome: "policy", reason: "watch-threshold", budgetReserved: false } }) };
	const { processor, seen } = harness({ pauseWindowsNewer: () => true, deps: { watchRuntime } });
	const { job, moves } = spyJob({ kind: "watch", watch: { findingId: "a".repeat(64), ruleId: "r", phase: "dispatch" } });
	await assert.rejects(() => processor(job, "tok", new AbortController().signal), deferred);
	assert.equal(resolved, 0, "the runtime that takes the finding never ran");
	assert.equal(moves.length, 1);
	assert.equal(seen.records, 0);
	// Without the newer file the runtime resolves as before.
	const plain = harness({ deps: { watchRuntime } });
	const second = spyJob({ kind: "watch", watch: { findingId: "a".repeat(64), ruleId: "r", phase: "dispatch" } });
	assert.equal((await plain.processor(second.job, "tok", new AbortController().signal)).reason, "watch-threshold");
	assert.equal(resolved, 1);
});

// The processor's free gates read the live triggers file and throw `NewerReleaseHold`; the index's catch defers it.
const HOLD_CASES = [
	{
		what: "the one-shot check",
		data: forgeJob({ type: "issue", index: 0, once: true }),
		deps: (calls) => ({ checkOnceSpent: async () => (calls.push("checkOnceSpent"), { newer: true }) }),
		asked: "checkOnceSpent",
	},
	{
		what: "the skew check",
		data: forgeJob({ type: "label", index: 0 }),
		deps: (calls) => ({ checkWaitSkew: async () => (calls.push("checkWaitSkew"), { newer: true }) }),
		asked: "checkWaitSkew",
	},
	{
		what: "the approval check",
		data: forgeJob({ type: "comment", index: 0 }, { gates: ["deploy:staging"], resume: true }),
		deps: (calls) => ({ approvalRuntime: { before: async () => (calls.push("approvalBefore"), { newer: true }), finish: async () => (calls.push("approvalFinish"), { ok: true }) } }),
		asked: "approvalBefore",
	},
];

for (const c of HOLD_CASES) {
	test(`a newer triggers file at ${c.what} defers the job (newer-release) from the processor's catch, before any spend`, { skip }, async () => {
		const asked = [];
		const { processor, seen, inFlight } = harness({ deps: c.deps(asked) });
		const { job, moves } = spyJob(c.data);
		await assert.rejects(() => processor(job, "tok", new AbortController().signal), deferred);
		assert.deepEqual(asked, [c.asked], "the free check ran, and nothing after it");
		assert.deepEqual(moves, [{ ts: NOW + mod.NEWER_RELEASE_RECHECK_MS, tok: "tok" }]);
		assertNothingSpent(seen, c.what);
		assert.equal(inFlight.count(rowScopeFor(c.data, [])), 0, "the repo slot the pickup held went back in the finally");
		assert.deepEqual(seen.logs.filter(([event]) => event === "newer_release_hold").map(([, fields]) => fields), [{ jobId: "gh-761", what: "the triggers file", delayMs: mod.NEWER_RELEASE_RECHECK_MS }]);
		assert.equal(seen.logs.some(([event]) => event === "defer_retry" || event === "job_cancelled_instead_of_retry"), false, "no attempt counted");
	});
}

// The head gate: the triggers file on disk was written by a newer pi-dispatch (start.mjs's reload says so), and every
// kind of job waits at the processor's head, right after the job data's gate, before any branch reads anything.
test("a newer triggers file defers EVERY kind of job at the processor's head, before any runtime, read, hold or spend", { skip }, async () => {
	const kinds = [
		["forge", { kind: "github", repo: "acme/web", target: { type: "issue", number: 7 }, flow: "fix", trigger: { deliveryId: "d", sender: { id: 1 }, matched: { type: "label", index: 0 } } }],
		["local", { kind: "local", folder: "/srv/site", flow: "tidy", task: "t" }],
		["cron", { kind: "local", folder: "/srv/site", flow: "tidy", task: "t", trigger: { id: "nightly", pattern: "0 3 * * *" } }],
		["watch", { kind: "watch", watch: { findingId: "a".repeat(64), ruleId: "r", phase: "dispatch" } }],
		["answer draft", { kind: "answer-draft", purpose: "answer-draft", answerDraft: { runId: "gh-1", ruleId: "faq" } }],
		["question grouping", { kind: "zero-touch-grouping", purpose: "zero-touch-grouping", questionGrouping: { project: null } }],
	];
	for (const [label, data] of kinds) {
		const runtimes = [];
		const runtime = (name) => ({ resolve: async () => (runtimes.push(name), { result: { outcome: "policy", reason: "x", budgetReserved: false } }), refused: async () => runtimes.push(`${name}.refused`) });
		const { processor, seen } = harness({
			triggersNewer: () => true,
			deps: { watchRuntime: runtime("watch"), answerDraftRuntime: runtime("answerDraft"), questionGroupRuntime: runtime("grouping"), checkSandboxWorkspace: async () => (runtimes.push("sandbox"), null) },
		});
		const { job, moves } = spyJob(data);
		if (label === "cron") job.id = "repeat:nightly:1793232000000";
		await assert.rejects(() => processor(job, "tok", new AbortController().signal), deferred, label);
		assert.deepEqual(moves, [{ ts: NOW + mod.NEWER_RELEASE_RECHECK_MS, tok: "tok" }], label);
		assert.deepEqual(runtimes, [], `${label}: no runtime resolved, no sandbox boundary read`);
		assert.deepEqual(seen.calls, [], `${label}: no projects, settings or pause read, nothing minted, cloned, run, posted or settled`);
		assert.equal(seen.records, 0, label);
		assert.equal(seen.incr, 0, label);
		assert.deepEqual(seen.logs.filter(([event]) => event === "newer_release_hold").map(([, fields]) => fields.what), ["the triggers file"], label);
	}
	// Job data a newer release wrote is asked first, and says so; the triggers gate is the second.
	const both = harness({ triggersNewer: () => true });
	const { job } = spyJob({ kind: "local", folder: "/srv/site", flow: "tidy", task: "t", dataVersion: 2 });
	await assert.rejects(() => both.processor(job, "tok", new AbortController().signal), deferred);
	assert.deepEqual(both.seen.logs.filter(([event]) => event === "newer_release_hold").map(([, fields]) => fields.what), ["job data"]);
	// Cleared (the next good reload), the same job runs.
	const cleared = harness({ triggersNewer: () => false });
	const local = spyJob(LOCAL);
	assert.equal((await cleared.processor(local.job, "tok", new AbortController().signal)).outcome, "completed");
	assert.equal(local.moves.length, 0);
});

test("a watch runtime that met a newer read before taking the finding defers the job, never refuses it", { skip }, async () => {
	for (const what of ["the triggers file", "the settings file"]) {
		const { processor, seen } = harness({ deps: { watchRuntime: { resolve: async () => ({ newer: what }) } } });
		const { job, moves } = spyJob({ kind: "watch", watch: { findingId: "a".repeat(64), ruleId: "r", phase: "dispatch" } });
		await assert.rejects(() => processor(job, "tok", new AbortController().signal), deferred);
		assert.deepEqual(moves, [{ ts: NOW + mod.NEWER_RELEASE_RECHECK_MS, tok: "tok" }]);
		assert.equal(seen.records, 0, "no record: the finding was not taken and the job is not over");
		assert.deepEqual(seen.logs.filter(([event]) => event === "newer_release_hold").map(([, fields]) => fields.what), [what]);
	}
});
