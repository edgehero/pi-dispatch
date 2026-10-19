import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { transcriptRecord } from "../../image/runner/src/transcript-mirror.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #686: the stdio transcript in runContainer. Its arming matrix, each skip by name, the env it writes, and the
// stderr demux between the CLI child and the tee: records verified under the attempt's key and pushed into the
// publisher, every other byte passed on unchanged. The records are built with the RUNNER's own writer.

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
const JOB = { kind: "github", provider: "anthropic", model: "m", maxTurns: 5 };
const KEY = "ab".repeat(32);
const NAME = "pi-job-s1";

/**
 * A CLI child that reads the key off its stdin, as the runner does, then writes `stderr(key)` to its stderr in the
 * chunks the test names (cut anywhere, as OpenShell forwards them), then closes.
 */
function stdioChild({ stderr = () => [], stdout = [] } = {}) {
	return () => {
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		let key = null;
		const emit = () => {
			for (const chunk of stdout) child.stdout.emit("data", Buffer.from(chunk));
			for (const chunk of stderr(key)) child.stderr.emit("data", Buffer.from(chunk, "latin1"));
			child.emit("close", 0);
		};
		child.stdin = { on() {}, end: (text) => ((key = String(text).trim()), queueMicrotask(emit)) };
		// Unkeyed, nothing writes the stdin: the child runs at once. Keyed, the key is written in the same tick as the spawn.
		queueMicrotask(() => key === null && emit());
		return child;
	};
}

function harness({ transcript = "stdio", layout = "sandbox", opener = true, child = stdioChild(), keyed = true } = {}) {
	const seen = { env: null, opened: [], pushed: [], ends: [], baselines: [], skipped: [], resets: [], logs: [], output: [], sunk: [] };
	const openLiveTranscript = opener
		? (args) => {
				seen.opened.push(args);
				return { start() {}, finish: async () => {}, setBaseline: (size) => seen.baselines.push(size), push: (l, end) => (seen.pushed.push(l.toString("utf8")), seen.ends.push(end)), skip: (n) => seen.skipped.push(n), reset: (size) => seen.resets.push(size), progressSummary: () => null };
			}
		: null;
	const run = mod.makeRunContainer({
		image: "pi-job:x",
		hostEnv: HOST,
		layout,
		transcript,
		...(openLiveTranscript ? { openLiveTranscript } : {}),
		mintExitKey: () => KEY,
		buildArgs: (opts) => ((seen.env = opts.env), ["sandbox", "exec"]),
		memoryLimitOf: () => null,
		spawnFn: child,
		onOutput: (chunk) => seen.output.push(Buffer.from(chunk).toString("latin1")),
		openJobLog: () => ({ write: (c) => seen.sunk.push(Buffer.from(c).toString("latin1")), close: async () => ({ turns: null, tokens: null, session: null, usage: null, context: null, exitReason: null, exitAuth: "verified" }) }),
		log: (event, fields) => seen.logs.push([event, fields]),
	});
	const jobDir = tempDir("pi-stdio-");
	return {
		seen,
		go: (bag = {}) => run({ job: JOB, prepared: { workspace: `${jobDir}/workspace`, jobDir, live: { hostDir: `${jobDir}/session` } }, name: NAME, signal: new AbortController().signal, jobId: "j-1", exitAuth: keyed, transcriptStderr: true, ...bag }),
	};
}

test("armed: PI_TRANSCRIPT=stderr, the opener on the stdio source, verified lines pushed in order, every other byte passed on (#686)", { skip }, async () => {
	const plain = "openshell: forwarded a line\nanother, with no newline at the end";
	const { seen, go } = harness({
		child: stdioChild({
			stderr: (key) => {
				const stream = `${transcriptRecord(key, NAME, 1, "b", 0)}${plain.slice(0, 28)}${transcriptRecord(key, NAME, 2, "l", 19, Buffer.from('{"type":"session"}'))}${transcriptRecord("cd".repeat(32), NAME, 3, "l", 32, Buffer.from('{"forged":1}'))}${transcriptRecord(key, NAME, 4, "l", 51, Buffer.from('{"type":"message"}'))}${plain.slice(28)}`;
				// 4 KiB reads cut nowhere useful; these cut inside the marker and inside a MAC.
				return [stream.slice(0, 30), stream.slice(30, 31), stream.slice(31, 120), stream.slice(120)];
			},
		}),
	});
	await go();
	assert.equal(seen.env.PI_TRANSCRIPT, "stderr");
	assert.equal(seen.env.PI_EXIT_AUTH, "stdin");
	assert.equal(seen.opened.length, 1);
	assert.equal(seen.opened[0].source, "stdio");
	assert.equal(seen.opened[0].file, null, "the host file is the upload's copy and is never tailed");
	assert.deepEqual(seen.baselines, [0], "the runner's baseline, handed on");
	assert.deepEqual(seen.pushed, ['{"type":"session"}', '{"type":"message"}']);
	assert.deepEqual(seen.ends, [19, 51], "each line with the runner's own end");
	assert.deepEqual(seen.skipped, [1], "the forged record's place is a gap");
	assert.equal(seen.output.join(""), plain, "byte for byte, the unterminated tail flushed at close");
	assert.equal(seen.sunk.join(""), plain, "the job log sees exactly what the terminal sees");
	assert.deepEqual(seen.logs.filter(([e]) => e.startsWith("transcript_record") || e === "live_transcript_skipped"), [
		["transcript_record_unverified", { container: NAME, count: 1 }],
		["transcript_record_dropped", { container: NAME, replayed: 0, gaps: 1, oversize: 0 }],
	], "counts only, never a payload");
	assert.ok(!JSON.stringify(seen.logs).includes("forged"));
});

test("the arming matrix: each missing part is a named skip, writes no PI_TRANSCRIPT and opens no publisher (#686)", { skip }, async () => {
	const cases = [
		{ name: "the image lacks transcriptStderr", h: {}, bag: { transcriptStderr: false }, reason: "no-capability" },
		{ name: "no exit key (the image lacks exitAuth)", h: { keyed: false }, bag: {}, reason: "no-exit-key" },
		{ name: "a copying venue that does not mirror", h: { transcript: "file" }, bag: {}, reason: "venue-copies" },
	];
	for (const c of cases) {
		const { seen, go } = harness(c.h);
		await go(c.bag);
		assert.equal("PI_TRANSCRIPT" in seen.env, false, c.name);
		assert.equal(seen.opened.length, 0, c.name);
		assert.deepEqual(seen.logs.filter(([e]) => e === "live_transcript_skipped"), [["live_transcript_skipped", { container: NAME, reason: c.reason }]], c.name);
	}
	// A status comment then has nothing to read progress from, and says `no-transcript` (it said `progress-off`).
	const { seen, go } = harness({});
	await go({ transcriptStderr: false, job: { ...JOB, statusComment: true } });
	assert.deepEqual(seen.logs.filter(([e]) => e === "status_comment_skipped"), [["status_comment_skipped", { jobId: "j-1", reason: "no-transcript" }]]);
});

test("nothing would read it (no opener): nothing is armed and nothing is said; stderr passes through as it always did (#686)", { skip }, async () => {
	const { seen, go } = harness({ opener: false, child: stdioChild({ stderr: () => ["\x1epidt 1 x y\n", "plain\n"] }) });
	await go();
	assert.equal("PI_TRANSCRIPT" in seen.env, false);
	assert.equal(seen.logs.filter(([e]) => e === "live_transcript_skipped" || e.startsWith("transcript_record")).length, 0);
	assert.equal(seen.output.join(""), "\x1epidt 1 x y\nplain\n", "unarmed, no demux: every byte as the CLI wrote it");
});

test("a binding venue is untouched: the file tail, no PI_TRANSCRIPT, no skip, whatever the image declares (#686)", { skip }, async () => {
	const { seen, go } = harness({ transcript: "file", layout: "mounts" });
	await go();
	assert.equal("PI_TRANSCRIPT" in seen.env, false);
	assert.equal(seen.opened.length, 1);
	assert.equal("source" in seen.opened[0], false, "the opener is called exactly as before");
	assert.match(seen.opened[0].file, /session\/current\.jsonl$/);
	assert.equal(seen.logs.filter(([e]) => e === "live_transcript_skipped").length, 0);
});

test("a reset record reaches the publisher's reset, and a replayed record is dropped (#686)", { skip }, async () => {
	const { seen, go } = harness({
		child: stdioChild({
			stderr: (key) => [transcriptRecord(key, NAME, 1, "l", 2, Buffer.from("a")), transcriptRecord(key, NAME, 1, "l", 2, Buffer.from("a")), transcriptRecord(key, NAME, 2, "r", 2), transcriptRecord(key, NAME, 3, "l", 2, Buffer.from("a"))],
		}),
	});
	await go();
	assert.deepEqual(seen.pushed, ["a", "a"]);
	assert.deepEqual(seen.resets, [2], "with the rewritten file's size");
	assert.deepEqual(seen.logs.filter(([e]) => e === "transcript_record_dropped"), [["transcript_record_dropped", { container: NAME, replayed: 1, gaps: 0, oversize: 0 }]]);
});

test("a demux that throws is ended and not asked again: what it held, then the chunk, then the rest, no byte twice (#709 review)", { skip }, async () => {
	const output = [];
	const logs = [];
	let pushes = 0;
	const makeDemux = () => ({
		push: (chunk) => {
			pushes += 1;
			if (pushes === 1) return Buffer.alloc(0); // holds "\x1epi" as a marker's head
			throw new Error("demux fault");
		},
		end: () => Buffer.from("\x1epi"),
		stats: () => ({ records: 0, unverified: 0, replayed: 0, gaps: 0, oversize: 0 }),
	});
	const jobDir = tempDir("pi-stdio-");
	await mod.makeRunContainer({
		image: "pi-job:x",
		hostEnv: HOST,
		layout: "sandbox",
		transcript: "stdio",
		openLiveTranscript: () => ({ start() {}, finish: async () => {}, push() {}, progressSummary: () => null }),
		mintExitKey: () => KEY,
		buildArgs: () => ["sandbox", "exec"],
		memoryLimitOf: () => null,
		makeDemux,
		spawnFn: stdioChild({ stderr: () => ["\x1epi", "x one\n", "two\n"] }),
		onOutput: (chunk) => output.push(Buffer.from(chunk).toString("latin1")),
		log: (event) => logs.push(event),
	})({ job: JOB, prepared: { workspace: `${jobDir}/workspace`, jobDir }, name: NAME, signal: new AbortController().signal, jobId: "j-1", exitAuth: true, transcriptStderr: true });
	assert.equal(output.join(""), "\x1epix one\ntwo\n");
	assert.equal(pushes, 2, "never asked again after the throw");
	assert.ok(logs.includes("transcript_demux_failed"));
});

test("a demux that throws after completing a record in that chunk: only what it had not read follows, never the record's bytes (#709 review 2)", { skip }, async () => {
	const output = [];
	const makeDemux = () => ({
		push: () => {
			// As the real demux throws: "ok\n" passed, a record completed, then a fault with "tail\n" unread.
			throw Object.assign(new Error("demux fault"), { passed: Buffer.from("ok\n"), rest: Buffer.from("tail\n") });
		},
		end: () => Buffer.alloc(0),
		stats: () => ({ records: 1, unverified: 0, replayed: 0, gaps: 0, oversize: 0 }),
	});
	const jobDir = tempDir("pi-stdio-");
	await mod.makeRunContainer({
		image: "pi-job:x",
		hostEnv: HOST,
		layout: "sandbox",
		transcript: "stdio",
		openLiveTranscript: () => ({ start() {}, finish: async () => {}, push() {}, progressSummary: () => null }),
		mintExitKey: () => KEY,
		buildArgs: () => ["sandbox", "exec"],
		memoryLimitOf: () => null,
		makeDemux,
		spawnFn: stdioChild({ stderr: () => ["ok\n\x1epidt 2 l 3 RECORD-BYTES\ntail\n", "later\n"] }),
		onOutput: (chunk) => output.push(Buffer.from(chunk).toString("latin1")),
	})({ job: JOB, prepared: { workspace: `${jobDir}/workspace`, jobDir }, name: NAME, signal: new AbortController().signal, jobId: "j-1", exitAuth: true, transcriptStderr: true });
	assert.equal(output.join(""), "ok\ntail\nlater\n");
});
