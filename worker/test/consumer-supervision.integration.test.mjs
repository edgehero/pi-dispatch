import assert from "node:assert/strict";
import { test } from "node:test";
import { makeConsumerSupervisor } from "../src/consumer-supervision.mjs";
import { readConsumerDemand } from "../src/bullmq-internals.mjs";

const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("consumer supervision integration requires VALKEY_TEST_URL");
const skip = url ? false : "needs VALKEY_TEST_URL";
async function until(check) {
	const end = performance.now() + 12_000;
	while (!(await check())) {
		if (performance.now() > end) throw new Error("consumer did not make progress");
		await new Promise((r) => setTimeout(r, 10));
	}
}

test("pinned consumers reconnect, take immediate/due work, keep recurring schedules alive, and report a terminal connection", { skip }, async () => {
	const { Worker } = await import("bullmq");
	const { makeQueue } = await import("../src/queue.mjs");
	const { parseConnection } = await import("../src/connection.mjs");
	const faults = [], workers = [], queues = [], taken = new Map();
	const supervisor = makeConsumerSupervisor({ onFatal: (fault) => faults.push(fault) });
	try {
		for (const role of ["shared", "host", "sandbox"]) {
			const name = `consumer-test-${process.pid}-${role}-${Math.random().toString(16).slice(2)}`;
			const q = makeQueue(parseConnection(url), { name }); queues.push(q);
			const w = new Worker(name, async (j) => { taken.set(`${role}-${j.id}`, (taken.get(`${role}-${j.id}`) ?? 0) + 1); }, { connection: parseConnection(url), autorun: false, maxStalledCount: 0, drainDelay: 0.05 });
			w.on("error", () => {}); workers.push(w); supervisor.attach(w, role);
			await w.waitUntilReady();
			await q.add("immediate", {}, { jobId: "first" });
			await until(() => taken.has(`${role}-first`));
			// BullMQ itself uses disconnect(true) when a blocking read overruns. It must not be fatal.
			w.blockingConnection._client.disconnect(true);
			await q.add("delayed", {}, { jobId: "due", delay: 30 });
			await q.add("immediate", {}, { jobId: "after" });
			await until(() => taken.has(`${role}-due`) && taken.has(`${role}-after`));
		}
		assert.deepEqual(faults, []);
		// Opt-in incident experiment: block this worker's loop for a minute with only harmless work pending.
		// The ordinary CI test remains fast; the long experiment records whether the pin resumes, not a presumed cause.
		const stallMs = Number(process.env.PI_DISPATCH_TEST_EVENT_LOOP_STALL_MS ?? 0);
		if (stallMs > 0 && stallMs <= 90_000) {
			for (const q of queues) await q.add("after-stall", {}, { jobId: "after-stall", delay: 200 });
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stallMs);
			await until(() => ["shared", "host", "sandbox"].every((role) => taken.has(`${role}-after-stall`)));
			assert.deepEqual(faults, [], "all three consumers recovered from the event-loop pause");
		}
		await queues[1].upsertJobScheduler("recurring", { every: 100 }, { name: "recurring", data: {} });
		await until(() => [...taken.keys()].filter((id) => id.startsWith("host-repeat:")).length >= 2);
		await queues[1].removeJobScheduler("recurring");
		assert.ok([...taken.values()].every((count) => count === 1), "no duplicate processor invocation");
		workers[2].blockingConnection._client.disconnect();
		await until(() => faults.length > 0);
		assert.deepEqual(faults, [{ role: "sandbox", reason: "connection-ended" }]);
	} finally {
		supervisor.stop();
		for (const w of workers) await w.close(true);
		for (const q of queues) { await q.removeJobScheduler("recurring"); await q.obliterate({ force: true }); await q.close(); }
	}
});

test("demand reads see overdue delayed and waiting work while preserving a queue's pause", { skip }, async () => {
	const { makeQueue } = await import("../src/queue.mjs");
	const { parseConnection } = await import("../src/connection.mjs");
	const q = makeQueue(parseConnection(url), { name: `consumer-demand-${process.pid}-${Math.random().toString(16).slice(2)}` });
	const now = Date.now();
	try {
		const client = await q.client;
		const read = () => readConsumerDemand(client, q.name, { now: now + 10000, graceMs: 1000 });
		assert.deepEqual(await read(), { paused: false, overdue: false });
		await q.add("later", {}, { delay: 100, timestamp: now });
		assert.deepEqual(await read(), { paused: false, overdue: true });
		await q.pause();
		assert.deepEqual(await read(), { paused: true, overdue: true });
		await q.obliterate({ force: true });
		await q.resume();
		await q.add("priority", {}, { timestamp: now, priority: 1 });
		assert.deepEqual(await read(), { paused: false, overdue: true });
		await q.obliterate({ force: true }); await q.resume();
		await q.add("waiting", {}, { timestamp: now });
		assert.deepEqual(await read(), { paused: false, overdue: true });
	} finally { await q.obliterate({ force: true }); await q.close(); }
});

test("supervision preserves BullMQ's processor abort signal and counts busy preflight", { skip }, async () => {
	const { Worker } = await import("bullmq");
	const { makeQueue } = await import("../src/queue.mjs");
	const { parseConnection } = await import("../src/connection.mjs");
	const q = makeQueue(parseConnection(url), { name: `consumer-abort-${process.pid}-${Math.random().toString(16).slice(2)}` });
	let signal;
	const faults = [];
	const supervisor = makeConsumerSupervisor({ onFatal: (f) => faults.push(f) });
	const w = new Worker(q.name, async (job, token, receivedSignal) => {
		signal = receivedSignal;
		await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
	}, { connection: parseConnection(url), autorun: false, maxStalledCount: 0 });
	w.on("error", () => {}); supervisor.attach(w, "shared");
	try {
		await q.add("abortable", {});
		await until(() => signal !== undefined);
		assert.equal(JSON.parse(supervisor.snapshot(1)).rows[0].active, 1);
		await w.cancelAllJobs("shutdown");
		await until(() => JSON.parse(supervisor.snapshot(1)).rows[0].active === 0);
		assert.equal(signal.aborted, true);
		assert.deepEqual(faults, []);
	} finally { supervisor.stop(); await w.close(true); await q.obliterate({ force: true }); await q.close(); }
});
