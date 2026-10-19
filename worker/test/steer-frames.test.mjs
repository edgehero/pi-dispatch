import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import * as runner from "../../image/runner/src/steer-frames.mjs";
import { encodeFrame, frameMac, keyFrame, STEER_FILE_MAX_BYTES, STEER_FRAME_DOMAIN, STEER_FRAME_MAX_BYTES, STEER_STDIN_BUDGET_BYTES, steerFileJson, steerFrame } from "../src/steer-framing.mjs";

// Issue #686: the stdin frame channel, both halves. The worker's encoder (steer-framing.mjs) and the runner's decoder
// (image/runner/src/steer-frames.mjs) cannot import each other at run time, so this file holds them to one another byte
// for byte, the constants included, and drives the decoder through every break token, oversize and unverified frames.

const KEY = "ab".repeat(32);
const RUN = "pi-job-s1";
const entry = (over = {}) => ({ id: "0123456789abcdef0123456789abcdef", mode: "steer", source: "cli", author: { kind: "operator", by: "cli" }, text: "look at the tests first", ...over });
const bodyOf = (over) => steerFileJson({ entry: entry(over) });

function decode(chunks, { consumed = keyFrame(KEY).length, budget, frameMax, seen = new Set() } = {}) {
	const frames = [];
	const breaks = [];
	const d = runner.createFrameDecoder({ key: KEY, runId: RUN, consumed, ...(budget ? { budget } : {}), ...(frameMax ? { frameMax } : {}), isSeen: (id) => seen.has(id), onFrame: (f) => frames.push(f), onBreak: (r) => breaks.push(r) });
	for (const c of chunks) d.push(c);
	return { d, frames, breaks };
}
const raw = (obj) => encodeFrame(JSON.stringify(obj));

test("the constants are one on both sides: the domain, the budget (the measured 4 MiB less 1 KiB) and the frame cap", () => {
	assert.equal(runner.FRAME_DOMAIN, STEER_FRAME_DOMAIN);
	assert.equal(STEER_FRAME_DOMAIN, "pi-dispatch-inbox-frame");
	assert.equal(runner.STEER_STDIN_BUDGET_BYTES, STEER_STDIN_BUDGET_BYTES);
	assert.equal(STEER_STDIN_BUDGET_BYTES, 4_194_304 - 1024, "under the measured limit, at the largest total the #686 lab saw pass");
	assert.ok(STEER_STDIN_BUDGET_BYTES < 4 * 1024 * 1024, "never at or above the 4 MiB OpenShell 0.1.4 refuses past");
	assert.equal(runner.STEER_FRAME_MAX_BYTES, STEER_FRAME_MAX_BYTES);
	assert.equal(STEER_FRAME_MAX_BYTES, STEER_FILE_MAX_BYTES + 256);
});

test("the frame: a 4-byte big-endian length, then that many bytes of UTF-8 JSON; frame 1 is the key", () => {
	const f = encodeFrame('{"a":"é"}');
	assert.equal(f.readUInt32BE(0), Buffer.byteLength('{"a":"é"}'));
	assert.equal(f.subarray(4).toString("utf8"), '{"a":"é"}');
	const k = keyFrame(KEY);
	assert.equal(k.subarray(4).toString(), `{"t":"key","key":"${KEY}"}`);
	assert.equal(k.length, 4 + 84);
	assert.equal(runner.keyOfFrame(k.subarray(4)), KEY);
	for (const bad of ['{"t":"key","key":"AB"}', `{"t":"key","key":"${KEY}","x":1}`, `{"t":"steer","key":"${KEY}"}`, "[]", "nope"]) assert.equal(runner.keyOfFrame(Buffer.from(bad)), null, bad);
});

test("the MAC is HMAC-SHA256 under the exit key of the domain, the run id, the decimal seq and the body; both sides agree", () => {
	const body = bodyOf();
	const want = createHmac("sha256", KEY).update(`pi-dispatch-inbox-frame\0${RUN}\0${7}\0${body}`, "utf8").digest("hex");
	assert.equal(frameMac(KEY, RUN, 7, body), want);
	assert.equal(runner.frameMac(KEY, RUN, 7, body), want);
	// Domain-separated from the ack and from a different seq or run.
	assert.notEqual(want, createHmac("sha256", KEY).update(`pi-dispatch-inbox-ack\0${RUN}\0${entry().id}`).digest("hex"));
	assert.notEqual(want, frameMac(KEY, RUN, 8, body));
	assert.notEqual(want, frameMac(KEY, "pi-job-s2", 7, body));
});

test("a steer frame round-trips: the runner rebuilds steerFileJson's exact bytes from the frame's fields and verifies it", () => {
	const body = bodyOf({ text: 'quotes " and \\ and   and é and ``` fences' });
	const f = steerFrame({ exitKey: KEY, runId: RUN, seq: 2, body });
	const payload = JSON.parse(f.subarray(4).toString());
	assert.deepEqual(Object.keys(payload), ["t", "seq", "v", "id", "mode", "source", "content", "mac"], "the contract's key order");
	assert.equal(runner.frameBody(payload), body, "byte for byte");
	// Cut anywhere, even inside the prefix and inside a multi-byte character.
	const all = Buffer.concat([f, steerFrame({ exitKey: KEY, runId: RUN, seq: 3, body: bodyOf({ id: "f".repeat(32), mode: "followUp" }) })]);
	const chunks = [all.subarray(0, 2), all.subarray(2, 9), all.subarray(9, 200), all.subarray(200)];
	const { frames, breaks, d } = decode(chunks);
	assert.deepEqual(breaks, []);
	assert.deepEqual(frames.map((x) => [x.seq, x.id, x.frame.mode]), [[2, entry().id, "steer"], [3, "f".repeat(32), "followUp"]]);
	assert.equal(frames[0].body, body);
	assert.equal(d.stats().bytes, keyFrame(KEY).length + all.length, "the budget counts every byte, the key frame's included");
});

test("steerFrame refuses what it cannot frame: a seq below 2, a body steerFileJson would not write, no key or run id", () => {
	const body = bodyOf();
	assert.equal(steerFrame({ exitKey: KEY, runId: RUN, seq: 1, body }), null, "1 is the key frame's");
	assert.equal(steerFrame({ exitKey: KEY, runId: RUN, seq: 2, body: '{"v":1, "id":"x"}' }), null, "not steerFileJson's bytes");
	assert.equal(steerFrame({ exitKey: "", runId: RUN, seq: 2, body }), null);
	assert.equal(steerFrame({ exitKey: KEY, runId: "", seq: 2, body }), null);
	assert.equal(steerFrame({ exitKey: KEY, runId: RUN, seq: 2, body: "nope" }), null);
});

test("an unverified frame is dropped and counted, and reading goes on; a replayed seq or seen id is dropped too", () => {
	const good = steerFrame({ exitKey: KEY, runId: RUN, seq: 2, body: bodyOf() });
	const forged = steerFrame({ exitKey: "cd".repeat(32), runId: RUN, seq: 3, body: bodyOf({ id: "1".repeat(32) }) });
	const otherRun = steerFrame({ exitKey: KEY, runId: "pi-job-other", seq: 4, body: bodyOf({ id: "2".repeat(32) }) });
	const later = steerFrame({ exitKey: KEY, runId: RUN, seq: 5, body: bodyOf({ id: "3".repeat(32) }) });
	const { frames, breaks, d } = decode([good, forged, otherRun, good, later]);
	assert.deepEqual(breaks, [], "an unverified frame never breaks the stream");
	assert.deepEqual(frames.map((f) => f.seq), [2, 5]);
	assert.deepEqual([d.stats().unverified, d.stats().replayed], [2, 1], "the replay of seq 2 is dropped");
	// A relabelled frame (steer to follow-up) no longer matches its MAC.
	const relabel = JSON.parse(good.subarray(4).toString());
	relabel.mode = "followUp";
	assert.equal(decode([raw(relabel)]).d.stats().unverified, 1);
	// An id already seen this attempt (the transcript's seed) is dropped although it verifies.
	const seen = decode([good], { seen: new Set([entry().id]) });
	assert.deepEqual([seen.frames.length, seen.d.stats().replayed], [0, 1]);
});

test("every break token: length, json, shape; each ends reading for the attempt, once", () => {
	const good = steerFrame({ exitKey: KEY, runId: RUN, seq: 2, body: bodyOf() });
	const zero = Buffer.alloc(4);
	const huge = Buffer.alloc(4);
	huge.writeUInt32BE(STEER_FRAME_MAX_BYTES + 1, 0);
	const cases = [
		["a zero length", [zero], "length"],
		["a length past the frame cap", [huge], "length"],
		["a length past what is left of the budget", [good], "length", { budget: keyFrame(KEY).length + good.length - 1 }],
		["a frame cut by EOF", [good.subarray(0, good.length - 3)], "length", { end: true }],
		["bytes that are not UTF-8", [encodeFrame("x").subarray(0, 4), Buffer.from([0xff])], "json"],
		["text that is not JSON", [encodeFrame("{nope")], "json"],
		["an array", [encodeFrame("[1]")], "shape"],
		["a key frame after frame 1, never a re-key", [keyFrame(KEY)], "shape"],
		["an unknown t", [raw({ ...JSON.parse(good.subarray(4).toString()), t: "ack" })], "shape"],
		["an extra key", [raw({ ...JSON.parse(good.subarray(4).toString()), x: 1 })], "shape"],
		["a missing key", [raw((({ mac, ...rest }) => rest)(JSON.parse(good.subarray(4).toString())))], "shape"],
		["seq 1", [raw({ ...JSON.parse(good.subarray(4).toString()), seq: 1 })], "shape"],
		["a mac that is not 64 hex", [raw({ ...JSON.parse(good.subarray(4).toString()), mac: "zz" })], "shape"],
	];
	for (const [name, chunks, reason, opts = {}] of cases) {
		// A frame after the bad one, except where the EOF is the point (it would only complete the cut frame).
		const { d, frames, breaks } = decode(opts.end ? chunks : [...chunks, good], opts);
		if (opts.end) d.end();
		assert.deepEqual(breaks, [reason], name);
		assert.equal(frames.length, 0, `${name}: nothing after a break is read`);
		assert.equal(d.stats().broken, reason);
	}
	assert.deepEqual(runner.BREAK_REASONS, ["length", "json", "shape"]);
	// A clean EOF between frames is no break.
	const clean = decode([good]);
	clean.d.end();
	assert.deepEqual(clean.breaks, []);
});

test("readKeyFrame reads EXACTLY frame 1 and not a byte past it, waiting out EAGAIN; anything else is malformed", () => {
	const after = steerFrame({ exitKey: KEY, runId: RUN, seq: 2, body: bodyOf() });
	const stream = Buffer.concat([keyFrame(KEY), after]);
	let pos = 0;
	let eagain = 1;
	const asked = [];
	const read = (_fd, buf, off, len) => {
		asked.push(len);
		if (eagain-- > 0) throw Object.assign(new Error("again"), { code: "EAGAIN" });
		const n = Math.min(len, 3, stream.length - pos); // short reads, as a pipe gives them
		stream.copy(buf, off, pos, pos + n);
		pos += n;
		return n;
	};
	const got = runner.readKeyFrame({ read, sleep: () => {} });
	assert.equal(got.key, KEY);
	assert.equal(got.problem, null);
	assert.deepEqual(got.bytes, keyFrame(KEY));
	assert.equal(pos, keyFrame(KEY).length, "the next frame is still in the pipe");
	assert.ok(asked.every((n) => n <= 84), "never asks for more than what is left of frame 1");
	const fromBytes = (b) => {
		let p = 0;
		return runner.readKeyFrame({ read: (_fd, buf, off, len) => { const n = Math.min(len, b.length - p); b.copy(buf, off, p, p + n); p += n; return n; }, sleep: () => {} });
	};
	assert.equal(fromBytes(Buffer.from([0, 0])).problem, "malformed", "an early EOF");
	const long = Buffer.alloc(4);
	long.writeUInt32BE(runner.KEY_FRAME_MAX_BYTES + 1, 0);
	assert.equal(fromBytes(Buffer.concat([long, Buffer.alloc(300)])).bytes.length, 4, "a length past a key frame's: nothing more is read");
	assert.equal(fromBytes(encodeFrame('{"t":"key","key":"x"}')).problem, "malformed");
	assert.equal(fromBytes(after).problem, "malformed", "a steer frame first is no key");
	assert.equal(runner.readKeyFrame({ read: () => { throw Object.assign(new Error("io"), { code: "EIO" }); } }).problem, "unreadable");
});

test("isolateStdin closes fd 0 and opens /dev/null onto it; a failed close fails open, the other failures refuse (L5)", () => {
	const calls = [];
	assert.deepEqual(runner.isolateStdin({ close: (fd) => calls.push(["close", fd]), open: (p) => (calls.push(["open", p]), 0) }), { isolated: true, refuse: false });
	assert.deepEqual(calls, [["close", 0], ["open", "/dev/null"]]);
	assert.deepEqual(runner.isolateStdin({ close: () => {}, open: () => 5 }), { isolated: false, refuse: true, code: "fd0-taken" }, "something else took 0: what a child would inherit");
	assert.deepEqual(runner.isolateStdin({ close: () => {}, open: () => { throw Object.assign(new Error(), { code: "EMFILE" }); } }), { isolated: false, refuse: true, code: "EMFILE" }, "fd 0 closed and nothing on it");
	assert.deepEqual(runner.isolateStdin({ close: () => { throw Object.assign(new Error(), { code: "EBADF" }); }, open: () => 0 }), { isolated: false, refuse: false, code: "EBADF" }, "fd 0 left as it was: a socket at EOF, never the frames");
	assert.equal(runner.FRAME_FD, 3);
});

test("frameFdOpen wants the supervisor's SOCKET on fd 3, not any open descriptor: a bare node's epoll fd is no channel (L4)", () => {
	assert.equal(runner.frameFdOpen({ fstat: () => ({ isSocket: () => true }) }), true);
	assert.equal(runner.frameFdOpen({ fstat: () => ({ isSocket: () => false }) }), false, "an eventpoll or a file on 3");
	assert.equal(runner.frameFdOpen({ fstat: () => { throw new Error("EBADF"); } }), false);
});

test("the budget fits EXACTLY on the runner's side: a frame ending at the budget is read, one byte more is a length break (L7)", () => {
	const good = steerFrame({ exitKey: KEY, runId: RUN, seq: 2, body: bodyOf() });
	const key = keyFrame(KEY).length;
	const exact = decode([good], { budget: key + good.length });
	assert.deepEqual([exact.frames.length, exact.breaks], [1, []], "total == budget is within it");
	const over = decode([good], { budget: key + good.length - 1 });
	assert.deepEqual([over.frames.length, over.breaks], [0, ["length"]]);
});
