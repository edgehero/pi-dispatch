import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createExitWriter, drainStdin, EXIT_TERMINATED, exitLineMac, readExitKey, signExitLine, writeAllSync } from "../src/exit-line.mjs";
import { authenticExitLines, makeLogSink } from "../../../worker/src/run-history.mjs";

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
	assert.match(entrypoint, /\nexec \/opt\/pi-dispatch\/runner-node \/app\/image\/runner\/run-job\.mjs\n/);
	assert.match(dockerfile, /\nRUN install -o root -g root -m 0711 \/usr\/local\/bin\/node \/opt\/pi-dispatch\/runner-node\n/);
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
	assert.match(src, /\n\t\twrite: \(line\) => writeAllSync\(1, line\),\n/);
});
