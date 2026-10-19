import assert from "node:assert/strict";
import { test } from "node:test";

// DES-AWAIT-INPUT-ENDS-THE-JOB: the WIRING half. processor.test.mjs pins when the processor closes a parked run's
// window; this pins that the wired worker closes it on the REAL BullMQ job, the only object holding the stored dedup
// id and the compare-and-delete. A wiring that bound nothing would pass every processor test and swallow every
// quick answer in production, which is exactly how the defect shipped.

// index.mjs imports bullmq; skip below the node floor / without deps, hard-fail in CI (mirrors pause-gate).
let mod;
let importError;
try {
	mod = await import("../src/index.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`parked-window tests are REQUIRED here but bullmq could not import.\n${importError}`);
}
const skip = mod ? false : `bullmq not installed (node ${process.version} < 22.19.0); CI runs these`;

function fakeRedis() {
	const redis = {};
	redis.incr = async () => 1;
	redis.decr = async () => 0;
	redis.expire = async () => {};
	redis.get = async () => null;
	return redis;
}

function harness({ exitReason, lines }) {
	return mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis: fakeRedis(),
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
		applyConcurrency: () => {},
		recordRun: () => {},
		timeoutMs: 100000,
		deps: {
			mintToken: async () => "tok",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j", session: { key: "abc", hostDir: "/j/session", resume: true, reason: "resumed", bytes: 1 } }),
			imagePreflight: async () => ({ ok: true, piVersion: "0.80.7", capabilities: ["awaitInput"] }),
			sessionsDir: "/srv/pi-sessions",
			promoteSession: () => ({ promoted: true, reason: "promoted", bytes: 1 }),
			runContainer: async () => ({ code: 0, aborted: false, turns: 1, tokens: null, session: { resumed: true, reason: "resumed" }, exitReason }),
			cleanup: async () => {},
			comment: async () => {},
			parkedLabel: async () => {},
			log: (event, fields) => lines.push({ event, ...fields }),
		},
	});
}

// A BullMQ-shaped job: the stored dedup id and the job's own compare-and-delete, counted.
function bullJob() {
	const asked = [];
	const data = { kind: "github", repo: "acme/web", target: { type: "issue", number: 3 }, flow: "ask", resume: true, awaitInput: true, trigger: { deliveryId: "d", sender: { id: 1 } } };
	return { job: { id: "gh-d", attemptsMade: 0, name: "github", data, deduplicationId: "acme/web#3:ask", removeDeduplicationKey: async () => (asked.push("gh-d"), true) }, asked };
}

test("a parked run's window is closed on the real BullMQ job by the wired worker", { skip }, async () => {
	const lines = [];
	const { job, asked } = bullJob();
	await harness({ exitReason: "awaiting-input", lines })(job, "tok", new AbortController().signal);
	assert.deepEqual(asked, ["gh-d"], "the job's own removeDeduplicationKey, once");
	assert.ok(lines.some((l) => l.event === "parked_window_released" && l.jobId === "gh-d" && l.released === true));
});

test("a run that did not park keeps its window under the wired worker", { skip }, async () => {
	const lines = [];
	const { job, asked } = bullJob();
	await harness({ exitReason: null, lines })(job, "tok", new AbortController().signal);
	assert.deepEqual(asked, []);
});

// Issue #638, review round 2: a run both steer-armed and awaitInput, driven through the wired processor. Its park takes a
// held reply as the resumed job; a late steer message from the same moment is then ANSWERED, never resumed beside it
// (`heldResumed`), and the park's comment says the run continues rather than asking for a reply.
test("a steer-armed awaitInput park that took a held reply answers its late steer message instead of starting a second resume", { skip }, async () => {
	const { makeHeldSettle, HELD_EXTRA_REPLY } = await import("../src/held-settle.mjs");
	const { HELD_TAKEN_COMMENT } = await import("../src/processor.mjs");
	const { makeLateForge, STEER_LATE_REPLY } = await import("../src/inbox-settle.mjs");
	const NOW = 1_800_000_000_000;
	const lateId = "a".repeat(32);
	const late = { v: 1, id: lateId, mode: "steer", source: "forge", author: { kind: "forge", id: 5, association: "OWNER" }, text: "late words", at: NOW, deliveryId: "d-late" };
	const heldEntry = { id: "b".repeat(32), at: NOW, route: "dedup", fallback: { kind: "github", repo: "acme/web", target: { type: "issue", number: 3 }, flow: "ask", resume: true, awaitInput: true, trigger: { deliveryId: "d-held", sender: { id: 5 } }, jobId: "gh-d-held" } };
	const redis = fakeRedis();
	// The steer inbox's close (settleInbox): one late forge message, closed for the first time.
	redis.eval = async () => [[JSON.stringify(late)], [lateId, "late"], 1];
	const posted = [];
	const adds = [];
	const comment = async (_job, text) => posted.push(text);
	const queues = { shared: () => ({ add: async (name, data, opts) => (adds.push(opts.jobId), { id: opts.jobId }) }) };
	const heldSettle = makeHeldSettle({ redis, queues, comment, now: () => NOW, held: { awaitTargetKeyOf: () => null, closeHeld: async () => ({ entries: [heldEntry], first: true }) } });
	const lateForge = makeLateForge({ redis, queues, comment, now: () => NOW, release: async () => false, inbox: { readFallbacks: async () => ({ jobs: { [lateId]: { ...heldEntry.fallback, trigger: { deliveryId: "d-late", sender: { id: 5 } }, jobId: "gh-d-late" } } }) } });
	const lines = [];
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis,
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
		applyConcurrency: () => {},
		recordRun: () => {},
		timeoutMs: 100000,
		deps: {
			mintToken: async () => "tok",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j", session: { key: "abc", hostDir: "/j/session", resume: true, reason: "resumed", bytes: 1 } }),
			imagePreflight: async () => ({ ok: true, piVersion: "0.80.7", capabilities: ["awaitInput", "steer"] }),
			sessionsDir: "/srv/pi-sessions",
			promoteSession: () => ({ promoted: true, reason: "promoted", bytes: 1 }),
			runContainer: async () => ({ code: 0, aborted: false, turns: 1, tokens: null, session: { resumed: true, reason: "resumed" }, exitReason: "awaiting-input" }),
			cleanup: async () => {},
			comment,
			parkedLabel: async () => {},
			settleHeld: heldSettle,
			takeHeld: heldSettle.take,
			onLateForge: lateForge,
			log: (event, fields) => lines.push({ event, ...fields }),
		},
	});
	const { job } = bullJob();
	job.data = { ...job.data, steer: true };
	const r = await processor(job, "tok", new AbortController().signal);
	assert.equal(r.reason, "awaiting-input");
	assert.deepEqual(adds, ["gh-d-held"], "ONE resumed job: the held reply, never the late steer message beside it");
	assert.ok(posted.includes(HELD_TAKEN_COMMENT), "the park says the run continues");
	assert.ok(posted.includes(STEER_LATE_REPLY), "the late message is answered");
	assert.equal(posted.includes(HELD_EXTRA_REPLY), false);
});
