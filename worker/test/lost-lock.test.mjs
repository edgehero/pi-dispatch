import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { makeSettledRecord } from "../src/run-history.mjs";

// The processor's lost-lock gate (DES-TERMINAL-COMMENTS-AND-FAILURE-HOOK, CONST-RETRY-INFRA-ONLY): a job BullMQ hands
// back after its stall check, whose run record says this attempt already finished, ends as the record says and is
// never run again. index.mjs imports bullmq, so this skips below the node floor / without deps and runs in CI, where
// PI_DISPATCH_REQUIRE_WORKER_TESTS=1 turns a skip into a hard failure.
let mod;
let importError;
try {
	mod = await import("../src/index.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`lost-lock tests are REQUIRED here but bullmq could not import.\n${importError}`);
}
const skip = mod ? false : `bullmq not installed (node ${process.version} < 22.19.0); CI runs these`;

const CREATED = Date.parse("2026-10-04T10:00:00.000Z");

/** A scheduled job as BullMQ hands it back after a stall: same id, same attemptsMade, `stalledCounter` raised. */
const stalledJob = (over = {}) => ({
	id: "repeat:nightly:1759572000000",
	name: "local",
	attemptsMade: 0,
	stalledCounter: 1,
	timestamp: CREATED,
	data: { kind: "local", folder: "/proj", flow: "tidy", provider: "anthropic", model: "m", maxTurns: 7, trigger: { id: "nightly", pattern: "0 3 * * *" } },
	...over,
});

/** The record the first run wrote before its completion was refused. */
const completedRecord = (over = {}) => ({
	jobId: "repeat:nightly:1759572000000",
	outcome: "completed",
	reason: null,
	exitCode: 0,
	turns: 4,
	tokens: { input: 10, output: 5, total: 15, cost: 0.01 },
	budgetReserved: true,
	attempt: 1,
	startedAt: "2026-10-04T10:00:01.000Z",
	endedAt: "2026-10-04T10:03:00.000Z",
	...over,
});

function harness({ record = completedRecord(), settledRecord } = {}) {
	const seen = { containerCalls: 0, incr: 0, records: [], logs: [], asked: [] };
	// `null` is a bare wiring (no lookup at all); only an absent option takes the real lookup over `record`.
	const lookup =
		settledRecord !== undefined
			? settledRecord
			: makeSettledRecord({
					readRecord: (id) => (seen.asked.push(id), record),
				});
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis: { incr: async () => (seen.incr++, 1), decr: async () => 0, expire: async () => {} },
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
		recordRun: (rec) => seen.records.push(rec),
		settledRecord: lookup,
		timeoutMs: 100000,
		// The clock the fixtures name (issue #284's rule): the gate reads no clock, and the gates after it read this one.
		now: () => CREATED + 60_000,
		deps: {
			mintToken: async () => null,
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			runContainer: async () => (seen.containerCalls++, { code: 0, aborted: false, turns: 3 }),
			cleanup: async () => {},
			comment: async () => {},
			log: (event, fields) => seen.logs.push({ event, ...fields }),
		},
	});
	return { processor, seen };
}

test("a stalled job whose record says this attempt completed is returned as recorded and never run again", { skip }, async () => {
	const { processor, seen } = harness();
	const result = await processor(stalledJob(), "tok", new AbortController().signal);
	assert.equal(seen.containerCalls, 0, "no container: the run already happened and was paid for");
	assert.equal(seen.incr, 0, "no budget reservation either");
	assert.deepEqual(seen.records, [], "the first run's record is kept, never overwritten by a second one");
	assert.deepEqual(result, { outcome: "completed", reason: null, exitCode: 0, turns: 4, tokens: { input: 10, output: 5, total: 15, cost: 0.01 }, budgetReserved: true });
	assert.deepEqual(seen.logs.filter((l) => l.event === "job_lost_lock_after_completion"), [{ event: "job_lost_lock_after_completion", jobId: "repeat:nightly:1759572000000", outcome: "completed" }]);
});

test("the gate asks for attempt attemptsMade + 1 and the job's creation time", { skip }, async () => {
	const asked = [];
	const { processor, seen } = harness({ settledRecord: async (id, { attempt, since }) => (asked.push({ id, attempt, since }), null) });
	await processor(stalledJob({ attemptsMade: 1 }), "tok", new AbortController().signal);
	assert.deepEqual(asked, [{ id: "repeat:nightly:1759572000000", attempt: 2, since: CREATED }]);
	assert.equal(seen.containerCalls, 1, "no record: the job runs, today's path");
});

test("a recorded policy stop is returned with its reason and its own budgetReserved, so the completed listener pages exactly as it would have", { skip }, async () => {
	const { processor, seen } = harness({ record: completedRecord({ outcome: "policy", reason: "runner-policy", exitCode: 2, budgetReserved: true }) });
	const result = await processor(stalledJob(), "tok", new AbortController().signal);
	assert.equal(seen.containerCalls, 0);
	assert.equal(result.outcome, "policy");
	assert.equal(result.reason, "runner-policy");
	assert.equal(result.budgetReserved, true);
	assert.deepEqual(seen.logs.find((l) => l.event === "job_lost_lock_after_completion"), { event: "job_lost_lock_after_completion", jobId: "repeat:nightly:1759572000000", outcome: "policy", reason: "runner-policy" });
});

test("a recorded FREE refusal keeps budgetReserved false, so the completed listener pages nobody", { skip }, async () => {
	// `model-not-allowed` is both the runner's paid stop and the worker's free pre-spend refusal; only
	// `budgetReserved` tells them apart (issue #502), so the gate must hand on the record's own value.
	const { processor, seen } = harness({ record: completedRecord({ outcome: "policy", reason: "model-not-allowed", exitCode: null, budgetReserved: false }) });
	const result = await processor(stalledJob(), "tok", new AbortController().signal);
	assert.equal(seen.containerCalls, 0);
	assert.equal(result.reason, "model-not-allowed");
	assert.equal(result.budgetReserved, false, "the record's own value, not a constant");
});

test("a record the gate refuses is logged with its fixed reason before the job runs again", { skip }, async () => {
	const { processor, seen } = harness({ record: completedRecord({ attempt: 3 }) });
	await processor(stalledJob(), "tok", new AbortController().signal);
	assert.equal(seen.containerCalls, 1);
	assert.deepEqual(seen.logs.filter((l) => l.event === "job_lost_lock_record_rejected"), [{ event: "job_lost_lock_record_rejected", jobId: "repeat:nightly:1759572000000", reason: "other-attempt", source: "local" }]);
});

test("a refused record is logged once per job, stall count and attempt, however often the job is picked up", { skip }, async () => {
	// The gate runs before every deferral, and BullMQ never resets a job's stall count, so a held job meets it on
	// every deferred pickup; the verdict cannot change between them.
	const { processor, seen } = harness({ record: completedRecord({ attempt: 3 }) });
	for (let i = 0; i < 5; i++) await processor(stalledJob(), "tok", new AbortController().signal);
	const rejected = () => seen.logs.filter((l) => l.event === "job_lost_lock_record_rejected");
	assert.equal(rejected().length, 1, "five pickups, one line");
	await processor(stalledJob({ stalledCounter: 2 }), "tok", new AbortController().signal);
	assert.equal(rejected().length, 2, "a new stall is a new fact");
	await processor(stalledJob({ id: "repeat:other:1", stalledCounter: 2 }), "tok", new AbortController().signal);
	assert.equal(rejected().length, 3, "another job is its own line");
});

test("the remembered rejections are bounded at REJECTED_SEEN_MAX, oldest out first", { skip }, async () => {
	const { processor, seen } = harness({ record: completedRecord({ attempt: 3, jobId: "x" }) });
	const pick = (n) => processor(stalledJob({ id: `job-${n}` }), "tok", new AbortController().signal);
	for (let n = 0; n <= mod.REJECTED_SEEN_MAX; n++) await pick(n);
	const count = () => seen.logs.filter((l) => l.event === "job_lost_lock_record_rejected").length;
	assert.equal(count(), mod.REJECTED_SEEN_MAX + 1);
	await pick(mod.REJECTED_SEEN_MAX);
	assert.equal(count(), mod.REJECTED_SEEN_MAX + 1, "the newest is still remembered");
	await pick(0);
	assert.equal(count(), mod.REJECTED_SEEN_MAX + 2, "the oldest was let go, so it may be said again");
	assert.equal(mod.REJECTED_SEEN_MAX, 1000);
});

test("the gate stays out of the way when it cannot show the attempt finished: the job runs", { skip }, async () => {
	const cases = [
		["a job that never stalled", { job: stalledJob({ stalledCounter: 0 }) }],
		["a record of another attempt", { record: completedRecord({ attempt: 2 }) }],
		["a failed record", { record: completedRecord({ outcome: "failed" }) }],
		["a record older than the job (a reused id)", { record: completedRecord({ startedAt: "2026-10-04T09:00:00.000Z" }) }],
		["no record", { record: null }],
	];
	for (const [label, { job = stalledJob(), record = completedRecord() }] of cases) {
		const { processor, seen } = harness({ record });
		await processor(job, "tok", new AbortController().signal);
		assert.equal(seen.containerCalls, 1, `${label}: runs`);
		assert.ok(!seen.logs.some((l) => l.event === "job_lost_lock_after_completion"), `${label}: no lost-lock line`);
	}
	// A bare wiring (no lookup) keeps today's behaviour too.
	const bare = harness({ settledRecord: null });
	await bare.processor(stalledJob(), "tok", new AbortController().signal);
	assert.equal(bare.seen.containerCalls, 1);
});

test("a stalled job is not read for a record at all when it never stalled", { skip }, async () => {
	const { processor, seen } = harness();
	await processor(stalledJob({ stalledCounter: 0 }), "tok", new AbortController().signal);
	assert.deepEqual(seen.asked, [], "the first pickup of every job costs no file read");
});

test("STALLED_FAILED_REASON is the literal the pinned bullmq's stall check writes", { skip }, () => {
	// start.mjs's failed listener matches this EXACTLY. A bullmq bump that rewords it must fail here, not turn the
	// lost-lock check off in silence.
	const require = createRequire(import.meta.url);
	const root = dirname(require.resolve("bullmq/package.json"));
	const lua = readFileSync(join(root, "dist/esm/commands/moveStalledJobsToWait-9.lua"), "utf8");
	assert.equal(mod.STALLED_FAILED_REASON, "job stalled more than allowable limit");
	assert.ok(lua.includes(`local failedReason = "${mod.STALLED_FAILED_REASON}"`), "the stall check's deferred failure reason");
	assert.ok(lua.includes('rcall("HSET", jobKey, "defa", failedReason)'), "stored as the deferred failure the next pickup throws");
});
