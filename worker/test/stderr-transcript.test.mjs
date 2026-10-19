import assert from "node:assert/strict";
import { test } from "node:test";
import { transcriptRecord } from "../../image/runner/src/transcript-mirror.mjs";
import { makeStderrTranscript, TRANSCRIPT_RECORD_MAX_BYTES, verifyTranscriptRecord } from "../src/stderr-transcript.mjs";

/**
 * Issue #686: the worker's stderr demux. Records are built with the RUNNER's own writer (image/runner/src/
 * transcript-mirror.mjs), so the format the two sides agree on is exercised, never a copy of it.
 */

const KEY = "0123456789abcdef".repeat(4);
const OTHER = "fedcba9876543210".repeat(4);
const RUN = "pi-job-run-1";
const rec = (seq, line, end = 100 * seq, key = KEY, run = RUN) => transcriptRecord(key, run, seq, "l", end, Buffer.from(line, "utf8"));

function feed(chunks, opts = {}) {
	const lines = [];
	const events = [];
	const demux = makeStderrTranscript({
		key: KEY,
		runId: RUN,
		onLine: (l, end) => (lines.push(l.toString("utf8")), events.push(["line", l.toString("utf8"), end])),
		onBaseline: (size) => events.push(["baseline", size]),
		onGap: (n) => events.push(["gap", n]),
		onReset: (size) => events.push(["reset", size]),
		...opts,
	});
	const out = [];
	for (const c of chunks) out.push(demux.push(Buffer.from(c, "latin1")));
	out.push(demux.end());
	return { lines, events, passed: Buffer.concat(out).toString("latin1"), stats: demux.stats() };
}

test("records come out with their ends and every other byte passes through unchanged, cut at EVERY offset (the marker included)", () => {
	const parts = ["runner said this\n", "partial \x1epid not a record\n", "\x1e alone\n", "last line without newline"];
	const plain = parts.join("");
	const stream = `${transcriptRecord(KEY, RUN, 1, "b", 0)}${parts[0]}${rec(2, '{"type":"session"}', 19)}${parts[1]}${parts[2]}${rec(3, '{"n":"ü"}', 31)}${parts[3]}`;
	const want = feed([stream]);
	assert.deepEqual(want.events, [["baseline", 0], ["line", '{"type":"session"}', 19], ["line", '{"n":"ü"}', 31]]);
	assert.equal(want.passed, plain, "byte for byte, the unterminated last line flushed at end()");
	const bytes = Buffer.from(stream, "utf8").toString("latin1");
	for (let a = 0; a <= bytes.length; a++) {
		const got = feed([bytes.slice(0, a), bytes.slice(a)]);
		assert.deepEqual(got.events, want.events, `cut at ${a}`);
		assert.equal(got.passed, plain, `cut at ${a}`);
	}
	const single = feed([...bytes]);
	assert.deepEqual(single.events, want.events);
	assert.equal(single.passed, plain);
});

test("a line that is not a record is passed on as soon as it cannot be one, never held to its newline", () => {
	const demux = makeStderrTranscript({ key: KEY, runId: RUN });
	assert.equal(demux.push(Buffer.from("progress: 1")).toString(), "progress: 1", "the first byte already differs from the marker");
	assert.equal(demux.push(Buffer.from("0%\n\x1epi")).toString(), "0%\n", "the marker's head is held, and only it");
	assert.equal(demux.push(Buffer.from("x\n")).toString(), "\x1epix\n");
});

test("a forged record (another key, another run id, a tampered line, end or MAC) is dropped and counted, never passed on", () => {
	const good = rec(1, '{"a":1}', 8);
	const tampered = good.replace(/ [A-Za-z0-9+/=]+\n$/, ` ${Buffer.from('{"a":2}').toString("base64")}\n`);
	const movedEnd = good.replace(/^(\x1epidt 1 l )8 /, "$19 ");
	const flippedMac = good.replace(/^(\x1epidt 1 l 8 )(.)/, (_, head, c) => `${head}${c === "0" ? "1" : "0"}`);
	const got = feed([rec(1, "x", 2, OTHER), rec(1, "x", 2, KEY, "pi-job-other"), tampered, movedEnd, flippedMac]);
	assert.deepEqual(got.lines, []);
	assert.equal(got.stats.unverified, 5);
	assert.equal(got.passed, "");
	assert.deepEqual(feed([rec(1, "x", 2, OTHER), good]).lines, ['{"a":1}'], "a forgery does not move seq");
});

test("a broken record ends at the first byte no record holds: its own bytes dropped, that byte on passed through (#709 review)", () => {
	const good = rec(1, '{"a":1}', 8);
	// Cut short by another writer inside the MAC: "error" breaks at "r" (no hex), so "e" is lost with the record and the
	// rest of that write, and the record's own tail after the foreign newline, are ordinary output.
	assert.equal(good.slice(25, 40).match(/^[0-9a-f]+$/) !== null, true, "the cut lands inside the MAC");
	const cut = `${good.slice(0, 40)}error: something broke\n${good.slice(40)}`;
	const got = feed([cut, "next line\n"]);
	assert.equal(got.stats.unverified, 1);
	assert.equal(got.passed, `rror: something broke\n${good.slice(40)}next line\n`);
	// Hex inside the MAC is taken into the record up to its first space, as the protocol states.
	const hexy = feed([`${good.slice(0, 30)}deadbeef cafe\n`]);
	assert.equal(hexy.passed, " cafe\n");
	// A record missing its newline: the next line starts at its first byte that is not record-shaped.
	const unterminated = feed([good.slice(0, -1), "[warn] the next line\n"]);
	assert.equal(unterminated.passed, "[warn] the next line\n");
	assert.equal(unterminated.stats.unverified, 1);
	// A record cut before its payload, at a newline: the newline is its own, the next line is whole.
	const early = feed(["\x1epidt 1 l 8\n", "whole\n", "\x1epidt hello\n"]);
	assert.equal(early.passed, "whole\nhello\n");
	assert.equal(early.stats.unverified, 2);
});

test("a record after a foreign write that left no newline is still a record; an RS that does not start the marker passes (#709 review 2)", () => {
	const base = transcriptRecord(KEY, RUN, 1, "b", 0);
	const got = feed([base, "progress 50%", rec(2, "secretline", 10), "\r", rec(3, "second", 20)]);
	assert.deepEqual(got.lines, ["secretline", "second"]);
	assert.equal(got.passed, "progress 50%\r");
	const json = feed(["\x1e{\"a\":1}\n", "x\x1e\x1epidt 9\n"]);
	assert.equal(json.passed, "\x1e{\"a\":1}\nx\x1e");
	// A foreign carriage return mid-payload breaks the record there: the rest of its base64 is ordinary output (stated).
	const r = rec(2, "secretline", 10);
	const at = r.length - 5; // inside the payload, before its newline
	const cr = feed([base, r.slice(0, at), "\r", r.slice(at)]);
	assert.equal(cr.passed, `\r${r.slice(at)}`);
	assert.equal(cr.stats.unverified, 1);
});

test("the grammar's own bounds: a number past 16 digits and a MAC not 64 hex before its space each break the record there", () => {
	assert.equal(feed([`\x1epidt ${"1".repeat(17)}x\n`]).passed, "1x\n", "the 17th digit is the break");
	assert.equal(feed([`\x1epidt 1 l ${"2".repeat(17)} x\n`]).passed, "2 x\n");
	assert.equal(feed(["\x1epidt 1 l 8 abc def\n"]).passed, " def\n", "a space after 3 of 64 hex digits is the break");
});

test("a lost baseline is no missing line: the first line record at seq 2 reports no gap (#709 review 2)", () => {
	const got = feed([rec(2, "a", 2), rec(4, "b", 4)]);
	assert.deepEqual(got.events, [["line", "a", 2], ["gap", 1], ["line", "b", 4]]);
	assert.equal(got.stats.gaps, 1);
});

test("a fault inside the demux carries what the chunk already passed on and what it had not read, never a completed record's bytes", () => {
	let calls = 0;
	const bound = { valueOf: () => (++calls === 1 ? 1e9 : (() => { throw new Error("fault"); })()) };
	const demux = makeStderrTranscript({ key: KEY, runId: RUN, maxRecordBytes: bound });
	const r2 = rec(2, "b", 4);
	let error;
	try {
		demux.push(Buffer.from(`ok\n${rec(1, "a", 2)}mid\n${r2}`, "latin1"));
	} catch (e) {
		error = e;
	}
	assert.equal(error.passed.toString("latin1"), "ok\nmid\n");
	assert.equal(error.rest.toString("latin1"), r2.slice(r2.lastIndexOf(" ") + 1));
	assert.equal(demux.stats().records, 1, "the first record was completed before the fault");
});

test("seq: a replay (equal or lower) is dropped and counted, a gap is allowed, counted and reported first", () => {
	const got = feed([rec(1, "a"), rec(1, "a"), rec(3, "c"), rec(2, "b"), rec(4, "d")]);
	assert.deepEqual(got.lines, ["a", "c", "d"]);
	assert.deepEqual(got.events, [["line", "a", 100], ["gap", 1], ["line", "c", 300], ["line", "d", 400]]);
	assert.equal(got.stats.replayed, 2);
	assert.equal(got.stats.gaps, 1);
});

test("the baseline and the reset carry the runner's sizes, and carry no payload", () => {
	const got = feed([transcriptRecord(KEY, RUN, 1, "b", 412), rec(2, "a", 420), transcriptRecord(KEY, RUN, 3, "r", 9), rec(4, "a", 2)]);
	assert.deepEqual(got.events, [["baseline", 412], ["line", "a", 420], ["reset", 9], ["line", "a", 2]]);
	const withPayload = transcriptRecord(KEY, RUN, 1, "b", 0, Buffer.from("x"));
	assert.equal(feed([withPayload]).stats.unverified, 1, "a baseline with a payload is no record");
});

test("a record past the bound is read to its end and dropped, never held and never passed on; an unterminated one at end() is dropped", () => {
	const got = feed([`\x1epidt 1 l 8 ${"a".repeat(64)} ${"QUJD".repeat(10)}`, "QUJD\nafter\n"], { maxRecordBytes: 40 });
	assert.equal(got.stats.oversize, 1);
	assert.equal(got.passed, "after\n");
	assert.ok(TRANSCRIPT_RECORD_MAX_BYTES >= Math.ceil((1024 * 1024 * 4) / 3) + 100, "a genuine record of the longest mirrored line fits");
	const cut = feed([rec(1, "a").slice(0, 30)]);
	assert.equal(cut.passed, "");
	assert.equal(cut.stats.unverified, 1);
});

test("a throwing callback costs that record only", () => {
	const lines = [];
	const demux = makeStderrTranscript({
		key: KEY,
		runId: RUN,
		onLine: (l) => {
			lines.push(l.toString());
			if (lines.length === 1) throw new Error("consumer fault");
		},
	});
	const out = demux.push(Buffer.from(`${rec(1, "a")}plain\n${rec(2, "b")}`, "latin1"));
	assert.equal(out.toString(), "plain\n");
	assert.deepEqual(lines, ["a", "b"]);
});

test("verifyTranscriptRecord refuses without a key or run id, a non-canonical base64 or number", () => {
	const body = rec(1, "abcd", 5).slice("\x1epidt ".length, -1);
	assert.deepEqual(verifyTranscriptRecord(body, { key: KEY, runId: RUN }), { seq: 1, type: "l", end: 5, payload: Buffer.from("abcd") });
	assert.equal(verifyTranscriptRecord(body, { key: null, runId: RUN }), null);
	assert.equal(verifyTranscriptRecord(body, { key: KEY, runId: "" }), null);
	assert.ok(body.endsWith("="), "\"abcd\" pads, so the unpadded spelling below is a second one");
	assert.equal(verifyTranscriptRecord(body.replace(/=+$/, ""), { key: KEY, runId: RUN }), null, "unpadded base64 is refused");
	const [seq, type, end, mac, payload] = body.split(" ");
	// "YWJjZA==": the "A" before the padding carries four bits no byte uses, so "B" there decodes to the same bytes.
	const sloppy = `${payload.slice(0, -3)}${payload.at(-3) === "A" ? "B" : "A"}==`;
	assert.deepEqual(Buffer.from(sloppy, "base64"), Buffer.from(payload, "base64"), "the same bytes, another spelling");
	assert.equal(verifyTranscriptRecord(`${seq} ${type} ${end} ${mac} ${sloppy}`, { key: KEY, runId: RUN }), null, "only the canonical spelling verifies");
	assert.equal(verifyTranscriptRecord(`0${body}`, { key: KEY, runId: RUN }), null, "a seq with a leading zero is another spelling");
	assert.equal(verifyTranscriptRecord(`${seq} ${type} 0${end} ${mac} ${payload}`, { key: KEY, runId: RUN }), null, "and an end");
});
