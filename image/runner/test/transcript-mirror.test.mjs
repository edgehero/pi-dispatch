import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createTranscriptMirror, TRANSCRIPT_DOMAIN, TRANSCRIPT_LINE_MAX_BYTES, TRANSCRIPT_RECORD_MARKER, transcriptMirrorWanted, transcriptRecord, transcriptRecordMac } from "../src/transcript-mirror.mjs";
import { makeStderrTranscript, TRANSCRIPT_RECORD_MARKER as WORKER_MARKER, transcriptRecordMac as workerMac } from "../../../worker/src/stderr-transcript.mjs";
import { LIVE_LINE_MAX_BYTES } from "../../../worker/src/live-transcript.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * Issue #686: the runner's transcript mirror. The worker's demux is imported directly, so the two halves of the record
 * format and its MAC are checked against each other rather than each against a copy of the other's rule.
 */

const KEY = "0123456789abcdef".repeat(4);
const OTHER = "fedcba9876543210".repeat(4);
const RUN = "pi-job-abc";
const noTimers = { setInterval: () => null, clearInterval: () => {} };

function harness(file, opts = {}) {
	const written = [];
	const mirror = createTranscriptMirror({ file, key: KEY, runId: RUN, write: (text) => written.push(text), timers: noTimers, ...opts });
	return { mirror, written };
}

/** What the worker's demux makes of `text` under `key`: every event in order, and the bytes it passed on. */
function verified(text, key = KEY) {
	const events = [];
	const demux = makeStderrTranscript({
		key,
		runId: RUN,
		onBaseline: (size) => events.push(["baseline", size]),
		onLine: (l, end) => events.push(["line", l.toString("utf8"), end]),
		onReset: (size) => events.push(["reset", size]),
		onGap: (n) => events.push(["gap", n]),
	});
	const passed = Buffer.concat([demux.push(Buffer.from(text, "utf8")), demux.end()]).toString("utf8");
	return { events, lines: events.filter((e) => e[0] === "line").map((e) => e[1]), passed, stats: demux.stats() };
}

test("the record format, its marker and its MAC are the worker's, and the line bound is the live tail's", () => {
	assert.equal(TRANSCRIPT_RECORD_MARKER, WORKER_MARKER);
	assert.equal(TRANSCRIPT_DOMAIN, "pi-dispatch-transcript");
	assert.equal(TRANSCRIPT_LINE_MAX_BYTES, LIVE_LINE_MAX_BYTES, "a line past the worker's bound would be skipped there anyway");
	const line = Buffer.from('{"type":"message"}');
	assert.equal(transcriptRecordMac(KEY, RUN, 7, "l", 40, line), workerMac(KEY, RUN, "7", "l", "40", line));
	assert.equal(transcriptRecord(KEY, RUN, 7, "l", 40, line), `\x1epidt 7 l 40 ${transcriptRecordMac(KEY, RUN, 7, "l", 40, line)} ${line.toString("base64")}\n`);
	assert.equal(transcriptRecord(KEY, RUN, 1, "b", 0), `\x1epidt 1 b 0 ${transcriptRecordMac(KEY, RUN, 1, "b", 0, Buffer.alloc(0))} \n`);
});

test("transcriptMirrorWanted: off without PI_TRANSCRIPT, and a named problem for each part missing", () => {
	assert.deepEqual(transcriptMirrorWanted({}, { key: KEY }), { on: false, problem: null }, "unset: nothing runs, so every other venue's stderr is untouched");
	assert.deepEqual(transcriptMirrorWanted({ PI_TRANSCRIPT: "stdout", PI_SESSION_FILE: "/s" }, { key: KEY }), { on: false, problem: "unknown-channel" });
	assert.deepEqual(transcriptMirrorWanted({ PI_TRANSCRIPT: "stderr", PI_SESSION_FILE: "/s" }, { key: null }), { on: false, problem: "no-exit-key" });
	assert.deepEqual(transcriptMirrorWanted({ PI_TRANSCRIPT: "stderr" }, { key: KEY }), { on: false, problem: "no-session-file" });
	assert.deepEqual(transcriptMirrorWanted({ PI_TRANSCRIPT: "stderr", PI_SESSION_FILE: "/s" }, { key: KEY }), { on: true, problem: null });
});

test("the baseline record first (seq 1, the size at start), then each COMPLETE line with its end; a partial line waits", () => {
	const file = join(tempDir("pi-mirror-"), "current.jsonl");
	const { mirror, written } = harness(file);
	mirror.start();
	mirror.drain();
	assert.equal(written.length, 1, "no file yet: the baseline alone (size 0), and no error");
	writeFileSync(file, '{"type":"session"}\n{"type":"message","n":1}\n{"type":"mess');
	mirror.drain();
	appendFileSync(file, 'age","n":2}\n\n');
	mirror.drain();
	const out = verified(written.join(""));
	assert.deepEqual(out.events, [
		["baseline", 0],
		["line", '{"type":"session"}', 19],
		["line", '{"type":"message","n":1}', 44],
		["line", '{"type":"message","n":2}', 69],
	], "the empty line is never sent and takes no seq");
	assert.equal(out.passed, "", "every byte was a record");
	assert.deepEqual(out.stats, { records: 4, unverified: 0, replayed: 0, gaps: 0, oversize: 0 });
});

test("a resumed session: the baseline is the staged file's size, so its earlier lines end at or before it (#709 review)", () => {
	const file = join(tempDir("pi-mirror-"), "current.jsonl");
	const staged = '{"type":"session"}\n{"type":"message","n":1}\n';
	writeFileSync(file, staged);
	const { mirror, written } = harness(file);
	mirror.start();
	appendFileSync(file, '{"type":"message","n":2}\n');
	mirror.drain();
	const out = verified(written.join(""));
	assert.deepEqual(out.events[0], ["baseline", Buffer.byteLength(staged)]);
	assert.deepEqual(out.events.slice(1).map((e) => e[2] <= Buffer.byteLength(staged)), [true, true, false]);
});

test("another key verifies none of the records, and none of their bytes is passed on", () => {
	const file = join(tempDir("pi-mirror-"), "current.jsonl");
	writeFileSync(file, '{"a":1}\n{"b":2}\n');
	const { mirror, written } = harness(file);
	mirror.start();
	mirror.drain();
	const out = verified(written.join(""), OTHER);
	assert.deepEqual(out.lines, []);
	assert.equal(out.stats.unverified, 3);
	assert.equal(out.passed, "");
});

test("a line past the bound is not sent but takes its seq; the next line's own end keeps the positions exact", () => {
	const file = join(tempDir("pi-mirror-"), "current.jsonl");
	writeFileSync(file, `{"a":1}\n${"x".repeat(40)}\n{"b":2}\n`);
	const { mirror, written } = harness(file, { lineMaxBytes: 16 });
	mirror.start();
	mirror.drain();
	const out = verified(written.join(""));
	assert.deepEqual(out.events.slice(1), [["line", '{"a":1}', 8], ["gap", 1], ["line", '{"b":2}', 57]]);
	// An oversize line still being written is skipped once, as it arrives, and its newline ends the skip.
	const file2 = join(tempDir("pi-mirror-"), "current.jsonl");
	writeFileSync(file2, "y".repeat(40));
	const two = harness(file2, { lineMaxBytes: 16 });
	two.mirror.drain();
	appendFileSync(file2, `${"y".repeat(10)}\n{"c":3}\n`);
	two.mirror.drain();
	assert.deepEqual(verified(two.written.join("")).lines, ['{"c":3}']);
	assert.equal(two.mirror.stats().seq, 2);
});

test("a rewritten file (shrunk, a new inode, or its first line changed in place) is read again from 0 behind a reset", () => {
	const dir = tempDir("pi-mirror-");
	const file = join(dir, "current.jsonl");
	writeFileSync(file, '{"a":1}\n{"b":2}\n');
	const { mirror, written } = harness(file);
	mirror.drain();
	writeFileSync(file, '{"a":1}\n');
	mirror.drain();
	writeFileSync(join(dir, "next"), '{"z":9}\n{"y":8}\n');
	renameSync(join(dir, "next"), file);
	mirror.drain();
	// pi's in-place rewrite: the same inode, a larger size, and a first line whose bytes changed.
	writeFileSync(file, '{"q":0}\n{"y":8}\n{"x":7}\n');
	mirror.drain();
	const out = verified(written.join(""));
	assert.deepEqual(out.events.filter((e) => e[0] === "reset"), [["reset", 8], ["reset", 16], ["reset", 24]]);
	assert.deepEqual(out.lines, ['{"a":1}', '{"b":2}', '{"a":1}', '{"z":9}', '{"y":8}', '{"q":0}', '{"y":8}', '{"x":7}']);
	assert.equal(mirror.stats().resets, 3);
});

test("a failed write takes no seq and rewinds to the start of its line, so the next drain sends it: nothing lost without a gap (#709 review)", () => {
	const file = join(tempDir("pi-mirror-"), "current.jsonl");
	writeFileSync(file, '{"a":1}\n{"b":2}\n{"c":3}\n');
	const written = [];
	let failNext = 0;
	const mirror = createTranscriptMirror({
		file,
		key: KEY,
		runId: RUN,
		timers: noTimers,
		write: (text) => {
			if (text.includes(Buffer.from('{"b":2}').toString("base64")) && failNext++ === 0) throw Object.assign(new Error("EAGAIN"), { code: "EPIPE" });
			written.push(text);
		},
	});
	mirror.start();
	mirror.drain();
	assert.equal(mirror.stats().errors, 1);
	mirror.drain();
	const out = verified(written.join(""));
	assert.deepEqual(out.lines, ['{"a":1}', '{"b":2}', '{"c":3}']);
	assert.equal(out.stats.gaps, 0, "the failed record's seq is the retried one's");
});

test("anything but a regular file is refused for good: a symlink, a FIFO (never a hung read)", () => {
	const dir = tempDir("pi-mirror-");
	const target = join(dir, "target");
	writeFileSync(target, '{"secret":1}\n');
	const link = join(dir, "current.jsonl");
	symlinkSync(target, link);
	const logs = [];
	const { mirror, written } = harness(link, { log: (e, f) => logs.push([e, f]) });
	mirror.drain();
	mirror.drain();
	assert.equal(written.length, 0);
	assert.deepEqual(logs, [["transcript_mirror_off", { problem: "not-a-regular-file" }]], "said once");
	assert.equal(mirror.stats().refused, true);
	const fifo = join(dir, "fifo");
	execFileSync("mkfifo", [fifo]);
	const f = harness(fifo);
	f.mirror.drain();
	assert.equal(f.mirror.stats().refused, true);
});

test("drain never throws: a write that fails is counted, and the timer is unref'd and stoppable", () => {
	const file = join(tempDir("pi-mirror-"), "current.jsonl");
	writeFileSync(file, '{"a":1}\n');
	const mirror = createTranscriptMirror({
		file,
		key: KEY,
		runId: RUN,
		write: () => {
			throw Object.assign(new Error("EPIPE"), { code: "EPIPE" });
		},
		timers: noTimers,
	});
	mirror.drain();
	assert.equal(mirror.stats().errors, 1);
	assert.equal(mirror.stats().seq, 0);
	let unrefd = false;
	let cleared = false;
	const timed = createTranscriptMirror({ file, key: KEY, runId: RUN, write: () => {}, pollMs: 250, timers: { setInterval: (fn, ms) => (assert.equal(ms, 250), { unref: () => (unrefd = true) }), clearInterval: () => (cleared = true) } });
	timed.start();
	timed.stop();
	assert.equal(unrefd, true, "the poll never keeps the runner alive");
	assert.equal(cleared, true);
});

test("run-job.mjs: the variable leaves the environment before pi loads, and every exit line is preceded by a final drain", () => {
	const src = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	const block = src.slice(src.indexOf("if (!nestedRunner) {"));
	assert.ok(block.indexOf("delete process.env.PI_TRANSCRIPT;") > -1 && block.indexOf("delete process.env.PI_TRANSCRIPT;") < block.indexOf("main()"), "removed in the job runner's block, before main runs");
	assert.match(block, /write: \(line\) => \{\n\t+transcriptMirror\?\.drain\(\);\n\t+transcriptMirror\?\.stop\(\);\n\t+writeAllSync\(1, line\);/, "the exit writer drains first, on every path it serves");
});

test("an oversize line's skip moves the line start past it: a failed write after it rewinds to its own line only (#709 review 2)", () => {
	const file = join(tempDir("pi-mirror-"), "current.jsonl");
	writeFileSync(file, "y".repeat(40));
	const written = [];
	let failed = false;
	const mirror = createTranscriptMirror({
		file,
		key: KEY,
		runId: RUN,
		lineMaxBytes: 16,
		timers: noTimers,
		write: (text) => {
			if (!failed && text.includes(Buffer.from('{"c":3}').toString("base64"))) {
				failed = true;
				throw Object.assign(new Error("EPIPE"), { code: "EPIPE" });
			}
			written.push(text);
		},
	});
	mirror.start();
	mirror.drain();
	appendFileSync(file, `${"y".repeat(10)}\n{"c":3}\n`);
	mirror.drain();
	mirror.drain();
	const out = verified(written.join(""));
	assert.deepEqual(out.events, [["baseline", 40], ["gap", 1], ["line", '{"c":3}', 59]], "the oversize line is skipped once, never read again");
});

test("the file swapped before the first drain (the runner's quarantine) is a reset to 0, so this run's lines are not prior (#709 review 2)", () => {
	const dir = tempDir("pi-mirror-");
	const file = join(dir, "current.jsonl");
	writeFileSync(file, "not a session\n");
	const { mirror, written } = harness(file);
	mirror.start();
	// session.mjs: rename the unparseable file aside and stage an empty one; pi then writes this run's lines.
	renameSync(file, join(dir, "current.jsonl.invalid-1"));
	writeFileSync(file, '{"type":"session"}\n');
	mirror.drain();
	const out = verified(written.join(""));
	assert.deepEqual(out.events, [["baseline", 14], ["reset", 0], ["line", '{"type":"session"}', 19]]);
});

test("one drain reads at most what the file held when it began: an agent appending without pause cannot hold it (#709 review 2)", () => {
	const file = join(tempDir("pi-mirror-"), "current.jsonl");
	writeFileSync(file, '{"a":1}\n');
	let appended = 0;
	const { mirror, written } = harness(file, {
		write: (text) => {
			written.push(text);
			// Every record written makes the file grow again, as a busy agent would.
			if (appended++ < 1000) appendFileSync(file, '{"more":1}\n');
		},
	});
	mirror.drain();
	assert.equal(written.length, 1, "this drain's own bytes only; the appended ones are the next drain's");
	mirror.drain();
	assert.equal(written.length, 2);
});
