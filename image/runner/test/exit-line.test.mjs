import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createExitWriter, drainStdin, EXIT_LINE_MAX_BYTES, EXIT_TAIL_BYTES, EXIT_TERMINATED, exitLineJson, exitLineMac, exitLineMaxBytes, readExitKey, signExitLine, SUPERVISOR_LINE_BYTES, writeAllSync } from "../src/exit-line.mjs";
import { capExitMessage } from "../src/outcome.mjs";
import { deathFields, BY_SUPERVISOR } from "../src/supervise.mjs";
import { authenticExitLines, makeLogSink, RESOURCE_KEYS, RUNNER_POLICY_REASONS, TOKEN_KEYS } from "../../../worker/src/run-history.mjs";

/**
 * Issue #545: the runner's signed exit line, its key off stdin, and the SIGTERM path that writes a real line on a stop.
 * The worker's half (`authenticExitLines`, the sink) is imported directly, so the two sides of the MAC are checked
 * against each other rather than each against a copy of the other's rule.
 */

const KEY = "0123456789abcdef".repeat(4);

test("readExitKey: no PI_EXIT_AUTH reads nothing and is no problem (a worker or an image run that predates the channel)", () => {
	let drained = false;
	assert.deepEqual(readExitKey({}, { drain: () => ((drained = true), KEY) }), { key: null, problem: null });
	assert.equal(drained, false, "stdin is never touched without the variable, so a runner never blocks on a stdin no one writes");
});

test("readExitKey: PI_EXIT_AUTH=stdin takes the drained key, trimmed", () => {
	assert.deepEqual(readExitKey({ PI_EXIT_AUTH: "stdin" }, { drain: () => `${KEY}\n` }), { key: KEY, problem: null });
});

test("readExitKey: a malformed key, an unknown channel and an unreadable stdin are problems, never keys", () => {
	assert.deepEqual(readExitKey({ PI_EXIT_AUTH: "stdin" }, { drain: () => "" }), { key: null, problem: "malformed" });
	assert.deepEqual(readExitKey({ PI_EXIT_AUTH: "stdin" }, { drain: () => KEY.toUpperCase() }), { key: null, problem: "malformed" });
	assert.deepEqual(readExitKey({ PI_EXIT_AUTH: "stdin" }, { drain: () => `${KEY}0` }), { key: null, problem: "malformed" });
	assert.deepEqual(readExitKey({ PI_EXIT_AUTH: "file" }, { drain: () => KEY }), { key: null, problem: "unknown-channel" });
	assert.deepEqual(
		readExitKey({ PI_EXIT_AUTH: "stdin" }, {
			drain: () => {
				throw Object.assign(new Error("bad fd"), { code: "EBADF" });
			},
		}),
		{ key: null, problem: "unreadable" },
	);
});

test("drainStdin reads to EOF (so nothing stays in the pipe), keeps at most `max` bytes, and waits out EAGAIN", () => {
	const chunks = [Buffer.from("ab"), "EAGAIN", Buffer.from("cdef"), Buffer.from("gh")];
	let slept = 0;
	const read = (fd, buf) => {
		const next = chunks.shift();
		if (next === undefined) return 0;
		if (next === "EAGAIN") throw Object.assign(new Error("try again"), { code: "EAGAIN" });
		next.copy(buf);
		return next.length;
	};
	assert.equal(drainStdin({ read, max: 5, sleep: () => slept++ }), "abcde");
	assert.equal(chunks.length, 0, "every chunk was read, the ones past the cap included");
	assert.equal(slept, 1);
});

test("signExitLine puts an HMAC-SHA256 of the unsigned bytes last, keyed by the key's own characters", () => {
	const body = JSON.stringify({ event: "exit", jobId: "j", code: 0, tokens: { total: 1 } });
	const signed = signExitLine(body, KEY);
	const mac = createHmac("sha256", KEY).update(body).digest("hex");
	assert.equal(signed, `${body.slice(0, -1)},"auth":"${mac}"}`);
	assert.equal(exitLineMac(KEY, body), mac);
	assert.deepEqual(JSON.parse(signed), { ...JSON.parse(body), auth: mac });
});

test("the worker accepts the runner's signed line and nothing else: unsigned, wrong key, edited, or glued", () => {
	const body = JSON.stringify({ event: "exit", jobId: "j", code: 0, reason: "completed", tokens: { total: 5, cost: 0.5 } });
	const signed = signExitLine(body, KEY);
	assert.equal(authenticExitLines(`noise\n${signed}\n`, KEY), body);
	assert.equal(authenticExitLines(`${body}\n`, KEY), "", "an unsigned line");
	assert.equal(authenticExitLines(`${signExitLine(body, "f".repeat(64))}\n`, KEY), "", "a line signed with a key the tool made up");
	assert.equal(authenticExitLines(`${signed.replace('"total":5', '"total":0')}\n`, KEY), "", "an edited line");
	assert.equal(authenticExitLines(`partial write{"event":"exit","code":0${signed}\n`, KEY), body, "a genuine line glued to stray bytes, an anchor among them");
	assert.equal(authenticExitLines(`${signed}\n`, null), "", "no key, nothing authenticated");
	assert.equal(authenticExitLines(undefined, KEY), "");
});

test("createExitWriter writes one line only, signed when there is a key", () => {
	const out = [];
	const writer = createExitWriter({ key: KEY, jobId: "j", write: (s) => out.push(s), exit: () => assert.fail("no exit") });
	assert.equal(writer.writeExit({ code: 2, reason: "cost-cap" }), true);
	assert.equal(writer.writeExit({ code: 0, reason: "completed" }), false, "a second line is refused");
	assert.equal(out.length, 1);
	assert.equal(authenticExitLines(out[0], KEY), JSON.stringify({ event: "exit", jobId: "j", code: 2, reason: "cost-cap" }));
	const plain = [];
	createExitWriter({ key: null, jobId: "j", write: (s) => plain.push(s), exit: () => {} }).writeExit({ code: 0 });
	assert.equal(plain[0], `\n${JSON.stringify({ event: "exit", jobId: "j", code: 0 })}\n`, "no key: the unsigned line, byte for byte as before");
});

test("terminate writes a terminated line with the caller's counts and exits 143; after a line, it exits with that line's code", () => {
	const out = [];
	const exits = [];
	const writer = createExitWriter({ key: KEY, jobId: "j", write: (s) => out.push(s), exit: (c) => exits.push(c) });
	writer.terminate({ turns: 3, tokens: { total: 7 } });
	assert.deepEqual(exits, [EXIT_TERMINATED]);
	assert.deepEqual(JSON.parse(authenticExitLines(out.join(""), KEY)), { event: "exit", jobId: "j", code: 143, reason: "terminated", turns: 3, tokens: { total: 7 } });

	const out2 = [];
	const exits2 = [];
	const done = createExitWriter({ key: KEY, jobId: "j", write: (s) => out2.push(s), exit: (c) => exits2.push(c) });
	done.writeExit({ code: 0, reason: "completed" });
	done.terminate({ turns: 9 });
	assert.equal(out2.length, 1, "no second line after the decided one");
	assert.deepEqual(exits2, [0], "the process exits with the code its line said, so the container's code and the line agree");
});

test("the writer reads `resources` at write time, last of the fields and signed, and omits it when nothing was read (issue #596)", () => {
	const order = [];
	const used = { memPeak: 5, swapPeak: 0, oomKills: 0, memSomeUsec: null, memFullUsec: null, cpuUsec: 9, throttledUsec: 0, throttled: 0, pidsPeak: 3 };
	const out = [];
	const writer = createExitWriter({
		key: KEY,
		jobId: "j",
		write: (s) => {
			order.push("write");
			out.push(s);
		},
		exit: () => {},
		resources: () => {
			order.push("read");
			return used;
		},
	});
	assert.deepEqual(order, [], "not read when the writer is made: a peak read early would miss what the job did after");
	writer.writeExit({ code: 0, reason: "completed", turns: 1 });
	assert.deepEqual(order, ["read", "write"], "read once, just before the line is written");
	const body = authenticExitLines(out[0], KEY);
	assert.notEqual(body, "", "the block is inside the signed bytes");
	assert.deepEqual(Object.keys(JSON.parse(body)), ["event", "jobId", "code", "reason", "turns", "resources"], "last of the fields");
	assert.deepEqual(JSON.parse(body).resources, used);
	// The SIGTERM path goes through the same writer, so it carries the block too.
	const term = [];
	createExitWriter({ key: KEY, jobId: "j", write: (s) => term.push(s), exit: () => {}, resources: () => used }).terminate({ turns: 2 });
	assert.deepEqual(JSON.parse(authenticExitLines(term.join(""), KEY)).resources, used);
	// Nothing read, or a reader that throws: no key at all, so the line is byte-identical to one from before the field.
	for (const resources of [() => null, () => undefined, () => 7, () => { throw new Error("boom"); }]) {
		const plain = [];
		createExitWriter({ key: null, jobId: "j", write: (s) => plain.push(s), exit: () => {}, resources }).writeExit({ code: 0 });
		assert.equal(plain[0], `\n${JSON.stringify({ event: "exit", jobId: "j", code: 0 })}\n`);
	}
});

test("run-job.mjs hands the writer the cgroup reader, so every exit-line path carries `resources` (issue #596)", () => {
	const src = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	assert.match(src, /\n\t\tresources: \(\) => readCgroupUsage\(\),\n\t\}\);/);
	assert.match(src, /import \{ readCgroupUsage \} from "\.\/src\/cgroup-usage\.mjs";/);
});

test("run-job.mjs reads the key and installs the SIGTERM handler before main, and writes every exit line through the writer", () => {
	const src = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	const handler = src.indexOf('process.on("SIGTERM", () => {');
	// The meter's teardown (issue #500 part E's review) runs first, caught, so the line carries the final fold and is
	// written whatever the teardown did.
	assert.match(src, /process\.on\("SIGTERM", \(\) => \{\n\t\ttry \{\n\t\t\tfinishMeter\(\);\n\t\t\} catch \{\n[^}]*\}\n\t\texitWriter\.terminate\(\{ \.\.\.liveExitFields\(\), \.\.\.meteredExitFields\(\) \}\);\n\t\}\);/);
	const keyRead = src.indexOf("\texitKey = readExitKey(process.env);");
	const mainCall = src.indexOf("\n\tmain()");
	assert.ok(keyRead !== -1 && handler !== -1 && mainCall !== -1, "the key read, the handler and the main call are all there");
	assert.ok(keyRead < handler && handler < mainCall, "the key is read and the handler installed before main runs");
	assert.equal((src.match(/log\("exit"/g) ?? []).length, 0, "no exit line bypasses the writer, so none goes out unsigned");
	assert.match(src, /liveExitFields = \(\) => \(\{ turns: budget\.state\.turns, retryTurns: budget\.state\.retryTurns, session: /);
});

test("image entrypoint runs the runner under the exec-only node the Dockerfile installs (issue #545)", () => {
	const entrypoint = readFileSync(new URL("../../entrypoint.sh", import.meta.url), "utf8");
	const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
	// Issue #596: the entrypoint starts the supervisor, which holds the key too, under the same exec-only node and with
	// --disable-sigusr1, and it starts the runner the same way in turn (src/supervise.mjs RUNNER_NODE, RUNNER_NODE_FLAGS
	// and RUNNER_SCRIPT, pinned in supervise.test.mjs).
	// Issue #730: the entrypoint picks the node from PI_RUNNER_OBSERVABLE, defaulting to the exec-only one; the supervisor
	// (supervise.mjs runnerNodeFor) picks the runner's from the same variable.
	assert.match(entrypoint, /\n""\) node=\/opt\/pi-dispatch\/runner-node ;;\n/);
	assert.match(entrypoint, /\n1\) node=\/opt\/pi-dispatch\/runner-observable ;;\n/);
	assert.match(entrypoint, /\nexec "\$node" --disable-sigusr1 \/app\/image\/runner\/supervise\.mjs\n/);
	assert.match(dockerfile, /\nRUN install -o root -g root -m 0711 \/usr\/local\/bin\/node \/opt\/pi-dispatch\/runner-node\n/);
	assert.match(dockerfile, /\nRUN install -o root -g root -m 0755 \/usr\/local\/bin\/node \/opt\/pi-dispatch\/runner-observable\n/, "issue #730: the readable copy for the OpenShell venues");
	assert.ok(dockerfile.indexOf("runner-node") < dockerfile.indexOf("chmod -R a-w /opt/pi-dispatch"), "installed before /opt/pi-dispatch is made read-only");
});

/** Run the harness: key on stdin, wait for its tool child to forge, then stop it the way `docker stop` does. */
function runHarness({ key, bigMessage = 0 }) {
	return new Promise((resolve, reject) => {
		const env = { ...process.env };
		delete env.PI_EXIT_AUTH;
		if (key) env.PI_EXIT_AUTH = "stdin";
		if (bigMessage > 0) env.HARNESS_BIG_MESSAGE = String(bigMessage);
		const child = spawn(process.execPath, [new URL("./fixtures/exit-harness.mjs", import.meta.url).pathname], { stdio: ["pipe", "pipe", "pipe"], env });
		child.stdin.end(key ? `${key}\n` : "");
		let out = "";
		let stopped = false;
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`harness never became ready: ${out}`));
		}, 15_000);
		child.stdout.on("data", (d) => {
			out += d;
			if (!stopped && out.includes('"event":"ready"')) {
				stopped = true;
				child.kill("SIGTERM");
			}
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			resolve({ out, code, signal });
		});
	});
}

test("a tool child's forged exit lines are never read, and SIGTERM still yields the runner's real, signed line (issue #545)", async () => {
	const { out, code, signal } = await runHarness({ key: KEY });
	assert.equal(signal, null, "the handler ran: the process exited, it was not killed by the signal");
	assert.equal(code, 143);
	assert.equal((out.match(/"event":"exit"/g) ?? []).length, 3, "two forged lines from the tool, then the runner's own");
	const sink = makeLogSink({ logsDir: "/nonexistent", enabled: false, fs: { mkdirSync() {} } })("harness-1", { exitKey: KEY });
	sink.write(out);
	const read = await sink.close();
	assert.equal(read.exitAuth, "verified");
	assert.equal(read.exitLineCode, 143, "the line read is the runner's, whose code matches the process's");
	assert.equal(read.tokens.total, 1000, "the meter's real count, not the forged zero");
	assert.equal(read.tokens.cost, 1.8);
	assert.equal(read.turns, 2);
});

test("old-image compatibility: without a key the harness writes an unsigned line, and a keyless read takes the last line as before", async () => {
	const { out, code } = await runHarness({ key: null });
	assert.equal(code, 143);
	const own = out.split("\n").find((line) => line.includes('"input":900'));
	assert.ok(own && !own.includes('"auth"'), "the runner's own line is unsigned when no key was handed over");
	const sink = makeLogSink({ logsDir: "/nonexistent", enabled: false, fs: { mkdirSync() {} } })("harness-1");
	sink.write(out);
	const read = await sink.close();
	assert.equal("exitAuth" in read, false, "no key issued, so nothing is verified and nothing is required");
	assert.equal(read.tokens.total, 1000, "with the SIGTERM handler the runner's line is last even unsigned");
});

test("writeAllSync writes every byte through short writes and a full pipe's EAGAIN", () => {
	const got = [];
	let calls = 0;
	const write = (fd, buf, off, len) => {
		calls++;
		if (calls === 2) throw Object.assign(new Error("full"), { code: "EAGAIN" });
		const n = Math.min(len, 3);
		got.push(buf.subarray(off, off + n).toString());
		return n;
	};
	let slept = 0;
	writeAllSync(1, "abcdefgh", { write, sleep: () => slept++ });
	assert.equal(got.join(""), "abcdefgh");
	assert.equal(slept, 1);
	assert.throws(() => writeAllSync(1, "x", { write: () => { throw Object.assign(new Error("gone"), { code: "EPIPE" }); } }), /gone/);
});

test("a large exit line written on SIGTERM and exited on at once arrives whole and verified (PR #555's review)", async () => {
	const size = 1024 * 1024;
	const { out, code } = await runHarness({ key: KEY, bigMessage: size });
	assert.equal(code, 143);
	const verified = authenticExitLines(out, KEY);
	assert.notEqual(verified, "", "the signed line arrived whole: a truncated tail would fail its MAC");
	assert.equal(JSON.parse(verified).message.length, size);
});

test("run-job.mjs writes the exit line synchronously to fd 1", () => {
	const src = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	// Issue #686: the transcript mirror's final drain runs first (stderr, never fd 1), then the line, synchronously.
	assert.match(src, /\n\t\twrite: \(line\) => \{\n(?:\t{3}transcriptMirror\?\.[a-z]+\(\);\n)*\t{3}writeAllSync\(1, line\);\n\t\t\},\n/);
});

test("readExitKey: PI_EXIT_AUTH=stdin-frames takes frame 1's key and how many bytes it took, never draining to EOF (#686)", () => {
	const got = readExitKey({ PI_EXIT_AUTH: "stdin-frames" }, { drain: () => assert.fail("never drained"), readFrame: () => ({ key: KEY, problem: null, bytes: Buffer.alloc(88) }) });
	assert.deepEqual(got, { key: KEY, problem: null, frames: true, consumed: 88 });
	assert.deepEqual(readExitKey({ PI_EXIT_AUTH: "stdin-frames" }, { readFrame: () => ({ key: null, problem: "malformed", bytes: Buffer.alloc(2) }) }), { key: null, problem: "malformed", frames: true, consumed: 2 });
	assert.deepEqual(readExitKey({ PI_EXIT_AUTH: "stdin-frames" }, { readFrame: () => { throw new Error("x"); } }), { key: null, problem: "unreadable", frames: true, consumed: 0 });
	assert.deepEqual(readExitKey({ PI_EXIT_AUTH: "stdin-lines" }), { key: null, problem: "unknown-channel" }, "any other value is still unknown");
});

test("a noted fact is on the line however the run ends, and a field the line itself sets wins (issue #796)", () => {
	const lines = (act) => {
		const out = [];
		const writer = createExitWriter({ jobId: "j", write: (s) => out.push(s), exit: () => {} });
		act(writer);
		return JSON.parse(out.join("").trim());
	};
	assert.equal(lines((w) => { w.note({ canaryLoad: "loaded" }); w.writeExit({ code: 0, reason: "completed" }); }).canaryLoad, "loaded");
	assert.equal(lines((w) => { w.note({ canaryLoad: "failed" }); w.terminate(); }).canaryLoad, "failed", "also on the SIGTERM path");
	assert.equal(Object.hasOwn(lines((w) => w.writeExit({ code: 0, reason: "completed" })), "canaryLoad"), false, "nothing noted, nothing said: a line stays what it was");
	assert.equal(lines((w) => { w.note({ code: 9 }); w.writeExit({ code: 0, reason: "completed" }); }).code, 0);
});

// ---- issue #800: one line, always inside the worker's tail, and always verifying ----

const LONGEST_RESOURCES = Object.fromEntries(RESOURCE_KEYS.map((key) => [key, Number.MAX_SAFE_INTEGER]));
/** The longest PI_JOB_ID the old 6 KiB test measures with. A real one can be longer: see the budget test below. */
const JOB_ID = "repeat:very-long-schedule-name:1767225600000";
/** The longest a cron trigger's id makes a job id: `pi-job-repeat_<176 characters>_<millis>`, worker/src/triggers.mjs CRON_ID_MAX. */
const LONGEST_JOB_ID = `pi-job-repeat_${"x".repeat(176)}_1767225600000`;

/**
 * Every field a decided line can carry at once, each at its largest: the old test's fields (the maximal ledger, the
 * context block, the longest session reason) plus the four it leaves out (modelRoles, steer, recovery, providerFailure),
 * and a provider error of the worst kind already through capExitMessage.
 */
function worstFields(message = `403 ${"\u0001".repeat(16000)}`) {
	const wide = (prefix, i) => `${prefix}-${i}`.padEnd(64, "x");
	const N = 99_999_999;
	const row = (provider, model) => ({ provider, model, calls: N, input: N, output: N, cacheRead: N, cacheWrite: N, cacheWrite1h: N, reasoning: N, total: N, cost: 99_999.99, unpriced: N, providerBilled: N });
	const reason = [...RUNNER_POLICY_REASONS].reduce((a, b) => (b.length > a.length ? b : a));
	return {
		...capExitMessage({ code: 2, reason, message }),
		turns: 4096,
		retryTurns: 4096,
		modelRoles: { refusals: Array.from({ length: 8 }, () => ({ agentHash: "a".repeat(64), reason: "invalid-arguments" })) },
		tokens: Object.fromEntries(TOKEN_KEYS.map((key) => [key, key === "metered" ? true : key === "cost" ? 99_999.99 : N])),
		usage: { v: 1, piAi: "88.88.88", truncated: 1, models: [...Array.from({ length: 8 }, (_, i) => row(wide("provider", i), wide("model", i))), row("other", "other")] },
		context: { tokens: N, window: N },
		session: { resumed: false, reason: "resume-chain-too-long" },
		replaySafe: false,
		toolsStarted: true,
		providerFailure: { kind: "quota-exhausted", resetAt: 253402300799999, subscriptionCode: "usage_limit_reached", subscriptionProvider: "anthropic" },
		recovery: { orphans: N, replayed: N, interrupted: N, notStarted: N },
		steer: { delivered: N, pending: N, deliveredIds: Array.from({ length: 16 }, () => "a".repeat(32)) },
	};
}
function writeOne(fields, options = {}) {
	const out = [];
	const writer = createExitWriter({ key: KEY, jobId: JOB_ID, write: (s) => out.push(s), exit: () => {}, resources: () => LONGEST_RESOURCES, ...options });
	writer.writeExit(fields);
	assert.equal(out.length, 1);
	return out[0];
}
/** Through the worker's real sink, in the chunks a pipe hands over, with the `.log` off. */
async function throughSink(text, { chunk = 4096, exitKey = KEY } = {}) {
	const sink = makeLogSink({ logsDir: "/nonexistent", enabled: false, fs: { mkdirSync() {} } })("exit-line", { exitKey });
	const bytes = Buffer.from(text, "utf8");
	for (let at = 0; at < bytes.length; at += chunk) sink.write(bytes.subarray(at, at + chunk));
	return sink.close();
}

test("the tail this budget is measured against is the worker's: a signed line of exactly 8192 characters verifies through the real sink, and one more does not", async () => {
	const padded = (size) => {
		const empty = `${signExitLine(JSON.stringify({ event: "exit", code: 0, reason: "stop", p: "" }), KEY)}\n`.length;
		return `${signExitLine(JSON.stringify({ event: "exit", code: 0, reason: "stop", p: "p".repeat(size - empty) }), KEY)}\n`;
	};
	const noise = "x".repeat(4000);
	assert.equal(padded(EXIT_TAIL_BYTES).length, EXIT_TAIL_BYTES);
	assert.equal((await throughSink(`${noise}\n${padded(EXIT_TAIL_BYTES)}`)).exitAuth, "verified");
	assert.equal((await throughSink(`${noise}\n${padded(EXIT_TAIL_BYTES + 1)}`)).exitAuth, "unverified", "its head left the tail, so the MAC cannot verify");
});

test("the supervisor's longest line is the 449 this budget sets aside, plus its job id, measured on the real writer", () => {
	const lengths = [];
	for (const [signal, oomKills] of [["SIGKILL", 1], ["SIGTERM", 0], ["SIGSTKFLT", 0], ["SIGVTALRM", 0]]) {
		const verdict = deathFields(signal, { oomKills });
		const line = writeOne({ code: verdict.code, reason: verdict.reason, ...(verdict.signal ? { signal: verdict.signal } : {}), by: BY_SUPERVISOR }, { jobId: "" });
		lengths.push(Buffer.byteLength(line));
	}
	assert.equal(Math.max(...lengths), SUPERVISOR_LINE_BYTES, `the lines were ${lengths}`);
	// The arithmetic the constant states: 8192 less the supervisor's line at a 44-character id, less 19 to spare.
	assert.equal(SUPERVISOR_LINE_BYTES + JOB_ID.length, 493);
	assert.equal(EXIT_TAIL_BYTES - 493 - 19, EXIT_LINE_MAX_BYTES);
});

test("the budget shrinks with a job id past 63 characters, so the pair still fits", () => {
	assert.equal(exitLineMaxBytes(JOB_ID), EXIT_LINE_MAX_BYTES);
	assert.equal(exitLineMaxBytes("x".repeat(63)), EXIT_LINE_MAX_BYTES);
	assert.equal(exitLineMaxBytes("x".repeat(64)), EXIT_LINE_MAX_BYTES - 1);
	assert.equal(exitLineMaxBytes(LONGEST_JOB_ID), EXIT_TAIL_BYTES - SUPERVISOR_LINE_BYTES - LONGEST_JOB_ID.length);
	assert.equal(exitLineMaxBytes(undefined), EXIT_LINE_MAX_BYTES);
});

test("exitLineJson is pure ASCII and JSON.parse reads back the same value, quotes, backslashes and astral characters included", () => {
	const value = { message: 'caf\u00e9 \u201cquoted\u201d \\ "plain" \u2028 \ud83d\ude00 \ud83d alone', "k\u00e9y": ["\u0400"] };
	const text = exitLineJson(value);
	assert.match(text, /^[\x00-\x7f]*$/);
	assert.deepEqual(JSON.parse(text), value);
	assert.equal(exitLineJson({ a: "plain", n: 1 }), JSON.stringify({ a: "plain", n: 1 }), "an ASCII line is byte-identical to what it always was");
});

test("the premise: a raw non-ASCII line split inside a character by the sink's chunks fails its MAC", async () => {
	const body = JSON.stringify({ event: "exit", jobId: "j", code: 2, reason: "error", message: "\u201c".repeat(4000) });
	const signed = `\n${signExitLine(body, KEY)}\n`;
	assert.equal((await throughSink(signed)).exitAuth, "unverified", "one chunk boundary falls inside a three-byte character");
	assert.equal((await throughSink(signed, { chunk: 1 << 20 })).exitAuth, "verified", "the same line in one chunk verifies, so the split is what broke it");
});

test("a non-ASCII message cut into 4 KiB chunks verifies through the worker's real sink, for each chunk offset", async () => {
	const line = writeOne({ code: 2, reason: "cost-cap", message: "\u201cnot allowed\u201d \ud83d\ude00 ".repeat(30) });
	assert.match(line, /^[\x00-\x7f]*$/, "nothing a chunk boundary can split");
	assert.deepEqual(JSON.parse(authenticExitLines(line, KEY)).message.slice(0, 2), ["\u201c", "n"].join(""));
	for (const noise of [0, 1, 2, 3, 4093, 4094, 4095]) {
		const read = await throughSink(`${"n".repeat(noise)}${line}`);
		assert.equal(read.exitAuth, "verified", `after ${noise} bytes of noise`);
		assert.equal(read.exitLineCode, 2);
		assert.equal(read.exitReason, "cost-cap");
	}
});

test("a maximal line stays at or under 7,680 bytes and verifies, with the code, the reason and the money intact", async () => {
	const fields = worstFields();
	const uncut = `\n${signExitLine(JSON.stringify({ event: "exit", jobId: JOB_ID, ...fields, resources: LONGEST_RESOURCES }), KEY)}\n`;
	assert.ok(uncut.length > EXIT_LINE_MAX_BYTES, `the premise: this line is ${uncut.length} before the writer fits it`);
	assert.ok(uncut.length + SUPERVISOR_LINE_BYTES + JOB_ID.length > EXIT_TAIL_BYTES, "and with the supervisor's line it would have left the tail");
	const line = writeOne(fields);
	assert.ok(Buffer.byteLength(line) <= EXIT_LINE_MAX_BYTES, `the line is ${Buffer.byteLength(line)} bytes`);
	assert.equal(Buffer.byteLength(line), line.length, "ASCII, so the tail's characters are its bytes");
	const read = await throughSink(line);
	assert.equal(read.exitAuth, "verified");
	assert.equal(read.exitLineCode, fields.code);
	assert.equal(read.exitReason, fields.reason);
	assert.equal(read.tokens.total, 99_999_999);
	const parsed = JSON.parse(authenticExitLines(line, KEY));
	assert.deepEqual(parsed.steer, fields.steer, "every other field survives whole: only the message was cut");
	assert.deepEqual(parsed.usage.models.length, 9);
	assert.match(parsed.message, /\.\.\. \[truncated \d+ chars\]$/);
});

test("a message of non-ASCII characters, which capExitMessage counts as one each and the line spells in six, is cut to fit on a whole code point", async () => {
	const message = "\ud83d\ude00\u201c".repeat(4000);
	const fields = worstFields(message);
	assert.ok(fields.message.length > 1000);
	const line = writeOne(fields);
	assert.ok(Buffer.byteLength(line) <= EXIT_LINE_MAX_BYTES);
	assert.equal((await throughSink(line)).exitAuth, "verified");
	const parsed = JSON.parse(authenticExitLines(line, KEY));
	assert.doesNotMatch(parsed.message, /[\ud800-\udbff](?![\udc00-\udfff])/, "no half of a surrogate pair is left at the cut");
	assert.match(parsed.message, /\[truncated \d+ chars\]$/);
});

test("at the budget's edge: a line that fits is untouched, and one byte over cuts the message to fit exactly or less", () => {
	const sized = (extra) => {
		const fields = { code: 2, reason: "error", message: "m".repeat(extra) };
		return { fields, line: writeOne(fields, { maxBytes: 600, resources: () => null }) };
	};
	const base = writeOne({ code: 2, reason: "error", message: "" }, { maxBytes: 600, resources: () => null });
	const room = 600 - Buffer.byteLength(base);
	const fits = sized(room);
	assert.equal(JSON.parse(authenticExitLines(fits.line, KEY)).message, fits.fields.message);
	assert.equal(Buffer.byteLength(fits.line), 600);
	const over = sized(room + 1);
	const cut = JSON.parse(authenticExitLines(over.line, KEY)).message;
	assert.notEqual(cut, over.fields.message);
	assert.match(cut, /^m+\.\.\. \[truncated \d+ chars\]$/);
	assert.ok(Buffer.byteLength(over.line) <= 600);
	assert.equal(/truncated (\d+)/.exec(cut)[1], String(over.fields.message.length - cut.indexOf(".")), "the marker counts what it took");
});

test("a room too small for the marker leaves an empty message, and a line with nothing left to cut keeps its verdict and its money, marked", () => {
	const noMessage = writeOne({ code: 2, reason: "error", message: "m".repeat(500) }, { maxBytes: 150 + JOB_ID.length, resources: () => null });
	const body = JSON.parse(authenticExitLines(noMessage, KEY));
	assert.equal(body.message, "");
	assert.ok(Buffer.byteLength(noMessage) <= 150 + JOB_ID.length);
	// A field no one bounded, past the whole budget: without a message to cut, only the last resort can still verify.
	const huge = writeOne({ code: 1, reason: "error", tokens: { total: 7, cost: 0.5 }, why: "over-cap", usage: { models: "u".repeat(20000) } });
	assert.ok(Buffer.byteLength(huge) <= EXIT_LINE_MAX_BYTES);
	assert.deepEqual(JSON.parse(authenticExitLines(huge, KEY)), { event: "exit", jobId: JOB_ID, code: 1, reason: "error", why: "over-cap", tokens: { total: 7, cost: 0.5 }, lineCut: true });
	const withMessage = writeOne({ code: 1, reason: "error", message: "m", usage: { models: "u".repeat(20000) } });
	assert.deepEqual(JSON.parse(authenticExitLines(withMessage, KEY)), { event: "exit", jobId: JOB_ID, code: 1, reason: "error", lineCut: true }, "the message is not worth keeping over a line that verifies");
});

test("a runner line at the budget plus the supervisor's line fits the tail: the runner's line verifies and decides, for the longest job id too", async () => {
	for (const jobId of [JOB_ID, "y".repeat(63), LONGEST_JOB_ID]) {
		const runner = writeOne(worstFields(), { jobId });
		assert.ok(Buffer.byteLength(runner) <= exitLineMaxBytes(jobId));
		const verdict = deathFields("SIGKILL", { oomKills: 1 });
		const supervisor = writeOne({ code: verdict.code, reason: verdict.reason, signal: verdict.signal, by: BY_SUPERVISOR }, { jobId });
		assert.equal(Buffer.byteLength(supervisor), SUPERVISOR_LINE_BYTES + jobId.length);
		assert.ok(Buffer.byteLength(runner) + Buffer.byteLength(supervisor) <= EXIT_TAIL_BYTES, jobId);
		const read = await throughSink(`${"agent noise\n".repeat(900)}${runner}${supervisor}`);
		assert.equal(read.exitAuth, "verified", jobId);
		assert.equal(read.exitLineCode, worstFields().code, "the runner's own line decides, not the supervisor's");
		assert.equal(read.tokens.total, 99_999_999, "with the tokens the supervisor never has");
		assert.equal(read.exitOomKilled, undefined);
	}
});

test("an older worker's read: the fields it knows parse off a fitted line as they always did, keyed or not", async () => {
	const line = writeOne(worstFields("\u201c".repeat(9000)), { key: null });
	const read = await throughSink(line, { exitKey: null });
	assert.equal("exitAuth" in read, false);
	assert.equal(read.exitLineCode, 2);
	assert.equal(read.tokens.total, 99_999_999);
	assert.ok(Buffer.byteLength(line) <= EXIT_LINE_MAX_BYTES, "the unsigned line is held to the same budget");
});
