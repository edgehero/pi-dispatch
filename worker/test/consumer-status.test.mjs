import assert from "node:assert/strict";
import { test } from "node:test";
import { readConsumerStatus, consumerQueueName, CONSUMER_READ_QUEUES_MAX } from "../src/consumer-status.mjs";
import { queueKey, QUEUE_KEY } from "../src/bullmq-internals.mjs";
import { olderConsumerHealthFindings } from "../src/older-state.mjs";

const now = () => 500000;
const host = (name = "build3", overrides = {}) => ({ name, routes: "true", startedAt: "1000", ttlAgeMs: 1000, consumers: JSON.stringify({ v: 1, startedAt: 1000, rows: ["shared", "host", "sandbox"].map((role) => ({ role, state: "running", connection: "ready", active: 0, rateLimited: false, lastFetchAt: 1000, lastSuccessAt: 1000, lastTakenAt: null, fetchAgeMs: 200000, successAgeMs: 200000 })) }), ...overrides });

test("overdue work corroborates only its own consumer, with one read for a shared queue", async () => {
	const calls = [];
	const redis = { eval: async (...args) => {
		calls.push(args);
		const key = args[2];
		return key === queueKey(consumerQueueName("build3", "shared"), QUEUE_KEY.meta) ? [1, 1] : key === queueKey(consumerQueueName("build3", "sandbox"), QUEUE_KEY.meta) ? [0, 1] : [0, 0];
	} };
	const [a, b] = await readConsumerStatus(redis, [host(), host("mini1")], { now });
	assert.deepEqual(a.rows.map((c) => c.verdict), ["paused", "unknown", "stalled"]);
	assert.equal(a.state, "stalled");
	assert.equal(b.state, "unknown");
	assert.equal(calls.length, 5, "the shared queue is read once");
	assert.ok(calls.every((args) => args[1] === 4 && args[6] === now()), "four keys and one injected clock sample");
	assert.equal(consumerQueueName("bad:host", "host"), null);
});

test("an unanswered or malformed demand read is bounded, never evidence of a stalled queue", async () => {
	for (const evalFn of [async () => { throw new Error("private details"); }, async () => [2, 1], () => new Promise(() => {})]) {
		const [health] = await readConsumerStatus({ eval: evalFn }, [host()], { now, timeoutMs: 5 });
		assert.equal(health.state, "unknown");
	}
	let calls = 0;
	const many = await readConsumerStatus({ eval: async () => { calls++; return [0, 0]; } }, Array.from({ length: 200 }, (_, i) => host(`worker-${i}`)), { now });
	assert.equal(calls, CONSUMER_READ_QUEUES_MAX);
	assert.ok(many.every((h) => h.state === "unknown"));
});

test("only the exact old published registry shape is an older-state finding, and it retires", () => {
	for (const version of ["5.3.3", "5.4.0"]) {
		assert.equal(olderConsumerHealthFindings([host("build3", { version, consumers: undefined })]).length, 1);
		assert.deepEqual(olderConsumerHealthFindings([host("build3", { version })]), []);
	}
	for (const version of ["custom", "5.4.0-custom", "5.4.1"]) assert.deepEqual(olderConsumerHealthFindings([host("mini1", { version, consumers: undefined })]), []);
	assert.deepEqual(olderConsumerHealthFindings([]), []);
});
