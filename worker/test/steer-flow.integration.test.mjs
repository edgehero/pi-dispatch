import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxAck } from "../../image/runner/src/inbox.mjs";
import { makeInboxRelay } from "../src/inbox-relay.mjs";
import { makeLateForge, settleInbox, STEER_LATE_REPLY } from "../src/inbox-settle.mjs";
import { makeLiveTranscriptOpener } from "../src/live-transcript.mjs";
import { makeSteerAck } from "../src/steer-ack.mjs";
import { forgeMessageId, isOpen, messageState, operatorMessageId, pushSteer, registerLive, storeFallback, unregisterLive } from "../src/steer-inbox.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #646, end to end against a real Valkey: an operator's push (the CLI's call) becomes a file in the run's inbox
// directory, a forged ack the agent writes into its transcript is ignored, the runner's real ack marks the message
// delivered and removes its file, and the settle step at the final outcome counts it and turns what waits into `late`.
// The container is the only part faked: this test plays the runner's two moves (read the file, write the ack line).

const valkeyUrl = process.env.VALKEY_TEST_URL;
if (!valkeyUrl && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("steer-flow tests REQUIRE VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
const live = valkeyUrl ? false : "VALKEY_TEST_URL not set; the flow needs a real Valkey";

// Database 4: no other test file in the repository selects it.
const clients = [];
async function client() {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const url = new URL(valkeyUrl);
	url.pathname = "/4";
	const r = makeRedisClient(url.toString());
	r.on("error", () => {});
	clients.push(r);
	await r.flushdb();
	return r;
}
test.after(async () => {
	await Promise.all(clients.map((r) => r.quit().catch(() => {})));
});

const T0 = 1_800_000_000_000;
const KEY = "5e".repeat(32);
const FORGED_KEY = "a7".repeat(32);
const line = (o) => `${JSON.stringify({ timestamp: "2026-10-17T10:00:00.000Z", ...o })}\n`;
const ackLine = (id, ack) => line({ type: "custom_message", customType: "pi-dispatch-inbox", content: [{ type: "text", text: "framed" }], display: true, details: { id, mode: "steer", source: "cli", ack } });
const opMessage = (id, text) => ({ v: 1, id, mode: "steer", source: "cli", author: { kind: "operator", by: "cli" }, text });

test("a pushed message becomes a file; a forged ack is ignored, the real one marks it delivered; the settle counts it and closes the inbox", { skip: live, timeout: 20_000 }, async () => {
	const redis = await client();
	const dir = tempDir("pi-steer-flow-");
	const jobDir = join(dir, "job-f1");
	const inboxDir = `${jobDir}.inbox`;
	mkdirSync(join(jobDir, "session"), { recursive: true });
	mkdirSync(inboxDir, { mode: 0o700 });
	const transcript = join(jobDir, "session", "current.jsonl");
	writeFileSync(transcript, "");
	const runId = "flow-run-1";
	const containerName = "pi-job-flow-run-1"; // what the worker puts in PI_JOB_ID, and so what the runner MACs
	const logs = [];
	const log = (e, f) => logs.push([e, f]);
	const now = () => T0;

	// What runContainer wires for an ARMED attempt: the relay, the ack consumer under this attempt's key, the tail.
	const relay = makeInboxRelay({ redis, runId, jobId: runId, inboxDir, host: "flow-host", now, log, pollMs: 3_600_000 });
	const ack = makeSteerAck({ exitKey: KEY, ackRunId: containerName, relay, jobId: runId, log });
	const tail = makeLiveTranscriptOpener({ redis: null, transcripts: false, progress: false, steer: true, pollMs: 3_600_000, now })({ file: transcript, jobId: runId, job: { steer: true }, steer: ack });

	// Before the container: no open key, so a push is refused as gone (the CLI says the run is not accepting messages).
	assert.equal(await pushSteer({ redis, runId, entry: opMessage(operatorMessageId(), "too early"), now }), "gone");

	await relay.start();
	tail.start();
	assert.equal(await isOpen({ redis, runId }), true, "registered live with the container");

	// The CLI's push.
	const id = operatorMessageId();
	assert.equal(await pushSteer({ redis, runId, entry: opMessage(id, "please run the linter before you commit"), now }), "ok");
	const second = operatorMessageId();
	assert.equal(await pushSteer({ redis, runId, entry: opMessage(second, "and say hello"), now }), "ok");

	await tail.poll(); // the first pass: an empty transcript is a baseline of nothing
	// The tail's start already ran a pass whose baseline released a relay pass, which may have read the inbox before the
	// pushes landed; the relay's next tick (every 2 s in a worker) is the one that sees them, so two are awaited here.
	await relay.tick();
	await relay.tick();
	const names = readdirSync(inboxDir).sort();
	assert.deepEqual(names, [`000001-${id}.json`, `000002-${second}.json`]);
	const body = JSON.parse(readFileSync(join(inboxDir, names[0]), "utf8"));
	assert.equal(body.id, id);
	assert.match(body.content, /please run the linter before you commit/);
	assert.match(body.content, /An operator of this deployment \(the command line\)/);
	assert.equal(await messageState({ redis, runId, id }), "written");

	// The agent forges an ack (it can write /session, it cannot read the key): ignored, counted, the message stays written.
	appendFileSync(transcript, ackLine(id, inboxAck(FORGED_KEY, containerName, id)));
	appendFileSync(transcript, ackLine(second, inboxAck(KEY, "pi-job-some-other-run", second)));
	await tail.poll();
	await ack.drain();
	assert.equal(await messageState({ redis, runId, id }), "written", "a MAC under another key counts for nothing");
	assert.equal(await messageState({ redis, runId, id: second }), "written", "nor one for another run string");
	assert.equal(ack.stats().unverified, 2);
	assert.ok(logs.some(([e]) => e === "steer_ack_unverified"));

	// The runner delivers the first message and pi persists it with the real ack.
	appendFileSync(transcript, ackLine(id, inboxAck(KEY, containerName, id)));
	// The container exits: the tail's final read, the acks drained, the relay stopped (runContainer's close order).
	await tail.finish("completed");
	await ack.drain();
	await relay.stop();
	assert.equal(await messageState({ redis, runId, id }), "delivered");
	assert.deepEqual(readdirSync(inboxDir), [`000002-${second}.json`], "the delivered message's file is gone");
	assert.equal(await isOpen({ redis, runId }), true, "F3: HELD at the exit, so a message in the gap before the settle still lands; the inbox is open for a retry");

	// The final outcome (index.mjs's settleSteer): closed and counted; the undelivered message is late, a later push refused.
	const job = { id: runId, attemptsMade: 0, opts: { attempts: 1 }, data: { kind: "local", folder: "/x", steer: true } };
	assert.deepEqual(await settleInbox({ redis, job, result: { outcome: "completed" }, log }), { delivered: 1, late: 1, withdrawn: 0 });
	assert.equal(await messageState({ redis, runId, id: second }), "late");
	assert.equal(await pushSteer({ redis, runId, entry: opMessage(operatorMessageId(), "after the end"), now }), "closed");
	assert.ok(!JSON.stringify(logs).includes("linter"), "no message text in any log line");
});

test("an InfraRetry with an attempt left keeps the inbox open: the next attempt re-baselines and hands the message over again", { skip: live, timeout: 20_000 }, async () => {
	const redis = await client();
	const runId = "flow-run-2";
	const now = () => T0;
	const attempt = async (n, priorTranscript = "") => {
		const dir = tempDir("pi-steer-flow-");
		const inboxDir = join(dir, `job-${n}.inbox`);
		mkdirSync(inboxDir, { mode: 0o700 });
		const transcript = join(dir, "current.jsonl");
		writeFileSync(transcript, priorTranscript);
		const relay = makeInboxRelay({ redis, runId, inboxDir, host: "flow-host", now, pollMs: 3_600_000 });
		const ack = makeSteerAck({ exitKey: `${n}`.repeat(64), ackRunId: `pi-job-${n}`, relay });
		const tail = makeLiveTranscriptOpener({ redis: null, transcripts: false, progress: false, steer: true, pollMs: 3_600_000, now })({ file: transcript, jobId: runId, job: { steer: true }, steer: ack });
		await relay.start();
		tail.start();
		return { relay, ack, tail, inboxDir, transcript };
	};
	const job = { id: runId, attemptsMade: 0, opts: { attempts: 2 }, data: { kind: "local", folder: "/x", steer: true } };

	const a1 = await attempt(1);
	const id = operatorMessageId();
	assert.equal(await pushSteer({ redis, runId, entry: opMessage(id, "use the staging database"), now }), "ok");
	await a1.tail.poll();
	await a1.relay.tick();
	await a1.relay.tick();
	appendFileSync(a1.transcript, ackLine(id, inboxAck("1".repeat(64), "pi-job-1", id)));
	await a1.tail.finish("failed");
	await a1.ack.drain();
	await a1.relay.stop();
	assert.equal(await messageState({ redis, runId, id }), "delivered");
	const { InfraRetry } = await import("../src/processor.mjs");
	assert.equal(await settleInbox({ redis, job, error: new InfraRetry("x") }), null, "not final: the inbox stays open");

	// Attempt 2 starts from an EMPTY transcript (a plain retry): the delivery is not in it, so the message goes back to
	// written and its file appears again in this attempt's own directory.
	const a2 = await attempt(2);
	await a2.tail.poll();
	await a2.relay.tick();
	await a2.relay.tick();
	assert.equal(await messageState({ redis, runId, id }), "written");
	assert.deepEqual(readdirSync(a2.inboxDir), [`000001-${id}.json`]);
	await a2.tail.finish("completed");
	await a2.relay.stop();

	// Attempt 3 starts from a restored transcript that HOLDS the delivery (a #645 recovery): left delivered, no file.
	await redis.eval("redis.call('HSET', KEYS[1], ARGV[1], 'delivered')", 1, `run:inbox:state:${runId}`, id);
	const a3 = await attempt(3, line({ type: "session" }) + ackLine(id, inboxAck("1".repeat(64), "pi-job-1", id)));
	await a3.tail.poll();
	await a3.relay.tick();
	await a3.relay.tick();
	assert.equal(await messageState({ redis, runId, id }), "delivered");
	assert.deepEqual(readdirSync(a3.inboxDir), []);
	assert.equal(a3.ack.stats().verified, 0, "the earlier attempt's line is a baseline, never a new delivery");
	await a3.tail.finish("completed");
	await a3.relay.stop();
});

test("F1: a console retry under the same job id finds the inbox closed; its relay resets it, old deliveries stay out, new pushes are accepted", { skip: live, timeout: 20_000 }, async () => {
	const redis = await client();
	const runId = "flow-run-3";
	const now = () => T0;
	const job = { id: runId, attemptsMade: 0, opts: { attempts: 1 }, data: { kind: "local", folder: "/x", steer: true } };
	const run = async (n) => {
		const dir = tempDir("pi-steer-flow-");
		const inboxDir = join(dir, `job-${n}.inbox`);
		mkdirSync(inboxDir, { mode: 0o700 });
		const transcript = join(dir, "current.jsonl");
		writeFileSync(transcript, "");
		const relay = makeInboxRelay({ redis, runId, inboxDir, host: "flow-host", now, pollMs: 3_600_000 });
		const ack = makeSteerAck({ exitKey: `${n}`.repeat(64), ackRunId: `pi-job-${n}`, relay });
		const tail = makeLiveTranscriptOpener({ redis: null, transcripts: false, progress: false, steer: true, pollMs: 3_600_000, now })({ file: transcript, jobId: runId, job: { steer: true }, steer: ack });
		await relay.start();
		tail.start();
		return { relay, ack, tail, inboxDir, transcript };
	};
	// The first run: one message delivered, then the final outcome closes the inbox.
	const r1 = await run(1);
	const old = operatorMessageId();
	assert.equal(await pushSteer({ redis, runId, entry: opMessage(old, "the first run's message"), now }), "ok");
	await r1.tail.poll();
	await r1.relay.tick();
	await r1.relay.tick();
	appendFileSync(r1.transcript, ackLine(old, inboxAck("1".repeat(64), "pi-job-1", old)));
	await r1.tail.finish("failed");
	await r1.ack.drain();
	await r1.relay.stop();
	assert.deepEqual(await settleInbox({ redis, job, error: new Error("failed for good") }), { delivered: 1, late: 0, withdrawn: 0 });
	assert.equal(await pushSteer({ redis, runId, entry: opMessage(operatorMessageId(), "between the runs"), now }), "closed");

	// The console retry: same job id, same run id. The relay's start reopens the inbox for the new run.
	const r2 = await run(2);
	await r2.tail.poll();
	await r2.relay.tick();
	await r2.relay.tick();
	assert.equal(await messageState({ redis, runId, id: old }), null, "the old run's message is gone, never moved back to written");
	assert.deepEqual(readdirSync(r2.inboxDir), [], "and never handed to the new run");
	const fresh = operatorMessageId();
	assert.equal(await pushSteer({ redis, runId, entry: opMessage(fresh, "for the retry"), now }), "ok", "pushes are accepted again");
	await r2.relay.tick();
	assert.deepEqual(readdirSync(r2.inboxDir), [`000001-${fresh}.json`]);
	await r2.tail.finish("completed");
	await r2.relay.stop();
});

test("LATE, BRANCH A end to end: a run ends holding two late comments; the first starts a resumed job, the second is pre-seeded and its relay writes it at the start; late again, it is answered", { skip: live, timeout: 20_000 }, async () => {
	const redis = await client();
	const now = () => T0;
	const logs = [];
	const log = (e, f) => logs.push([e, f]);
	const data = { kind: "github", repo: "o/r", target: { type: "issue", number: 7 }, flow: "fix", steer: true };
	const runId = "gh-flow-late-run";
	const targetKey = (await import("../src/inbox-relay.mjs")).steerTargetOf(data).targetKey;
	// The run is live (its relay registered it); the receiver pushes two comments, each after storing its fallback.
	await registerLive({ redis, runId, targetKey, host: "flow-host", now });
	const comment = (n) => ({ v: 1, id: forgeMessageId(`flow-guid-${n}`), mode: "steer", source: "forge", author: { kind: "forge", id: 42, association: "MEMBER" }, text: `late comment ${n}`, deliveryId: `flow-guid-${n}` });
	for (const n of [1, 2]) {
		const fields = { kind: "github", jobId: `gh-flow-guid-${n}`, repo: "o/r", target: { type: "issue", number: 7, title: "t", body: "b" }, flow: "fix", trigger: { deliveryId: `flow-guid-${n}` }, provider: "p", model: "m", maxTurns: 3, resume: true, steer: true };
		assert.deepEqual(await storeFallback({ redis, runId, id: comment(n).id, job: fields }), { ok: true });
		assert.equal(await pushSteer({ redis, runId, entry: comment(n), now }), "ok");
	}
	await unregisterLive({ redis, runId, targetKey }); // the container exited before its relay wrote either

	// The final outcome: closed, both late, the first resumes on the run's queue, the second goes into the new job's inbox.
	const adds = [];
	const queue = { add: async (name, d, opts) => (adds.push({ name, data: d, opts }), { id: opts.jobId }) };
	const comments = [];
	const lateForge = makeLateForge({ redis, queues: { shared: () => queue, host: () => queue }, comment: async (d, text) => comments.push({ d, text }), log, now });
	let released = 0;
	const job = { id: runId, queueName: "pi-jobs", deduplicationId: "o/r#7:fix", removeDeduplicationKey: async () => (released += 1, true), attemptsMade: 0, opts: { attempts: 2 }, data };
	assert.deepEqual(await settleInbox({ redis, job, result: { outcome: "completed" }, log, onLateForge: lateForge }), { delivered: 0, late: 2, withdrawn: 0 });
	assert.equal(released, 1, "the run's window is released");
	assert.equal(adds.length, 1);
	const next = adds[0];
	assert.equal(next.opts.jobId, "gh-flow-guid-1");
	assert.equal("deduplication" in next.opts, false);
	assert.equal(comments.length, 0);
	assert.equal(await messageState({ redis, runId: "gh-flow-guid-1", id: comment(2).id }), "queued", "pre-seeded before the run is live");

	// The resumed job starts: its relay (runId = its job id) writes the carried message at the start, framed as a steer.
	const dir = tempDir("pi-steer-flow-");
	const inboxDir = join(dir, "job-next.inbox");
	mkdirSync(inboxDir, { mode: 0o700 });
	const transcript = join(dir, "current.jsonl");
	writeFileSync(transcript, "");
	const nextRun = next.opts.jobId;
	const nextTarget = (await import("../src/inbox-relay.mjs")).steerTargetOf(next.data);
	const relay = makeInboxRelay({ redis, runId: nextRun, jobId: nextRun, inboxDir, targetKey: nextTarget.targetKey, ref: nextTarget.ref, forge: nextTarget.forge, host: "flow-host", now, log, pollMs: 3_600_000 });
	const ack = makeSteerAck({ exitKey: KEY, ackRunId: `pi-job-${nextRun}`, relay, jobId: nextRun, log });
	const tail = makeLiveTranscriptOpener({ redis: null, transcripts: false, progress: false, steer: true, pollMs: 3_600_000, now })({ file: transcript, jobId: nextRun, job: { steer: true }, steer: ack });
	await relay.start();
	tail.start();
	await tail.poll();
	await relay.tick();
	await relay.tick();
	const names = readdirSync(inboxDir);
	assert.deepEqual(names, [`000001-${comment(2).id}.json`], "only the carried message: the first one is the job's own prompt");
	const body = JSON.parse(readFileSync(join(inboxDir, names[0]), "utf8"));
	assert.equal(body.mode, "steer");
	assert.equal(body.source, "forge");
	assert.match(body.content, /late comment 2/);
	assert.equal(await messageState({ redis, runId: nextRun, id: comment(2).id }), "written");
	await tail.finish("completed");
	await relay.stop();

	// That run ends without delivering it: late again, hop 1, so it is answered, never carried a second time.
	const nextJob = { id: nextRun, queueName: "pi-jobs", attemptsMade: 0, opts: { attempts: 2 }, data: next.data };
	assert.deepEqual(await settleInbox({ redis, job: nextJob, result: { outcome: "completed" }, log, onLateForge: lateForge }), { delivered: 0, late: 1, withdrawn: 0 });
	assert.equal(adds.length, 1, "no second job");
	assert.equal(comments.length, 1);
	assert.equal(comments[0].text, STEER_LATE_REPLY);
	assert.equal(comments[0].d.id, nextRun);
	assert.deepEqual(logs.find(([e]) => e === "steer_late_resumed")[1], { jobId: "gh-flow-guid-1", runId, n: 2, queue: "pi-jobs" });
	assert.deepEqual(logs.find(([e]) => e === "steer_late_replied")[1], { runId: nextRun, n: 1 });
	assert.ok(!JSON.stringify(logs).includes("late comment"), "no message text in any log line");
});

test("F3 + F2 end to end: a comment pushed after the container exited still lands, settles late and is answered ONCE across two settles", { skip: live, timeout: 20_000 }, async () => {
	const redis = await client();
	const now = () => T0;
	const data = { kind: "github", repo: "o/r", target: { type: "issue", number: 9 }, flow: "fix", steer: true };
	const { steerTargetOf, makeInboxRelay: relayOf } = await import("../src/inbox-relay.mjs");
	const t = steerTargetOf(data);
	const runId = "gh-flow-gap-run";
	const dir = tempDir("pi-steer-flow-");
	const inboxDir = join(dir, "job-gap.inbox");
	mkdirSync(inboxDir, { mode: 0o700 });
	const relay = relayOf({ redis, runId, inboxDir, targetKey: t.targetKey, ref: t.ref, forge: t.forge, host: "flow-host", now, pollMs: 3_600_000 });
	await relay.start();
	await relay.stop(); // the container exited; the settle has not run yet
	const { liveRunsForTarget } = await import("../src/steer-inbox.mjs");
	assert.deepEqual(await liveRunsForTarget({ redis, targetKey: t.targetKey, now }), [runId], "the receiver still finds the run");
	const msg = { v: 1, id: forgeMessageId("gap-guid"), mode: "steer", source: "forge", author: { kind: "forge", id: 42, association: "MEMBER" }, text: "in the gap", deliveryId: "gap-guid" };
	assert.equal(await pushSteer({ redis, runId, entry: msg, now }), "ok", "accepted, not swallowed by an enqueue the window would eat");
	const comments = [];
	const lateForge = makeLateForge({ redis, queues: { shared: () => null, host: () => null }, comment: async (d, text) => comments.push(text), now });
	const job = { id: runId, queueName: "pi-jobs", attemptsMade: 0, opts: { attempts: 2 }, data };
	assert.deepEqual(await settleInbox({ redis, job, error: new Error("for good"), onLateForge: lateForge }), { delivered: 0, late: 1, withdrawn: 0 }, "the record counts it as late, not lost");
	assert.deepEqual(await settleInbox({ redis, job, error: { reason: "infra" }, onLateForge: lateForge }), { delivered: 0, late: 1, withdrawn: 0 });
	assert.deepEqual(comments, [STEER_LATE_REPLY], "answered once");
	assert.equal(await isOpen({ redis, runId }), false, "the settle removed the held keys");
	assert.deepEqual(await liveRunsForTarget({ redis, targetKey: t.targetKey, now }), []);
});
