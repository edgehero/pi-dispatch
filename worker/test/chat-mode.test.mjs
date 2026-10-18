import assert from "node:assert/strict";
import { test } from "node:test";
import { CHAT_MODES, CHAT_REFUSALS, chatModeOf, parkedVerdictOf, pendingFactsOf, RUN_STATES, runStateOf } from "../src/chat-mode.mjs";

const parkedRecord = { jobId: "gh-1", kind: "github", target: "o/r#7", outcome: "completed", reason: "awaiting-input" };
const doneRecord = { jobId: "gh-1", kind: "github", target: "o/r#7", outcome: "completed", reason: "done" };

test("the table: active or an active recovery is live, an unanswered park is a reply, anything else finished is a fork", () => {
	assert.deepEqual(chatModeOf({ state: "active", record: null, activeJobId: "gh-1" }), { mode: "live", says: null });
	// The base attempt failed and its run goes on as `.r1`: live, through the recovery job.
	assert.deepEqual(chatModeOf({ state: "failed", record: { ...doneRecord, outcome: "failed", reason: "recovery-enqueued" }, activeJobId: "gh-1.r1" }), { mode: "live", says: null });
	assert.deepEqual(chatModeOf({ state: "completed", record: parkedRecord, activeJobId: null, parked: { answered: false } }), { mode: "reply", says: null });
	assert.deepEqual(chatModeOf({ state: null, record: doneRecord, activeJobId: null }), { mode: "fork", says: null });
	assert.deepEqual(chatModeOf({ state: "failed", record: { ...doneRecord, outcome: "failed", reason: "exit-1" } }), { mode: "fork", says: null });
	assert.equal(runStateOf({ state: "active" }), "active");
	assert.equal(runStateOf({ record: parkedRecord, parked: { answered: false } }), "parked");
	assert.equal(runStateOf({ record: doneRecord }), "finished");
});

test("refusals carry a sentence: queued, unknown, answered, and a park whose answer cannot be judged", () => {
	for (const state of ["waiting", "delayed", "prioritized", "waiting-children", "paused"]) {
		assert.deepEqual(chatModeOf({ state, record: null }), { mode: null, says: CHAT_REFUSALS.queued }, state);
		// A retry waiting to start is about to write the session, so queued wins over an earlier attempt's record.
		assert.deepEqual(chatModeOf({ state, record: doneRecord }), { mode: null, says: CHAT_REFUSALS.queued }, `${state} with a record`);
		assert.equal(runStateOf({ state }), "queued");
	}
	assert.deepEqual(chatModeOf({ state: null, record: null }), { mode: null, says: CHAT_REFUSALS.unknown });
	assert.deepEqual(chatModeOf({}), { mode: null, says: CHAT_REFUSALS.unknown });
	assert.deepEqual(chatModeOf(), { mode: null, says: CHAT_REFUSALS.unknown });
	assert.deepEqual(chatModeOf({ state: "completed", record: null }), { mode: null, says: CHAT_REFUSALS.endedNoRecord });
	assert.deepEqual(chatModeOf({ state: "failed", record: null }), { mode: null, says: CHAT_REFUSALS.endedNoRecord }, "a failed job is ended too");
	assert.deepEqual(chatModeOf({ state: "completed", record: parkedRecord, parked: { answered: true } }), { mode: null, says: CHAT_REFUSALS.answered });
	assert.equal(runStateOf({ record: parkedRecord, parked: { answered: true } }), "answered");
	for (const parked of [null, undefined, {}, { answered: "no" }]) {
		assert.deepEqual(chatModeOf({ record: parkedRecord, parked }), { mode: null, says: CHAT_REFUSALS.parkedUnknown }, JSON.stringify(parked));
		assert.equal(runStateOf({ record: parkedRecord, parked }), "unknown");
	}
	for (const says of Object.values(CHAT_REFUSALS)) assert.doesNotMatch(says, /[\u2013\u2014]/, "no dash as punctuation");
});

test("active wins over a record (an infra retry runs while attempt 1's record exists); a malformed active id is no active job", () => {
	assert.deepEqual(chatModeOf({ state: "active", record: parkedRecord, parked: { answered: false } }), { mode: "live", says: null });
	assert.deepEqual(chatModeOf({ state: null, record: doneRecord, activeJobId: "bad id\n" }), { mode: "fork", says: null });
	assert.deepEqual(chatModeOf({ state: null, record: doneRecord, activeJobId: 7 }), { mode: "fork", says: null });
	assert.deepEqual(chatModeOf({ state: null, record: "not a record" }), { mode: null, says: CHAT_REFUSALS.unknown });
	assert.deepEqual(chatModeOf({ state: null, record: [] }), { mode: null, says: CHAT_REFUSALS.unknown });
});

test("every answer's mode and state are in the exported vocabularies", () => {
	const states = [null, "active", "waiting", "completed", "failed", "unknown"];
	const records = [null, parkedRecord, doneRecord];
	const parkeds = [null, { answered: true }, { answered: false }];
	for (const state of states) for (const record of records) for (const parked of parkeds) for (const activeJobId of [null, "gh-1.r1"]) {
		const facts = { state, record, parked, activeJobId };
		const { mode, says } = chatModeOf(facts);
		assert.ok(mode === null || CHAT_MODES.includes(mode));
		assert.equal(mode === null, typeof says === "string" && says !== "", "a refusal always says why, a mode never does");
		assert.ok(RUN_STATES.includes(runStateOf(facts)));
	}
	assert.ok(Object.isFrozen(CHAT_MODES) && Object.isFrozen(RUN_STATES) && Object.isFrozen(CHAT_REFUSALS));
});

test("a run that goes on as a QUEUED #645 recovery is queued, not finished; active still wins; a malformed id is none", () => {
	const base = { ...doneRecord, outcome: "failed", reason: "recovery-enqueued" };
	assert.deepEqual(chatModeOf({ state: "failed", record: base, queuedJobId: "gh-1.r1" }), { mode: null, says: CHAT_REFUSALS.recoveryQueued });
	assert.equal(runStateOf({ state: null, record: base, queuedJobId: "gh-1.r1" }), "queued");
	assert.deepEqual(chatModeOf({ state: "failed", record: base, activeJobId: "gh-1.r2", queuedJobId: "gh-1.r1" }), { mode: "live", says: null });
	assert.deepEqual(chatModeOf({ state: "failed", record: base, queuedJobId: "bad id\n" }), { mode: "fork", says: null });
	assert.deepEqual(chatModeOf({ state: null, record: null, queuedJobId: "gh-1.r1" }), { mode: null, says: CHAT_REFUSALS.recoveryQueued }, "a dropped base whose recovery waits");
});

test("a park whose answer is queued or running (no record yet) is being answered; an unread queue is unknown, never a reply", () => {
	assert.deepEqual(chatModeOf({ state: "completed", record: parkedRecord, parked: { answered: false, pending: true } }), { mode: null, says: CHAT_REFUSALS.answering });
	assert.equal(runStateOf({ record: parkedRecord, parked: { answered: false, pending: true } }), "answered");
	assert.deepEqual(chatModeOf({ record: parkedRecord, parked: { answered: false, pending: false } }), { mode: "reply", says: null });
	assert.deepEqual(chatModeOf({ record: parkedRecord, parked: { answered: false, pending: null } }), { mode: null, says: CHAT_REFUSALS.parkedUnknown });
	assert.deepEqual(chatModeOf({ record: parkedRecord, parked: { answered: true, pending: true } }), { mode: null, says: CHAT_REFUSALS.answered }, "a record that took the answer says so first");
});

test("a queue too deep to check fails loudly with its own sentence; pendingFactsOf maps every scan shape, and parkedVerdictOf is chatModeOf on those facts (review round 2)", () => {
	assert.deepEqual(chatModeOf({ record: parkedRecord, parked: { answered: false, pending: null, pendingTooMany: true } }), { mode: null, says: CHAT_REFUSALS.parkedTooMany });
	assert.equal(runStateOf({ record: parkedRecord, parked: { answered: false, pending: null, pendingTooMany: true } }), "unknown");
	assert.deepEqual(chatModeOf({ record: parkedRecord, parked: { answered: true, pendingTooMany: true } }), { mode: null, says: CHAT_REFUSALS.answered }, "a record that took the answer still says so first");
	assert.match(CHAT_REFUSALS.parkedTooMany, /too many jobs to check whether an answer is already on its way; answer it on the forge/);
	assert.doesNotMatch(CHAT_REFUSALS.parkedTooMany, /try again|history/, "never the unreadable history's sentence");
	assert.deepEqual(pendingFactsOf({ jobId: "gh-9" }), { pending: true, pendingTooMany: false, pendingJobId: "gh-9" });
	assert.deepEqual(pendingFactsOf({ jobId: null }), { pending: false, pendingTooMany: false, pendingJobId: null });
	assert.deepEqual(pendingFactsOf({ unknown: true, tooMany: true }), { pending: null, pendingTooMany: true, pendingJobId: null });
	for (const scan of [{ unknown: true }, { unknown: true, tooMany: false }, { unreachable: true }, { tooMany: true }, { jobId: "bad id\n" }, {}, null, undefined]) {
		assert.deepEqual(pendingFactsOf(scan), { pending: null, pendingTooMany: false, pendingJobId: null }, JSON.stringify(scan));
	}
	for (const scan of [{ jobId: "gh-9" }, { jobId: null }, { unknown: true }, { unknown: true, tooMany: true }, { unreachable: true }, undefined]) {
		const facts = pendingFactsOf(scan);
		const { pendingJobId, ...parked } = facts;
		assert.deepEqual(parkedVerdictOf(scan), { ...chatModeOf({ record: parkedRecord, parked: { answered: false, ...parked } }), answeringJobId: pendingJobId }, JSON.stringify(scan));
	}
	assert.deepEqual(parkedVerdictOf({ jobId: null }), { mode: "reply", says: null, answeringJobId: null });
	assert.deepEqual(parkedVerdictOf({ unknown: true, tooMany: true }), { mode: null, says: CHAT_REFUSALS.parkedTooMany, answeringJobId: null });
});
