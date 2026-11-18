import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Worker } from "bullmq";
import { parseConnection } from "../src/connection.mjs";
import { enqueueForgeJob, makeQueue, releaseSemanticWindow } from "../src/queue.mjs";
import { JOB_FIELD, jobKeyOf, readSemanticWindowOwner, releaseCompletedSemanticWindow, semanticWindowKeyOf } from "../src/bullmq-internals.mjs";
import { removeQueuedJob } from "../src/cancel-state.mjs";
import { duplicateNoticeData } from "../src/duplicate-notice.mjs";
import { JOB_DATA_VERSION_FIELD } from "../src/job-data-version.mjs";
import { makeWaitState, jobKey as waitJobKey } from "../src/wait-state.mjs";

const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("semantic-window integration REQUIRES VALKEY_TEST_URL");
const skip = url ? false : "VALKEY_TEST_URL not set; CI requires these tests";
const refusal = { outcome: "policy", reason: "secret-bundle-trigger-changed", budgetReserved: false };
const cancellation = { outcome: "policy", reason: "operator-cancel", budgetReserved: true, turns: 1 };

const fields = (id, extra = {}) => ({
	repo: "owner/repo", projectId: 7, target: { type: "issue", number: 7, title: "private title", body: "private body" }, flow: "fix",
	trigger: { event: "issues", action: "labeled", deliveryId: id, sender: { id: 1 } }, ...extra,
});

// BullMQ supplies its own clock for these real transitions. Every test instant is taken at the call, never a dated
// fixture beside that clock; expiry cases expire the key explicitly instead of sleeping through a TTL.
async function world(t, { host = false } = {}) {
	const connection = parseConnection(url);
	const q = makeQueue(connection, { name: `pi-jobs${host ? "@" : "-"}s899-${randomUUID()}` });
	const w = new Worker(q.name, async () => {}, { connection, autorun: false });
	const redis = await q.client;
	t.after(async () => { await w.close(); await q.obliterate({ force: true }); await q.close(); });
	return {
		q, w, redis,
		add: (id, extra = {}, kind = "github") => enqueueForgeJob(q, kind, fields(id, extra)),
		finish: async (result) => {
			const token = randomUUID();
			const job = await w.getNextJob(token, { block: false });
			assert.ok(job, "there is a job to finish");
			await job.moveToCompleted(result, token, false);
			return job;
		},
	};
}

test("a stale refused or cancelled owner is repaired, and the retained delivery GUID still shields its original job", { skip }, async (t) => {
	for (const result of [refusal, cancellation, { ...cancellation, reason: "agent-cancel" }, { ...refusal, reason: "future-policy-refusal" }]) {
		await t.test(result.reason, async (t) => {
			const { q, add, finish, redis } = await world(t);
			const original = await add("original");
			const owner = await finish(result); // Simulates an older worker, or cleanup that could not reach Valkey.
			const key = semanticWindowKeyOf(q, owner.deduplicationId);
			assert.equal(await redis.get(key), original.jobId, "the positive-TTL key survived completion");
			const next = await add("corrected");
			assert.equal(next.deduplicated, false);
			assert.equal(await redis.get(key), next.jobId);
			assert.deepEqual((await q.getJob(original.jobId)).returnvalue, result, "repair retains the original result and GUID hash");
			assert.deepEqual(await add("original"), original, "replaying the original GUID never starts a new attempt");
			assert.equal((await q.getJobCounts("waiting")).waiting, 1);
		});
	}
});

test("real queue.add returns incoming data under the survivor ID; repair judges the actual stored result", { skip }, async (t) => {
	const { q, add, finish } = await world(t);
	const first = await add("original");
	const owner = await finish(refusal);
	const returned = await q.add("github", { incoming: true }, { jobId: "gh-observe", deduplication: { id: owner.deduplicationId, ttl: 600_000 } });
	assert.equal(returned.id, first.jobId);
	assert.deepEqual(returned.data, { incoming: true });
	assert.equal(returned.returnvalue, null);
	assert.equal((await add("corrected")).deduplicated, false);
});

test("successful, continuing and unknown results retain their window", { skip }, async (t) => {
	for (const result of [null, { outcome: "completed" }, { outcome: "future" }, { outcome: "policy", reason: "recovery-enqueued" }, { outcome: "policy", reason: "recovery-superseded" }]) {
		await t.test(JSON.stringify(result), async (t) => {
			const { add, finish } = await world(t);
			const original = await add("original");
			await finish(result);
			// Issue #932: the swallow says its owner has ended; no notice, since this producer did not ask for one.
			assert.deepEqual(await add("next"), { jobId: "gh-next", deduplicated: true, survivingJobId: original.jobId, survivor: "ended" });
		});
	}
});

test("waiting, active, delayed and failed jobs keep their window", { skip }, async (t) => {
	for (const state of ["waiting", "active", "delayed", "failed"]) {
		await t.test(state, async (t) => {
			const { add, q, w } = await world(t);
			const original = await add("original");
			if (state !== "waiting") {
				const token = randomUUID();
				const job = await w.getNextJob(token, { block: false });
				if (state === "delayed") await job.moveToDelayed(Date.now() + 60_000, token);
				if (state === "failed") { job.discard(); await job.moveToFailed(new Error("infra"), token, false); }
			}
			assert.equal(await (await q.getJob(original.jobId)).getState(), state);
			assert.equal((await add("next")).survivingJobId, original.jobId);
		});
	}
});

test("atomic repair refuses changed result bytes, state, dedup identity and replacement ownership", { skip }, async (t) => {
	const { q, add, finish, redis } = await world(t);
	await add("original");
	const owner = await finish(refusal);
	const id = owner.deduplicationId;
	const hash = jobKeyOf(q, owner.id);
	const key = semanticWindowKeyOf(q, id);
	const snapshot = await readSemanticWindowOwner(q, id, owner.id);
	assert.equal(snapshot.state, "completed");
	const release = () => releaseCompletedSemanticWindow(q, id, owner.id, snapshot.rawResult);
	await redis.hset(hash, JOB_FIELD.result, JSON.stringify({ ...refusal, reason: "changed" }));
	assert.equal(await release(), false, "changed result invalidates the witness");
	await redis.hset(hash, JOB_FIELD.result, snapshot.rawResult);
	await redis.hset(hash, JOB_FIELD.dedupId, "another-key");
	assert.equal(await release(), false, "same owner ID is not sufficient");
	assert.equal((await readSemanticWindowOwner(q, id, owner.id)).state, "invalid");
	await redis.hset(hash, JOB_FIELD.dedupId, id);
	await owner.retry("completed");
	assert.equal(await release(), false, "a job retried after the read must retain its key");
	await finish(refusal);
	await redis.pexpire(key, 0);
	const replacement = await add("replacement");
	assert.equal(await release(), false, "an expired owner never deletes its replacement");
	assert.equal(await owner.removeDeduplicationKey(), false, "the worker's ordinary release is owner-checked too");
	assert.equal(await redis.get(key), replacement.jobId);
});

test("raw result whitespace is preserved as a witness, and corrupt or missing owner state fails visibly", { skip }, async (t) => {
	const { q, add, finish, redis } = await world(t);
	await add("original");
	const owner = await finish(refusal);
	const hash = jobKeyOf(q, owner.id);
	await redis.hset(hash, JOB_FIELD.result, ' { "reason" : "operator-cancel", "outcome" : "policy" } ');
	assert.equal((await add("next")).deduplicated, false, "repair compares the raw bytes, not reserialized JSON");
	const next = await finish(refusal);
	for (const bad of [{ outcome: "policy" }, { outcome: "policy", reason: "not a token" }]) {
		await redis.hset(jobKeyOf(q, next.id), JOB_FIELD.result, JSON.stringify(bad));
		await assert.rejects(add("after-malformed"), { code: "semantic-window-result-invalid" });
	}
	await redis.hset(jobKeyOf(q, next.id), JOB_FIELD.result, "{broken");
	await assert.rejects(add("after-corruption"), { code: "semantic-window-result-invalid" });
	assert.equal(await q.getJob("gh-after-corruption"), undefined);
	await redis.del(jobKeyOf(q, next.id));
	await assert.rejects(add("after-orphan"), { code: "semantic-window-state-invalid" });
	assert.equal(await redis.get(semanticWindowKeyOf(q, next.deduplicationId)), next.id, "uncertainty never deletes protection");
});

test("two producers repairing the same refusal create exactly one replacement", { skip, timeout: 15_000 }, async (t) => {
	const { q, add, finish, redis } = await world(t);
	await add("original");
	await finish(refusal);
	let reads = 0;
	let unblock;
	const bothRead = new Promise((resolve) => { unblock = resolve; });
	const client = {
		eval: async (...args) => {
			const reply = await redis.eval(...args);
			if (Array.isArray(reply) && reply[0] === "completed") {
				if (++reads === 2) unblock();
				await bothRead;
			}
			return reply;
		},
	};
	const routed = { name: q.name, toKey: q.toKey.bind(q), client: Promise.resolve(client), add: q.add.bind(q) };
	const results = await Promise.all(["corrected-a", "corrected-b"].map((id) => enqueueForgeJob(routed, "github", fields(id))));
	assert.equal(reads, 2, "both judged the same completed owner before either conditional delete");
	assert.equal(results.filter((r) => !r.deduplicated).length, 1);
	assert.equal((await q.getJobCounts("waiting")).waiting, 1);
	const winner = results.find((r) => !r.deduplicated).jobId;
	assert.equal(results.find((r) => r.deduplicated).survivingJobId, winner);
});

test("all forges, replica discriminators and host queues use their stored semantic identity", { skip }, async (t) => {
	for (const kind of ["github", "gitlab", "forgejo", "azure"]) {
		await t.test(kind, async (t) => {
			const { q, add, finish, redis } = await world(t, { host: true });
			const extra = { target: { type: "pull_request", number: 7 }, replica: 1, replicas: 2 };
			await add("first", extra, kind);
			const owner = await finish(refusal);
			const otherReplica = await add("first", { ...extra, replica: 2 }, kind);
			const next = await add("corrected", extra, kind);
			assert.equal(next.deduplicated, false);
			assert.equal(await redis.get(semanticWindowKeyOf(q, owner.deduplicationId)), next.jobId);
			assert.ok(await q.getJob(otherReplica.jobId), "other replica remains independent");
			assert.equal((await q.getJobCounts("waiting")).waiting, 2);
		});
	}
});

test("queued cancellation removes only its owned window, and a failed locked removal leaves it", { skip }, async (t) => {
	const { q, add, w, redis } = await world(t);
	const first = await add("first");
	const queued = await q.getJob(first.jobId);
	const cancelled = await removeQueuedJob({ redis, queue: q, job: queued, jobId: queued.id, touchStore: null, now: Date.now });
	assert.equal(cancelled.ok, true);
	assert.equal(await redis.get(semanticWindowKeyOf(q, queued.deduplicationId)), null);
	const next = await add("next");
	assert.equal(next.deduplicated, false);
	const active = await w.getNextJob(randomUUID(), { block: false });
	const failed = await removeQueuedJob({ redis, queue: q, job: active, jobId: active.id, state: "waiting", touchStore: null, now: Date.now });
	assert.equal(failed.raced, true);
	assert.equal(await redis.get(semanticWindowKeyOf(q, active.deduplicationId)), active.id);
});

test("worker release has a bound and a late completion never turns the terminal result into an error", async () => {
	let finish;
	const pending = new Promise((resolve) => { finish = resolve; });
	const logs = [];
	assert.equal(await releaseSemanticWindow({ id: "gh-test", deduplicationId: "a", removeDeduplicationKey: () => pending }, (event, data) => logs.push({ event, ...data }), { cause: "policy", timeoutMs: 5 }), false);
	assert.deepEqual(logs, [{ event: "semantic_window_release_failed", jobId: "gh-test", cause: "policy", code: "ETIMEDOUT" }]);
	finish(true);
	await pending;
	assert.equal(logs.length, 1, "a late answer makes no false release claim");
});

test("held cancellation removes its hold and owned semantic window before a corrected event", { skip }, async (t) => {
	const { q, add, w, redis } = await world(t);
	await add("held");
	const token = randomUUID();
	const job = await w.getNextJob(token, { block: false });
	const instant = Date.now();
	const now = () => instant;
	const wait = makeWaitState({ redis, now });
	await wait.hold(job.id, { dedupId: job.deduplicationId, target: "owner/repo#7", label: "checks", untilMs: now() + 60_000 });
	await job.moveToDelayed(now() + 60_000, token);
	assert.ok((await redis.hgetall(waitJobKey(job.id))).since);
	const cancelled = await removeQueuedJob({ redis, queue: q, job, jobId: job.id, touchStore: null, now });
	assert.equal(cancelled.ok, true);
	assert.equal(cancelled.held, true, "takes the distinct held-removal path");
	assert.equal(await redis.exists(waitJobKey(job.id)), 0);
	assert.equal(await redis.get(semanticWindowKeyOf(q, job.deduplicationId)), null);
	assert.equal((await add("corrected")).deduplicated, false);
});

test("repair contention is bounded, with an ordinary add after the last permitted repair", async () => {
	for (const succeeds of [true, false]) {
		let adds = 0;
		let deletes = 0;
		const queue = {
			name: "pi-jobs-test",
			add: async (_kind, _data, opts) => ({ id: ++adds === 4 && succeeds ? opts.jobId : "gh-stale" }),
			// The conditional delete names 3 keys, the owner snapshot 4 (issue #932 added the failed set).
			client: Promise.resolve({ eval: async (_script, count) => {
				if (count === 3) { deletes++; return 1; }
				return ["completed", JSON.stringify(refusal)];
			} }),
		};
		if (succeeds) assert.equal((await enqueueForgeJob(queue, "github", fields("corrected"))).deduplicated, false);
		else await assert.rejects(enqueueForgeJob(queue, "github", fields("corrected")), { code: "semantic-window-repair-contended" });
		assert.equal(adds, 4);
		assert.equal(deletes, 3, "never delete a fourth owner without trying to enqueue afterwards");
	}
});

test("an expired owner between add and snapshot retries the ordinary add without any delete", async () => {
	let adds = 0;
	const queue = {
		name: "pi-jobs-test",
		add: async (_kind, _data, opts) => ({ id: ++adds === 1 ? "gh-expired" : opts.jobId }),
		client: Promise.resolve({ eval: async (_script, count) => {
			assert.equal(count, 4, "only snapshot, never a conditional delete");
			return ["changed"];
		} }),
	};
	assert.equal((await enqueueForgeJob(queue, "github", fields("corrected"))).deduplicated, false);
	assert.equal(adds, 2);
});

// Issue #932: a request the window drops against an ENDED job leaves one notice the worker answers on the item.
test("a request dropped against an ended job leaves exactly one notice, with no window of its own (#932)", { skip }, async (t) => {
	for (const ending of ["completed", "failed"]) {
		await t.test(ending, async (t) => {
			const { q, w, add, finish, redis } = await world(t);
			const original = await add("original");
			if (ending === "completed") await finish({ outcome: "completed" });
			else {
				const token = randomUUID();
				const job = await w.getNextJob(token, { block: false });
				job.discard();
				await job.moveToFailed(new Error("infra"), token, false);
			}
			const instant = Date.now();
			const ask = () => enqueueForgeJob(q, "github", fields("next"), { noticeOnDrop: true, now: () => instant });
			const dropped = await ask();
			assert.deepEqual(dropped, { jobId: "gh-next", deduplicated: true, survivingJobId: original.jobId, survivor: "ended", notice: "gh-next-dup" });
			const notice = await q.getJob("gh-next-dup");
			const { windowEndsAt } = notice.data;
			assert.ok(windowEndsAt > instant && windowEndsAt <= instant + 10 * 60 * 1000, "the window's own end, from its key");
			assert.deepEqual(notice.data, { ...duplicateNoticeData({ kind: "github", ...fields("next") }, { survivingJobId: original.jobId, windowEndsAt }), [JOB_DATA_VERSION_FIELD]: 10 }, "stamped 10, so an older worker holds it instead of running it");
			assert.equal(JSON.stringify(notice.data).includes("private"), false, "no title or body from the item");
			assert.equal(notice.deduplicationId, undefined, "a notice holds no window");
			// A replay of the same delivery is swallowed again and finds the notice it already left.
			assert.deepEqual(await ask(), dropped);
			assert.equal((await q.getJobCounts("waiting")).waiting, 1, "one notice for one delivery");
			// And the notice can never free the window that dropped it.
			const key = semanticWindowKeyOf(q, (await q.getJob(original.jobId)).deduplicationId);
			assert.equal(await releaseSemanticWindow(notice, () => {}, { cause: "policy" }), false);
			assert.equal(await redis.get(key), original.jobId);
		});
	}
});

test("a request joined to a live job leaves no notice, and neither does a producer that did not ask (#932)", { skip }, async (t) => {
	const { q, add, finish } = await world(t);
	const original = await add("original");
	assert.deepEqual(await enqueueForgeJob(q, "github", fields("live"), { noticeOnDrop: true }), { jobId: "gh-live", deduplicated: true, survivingJobId: original.jobId, survivor: "live" });
	await finish({ outcome: "completed" });
	assert.deepEqual(await add("console"), { jobId: "gh-console", deduplicated: true, survivingJobId: original.jobId, survivor: "ended" });
	assert.equal(await q.getJob("gh-live-dup"), undefined);
	assert.equal(await q.getJob("gh-console-dup"), undefined);
	assert.equal((await q.getJobCounts("waiting")).waiting, 0);
});

test("every replica of one dropped delivery shares one notice (#932)", { skip }, async (t) => {
	const { q, w } = await world(t);
	const replica = (id, i, options) => enqueueForgeJob(q, "github", { ...fields(id), replica: i, replicas: 2 }, options);
	await replica("original", 1);
	await replica("original", 2);
	for (let i = 0; i < 2; i++) {
		const token = randomUUID();
		const job = await w.getNextJob(token, { block: false });
		await job.moveToCompleted({ outcome: "completed" }, token, false);
	}
	const one = await replica("next", 1, { noticeOnDrop: true });
	const two = await replica("next", 2, { noticeOnDrop: true });
	assert.equal(one.notice, "gh-next-dup");
	assert.equal(two.notice, "gh-next-dup", "the replica-free id: BullMQ answers the one it already holds");
	assert.equal((await q.getJobCounts("waiting")).waiting, 1);
});
