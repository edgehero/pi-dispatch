import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxAck as runnerAck, INBOX_CUSTOM_TYPE as RUNNER_TYPE } from "../../image/runner/src/inbox.mjs";
import { makeLiveTranscriptOpener } from "../src/live-transcript.mjs";
import { ackVerifies, inboxAck, INBOX_CUSTOM_TYPE, makeSteerAck } from "../src/steer-ack.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #646: the worker counts a delivery only off a transcript line whose ack verifies under the attempt's exit key.

const KEY = "ab".repeat(32);
const OTHER_KEY = "cd".repeat(32);
const ACK_RUN = "pi-job-42";
const ID1 = "1".repeat(32);
const ID2 = "2".repeat(32);
const ID3 = "3".repeat(32);
const ackLine = (id, ack) => ({ type: "custom_message", customType: INBOX_CUSTOM_TYPE, content: [{ type: "text", text: "x" }], details: { id, mode: "steer", source: "cli", ack } });

function relaySpy() {
	const got = [];
	const baselines = [];
	const verifiedSets = [];
	return {
		got,
		baselines,
		verifiedSets,
		async delivered(id) {
			got.push(id);
		},
		afterBaseline(prior, verified = new Set()) {
			baselines.push([...prior].sort());
			verifiedSets.push([...verified].sort());
		},
	};
}

test("the worker's ack is the runner's, byte for byte: one domain string, one message, both sides", () => {
	assert.equal(INBOX_CUSTOM_TYPE, RUNNER_TYPE);
	assert.equal(inboxAck(KEY, ACK_RUN, ID1), runnerAck(KEY, ACK_RUN, ID1));
	assert.notEqual(inboxAck(KEY, ACK_RUN, ID1), inboxAck(KEY, "pi-job-43", ID1), "the run string is in the MAC");
	assert.notEqual(inboxAck(KEY, ACK_RUN, ID1), inboxAck(OTHER_KEY, ACK_RUN, ID1), "and the key");
});

test("ackVerifies: only the exact MAC, never a malformed input or a throw", () => {
	const good = inboxAck(KEY, ACK_RUN, ID1);
	assert.equal(ackVerifies(KEY, ACK_RUN, ID1, good), true);
	assert.equal(ackVerifies(KEY, ACK_RUN, ID2, good), false, "another message's ack");
	assert.equal(ackVerifies(OTHER_KEY, ACK_RUN, ID1, good), false, "another attempt's key");
	assert.equal(ackVerifies(KEY, ACK_RUN, ID1, good.toUpperCase()), false);
	for (const bad of [undefined, null, "", "zz".repeat(32), good.slice(2), `${good}00`, 7, {}]) assert.equal(ackVerifies(KEY, ACK_RUN, ID1, bad), false);
	assert.equal(ackVerifies(null, ACK_RUN, ID1, good), false, "no key, no verification");
	assert.equal(ackVerifies("", ACK_RUN, ID1, inboxAck("", ACK_RUN, ID1)), false, "an empty key verifies nothing, not even its own MAC (A11)");
	assert.equal(ackVerifies(KEY, "", ID1, good), false);
	assert.equal(ackVerifies(KEY, ACK_RUN, "not-an-id", good), false);
});

test("a good MAC hands the id to the relay once; a bad or missing MAC is ignored, counted and said once", async () => {
	const relay = relaySpy();
	const logs = [];
	const ack = makeSteerAck({ exitKey: KEY, ackRunId: ACK_RUN, relay, jobId: "j", log: (e, f) => logs.push([e, f]) });
	ack.consume(ackLine(ID1, inboxAck(KEY, ACK_RUN, ID1)), 0, { prior: false });
	ack.consume(ackLine(ID1, inboxAck(KEY, ACK_RUN, ID1)), 0, { prior: false }); // the same line read twice
	ack.consume(ackLine(ID2, inboxAck(OTHER_KEY, ACK_RUN, ID2)), 0, { prior: false }); // forged under another key
	ack.consume(ackLine(ID3, undefined), 0, { prior: false }); // the agent's own line, no ack
	ack.consume({ ...ackLine(ID3, inboxAck(KEY, ACK_RUN, ID3)), customType: "something-else" }, 0, { prior: false }); // not ours
	ack.consume({ type: "message", message: { role: "user" } }, 0, {});
	await ack.drain();
	assert.deepEqual(relay.got, [ID1]);
	assert.deepEqual(ack.stats(), { verified: 1, unverified: 2, prior: 0 });
	assert.deepEqual(logs, [["steer_ack_unverified", { jobId: "j", id: ID2 }]], "said once, by id, never the line");
});

test("prior lines never count as deliveries; their ids are the baseline set the relay re-baselines against", async () => {
	const relay = relaySpy();
	const ack = makeSteerAck({ exitKey: KEY, ackRunId: ACK_RUN, relay });
	// An earlier attempt's line: signed with a key this attempt does not have. It must not be verified, only remembered.
	ack.consume(ackLine(ID1, inboxAck(OTHER_KEY, ACK_RUN, ID1)), 0, { prior: true, end: 10 });
	// Even a line that WOULD verify is not a delivery when it is prior (it cannot be this attempt's).
	ack.consume(ackLine(ID2, inboxAck(KEY, ACK_RUN, ID2)), 0, { prior: true, end: 20 });
	ack.consume(ackLine("bad", "x"), 0, { prior: true });
	ack.onBaseline();
	ack.onBaseline();
	await ack.drain();
	assert.deepEqual(relay.got, []);
	assert.deepEqual(relay.baselines, [[ID1, ID2]], "called once, with the prior ids");
	assert.deepEqual(relay.verifiedSets, [[ID2]], "F5: only the prior line that verifies under THIS key is offered as a delivery to mark");
	assert.equal(ack.stats().prior, 2);
});

test("drain waits for a mark in flight, so the settle step reads the delivery", async () => {
	let release;
	const gate = new Promise((r) => (release = r));
	const marked = [];
	const relay = { delivered: async (id) => (await gate, marked.push(id)), afterBaseline() {} };
	const ack = makeSteerAck({ exitKey: KEY, ackRunId: ACK_RUN, relay });
	ack.consume(ackLine(ID1, inboxAck(KEY, ACK_RUN, ID1)), 0, {});
	let drained = false;
	const d = ack.drain().then(() => (drained = true));
	await new Promise((r) => setImmediate(r));
	assert.equal(drained, false);
	release();
	await d;
	assert.deepEqual(marked, [ID1]);
});

// --- the live tail is forced on for a steer job --------------------------------------------------------------------

const T = Date.parse("2026-10-17T10:00:00.000Z");
const line = (o) => `${JSON.stringify({ timestamp: "2026-10-17T10:00:00.000Z", ...o })}\n`;

test("the opener is built for steer alone (every other reader off), and reads nothing for a job that is not armed", () => {
	assert.equal(makeLiveTranscriptOpener({ redis: null, transcripts: false, progress: false }), null, "without steer: no opener, as before");
	const open = makeLiveTranscriptOpener({ redis: null, transcripts: false, progress: false, steer: true });
	assert.equal(typeof open, "function");
	assert.equal(open({ file: "/nowhere/current.jsonl", jobId: "j1", job: {} }), null, "an unarmed job: nothing reads its file");
	const handle = open({ file: "/nowhere/current.jsonl", jobId: "j1", job: { steer: true }, steer: { consume() {}, onBaseline() {} } });
	assert.equal(typeof handle?.start, "function", "an armed job's file is tailed");
	assert.equal(handle.progressSummary(), null, "with no progress sink");
});

test("with every other reader off, an armed job's prior lines feed the baseline, then onBaseline, then a new verified ack reaches the relay", async () => {
	const dir = tempDir("pi-steer-tail-");
	const file = join(dir, "current.jsonl");
	// A restored transcript: a header and an earlier attempt's delivery.
	writeFileSync(file, line({ type: "session", version: 3 }) + line(ackLine(ID1, inboxAck(OTHER_KEY, ACK_RUN, ID1))));
	const relay = relaySpy();
	const ack = makeSteerAck({ exitKey: KEY, ackRunId: ACK_RUN, relay });
	const open = makeLiveTranscriptOpener({ redis: null, transcripts: false, progress: false, steer: true, pollMs: 3_600_000, now: () => T });
	const live = open({ file, jobId: "j1", job: { steer: true }, steer: ack });
	live.start();
	await live.poll();
	assert.deepEqual(relay.baselines, [[ID1]], "the baseline after the first pass, with the prior id");
	appendFileSync(file, line(ackLine(ID2, inboxAck(KEY, ACK_RUN, ID2))) + line(ackLine(ID3, inboxAck(OTHER_KEY, ACK_RUN, ID3))));
	await live.finish("completed");
	await ack.drain();
	assert.deepEqual(relay.got, [ID2], "the final read caught the verified ack; the forged one is ignored");
	assert.deepEqual(live.stats().steer, { verified: 1, unverified: 1, prior: 1 });
});

test("onBaseline fails open: a transcript that is not there yet is a baseline of nothing, reported at the first poll", async () => {
	const dir = tempDir("pi-steer-tail-");
	const relay = relaySpy();
	const ack = makeSteerAck({ exitKey: KEY, ackRunId: ACK_RUN, relay });
	const live = makeLiveTranscriptOpener({ redis: null, transcripts: false, progress: false, steer: true, pollMs: 3_600_000, now: () => T })({ file: join(dir, "absent.jsonl"), jobId: "j2", job: { steer: true }, steer: ack });
	live.start();
	await live.poll();
	assert.deepEqual(relay.baselines, [[]]);
	await live.finish("completed");
});

test("A01: verification compares in constant time (timingSafeEqual), never with ===", () => {
	const src = readFileSync(new URL("../src/steer-ack.mjs", import.meta.url), "utf8");
	const body = src.slice(src.indexOf("export function ackVerifies"), src.indexOf("export function makeSteerAck"));
	assert.match(body, /return timingSafeEqual\(Buffer\.from\(inboxAck\(key, ackRunId, id\), "hex"\), Buffer\.from\(ack, "hex"\)\);/);
	assert.doesNotMatch(body.replace(/\/\/.*$/gm, ""), /===\s*ack\b|ack\s*===/);
});
