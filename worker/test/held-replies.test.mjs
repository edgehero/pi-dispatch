import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
	AWAIT_OPEN_TTL_MS,
	AWAIT_TARGET_PREFIX,
	AWAIT_TARGET_TTL_MS,
	HELD_ENTRY_MAX_BYTES,
	HELD_MAX_ENTRIES,
	HELD_OUTCOMES,
	HELD_ROUTES,
	HELD_TTL_MS,
	awaitOpenKey,
	AWAIT_PARKED_TTL_MS,
	awaitParkedKeyOf,
	awaitTargetKeyOf,
	closeHeld,
	recentlyParked,
	heldKeys,
	holdReply,
	liveAwaitRunsForTarget,
	normalizeHeldEntry,
	registerAwaitLive,
	resetClosedHeld,
	unregisterAwaitLive,
} from "../src/held-replies.mjs";
import { AWAIT_KEEPER_POLL_MS, HELD_EXTRA_REPLY, HELD_LOOKBACK_MS, HELD_RESUME_FAILED_REPLY, isParkedOutcome, makeAwaitKeeper, makeHeldSettle } from "../src/held-settle.mjs";
import { InfraRetry } from "../src/processor.mjs";
import { forgeMessageId, steerTargetKey } from "../src/steer-inbox.mjs";

// Issue #638: an answer to a run that is parking right now is held in keys of its own, and the run's settle starts the
// first one once it has parked; a run that does not park drops them, which is today's coalescing exactly.

const T0 = 1_800_000_000_000;
const clock = () => T0;
const runData = (over = {}) => ({ kind: "github", repo: "o/r", target: { type: "issue", number: 7, title: "T", body: "B" }, flow: "ask", resume: true, awaitInput: true, trigger: { event: "issue_comment", action: "created", deliveryId: "d-ask", sender: { id: 5 } }, ...over });
const runJob = (over = {}) => ({ id: "gh-d-ask", attemptsMade: 0, opts: { attempts: 2 }, data: runData(), ...over });
const fallbackFor = (delivery, over = {}) => ({ ...runData({ trigger: { event: "issue_comment", action: "created", deliveryId: delivery, sender: { id: 6 }, matched: { index: 1, type: "comment", phrase: "@pi" }, comment: { body: "the answer" } } }), kind: "github", jobId: `gh-${delivery}`, ...over });
const entryFor = (delivery, over = {}) => ({ id: forgeMessageId(delivery), at: T0, route: "dedup", fallback: fallbackFor(delivery), ...over });
const PARKED = { outcome: "completed", reason: "awaiting-input" };

// --- the contract, pinned literally (a constant-derived test is blind to a change IN the constant) ---------------------

test("the bounds and vocabularies are the contract's numbers and words", () => {
	assert.deepEqual([AWAIT_OPEN_TTL_MS, AWAIT_TARGET_TTL_MS, HELD_TTL_MS, HELD_MAX_ENTRIES, HELD_ENTRY_MAX_BYTES, AWAIT_KEEPER_POLL_MS], [30_000, 60_000, 3_600_000, 20, 1_048_576, 2_000]);
	assert.deepEqual(HELD_ROUTES, ["dedup", "pre-label"]);
	assert.deepEqual(HELD_OUTCOMES, ["ok", "dup", "closed", "gone"], "no `full`: at the cap the oldest entry goes");
	assert.equal(AWAIT_PARKED_TTL_MS, 60_000);
	assert.equal(awaitParkedKeyOf(awaitTargetKeyOf(runData())), `run:await:parked:${awaitTargetKeyOf(runData()).slice(AWAIT_TARGET_PREFIX.length)}`);
	assert.equal(awaitParkedKeyOf("run:steer:target:" + "0".repeat(32)), null);
	assert.ok(HELD_TTL_MS > 10 * 60 * 1000, "the list outlives the 10-minute semantic window it rescues replies from");
	assert.equal(HELD_EXTRA_REPLY, "This run was waiting for one answer and took the first reply it was given. If this comment adds to it, comment again once the run has replied.");
	for (const text of [HELD_EXTRA_REPLY, HELD_RESUME_FAILED_REPLY]) assert.doesNotMatch(text, /@|—| - |"/, "fixed words: no mention, no quote, no dash as punctuation");
});

test("the await target is the steer target's own hash under its own prefix, derived, never re-spelled; the keys are apart", () => {
	const steer = steerTargetKey({ kind: "github", repo: "o/r", targetType: "issue", number: 7 });
	const key = awaitTargetKeyOf(runData());
	assert.equal(key, `${AWAIT_TARGET_PREFIX}${steer.slice("run:steer:target:".length)}`);
	assert.match(key, /^run:await:target:[0-9a-f]{32}$/);
	assert.notEqual(key, steer, "trySteer's lookup can never see an await run");
	assert.equal(awaitTargetKeyOf(runData({ target: { type: "pull_request", number: 7 } })), `${AWAIT_TARGET_PREFIX}${steerTargetKey({ kind: "github", repo: "o/r", targetType: "pull_request", number: 7 }).slice(17)}`);
	assert.equal(awaitTargetKeyOf({ kind: "local", repo: "x" }), null);
	assert.equal(awaitTargetKeyOf(runData({ target: { type: "issue" } })), null);
	assert.equal(awaitTargetKeyOf(null), null);
	assert.equal(awaitTargetKeyOf(runData(), { targetOf: () => { throw new Error("x"); } }), null, "never throws");
	assert.equal(awaitOpenKey("gh-a/b"), "run:await:open:gh-a_b");
	assert.deepEqual(heldKeys("gh-a/b"), { list: "run:held:gh-a_b", closed: "run:held:closed:gh-a_b" });
	for (const k of [awaitOpenKey("r"), ...Object.values(heldKeys("r"))]) assert.doesNotMatch(k, /^run:(steer|inbox):/, "never the steer inbox's keys");
	// The source says it too: nothing here reads or writes a steer inbox key.
	const src = readFileSync(new URL("../src/held-replies.mjs", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
	assert.doesNotMatch(src, /run:inbox:/);
	assert.equal(src.match(/run:steer:target:/g)?.length, 1, "the steer prefix appears once: where the hash is cut off it");
});

test("normalizeHeldEntry keeps the contract's fields, id first, and refuses before Valkey is touched", () => {
	const n = normalizeHeldEntry(entryFor("d-1", { extra: "dropped" }));
	assert.deepEqual(Object.keys(n.entry), ["id", "at", "route", "fallback"]);
	assert.ok(n.json.startsWith(`{"id":"${forgeMessageId("d-1")}"`), "the hold script recognises a listed id by this prefix");
	assert.equal(normalizeHeldEntry({ ...entryFor("d-1"), at: undefined }, clock).entry.at, T0);
	const rows = [
		[null, /not an object/],
		[{ ...entryFor("d-1"), id: "X".repeat(32) }, /32 lowercase hex/],
		[{ ...entryFor("d-1"), route: "steer" }, /route/],
		[{ ...entryFor("d-1"), at: -1 }, /millisecond/],
		[{ ...entryFor("d-1"), fallback: [] }, /fallback job is not an object/],
		[{ ...entryFor("d-1"), fallback: { big: "x".repeat(HELD_ENTRY_MAX_BYTES) } }, /above the 1048576-byte limit/],
	];
	for (const [entry, re] of rows) assert.match(normalizeHeldEntry(entry).refusal, re);
});

test("holdReply, closeHeld and the registration never throw: a refusal touches nothing, a fault is a code, a strange reply is bad-reply", async () => {
	let touched = 0;
	const redis = { eval: async () => (touched++, "ok") };
	assert.equal((await holdReply({ redis, runId: "", entry: entryFor("d-1") })).error, "refused");
	assert.equal((await holdReply({ redis, runId: "r", entry: { ...entryFor("d-1"), route: "x" } })).error, "refused");
	assert.equal(touched, 0, "free refusals first");
	assert.equal(await holdReply({ redis, runId: "r", entry: entryFor("d-1") }), "ok");
	assert.deepEqual(await holdReply({ redis: { eval: async () => "maybe" }, runId: "r", entry: entryFor("d-1") }), { error: "bad-reply" });
	const down = { eval: async () => Promise.reject(Object.assign(new Error("x"), { code: "ECONNREFUSED" })), zrangebyscore: async () => { throw new Error("w"); }, multi() { throw new Error("m"); } };
	assert.deepEqual(await holdReply({ redis: down, runId: "r", entry: entryFor("d-1") }), { error: "ECONNREFUSED" });
	assert.deepEqual(await closeHeld({ redis: down, runId: "r" }), { error: "ECONNREFUSED" });
	assert.deepEqual(await closeHeld({ redis: { eval: async () => [[]] }, runId: "r" }), { error: "bad-reply" });
	assert.equal((await closeHeld({ redis: down, runId: "r", targetKey: "run:steer:target:" + "0".repeat(32) })).error, "refused", "never a steer key");
	assert.deepEqual(await resetClosedHeld({ redis: down, runId: "r" }), { error: "ECONNREFUSED" });
	assert.deepEqual(await liveAwaitRunsForTarget({ redis: down, targetKey: awaitTargetKeyOf(runData()), now: clock }), { error: "valkey" });
	assert.equal((await liveAwaitRunsForTarget({ redis: down, targetKey: "run:steer:target:" + "0".repeat(32), now: clock })).error, "refused");
	assert.deepEqual(await registerAwaitLive({ redis: down, runId: "r", targetKey: awaitTargetKeyOf(runData()), host: "h", now: clock }), { error: "valkey" });
	assert.deepEqual(await registerAwaitLive({ redis: down, runId: "r", targetKey: null, host: "h", now: clock }), { ok: true }, "nothing to register without a target");
	assert.equal((await registerAwaitLive({ redis: down, runId: "r", targetKey: awaitTargetKeyOf(runData()), host: "", now: clock })).error, "refused");
	assert.deepEqual(await unregisterAwaitLive({ redis: down, runId: "r" }), { error: "valkey" });
});

// --- the settle, with a fake held module --------------------------------------------------------------------------------

function settleEnv({ entries = [], first = true, closeError = null, enqueueThrows = false, answers = {} } = {}) {
	const calls = { closes: [], adds: [], comments: [] };
	const logs = [];
	const held = {
		awaitTargetKeyOf,
		closeHeld: async (args) => (calls.closes.push(args), closeError ? { error: closeError } : { entries, first }),
	};
	const queues = { shared: () => ({ name: "shared" }), host: (name) => ({ name }) };
	// `answers[jobId]` is what the add says, the real `enqueueForgeJob`'s shape: a swallow names the job that holds the window.
	const enqueue = async (queue, kind, fields) => {
		if (enqueueThrows) throw Object.assign(new Error("down"), { code: "ECONNRESET" });
		calls.adds.push({ queue: queue.name, kind, fields });
		return answers[fields.jobId] ?? { jobId: fields.jobId, deduplicated: false };
	};
	const comment = async (job, text) => calls.comments.push({ job, text });
	const settle = makeHeldSettle({ redis: {}, queues, comment, log: (e, f) => logs.push([e, f]), now: clock, enqueue, held });
	return { settle, take: settle.take, calls, logs };
}

test("THE TAKE: the first held reply is enqueued (with the window) on the queue that ran the run, the rest get ONE fixed comment", async () => {
	const env = settleEnv({ entries: [entryFor("d-1"), entryFor("d-2"), entryFor("d-3", { route: "pre-label" })] });
	const counts = await env.take({ job: runJob({ queueName: "pi-jobs@h1" }) });
	assert.deepEqual(counts, { resumed: 1, answered: 2, dropped: 0, taken: "here" });
	assert.equal(env.calls.closes.length, 1);
	assert.equal(env.calls.closes[0].runId, "gh-d-ask");
	assert.equal(env.calls.closes[0].targetKey, awaitTargetKeyOf(runData()), "the close takes the run off its target");
	assert.deepEqual(env.calls.adds, [{ queue: "pi-jobs@h1", kind: "github", fields: { ...fallbackFor("d-1"), replyReceivedAt: T0 } }], "a host queue stays on its host and keeps the original receiver receipt");
	assert.deepEqual(env.calls.comments.map((c) => c.text), [HELD_EXTRA_REPLY], "one comment however many replies followed");
	assert.equal(env.calls.comments[0].job.id, "gh-d-ask");
	assert.deepEqual(env.logs, [["held_reply_resumed", { jobId: "gh-d-1", runId: "gh-d-ask", n: 3, queue: "pi-jobs@h1" }]]);
	assert.ok(!JSON.stringify(env.logs).includes("the answer"), "ids and counts only, never text");
	// The default enqueue is the windowed one, so the taken reply holds the window every later answer meets.
	const src = readFileSync(new URL("../src/held-settle.mjs", import.meta.url), "utf8");
	assert.match(src, /enqueue = enqueueForgeJob,/);
	assert.doesNotMatch(src, /enqueueLateForgeJob/, "never the window-less add: a second answer would run beside it");
});

test("THE TAKE, alone: one reply is resumed and nothing is commented; a shared or unknown queue goes to the shared one", async () => {
	for (const queueName of [undefined, "pi-jobs", "elsewhere"]) {
		const env = settleEnv({ entries: [entryFor("d-1")] });
		await env.take({ job: runJob({ queueName }) });
		assert.equal(env.calls.adds[0].queue, "shared", String(queueName));
		assert.equal(env.calls.comments.length, 0);
	}
	const sweep = settleEnv({ entries: [entryFor("d-1")] });
	await sweep.take({ job: runJob({ queueName: "pi-jobs@gone" }), queueName: "pi-jobs" });
	assert.equal(sweep.calls.adds[0].queue, "shared", "an explicit queueName wins");
});

test("M1: a held reply older than HELD_LOOKBACK_MS before the take is dropped silently, never taken as the answer", async () => {
	assert.equal(HELD_LOOKBACK_MS, 300_000);
	const old = entryFor("d-old", { at: T0 - HELD_LOOKBACK_MS - 1 });
	const edge = entryFor("d-edge", { at: T0 - HELD_LOOKBACK_MS });
	const env = settleEnv({ entries: [old, edge, entryFor("d-2")] });
	assert.deepEqual(await env.take({ job: runJob() }), { resumed: 1, answered: 1, dropped: 1, taken: "here" });
	assert.deepEqual(env.calls.adds.map((a) => a.fields.jobId), ["gh-d-edge"], "the first RECENT reply, the boundary included");
	assert.deepEqual(env.logs[0], ["held_replies_dropped", { runId: "gh-d-ask", n: 1, stale: 1 }]);
	assert.deepEqual(env.calls.comments.map((c) => c.text), [HELD_EXTRA_REPLY], "the stale one gets no comment");
	const allOld = settleEnv({ entries: [old] });
	assert.deepEqual(await allOld.take({ job: runJob() }), { resumed: 0, answered: 0, dropped: 1, taken: null });
	assert.deepEqual([allOld.calls.adds.length, allOld.calls.comments.length], [0, 0]);
});

test("a take swallowed by the window is not a resumed job: against another job (an answer that got in first) HELD_EXTRA_REPLY, against this run's own (a failed release) HELD_RESUME_FAILED_REPLY", async () => {
	const other = settleEnv({ entries: [entryFor("d-1")], answers: { "gh-d-1": { jobId: "gh-d-1", deduplicated: true, survivingJobId: "gh-d-quick" } } });
	assert.deepEqual(await other.take({ job: runJob() }), { resumed: 0, answered: 1, dropped: 0, taken: "other" }, "the run HAS its resumed job: the comment and heldResumed say so");
	assert.deepEqual(other.calls.comments.map((c) => c.text), [HELD_EXTRA_REPLY]);
	assert.deepEqual(other.logs, [["held_reply_not_taken", { runId: "gh-d-ask", survivingJobId: "gh-d-quick" }]]);
	const own = settleEnv({ entries: [entryFor("d-1"), entryFor("d-2")], answers: { "gh-d-1": { jobId: "gh-d-1", deduplicated: true, survivingJobId: "gh-d-ask" } } });
	assert.deepEqual(await own.take({ job: runJob() }), { resumed: 0, answered: 2, dropped: 0, taken: null });
	assert.deepEqual(own.calls.comments.map((c) => c.text), [HELD_RESUME_FAILED_REPLY]);
});

test("L5: a fallback for another target is skipped and the NEXT eligible reply is taken; none matching is answered as not started", async () => {
	for (const over of [{ repo: "o/other" }, { target: { type: "pull_request", number: 7 } }, { target: { type: "issue", number: 8 } }, { kind: "gitlab" }]) {
		const env = settleEnv({ entries: [{ ...entryFor("d-1"), fallback: { ...fallbackFor("d-1"), ...over } }, entryFor("d-2")] });
		assert.deepEqual(await env.take({ job: runJob() }), { resumed: 1, answered: 1, dropped: 0, taken: "here" }, JSON.stringify(over));
		assert.deepEqual(env.calls.adds.map((a) => a.fields.jobId), ["gh-d-2"]);
		assert.deepEqual(env.logs[0], ["held_reply_mismatch", { runId: "gh-d-ask" }]);
		const alone = settleEnv({ entries: [{ ...entryFor("d-1"), fallback: { ...fallbackFor("d-1"), ...over } }] });
		await alone.take({ job: runJob() });
		assert.equal(alone.calls.adds.length, 0);
		assert.deepEqual(alone.calls.comments.map((c) => c.text), [HELD_RESUME_FAILED_REPLY]);
	}
});

test("review round 2: the take's close raises the parked marker; a fallback for another flow or command is no answer; a recovery's run id is the run's own", async () => {
	const env = settleEnv({ entries: [entryFor("d-1")] });
	await env.take({ job: runJob() });
	assert.equal(env.calls.closes[0].parked, true, "only the take raises it");
	const backstop = settleEnv({ entries: [entryFor("d-1")] });
	await backstop.settle({ job: runJob(), result: { outcome: "completed" } });
	assert.equal(backstop.calls.closes[0].parked, false);
	for (const over of [{ flow: "fix" }, { command: "wf run" }]) {
		const mis = settleEnv({ entries: [{ ...entryFor("d-1"), fallback: { ...fallbackFor("d-1"), ...over } }, entryFor("d-2")] });
		await mis.take({ job: runJob() });
		assert.deepEqual(mis.calls.adds.map((a) => a.fields.jobId), ["gh-d-2"], JSON.stringify(over));
	}
	const recovery = runJob({ id: "gh-d-ask.r1", data: runData({ recoveryOf: "gh-d-ask" }) });
	const rec = settleEnv({ entries: [entryFor("d-1")], answers: { "gh-d-1": { jobId: "gh-d-1", deduplicated: true, survivingJobId: "gh-d-ask" } } });
	assert.deepEqual(await rec.take({ job: recovery }), { resumed: 0, answered: 1, dropped: 0, taken: null }, "the original holds the window: nothing was started");
	assert.deepEqual(rec.calls.comments.map((c) => c.text), [HELD_RESUME_FAILED_REPLY]);
});

test("review round 2: after a take, the backstop settle of a park only drops, so a failed take's comment is never contradicted", async () => {
	const env = settleEnv({ entries: [entryFor("d-1")] });
	assert.deepEqual(await env.settle({ job: runJob(), result: PARKED, afterTake: true }), { resumed: 0, answered: 0, dropped: 1, taken: null });
	assert.equal(env.calls.adds.length, 0);
	assert.deepEqual(env.logs, [["held_replies_dropped", { runId: "gh-d-ask", n: 1 }]]);
});

test("L1: a take whose close fails says once that an answer may not have been started; an enqueue fault is answered too", async () => {
	const failed = settleEnv({ closeError: "ECONNRESET" });
	assert.equal(await failed.take({ job: runJob() }), null);
	assert.deepEqual(failed.logs, [["held_settle_failed", { jobId: "gh-d-ask", code: "ECONNRESET" }]]);
	assert.deepEqual(failed.calls.comments.map((c) => c.text), [HELD_RESUME_FAILED_REPLY]);
	const down = settleEnv({ entries: [entryFor("d-1"), entryFor("d-2")], enqueueThrows: true });
	assert.deepEqual(await down.take({ job: runJob() }), { resumed: 0, answered: 2, dropped: 0, taken: null });
	assert.deepEqual(down.calls.comments.map((c) => c.text), [HELD_RESUME_FAILED_REPLY]);
	assert.deepEqual(down.logs[0], ["held_reply_resume_failed", { runId: "gh-d-ask", queue: "pi-jobs", code: "ECONNRESET" }]);
	const notArmed = settleEnv({ entries: [entryFor("d-1")] });
	assert.equal(await notArmed.take({ job: runJob({ data: runData({ awaitInput: undefined }) }) }), null);
	assert.equal(notArmed.calls.closes.length, 0);
});

test("THE SETTLE (backstop): after a take it acts on nothing; NOT PARKED drops every held reply, an acked cancel included (L2)", async () => {
	const after = settleEnv({ entries: [entryFor("d-1"), entryFor("d-2")], first: false });
	assert.deepEqual(await after.settle({ job: runJob(), result: PARKED }), { resumed: 0, answered: 0, dropped: 0, taken: null });
	assert.deepEqual([after.calls.adds.length, after.calls.comments.length, after.logs.length], [0, 0, 0], "the take closed it: first is false");
	const outcomes = [{ result: { outcome: "completed" } }, { result: { outcome: "policy", reason: "operator-cancel" } }, { result: { outcome: "policy", reason: "agent-cancel" } }, { result: { outcome: "completed", reason: "awaiting-input-x" } }, { error: new Error("for good") }, { error: { reason: "recovery-host-lost" } }];
	for (const o of outcomes) {
		const env = settleEnv({ entries: [entryFor("d-1"), entryFor("d-2")] });
		assert.deepEqual(await env.settle({ job: runJob(), ...o }), { resumed: 0, answered: 0, dropped: 2, taken: null }, JSON.stringify(o));
		assert.deepEqual([env.calls.adds.length, env.calls.comments.length], [0, 0]);
		assert.deepEqual(env.logs, [["held_replies_dropped", { runId: "gh-d-ask", n: 2 }]]);
	}
	// A park whose take never ran (an unwired seam) still gets the take's logic, never a window-less add.
	const untaken = settleEnv({ entries: [entryFor("d-1")] });
	assert.deepEqual(await untaken.settle({ job: runJob(), result: PARKED }), { resumed: 1, answered: 0, dropped: 0, taken: "here" });
});

test("the settle acts only at a FINAL outcome, for an awaitInput job; a failed close is a logged null; never throws", async () => {
	const notFinal = settleEnv({ entries: [entryFor("d-1")] });
	assert.equal(await notFinal.settle({ job: runJob(), error: new InfraRetry("x", { reason: "container-never-started" }) }), null, "an attempt left: the next one keeps holding");
	assert.equal(await notFinal.settle({ job: runJob({ data: runData({ awaitInput: undefined }) }), result: PARKED }), null);
	assert.equal(await notFinal.settle({ job: runJob(), result: { outcome: "failed", reason: "recovery-enqueued" } }), null, "a #645 handoff is not the end");
	assert.equal(notFinal.calls.closes.length, 0);
	const none = settleEnv({ entries: [] });
	assert.deepEqual(await none.settle({ job: runJob(), result: PARKED }), { resumed: 0, answered: 0, dropped: 0, taken: null });
	assert.equal(none.logs.length, 0);
	const failed = settleEnv({ closeError: "ECONNRESET" });
	assert.equal(await failed.settle({ job: runJob(), result: { outcome: "completed" } }), null);
	assert.deepEqual(failed.logs, [["held_settle_failed", { jobId: "gh-d-ask", code: "ECONNRESET" }]]);
	assert.equal(failed.calls.comments.length, 0, "only the take's failed close comments: there an answer was expected");
	const throwing = makeHeldSettle({ redis: {}, held: { awaitTargetKeyOf: () => { throw new Error("x"); } }, log: () => {} });
	assert.equal(await throwing({ job: runJob(), result: PARKED }), null, "never throws");
	assert.equal(await throwing.take({ job: runJob() }), null);
	assert.equal(isParkedOutcome(PARKED), true);
	assert.equal(isParkedOutcome({ outcome: "policy", reason: "awaiting-input" }), false);
	assert.equal(isParkedOutcome(null), false);
});

// --- the keeper -------------------------------------------------------------------------------------------------------

test("the keeper resets a closed list, registers, refreshes on its period, and stop ends it without deleting anything", async () => {
	const calls = [];
	const held = {
		awaitTargetKeyOf,
		resetClosedHeld: async (a) => (calls.push(["reset", a.runId]), { reset: true }),
		refreshAwaitLive: async (a) => (calls.push(["refresh", a.runId, a.targetKey, a.host]), { ok: true }),
	};
	const keeper = makeAwaitKeeper({ redis: {}, job: runJob({ data: runData({ recoveryOf: "gh-base" }) }), host: "h1", now: clock, pollMs: 5, held });
	await keeper.start();
	assert.deepEqual(calls.slice(0, 2), [["reset", "gh-base"], ["refresh", "gh-base", awaitTargetKeyOf(runData()), "h1"]], "the RUN id, which a recovery shares");
	await new Promise((resolve) => setTimeout(resolve, 30));
	await keeper.stop();
	const n = calls.length;
	assert.ok(n >= 3, "refreshed on its period");
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(calls.length, n, "nothing after stop");
	assert.ok(calls.every(([op]) => op === "reset" || op === "refresh"), "stop deletes nothing: the close, or the 30 s expiry, does");

	const quiet = [];
	const none = makeAwaitKeeper({ redis: {}, job: runJob({ data: { kind: "local" } }), host: "h1", held: { ...held, resetClosedHeld: async () => quiet.push(1) } });
	await none.start();
	await none.stop();
	assert.deepEqual(quiet, [], "a run no forge reply can reach registers nothing");

	const logs = [];
	const faulty = makeAwaitKeeper({ redis: {}, job: runJob(), host: "h1", log: (e, f) => logs.push([e, f]), pollMs: 5, held: { awaitTargetKeyOf, resetClosedHeld: async () => ({ error: "EX" }), refreshAwaitLive: async () => { throw Object.assign(new Error("x"), { code: "EDOWN" }); } } });
	await faulty.start();
	await new Promise((resolve) => setTimeout(resolve, 20));
	await faulty.stop();
	assert.deepEqual(logs.map(([, f]) => f.step), ["reset", "register", "refresh"], "each fault step said once, by code");
});

// --- the processor's wiring -----------------------------------------------------------------------------------------------

test("BY SHAPE: settleSteer settles held replies FIRST, so every record site the steer bolt pins settles them too", () => {
	const src = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
	const def = src.indexOf("const settleSteer = async");
	assert.ok(def !== -1);
	assert.match(src.slice(def, def + 260), /^const settleSteer = async \(\{ result = null, error = null \} = \{\}\) => \{\n\t+const held = await settleHeldReplies\(\{ result, error \}\);\n(\t+carryLiveSkip\(result \?\? error\);\n)?\t+if \(job\.data\?\.steer !== true\) return;/, "issue #712: only the live-skip carry, which settles nothing, may sit between them");
	// And what it says reaches the steer settle, so a held resume and a late steer never both start a job.
	assert.match(src.slice(def, def + 1200), /lateContext: \{ heldResumed: Number\(held\?\.resumed\) > 0 \|\| Number\(heldTaken\?\.resumed\) > 0 \|\| heldTaken\?\.taken === "other" \}/);
	// Review round 2: once the take ran, the backstop is told so, and then only drops.
	assert.match(src, /heldTakeRan = true;\n\t+await awaitKeeper\?\.stop\(\);/);
	assert.match(src, /deps\.settleHeld\(\{ job, result, error, afterTake: heldTakeRan \}\)/);
	// The park's take (H1): bound on the real job like the release, the keeper stopped first, its answer kept for the
	// steer settle.
	const take = src.indexOf("const takeHeldReplies = async");
	assert.ok(take !== -1 && take < def + 3000);
	assert.match(src.slice(take, take + 300), /await awaitKeeper\?\.stop\(\);\n\t+heldTaken = await deps\.takeHeld\(\{ job \}\);/);
	assert.match(src, /releaseParkedWindow: \(\) => releaseSemanticWindow\(job, deps\?\.log\),\n(\t+\/\/[^\n]*\n)*\t+takeHeldReplies: \(\) => takeHeldReplies\(\)\.catch\(\(\) => null\),/);
	const held = src.indexOf("const settleHeldReplies = async");
	assert.ok(held !== -1 && held < src.indexOf("await settleSteer("), "defined before the first record site runs it");
	assert.match(src.slice(held, held + 500), /if \(job\.data\?\.awaitInput !== true\) return;[\s\S]*isFinalOutcome\(\{ job, result, error \}\)[\s\S]*await awaitKeeper\?\.stop\(\);[\s\S]*deps\.settleHeld\(\{ job, result, error, afterTake: heldTakeRan \}\)/);
	assert.match(src, /awaitKeeper = makeAwaitKeeper\(\{ redis, job, host: hostName \|\| "worker", now, log: [^\n]+\}\);/);
	assert.match(src, /\} finally \{[\s\S]{0,2500}await awaitKeeper\?\.stop\(\)\.catch\(\(\) => \{\}\);/);
	assert.doesNotMatch(src, /closeHeld/, "no bare close in the processor: held-settle.mjs knows what is final");
});

test("BY SHAPE: start.mjs wires one makeHeldSettle into all three settle sites", () => {
	const src = readFileSync(new URL("../src/start.mjs", import.meta.url), "utf8");
	assert.match(src, /const heldSettle = makeHeldSettle\(\{ redis, queues: recoveryQueues, comment, log, now \}\);/);
	assert.match(src, /deps: \{[\s\S]{0,800}settleHeld: heldSettle,[\s\S]{0,300}takeHeld: heldSettle\.take,/);
	assert.match(src, /if \(job\?\.data\?\.awaitInput === true\) await heldSettle\(\{ job, error: lostError, queueName: QUEUE \}\);\n\t+recordRun\(/, "the host-lost sweep, before its record");
	assert.match(src, /if \(job\.data\?\.awaitInput === true\) void heldSettle\(\{ job, error: \{ reason: [^}]+\} \}\);/, "the failed listener");
	assert.equal(src.match(/heldSettle\(\{/g)?.length, 2);
});

// --- against a real Valkey ----------------------------------------------------------------------------------------------

const valkeyUrl = process.env.VALKEY_TEST_URL;
if (!valkeyUrl && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("held-replies tests REQUIRE VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
const live = valkeyUrl ? false : "VALKEY_TEST_URL not set; the scripts need a real Valkey";

// Database 0, the queue integration tests' (queue.test.mjs): every numbered one is taken by a file that flushes it or
// needs it empty (7 and 8 by the render tests), and 0 is never flushed. So nothing here flushes either: every key is
// under a run id, a repo and a queue name this file makes unique, and every one carries a TTL of an hour at most.
const clients = [];
const liveUrl = () => {
	const url = new URL(valkeyUrl);
	url.pathname = "/0";
	return url.toString();
};
async function client() {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const r = makeRedisClient(liveUrl());
	r.on("error", () => {});
	clients.push(r);
	return r;
}
test.after(async () => {
	await Promise.all(clients.map((r) => r.quit().catch(() => {})));
});
const SALT = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
let runs = 0;
const runIdFor = (name) => `gh-${name}-${SALT}-${++runs}`;
const liveNow = () => Date.now();

test("live: gone before the run registers, ok once, dup on the same id, the oldest evicted at the cap, closed after the close, the parked marker only from a park's close", { skip: live }, async () => {
	const redis = await client();
	const runId = runIdFor("hold");
	const targetKey = awaitTargetKeyOf(runData({ repo: `o/${SALT}` }));
	assert.equal(await holdReply({ redis, runId, entry: entryFor("d-1") }), "gone");
	assert.deepEqual(await registerAwaitLive({ redis, runId, targetKey, host: "h1", now: liveNow }), { ok: true });
	assert.deepEqual(await liveAwaitRunsForTarget({ redis, targetKey, now: liveNow }), [runId]);
	assert.ok((await redis.pttl(awaitOpenKey(runId))) <= AWAIT_OPEN_TTL_MS);
	assert.equal(await holdReply({ redis, runId, entry: entryFor("d-1") }), "ok");
	assert.equal(await holdReply({ redis, runId, entry: entryFor("d-1", { route: "pre-label" }) }), "dup", "the id decides");
	const ttl = await redis.pttl(heldKeys(runId).list);
	assert.ok(ttl > HELD_TTL_MS - 5_000 && ttl <= HELD_TTL_MS, "the list lives an hour");
	for (let i = 2; i <= HELD_MAX_ENTRIES; i++) assert.equal(await holdReply({ redis, runId, entry: entryFor(`d-${i}`) }), "ok");
	assert.equal(await holdReply({ redis, runId, entry: entryFor("d-over") }), "ok", "at the cap the NEWEST is still held");
	assert.equal(await holdReply({ redis, runId, entry: entryFor("d-1") }), "ok", "the oldest was evicted, so its id is new again");
	const closed = await closeHeld({ redis, runId, targetKey, parked: true });
	assert.equal(closed.first, true);
	assert.equal(closed.entries.length, HELD_MAX_ENTRIES);
	assert.deepEqual(closed.entries[0], normalizeHeldEntry(entryFor("d-3")).entry, "in the order held, the two oldest gone");
	assert.deepEqual(closed.entries.slice(-2).map((e) => e.id), [forgeMessageId("d-over"), forgeMessageId("d-1")]);
	assert.equal(await recentlyParked({ redis, targetKey }), true, "the park's close raised the marker in the same script");
	const pttl = await redis.pttl(awaitParkedKeyOf(targetKey));
	assert.ok(pttl > 0 && pttl <= AWAIT_PARKED_TTL_MS);
	const other = runIdFor("noparked");
	const otherTarget = awaitTargetKeyOf(runData({ repo: `o/np-${SALT}` }));
	await closeHeld({ redis, runId: other, targetKey: otherTarget });
	assert.equal(await recentlyParked({ redis, targetKey: otherTarget }), false, "a settle's close raises nothing");
	assert.equal(await holdReply({ redis, runId, entry: entryFor("d-late") }), "closed");
	assert.deepEqual(await liveAwaitRunsForTarget({ redis, targetKey, now: liveNow }), [], "the close took it off its target");
	assert.equal(await redis.exists(awaitOpenKey(runId)), 0);
	const again = await closeHeld({ redis, runId, targetKey });
	assert.equal(again.first, false, "only the first close acts");
	assert.equal(again.entries.length, HELD_MAX_ENTRIES);
	assert.deepEqual(await resetClosedHeld({ redis, runId }), { reset: true }, "a retry under the same id starts clean");
	assert.equal(await redis.exists(heldKeys(runId).list), 0);
	assert.deepEqual(await resetClosedHeld({ redis, runId }), { reset: false }, "an open list is never reset");
	// The steer side cannot see it: the steer target under the same hash is empty.
	assert.equal(await redis.exists(steerTargetKey({ kind: "github", repo: `o/${SALT}`, targetType: "issue", number: 7 })), 0);
});

test("live, end to end (H1): a reply held before the park is the ONE resumed job; a reply after the marker is coalesced against it or held on it, never a second run; a run that does not park drops them", { skip: live }, async () => {
	const { Queue } = await import("bullmq");
	const { parseConnection } = await import("../src/connection.mjs");
	const { enqueueGitHubJob, releaseSemanticWindow } = await import("../src/queue.mjs");
	const redis = await client();
	const q = new Queue(`pi-jobs-held-${SALT}`, { connection: parseConnection(liveUrl()) });
	const repo = `o/held-${SALT}`;
	const delivery = (number, id, over = {}) => ({ repo, target: { type: "issue", number, title: "t", body: "b" }, flow: "ask", provider: "anthropic", model: "m", maxTurns: 5, resume: true, awaitInput: true, trigger: { event: "issue_comment", action: "created", deliveryId: id, sender: { id: 1 }, matched: { index: 1, type: "comment", phrase: "@pi" } }, ...over });
	const comments = [];
	const settle = makeHeldSettle({ redis, queues: { shared: () => q }, comment: async (job, text) => comments.push({ id: job.id, text }) });
	// The receiver's move, played here (receiver/test/held.test.mjs drives the receiver itself): enqueue, and on a swallow
	// hold the reply under the surviving id. `hold` is null when the enqueue created a job.
	const reply = async (number, id, over) => {
		const fields = delivery(number, id, over);
		fields.trigger.comment = { body: "the answer" };
		const r = await enqueueGitHubJob(q, fields);
		if (!r.deduplicated) return { r, hold: null };
		return { r, hold: await holdReply({ redis, runId: r.survivingJobId, entry: { id: forgeMessageId(id), at: Date.now(), route: "dedup", fallback: { ...fields, kind: "github", jobId: r.jobId } } }) };
	};
	const jobsOn = async (number) => (await q.getJobs(["waiting", "delayed", "active", "prioritized", "paused"])).filter((j) => j.data.target.number === number).map((j) => j.id).sort();
	try {
		// A run that asked and is parking: it holds its window and its keeper registered it.
		const asked = await enqueueGitHubJob(q, delivery(3, `ask-${SALT}`));
		const job = await q.getJob(asked.jobId);
		const keeper = makeAwaitKeeper({ redis, job, host: "h1" });
		await keeper.start();
		const one = await reply(3, `reply1-${SALT}`);
		assert.equal(one.r.survivingJobId, asked.jobId);
		assert.equal(one.hold, "ok", "held, not swallowed");
		// The park sequence: marker on (a phrase-free reply now routes as a parked reply, and still meets this run's
		// window, so it is held too), release, take.
		const two = await reply(3, `reply2-${SALT}`, { parkedReply: true });
		assert.equal(two.hold, "ok", "between the marker and the release: held, nothing slips past");
		assert.equal(await releaseSemanticWindow(job), true);
		await keeper.stop();
		const counts = await settle.take({ job });
		assert.deepEqual(counts, { resumed: 1, answered: 1, dropped: 0, taken: "here" });
		const resumed = await q.getJob(`gh-reply1-${SALT}`);
		assert.ok(resumed, "the first held reply is a job now, under its own delivery id");
		assert.equal(resumed.data.resume, true);
		assert.ok(resumed.deduplicationId, "enqueued WITH the window: every later answer is coalesced against it");
		assert.deepEqual(comments, [{ id: asked.jobId, text: HELD_EXTRA_REPLY }]);
		assert.equal(await holdReply({ redis, runId: asked.jobId, entry: entryFor(`late-${SALT}`) }), "closed");

		// A reply AFTER the park comment, as a parked reply the marker routes: deduplicated against the taken job, never a
		// second run. Queued, the taken job is not live, so the hold is refused and the receiver says `deduplicated`.
		const three = await reply(3, `reply3-${SALT}`, { parkedReply: true });
		assert.equal(three.r.deduplicated, true);
		assert.equal(three.r.survivingJobId, resumed.id);
		assert.equal(three.hold, "gone");
		// Once the taken job runs it is awaitInput too, so its keeper registers it and the next reply is held on IT.
		const keeper2 = makeAwaitKeeper({ redis, job: resumed, host: "h1" });
		await keeper2.start();
		const four = await reply(3, `reply4-${SALT}`);
		assert.equal(four.r.survivingJobId, resumed.id);
		assert.equal(four.hold, "ok", "held on the resumed run, for its own park");
		await keeper2.stop();
		assert.deepEqual(await jobsOn(3), [asked.jobId, resumed.id].sort(), "exactly one resumed job from one parked transcript");
		// The final-outcome settle after the take finds the list closed and acts on nothing.
		comments.length = 0;
		assert.deepEqual(await settle({ job, result: PARKED }), { resumed: 0, answered: 0, dropped: 0, taken: null });
		assert.deepEqual(comments, []);

		// A run that does NOT park: its held reply is dropped, no job, no comment.
		const other = await enqueueGitHubJob(q, delivery(4, `ask2-${SALT}`));
		const otherJob = await q.getJob(other.jobId);
		const keeper3 = makeAwaitKeeper({ redis, job: otherJob, host: "h1" });
		await keeper3.start();
		assert.equal((await reply(4, `reply5-${SALT}`)).hold, "ok");
		await keeper3.stop();
		assert.deepEqual(await settle({ job: otherJob, result: { outcome: "completed" } }), { resumed: 0, answered: 0, dropped: 1, taken: null });
		assert.equal(await q.getJob(`gh-reply5-${SALT}`), undefined);
		assert.deepEqual(comments, []);
	} finally {
		await q.obliterate({ force: true }).catch(() => {});
		await q.close();
	}
});
