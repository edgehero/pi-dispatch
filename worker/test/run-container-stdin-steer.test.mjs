import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { inboxAck } from "../../image/runner/src/inbox.mjs";
import { createFrameDecoder, keyOfFrame } from "../../image/runner/src/steer-frames.mjs";
import { signExitLine } from "../../image/runner/src/exit-line.mjs";
import { transcriptRecord } from "../../image/runner/src/transcript-mirror.mjs";
import { makeInboxRelay } from "../src/inbox-relay.mjs";
import { makeLiveTranscriptOpener } from "../src/live-transcript.mjs";
import { keyFrame } from "../src/steer-framing.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #686, part 2: a steer job on a venue that COPIES its files, armed through stdin frames. The arming matrix (each
// missing part a named skip, or the old `venue-copies`), the env and the stdin it gets, byte-identity of every other
// attempt, and one run end to end through the real relay, the real publisher and the runner's own frame decoder: the
// message goes down stdin as a frame, and its ack comes back over the stderr transcript.

let mod;
let importError;
try {
	mod = await import("../src/run-container.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`run-container tests are REQUIRED here but pi-ai could not import.\n${importError}`);
}
const skip = mod ? false : `pi-ai not installed (node ${process.version} < 22.19.0); CI runs these`;

const HOST = { ANTHROPIC_API_KEY: "sk-real" };
const KEY = "ab".repeat(32);
const NAME = "pi-job-s1";
const JOB = { kind: "github", repo: "o/r", target: { type: "issue", number: 7 }, provider: "anthropic", model: "m", maxTurns: 5, steer: true };

/** A CLI child recording what reaches its stdin (each write, and whether and with what it was ended); closes on `close`. */
function cliChild(rec, { onWrite = () => {}, stderr = () => [] } = {}) {
	return () => {
		const c = new EventEmitter();
		c.stdout = new EventEmitter();
		c.stderr = new EventEmitter();
		rec.writes = [];
		rec.ended = null;
		const stdin = new EventEmitter();
		stdin.write = (b) => {
			rec.writes.push(Buffer.from(b));
			onWrite(Buffer.from(b), c, rec);
			return true;
		};
		stdin.end = (v) => {
			rec.ended = v === undefined ? true : String(v);
			if (!rec.keyed) queueMicrotask(() => close(c));
		};
		c.stdin = stdin;
		rec.close = () => close(c);
		rec.child = c;
		rec.emitStdout = (text) => c.stdout.emit("data", Buffer.from(text));
		const close = (child) => {
			if (rec.closed) return;
			rec.closed = true;
			setImmediate(() => child.emit("close", 0));
		};
		queueMicrotask(() => {
			for (const chunk of stderr(rec)) c.stderr.emit("data", Buffer.from(chunk));
			if (rec.ended === null && !rec.keyed) close(c);
		});
		return c;
	};
}

function harness({ relayOpener = "fake", opener = true, child, binds = false, layout = "sandbox", transcript = "stdio", stdinExitGraceMs } = {}) {
	const seen = { env: null, opened: [], logs: [], buildOpts: null };
	const openInboxRelay =
		relayOpener === "fake"
			? (args) => (seen.opened.push(args), { start: async () => {}, afterBaseline() {}, delivered: async () => {}, stop: async () => ((seen.stopped = true), {}), attach: (s, o) => (seen.attached = { s, o }), closeStdin: () => (seen.closedStdin = (seen.closedStdin ?? 0) + 1) })
			: relayOpener;
	const openLiveTranscript = opener ? makeLiveTranscriptOpener({ redis: null, transcripts: false, progress: false, steer: true, pollMs: 3_600_000 }) : null;
	const run = mod.makeRunContainer({
		image: "pi-job:x",
		hostEnv: HOST,
		layout,
		transcript,
		...(openLiveTranscript ? { openLiveTranscript } : {}),
		...(openInboxRelay ? { openInboxRelay } : {}),
		mintExitKey: () => KEY,
		...(stdinExitGraceMs !== undefined ? { stdinExitGraceMs } : {}),
		buildArgs: (opts) => ((seen.env = opts.env), (seen.buildOpts = opts), ["sandbox", "exec"]),
		memoryLimitOf: () => null,
		spawnFn: child,
		onOutput: () => {},
		openJobLog: () => ({ write() {}, close: async () => seen.sink ?? { turns: null, tokens: null, session: null, usage: null, context: null, exitReason: null, exitAuth: "verified" } }),
		log: (event, fields) => seen.logs.push([event, fields]),
	});
	const jobDir = tempDir("pi-stdin-steer-");
	return {
		seen,
		go: (bag = {}) => run({ job: JOB, prepared: { workspace: `${jobDir}/workspace`, jobDir, live: { hostDir: `${jobDir}/session` } }, name: NAME, signal: new AbortController().signal, jobId: "j-1", exitAuth: true, transcriptStderr: true, steerStdin: true, binds, ...bag }),
	};
}
const skipsOf = (seen) => seen.logs.filter(([e]) => e === "steer_skipped").map(([, f]) => f.reason);

test("ARMED on a copying venue: PI_EXIT_AUTH=stdin-frames beside PI_STEER=1, frame 1 written and the pipe left OPEN for the relay, no /inbox (#686)", { skip }, async () => {
	const rec = { keyed: true };
	const { seen, go } = harness({ child: cliChild(rec, { stderr: () => [] }) });
	const running = go();
	await new Promise((r) => setImmediate(r));
	rec.close();
	const result = await running;
	assert.equal(seen.env.PI_EXIT_AUTH, "stdin-frames");
	assert.equal(seen.env.PI_STEER, "1");
	assert.equal(seen.env.PI_TRANSCRIPT, "stderr", "the acks come back over the stderr transcript");
	assert.equal(seen.buildOpts.steerInboxDir, undefined, "no directory: the messages go down the pipe");
	assert.deepEqual(rec.writes[0], keyFrame(KEY), "frame 1 is the key, at the spawn");
	assert.equal(keyOfFrame(rec.writes[0].subarray(4)), KEY);
	assert.equal(rec.ended, null, "the pipe is not closed after the key: the relay owns it now");
	assert.equal(seen.opened.length, 1);
	assert.deepEqual(seen.opened[0].frames, { exitKey: KEY, macRunId: NAME }, "MAC'd under this attempt's key and the container's PI_JOB_ID");
	assert.equal(seen.opened[0].inboxDir, null);
	assert.equal(seen.opened[0].runId, "j-1");
	assert.equal(seen.attached.s !== undefined && seen.attached.o.written, keyFrame(KEY).length, "the key frame counts against the budget");
	assert.deepEqual(skipsOf(seen), []);
	assert.equal("steerSkipped" in result, false);
});

test("the arming matrix: each missing part is the named skip, and the attempt is byte-identical to an unsteered one (#686)", { skip }, async () => {
	const cases = [
		{ name: "the image lacks steerStdin", h: {}, bag: { steerStdin: false }, reason: "venue-copies" },
		{ name: "no exit key (no exitAuth)", h: {}, bag: { exitAuth: false }, reason: "no-exit-key" },
		{ name: "the stdio transcript is not armed (no transcriptStderr)", h: {}, bag: { transcriptStderr: false }, reason: "no-transcript" },
		{ name: "a copying venue that does not mirror", h: { transcript: "file" }, bag: {}, reason: "no-transcript" },
		{ name: "no relay opener (no Valkey)", h: { relayOpener: null }, bag: {}, reason: "no-transcript" },
		{ name: "no live transcript opener", h: { opener: false }, bag: {}, reason: "no-transcript" },
		{ name: "no job id", h: {}, bag: { jobId: null }, reason: "no-transcript" },
	];
	for (const c of cases) {
		const rec = {};
		const { seen, go } = harness({ ...c.h, child: cliChild(rec) });
		const result = await go(c.bag);
		assert.deepEqual(skipsOf(seen), [c.reason], c.name);
		assert.equal(result.steerSkipped, c.reason, c.name);
		assert.equal(seen.env.PI_STEER, undefined, c.name);
		assert.notEqual(seen.env.PI_EXIT_AUTH, "stdin-frames", c.name);
		if (c.bag.exitAuth !== false) {
			assert.equal(seen.env.PI_EXIT_AUTH, "stdin", `${c.name}: the key channel of every other attempt`);
			assert.equal(rec.ended, `${KEY}\n`, `${c.name}: 64 hex, a newline, the pipe closed at once`);
			assert.equal(rec.writes.length, 0, c.name);
		}
		assert.equal(seen.opened.length, 0, c.name);
	}
});

test("byte-identity: a non-steer job on a stdin-steer image, and a bind venue whatever the image declares, get the key and EOF as before (#686)", { skip }, async () => {
	// Not asked: nothing reads steerStdin.
	const plain = {};
	const a = harness({ child: cliChild(plain) });
	await a.go({ job: { ...JOB, steer: undefined } });
	const plainNoCap = {};
	const b = harness({ child: cliChild(plainNoCap) });
	await b.go({ job: { ...JOB, steer: undefined }, steerStdin: false });
	assert.deepEqual(a.seen.env, b.seen.env, "the env is byte-identical with or without the capability");
	assert.equal(a.seen.env.PI_EXIT_AUTH, "stdin");
	assert.equal(plain.ended, `${KEY}\n`);
	assert.equal(plain.writes.length, 0);
	// A bind venue: the mount, never the frames.
	const bound = {};
	const c = harness({ child: cliChild(bound), binds: true, layout: "mounts", transcript: "file" });
	await c.go();
	assert.equal(c.seen.env.PI_EXIT_AUTH, "stdin");
	assert.equal(c.seen.env.PI_STEER, "1");
	assert.match(String(c.seen.buildOpts.steerInboxDir), /\.inbox$/, "the read-only /inbox mount");
	assert.equal("frames" in c.seen.opened[0], false, "the relay is opened with exactly the arguments it always was");
	assert.equal(bound.ended, `${KEY}\n`);
});

test("end to end: the real relay writes the message as a frame after the key, the runner's decoder verifies it, and its ack over stderr marks it delivered (#686)", { skip }, async () => {
	const id = "0123456789abcdef0123456789abcdef";
	const state = { [id]: "queued" };
	const entries = [{ v: 1, id, mode: "steer", source: "cli", author: { kind: "operator", by: "cli" }, text: "look at the README first", at: 1 }];
	const calls = [];
	const inbox = {
		resetClosedInbox: async () => ({ reset: false }),
		registerLive: async () => ({ ok: true }),
		refreshLive: async () => ({ ok: true }),
		holdLive: async () => ({ held: true }),
		readInbox: async () => ({ entries: entries.map((e) => ({ ...e })), state: { ...state }, closed: false }),
		markState: async ({ id: mid, from, to }) => {
			calls.push([mid, from.join("|"), to]);
			if (!from.includes(state[mid])) return { ok: false, prior: state[mid] };
			const prior = state[mid];
			state[mid] = to;
			return { ok: true, prior };
		},
	};
	const relayLogs = [];
	const openInboxRelay = (args) => makeInboxRelay({ redis: {}, host: "h1", now: () => 1, log: (e, f) => relayLogs.push([e, f]), pollMs: 3_600_000, inbox, ...args });
	const rec = { keyed: true };
	const got = [];
	// The CLI child plays the runner: frame 1 gives it the key, the decoder (the runner's own) the messages, and for each
	// one it writes the session line pi would persist, as a signed stderr record, then exits.
	let decoder = null;
	let key = null;
	const child = cliChild(rec, {
		stderr: () => [transcriptRecord(KEY, NAME, 1, "b", 0)],
		onWrite: (buf, c) => {
			if (key === null) {
				key = keyOfFrame(buf.subarray(4));
				decoder = createFrameDecoder({ key, runId: NAME, consumed: buf.length, onFrame: (f) => got.push(f) });
				return;
			}
			decoder.push(buf);
			const f = got.at(-1);
			if (!f) return;
			const line = Buffer.from(JSON.stringify({ type: "custom_message", customType: "pi-dispatch-inbox", details: { id: f.id, mode: "steer", source: "cli", ack: inboxAck(key, NAME, f.id) } }));
			c.stderr.emit("data", Buffer.from(transcriptRecord(KEY, NAME, 2, "l", line.length + 1, line)));
			setTimeout(() => rec.close(), 20);
		},
	});
	const { seen, go } = harness({ relayOpener: openInboxRelay, child });
	seen.sink = { turns: 1, tokens: null, session: null, usage: null, context: null, exitReason: null, exitAuth: "verified", steer: { delivered: 1, pending: 0, deliveredIds: [id] } };
	const result = await go();
	assert.equal(got.length, 1, "the runner's decoder accepted exactly one frame");
	assert.equal(got[0].seq, 2);
	assert.equal(got[0].id, id);
	assert.match(got[0].frame.content, /look at the README first/);
	assert.equal(state[id], "delivered", "the ack that came back over stderr verified and marked it");
	assert.deepEqual(calls[0], [id, "queued", "written"], "marked before the write");
	assert.deepEqual(result.steer, { delivered: 1, pending: 0 });
	assert.equal(rec.ended, true, "the relay's stop closed the pipe");
	assert.deepEqual(relayLogs.filter(([e]) => e === "steer_relay_fault"), []);
	assert.ok(!JSON.stringify([...seen.logs, ...relayLogs]).includes("README"), "never the text in a log");
});

test("the baseline: a fresh job's empty upload releases the relay AT the spawn; a staged transcript waits for the runner's baseline record (#686)", { skip }, async () => {
	for (const [name, bag, atSpawn] of [
		["a fresh job", {}, true],
		["a resume job (a staged session)", { session: { key: "k", hostDir: "/x", resume: true } }, false],
	]) {
		const rec = { keyed: true };
		const order = [];
		const relayOpener = () => ({ start: async () => {}, afterBaseline: () => order.push("baseline"), delivered: async () => {}, stop: async () => ({}), attach: () => order.push("attach") });
		const { go } = harness({ relayOpener, child: cliChild(rec) });
		const jobDir = tempDir("pi-stdin-steer-b-");
		const running = go({ prepared: { workspace: `${jobDir}/workspace`, jobDir, live: { hostDir: `${jobDir}/session` }, ...bag } });
		await new Promise((r) => setImmediate(r));
		assert.deepEqual(order, atSpawn ? ["attach", "baseline"] : ["attach"], name);
		rec.close();
		await running;
	}
});

test("M1: the pipe is ended as soon as a VERIFIED exit line is on stdout; an exit-shaped line that does not verify ends it after the grace (#686)", { skip }, async () => {
	for (const [name, line, grace] of [
		["a verified exit line", signExitLine('{"event":"exit","jobId":"pi-job-s1","code":0}', KEY), 60_000],
		["an unverified one (a forgery, or the supervisor's unkeyed line)", '{"event":"exit","jobId":"pi-job-s1","code":0}', 20],
	]) {
		const rec = { keyed: true };
		const { seen, go } = harness({ child: cliChild(rec), stdinExitGraceMs: grace });
		const running = go();
		await new Promise((r) => setImmediate(r));
		rec.emitStdout(`noise\n${line.slice(0, 10)}`);
		rec.emitStdout(`${line.slice(10)}\n`);
		if (grace > 1000) assert.equal(seen.closedStdin, 1, `${name}: at once, before the exec closed`);
		else {
			assert.equal(seen.closedStdin, undefined, `${name}: not at once`);
			await new Promise((r) => setTimeout(r, 60));
			assert.equal(seen.closedStdin, 1, `${name}: after the grace`);
		}
		assert.equal(seen.stopped, undefined, `${name}: the relay itself runs on until the exec closes`);
		rec.close();
		await running;
	}
});

test("M1: stdout that carries no exit line never ends the pipe, whatever the grace; each close is logged once by its reason (#686)", { skip }, async () => {
	const rec = { keyed: true };
	const { seen, go } = harness({ child: cliChild(rec), stdinExitGraceMs: 20 });
	const running = go();
	await new Promise((r) => setImmediate(r));
	rec.emitStdout('{"event":"model_call"}\nplain output\n{"event":"exi');
	rec.emitStdout('t_soon"}\n{"exit":1}\n');
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(seen.closedStdin, undefined, "no exit-shaped line, no close");
	assert.equal(seen.logs.some(([e]) => e === "steer_stdin_closed"), false);
	rec.close();
	await running;
	// The reasons, once each: a verified line, then a second one, log one close.
	for (const [line, reason, grace] of [
		[signExitLine('{"event":"exit","jobId":"pi-job-s1","code":0}', KEY), "exit-verified", 60_000],
		['{"event":"exit","jobId":"pi-job-s1","code":0}', "exit-unverified", 10],
	]) {
		const r2 = { keyed: true };
		const h = harness({ child: cliChild(r2), stdinExitGraceMs: grace });
		const run2 = h.go();
		await new Promise((r) => setImmediate(r));
		r2.emitStdout(`${line}\n${line}\n`);
		await new Promise((r) => setTimeout(r, 40));
		assert.deepEqual(h.seen.logs.filter(([e]) => e === "steer_stdin_closed"), [["steer_stdin_closed", { container: NAME, reason }]], reason);
		assert.equal(h.seen.closedStdin, 1, reason);
		r2.close();
		await run2;
	}
});
