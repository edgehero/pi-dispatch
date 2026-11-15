import assert from "node:assert/strict";
import { test } from "node:test";
import { DELAYED_SCORE_SHIFT, QUEUE_KEY, queueKey } from "../src/bullmq-internals.mjs";
import { DEFER_FIELDS, WAITING_DUE_GRACE_MS, deferKey } from "../src/defer-reasons.mjs";
import { readStatusWaiting, STATUS_WAITING_PER_QUEUE_MAX, STATUS_WAITING_QUEUES_MAX } from "../src/status-waiting.mjs";

const NOW = Date.UTC(2026, 10, 15, 12);
const clock = () => NOW;
const score = (due) => String(due * DELAYED_SCORE_SHIFT);
const fields = (why, until = NOW + 60_000, extra = {}) => DEFER_FIELDS.map((name) => ({ why, at: String(NOW), until: String(until), ...extra })[name] ?? null);

function queue({ name = "pi-jobs", members = ["manual:nightly:1", score(NOW + 60_000)], records = {}, zrange = null, replies = null } = {}) {
	const sent = [];
	const client = {
		async zrange(...args) { sent.push(["zrange", ...args]); return zrange ? zrange(...args) : members; },
		pipeline(commands) {
			sent.push(...commands);
			for (const [cmd, key, ...asked] of commands) {
				assert.equal(cmd, "hmget");
				assert.ok(key.startsWith(deferKey("")));
				assert.deepEqual(asked, DEFER_FIELDS, "never fetch a queued payload or unrelated stored fields");
			}
			return { exec: async () => replies ?? commands.map(([, key]) => [null, records[key] ?? DEFER_FIELDS.map(() => null)]) };
		},
	};
	return { name, client, sent };
}

test("status explains authentication waits on shared and host queues without reading payloads", async () => {
	const a = queue({ records: { [deferKey("manual:nightly:1")]: fields("subscription-auth", NOW + 60_000, { holder: "private-payload", n: "0123456789abcdef" }) } });
	const b = queue({ name: "pi-jobs@worker-one", members: ["host-job", score(NOW + 60_000)], records: { [deferKey("host-job")]: fields("subscription-owner") } });
	const got = await readStatusWaiting([a, b], { now: clock });
	assert.deepEqual(got, {
		rows: [
			{ jobId: "manual:nightly:1", queue: a.name, dueAt: NOW + 60_000, bucket: "check", why: "subscription-auth", until: NOW + 60_000 },
			{ jobId: "host-job", queue: b.name, dueAt: NOW + 60_000, bucket: "ready", why: "subscription-owner", until: NOW + 60_000 },
		],
		partial: false, truncated: false, skippedQueues: 0, unavailableQueues: [], invalidEntries: 0,
	});
	assert.deepEqual(a.sent[0], ["zrange", queueKey(a.name, QUEUE_KEY.delayed), 0, STATUS_WAITING_PER_QUEUE_MAX, "WITHSCORES"]);
	assert.ok(!JSON.stringify(got).includes("private-payload"));
	assert.ok(!JSON.stringify(got).includes("0123456789abcdef"));
});

test("missing, invalid and stale records do not invent an active hold; shaped new reasons stay unknown", async () => {
	const ids = ["missing", "invalid", "stale", "newer", "edge", "due"];
	const edge = NOW - WAITING_DUE_GRACE_MS;
	const dueFor = (id) => id === "edge" ? edge : id === "due" ? edge - 1 : NOW + 60_000;
	const q = queue({ members: ids.flatMap((id) => [id, score(dueFor(id))]), records: {
		[deferKey("invalid")]: fields("secret path /private/account"),
		[deferKey("stale")]: fields("subscription-auth", NOW + 1_000),
		[deferKey("newer")]: fields("newer-auth-gate"),
		[deferKey("edge")]: fields("subscription-auth", edge, { at: String(edge - 1000) }),
		[deferKey("due")]: fields("subscription-auth", edge - 1, { at: String(edge - 1000) }),
	} });
	const got = await readStatusWaiting([q], { now: clock });
	assert.deepEqual(got.rows.map((row) => [row.jobId, row.bucket, row.why]), [
		["missing", "none", null], ["invalid", "none", null], ["stale", "none", null],
		["newer", "unknown", "newer-auth-gate"], ["edge", "check", "subscription-auth"], ["due", "due", "subscription-auth"],
	]);
	assert.equal(got.rows.find((row) => row.jobId === "stale").until, null);
	assert.ok(!JSON.stringify(got).includes("/private"));
});

test("bounds report omitted queues and rows, and malformed members are neither read nor printed", async () => {
	const first = queue({ members: ["okay", score(NOW), "secret id\n", score(NOW), "third", score(NOW)] });
	const q = Array.from({ length: STATUS_WAITING_QUEUES_MAX + 1 }, (_, i) => i === 0 ? first : queue({ name: `pi-jobs@host-${i}`, members: [] }));
	const got = await readStatusWaiting(q, { now: clock, perQueue: 2 });
	assert.equal(got.partial, true);
	assert.equal(got.truncated, true);
	assert.equal(got.skippedQueues, 1);
	assert.equal(got.invalidEntries, 1);
	assert.deepEqual(got.rows.map((row) => row.jobId), ["okay"]);
	assert.equal(q.at(-1).sent.length, 0);
	assert.ok(!JSON.stringify(got).includes("secret id"));
	assert.equal(first.sent.length, 2, "one bounded membership read, one known-field read for the valid member");
});

test("a failed field read retains membership but says unavailable, with no raw error text", async () => {
	const q = queue({ replies: [[new Error("opaque-access-secret /private/operator"), null]] });
	const got = await readStatusWaiting([q], { now: clock });
	assert.deepEqual(got.rows, [{ jobId: "manual:nightly:1", queue: q.name, dueAt: NOW + 60_000, unavailable: true }]);
	assert.equal(got.partial, true);
	assert.deepEqual(got.unavailableQueues, [q.name]);
	assert.ok(!JSON.stringify(got).includes("secret"));
});

test("a stalled queue is bounded while readable queues remain visible, and a late response starts no follow-up", async () => {
	let finish;
	const stalled = queue({ name: "pi-jobs@stalled", zrange: () => new Promise((resolve) => { finish = resolve; }) });
	const good = queue();
	const got = await readStatusWaiting([stalled, good], { now: clock, timeoutMs: 10 });
	assert.equal(got.rows.length, 1);
	assert.equal(got.partial, true);
	assert.deepEqual(got.unavailableQueues, [stalled.name]);
	finish(["late-job", score(NOW + 60_000)]);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(stalled.sent.length, 1, "the timed-out reader never starts its field read");
	const noClient = { name: "pi-jobs@unreachable", client: new Promise(() => {}) };
	const unavailable = await readStatusWaiting([noClient], { now: clock, timeoutMs: 10 });
	assert.deepEqual(unavailable.unavailableQueues, [noClient.name]);
});

test("an invalid score or unreadable membership is partial, never a trustworthy empty set", async () => {
	for (const members of [["job", "nan"], ["orphan"], "not a list"]) {
		const got = await readStatusWaiting([queue({ members })], { now: clock });
		assert.equal(got.partial, true);
		assert.equal(got.rows.length, 0);
	}
});
