import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Real-Valkey check of the claim the record's `queuedAt` rests on (issue #599, INT-RUN-HISTORY-FILE-CONTRACT):
 * `job.timestamp + job.opts.delay` is the moment a job became eligible, on the pinned BullMQ (5.80.4), across the three
 * things that happen to a job between its add and its run here:
 *
 *   - a `moveToDelayed` (a pause window, a budget or scope deferral) rewrites the job's `delay` field and leaves the
 *     `opts.delay` it was added with alone, so a deferral counts as waiting rather than resetting the wait;
 *   - a retry after a failed attempt keeps both the timestamp and `opts.delay`;
 *   - the job scheduler creates each next cron job when the previous one runs, stamped with that moment and delayed until
 *     its slot, so `timestamp + opts.delay` is the slot itself (the millis in its `repeat:<id>:<millis>` id), where the
 *     timestamp alone would read as one whole period of waiting.
 *
 * No processor, no container: a bare Worker reads the job and `buildRecord` (pure) computes the field. Skips cleanly
 * without VALKEY_TEST_URL, and refuses to skip when CI requires the worker's integration tests.
 */

const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error("queued-at.integration REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
}
const skip = url ? false : "VALKEY_TEST_URL not set; queuedAt integration skipped locally";

let queueCounter = 0;
const uniqueQueueName = () => `pi-jobs-queued-at-${Date.now()}-${queueCounter++}-${Math.random().toString(36).slice(2, 8)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Bounded poll to a deadline, never a fixed sleep: a wedged expectation fails loudly instead of hanging CI.
async function until(fn, { timeoutMs = 8000, intervalMs = 25 } = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (fn()) return;
		if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms`);
		await sleep(intervalMs);
	}
}

async function load() {
	const { Queue, Worker, DelayedError } = await import("bullmq");
	const { parseConnection } = await import("../src/connection.mjs");
	const { buildRecord } = await import("../src/run-history.mjs");
	return { Queue, Worker, DelayedError, parseConnection, buildRecord };
}

async function teardown(queue, worker) {
	for (const d of (await queue?.getJobSchedulers(0, -1, true).catch(() => [])) ?? []) {
		await queue.removeJobScheduler(typeof d === "string" ? d : (d.key ?? d.id ?? d.name)).catch(() => {});
	}
	await worker?.close().catch(() => {});
	await queue?.obliterate({ force: true }).catch(() => {});
	await queue?.close().catch(() => {});
}

test("opts.delay survives a moveToDelayed and a retry, so queuedAt stays the moment the job became eligible", { skip }, async () => {
	const { Queue, Worker, DelayedError, parseConnection, buildRecord } = await load();
	const name = uniqueQueueName();
	const queue = new Queue(name, { connection: parseConnection(url) });
	let worker;
	const seen = [];
	try {
		worker = new Worker(
			name,
			async (job, token) => {
				seen.push({ id: job.id, attempt: job.attemptsMade, timestamp: job.timestamp, optsDelay: job.opts.delay, queuedAt: buildRecord({ job, result: { outcome: "completed" } }).queuedAt });
				if (job.name === "deferred" && seen.filter((s) => s.id === job.id).length === 1) {
					await job.moveToDelayed(Date.now() + 200, token);
					throw new DelayedError();
				}
				if (job.name === "retried" && job.attemptsMade === 0) throw new Error("first attempt fails");
				return 1;
			},
			{ connection: parseConnection(url) },
		);
		const deferred = await queue.add("deferred", { kind: "local" }, { delay: 300 });
		const retried = await queue.add("retried", { kind: "local" }, { delay: 150, attempts: 2, backoff: { type: "fixed", delay: 200 } });
		await until(() => seen.filter((s) => s.id === deferred.id).length >= 2 && seen.filter((s) => s.id === retried.id).length >= 2);

		for (const [job, delay] of [
			[deferred, 300],
			[retried, 150],
		]) {
			const pickups = seen.filter((s) => s.id === job.id);
			for (const p of pickups) {
				assert.equal(p.timestamp, job.timestamp, `${job.name}: the timestamp is the add's on every pickup`);
				assert.equal(p.optsDelay, delay, `${job.name}: opts.delay is the add's on every pickup`);
				assert.equal(p.queuedAt, new Date(job.timestamp + delay).toISOString(), `${job.name}: queuedAt is timestamp + the add's delay`);
			}
		}
		assert.equal(seen.filter((s) => s.id === retried.id).at(-1).attempt, 1, "the second pickup of the retried job IS its retry");
	} finally {
		await teardown(queue, worker);
	}
});

for (const [label, repeat] of [
	["an every scheduler", { every: 400 }],
	["a cron pattern scheduler", { pattern: "* * * * * *" }],
]) {
	test(`the job scheduler's jobs (${label}) record their slot as queuedAt, not their creation`, { skip }, async () => {
		const { Queue, Worker, parseConnection, buildRecord } = await load();
		const name = uniqueQueueName();
		const queue = new Queue(name, { connection: parseConnection(url) });
		let worker;
		const seen = [];
		try {
			worker = new Worker(
				name,
				async (job) => {
					seen.push({ id: job.id, timestamp: job.timestamp, optsDelay: job.opts.delay, queuedAt: buildRecord({ job, result: { outcome: "completed" } }).queuedAt });
					return 1;
				},
				{ connection: parseConnection(url) },
			);
			await queue.upsertJobScheduler("slot", repeat, { name: "tick", data: { kind: "local" } });
			await until(() => seen.length >= 3);
			await queue.removeJobScheduler("slot");
			for (const s of seen) {
				const slot = Number(/^repeat:slot:(\d+)$/.exec(s.id)?.[1]);
				assert.ok(Number.isSafeInteger(slot), `a scheduler job id carries its slot: ${s.id}`);
				assert.equal(s.queuedAt, new Date(slot).toISOString(), `queuedAt is the slot (${s.id})`);
			}
			// The reason the field adds the delay: past the first, a scheduler job is created before its slot and waits
			// delayed until it, so its timestamp alone lies before the moment it became eligible.
			assert.ok(
				seen.slice(1).some((s) => s.optsDelay > 0 && s.timestamp < Date.parse(s.queuedAt)),
				"a later scheduler job is stamped before its slot and carries the delay to it",
			);
		} finally {
			await teardown(queue, worker);
		}
	});
}
