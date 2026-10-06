import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { authenticExitLines, EXIT_OOM_KILLED, parseExitOomKilled } from "../../../worker/src/run-history.mjs";
import { BY_SUPERVISOR, deathFields, FORWARDED_SIGNALS, KILLED, OOM_KILLED, RAISE_THEN_EXEC, RUNNER_NODE, RUNNER_NODE_FLAGS, RUNNER_SCRIPT, superviseRunner, TERMINATED } from "../src/supervise.mjs";

/**
 * Issue #596: the supervisor between the container's init and the runner. Every effect is a seam here; the last test
 * runs a real child that dies of SIGKILL.
 */

const KEY = "0123456789abcdef".repeat(4);
const USED = (oomKills) => ({ memPeak: 67108864, swapPeak: 0, oomKills, memSomeUsec: null, memFullUsec: null, cpuUsec: 10, throttledUsec: 0, throttled: 0, pidsPeak: 4 });

/** A fake runner process: records its stdin and the signals sent to it, and exits when the test says so. */
function fakeChild() {
	const child = new EventEmitter();
	child.stdinWritten = null;
	child.stdin = Object.assign(new EventEmitter(), { end: (data) => (child.stdinWritten = data) });
	child.killed = [];
	child.kill = (signal) => child.killed.push(signal);
	return child;
}

function run({ env = { PI_EXIT_AUTH: "stdin", PI_JOB_ID: "j1" }, raw = `${KEY}\n`, oomKills = 0 } = {}) {
	const child = fakeChild();
	const out = [];
	const exits = [];
	const spawned = [];
	const handlers = new Map();
	let drained = 0;
	superviseRunner({
		env,
		spawnFn: (cmd, args, opts) => {
			spawned.push({ cmd, args, opts });
			return child;
		},
		drain: () => {
			drained += 1;
			return raw;
		},
		write: (s) => out.push(s),
		exit: (c) => exits.push(c),
		readResources: () => USED(oomKills),
		onSignal: (signal, handler) => handlers.set(signal, handler),
	});
	return { child, out, exits, spawned, handlers, drained: () => drained };
}

test("the runner is started under the exec-only node through a shell that raises its OOM score, then execs it", () => {
	const { spawned } = run();
	assert.equal(spawned.length, 1);
	assert.equal(spawned[0].cmd, "/bin/sh");
	assert.deepEqual(spawned[0].args, ["-c", RAISE_THEN_EXEC, RUNNER_NODE, "--disable-sigusr1", RUNNER_SCRIPT]);
	assert.deepEqual(RUNNER_NODE_FLAGS, ["--disable-sigusr1"], "the runner holds the key: a tool's SIGUSR1 must not open its inspector");
	assert.equal(RUNNER_NODE, "/opt/pi-dispatch/runner-node", "the exec-only node of issue #545, which keeps the key out of reach");
	assert.equal(RUNNER_SCRIPT, "/app/image/runner/run-job.mjs");
	// exec, so the runner keeps the shell's pid (and its raised score: oom_score_adj survives exec); the score is 1000.
	assert.equal(RAISE_THEN_EXEC, 'echo 1000 > /proc/self/oom_score_adj 2>/dev/null; exec "$0" "$@"');
	const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
	assert.match(dockerfile, /\/opt\/pi-dispatch\/runner-node\n/, "the node it names is the one the Dockerfile installs");
});

test("the key is drained first and handed to the runner byte for byte on its own stdin, closed", () => {
	const { child, spawned, drained } = run({ raw: `${KEY}\n` });
	assert.equal(drained(), 1);
	assert.equal(spawned[0].opts.stdio[0], "pipe");
	assert.equal(child.stdinWritten, `${KEY}\n`, "the runner's readExitKey sees exactly what the worker wrote");
	assert.equal(spawned[0].opts.env.PI_EXIT_AUTH, "stdin", "the runner still learns a key is waiting");
	// A malformed key is passed on as it came, so the runner reports the same problem it would have.
	const bad = run({ raw: "not-a-key\n" });
	assert.equal(bad.child.stdinWritten, "not-a-key\n");
});

test("with no PI_EXIT_AUTH nothing is drained and the runner inherits stdin, exactly as before", () => {
	const { spawned, drained, child } = run({ env: { PI_JOB_ID: "j1" } });
	assert.equal(drained(), 0);
	assert.equal(spawned[0].opts.stdio[0], "inherit");
	assert.equal(child.stdinWritten, null);
});

test("a runner that EXITS ends the supervisor with its own code, and the supervisor writes nothing", () => {
	for (const code of [0, 1, 2, 3, 143]) {
		const { child, out, exits } = run({ oomKills: 1 });
		child.emit("exit", code, null);
		assert.deepEqual(out, [], `code ${code}: the runner's own line (or none) stands`);
		assert.deepEqual(exits, [code]);
	}
});

test("a runner KILLED while the cgroup counted an OOM kill ends on a signed oom-killed line and 137", () => {
	const { child, out, exits } = run({ oomKills: 1 });
	child.emit("exit", null, "SIGKILL");
	assert.deepEqual(exits, [137]);
	const body = authenticExitLines(out.join(""), KEY);
	assert.notEqual(body, "", "signed with the job's key");
	assert.deepEqual(JSON.parse(body), { event: "exit", jobId: "j1", code: 137, reason: "oom-killed", signal: "SIGKILL", by: "supervisor", resources: USED(1) });
	assert.equal(BY_SUPERVISOR, "supervisor");
	assert.equal(parseExitOomKilled(body), true, "the worker reads it as a confirmed OOM");
	assert.equal(OOM_KILLED, EXIT_OOM_KILLED, "the runner's word and the worker's are one");
});

test("a SIGKILL with no OOM kill is `killed`, a SIGTERM death `terminated`: neither reads as an OOM", () => {
	const killed = run({ oomKills: 0 });
	killed.child.emit("exit", null, "SIGKILL");
	const kb = authenticExitLines(killed.out.join(""), KEY);
	assert.equal(JSON.parse(kb).reason, KILLED);
	assert.equal(JSON.parse(kb).by, "supervisor");
	assert.equal(parseExitOomKilled(kb), false);
	assert.deepEqual(killed.exits, [137]);
	const term = run({ oomKills: 3 });
	term.child.emit("exit", null, "SIGTERM");
	assert.equal(JSON.parse(authenticExitLines(term.out.join(""), KEY)).reason, TERMINATED, "a stop is never an OOM, whatever a child did");
	assert.deepEqual(term.exits, [143]);
	assert.deepEqual(deathFields("SIGSEGV", USED(1)), { code: 139, reason: KILLED, signal: "SIGSEGV" });
	assert.deepEqual(deathFields("SIGKILL", null), { code: 137, reason: KILLED, signal: "SIGKILL" }, "no counters read: not confirmed");
});

test("a stop is forwarded to the runner: the init process delivers it to the supervisor", () => {
	const { child, handlers } = run();
	assert.deepEqual([...handlers.keys()], [...FORWARDED_SIGNALS]);
	assert.deepEqual(FORWARDED_SIGNALS, ["SIGTERM", "SIGINT", "SIGHUP"]);
	for (const signal of FORWARDED_SIGNALS) handlers.get(signal)();
	assert.deepEqual(child.killed, ["SIGTERM", "SIGINT", "SIGHUP"]);
});

test("a runner that cannot start is the infra code, with a line", () => {
	const out = [];
	const exits = [];
	superviseRunner({ env: {}, spawnFn: () => { throw new Error("ENOENT"); }, drain: () => "", write: (s) => out.push(s), exit: (c) => exits.push(c), readResources: () => null, onSignal: () => {} });
	assert.deepEqual(exits, [1]);
	assert.equal(JSON.parse(out[0]).reason, "runner-not-started");
	assert.equal(JSON.parse(out[0]).by, "supervisor", "every line the supervisor writes says so, inside the signed bytes");
});

test("a real child killed by SIGKILL is reported, signed, by a real supervisor", async () => {
	const out = [];
	const done = new Promise((resolve) => {
		superviseRunner({
			env: { PI_EXIT_AUTH: "stdin", PI_JOB_ID: "real" },
			command: [process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.kill(process.pid, 'SIGKILL'));"]],
			drain: () => `${KEY}\n`,
			write: (s) => out.push(s),
			exit: (c) => resolve(c),
			readResources: () => USED(2),
			onSignal: () => {},
		});
	});
	assert.equal(await done, 137);
	const line = JSON.parse(authenticExitLines(out.join(""), KEY));
	assert.equal(line.reason, "oom-killed");
	assert.equal(line.resources.oomKills, 2);
});

test("the image runs the supervisor from an entry file that always calls it: no main-module guard to read false and exit 0", () => {
	const entry = readFileSync(new URL("../supervise.mjs", import.meta.url), "utf8");
	// The whole of its code: one import and one call. A guard that read false made node exit 0 with no output, which
	// the worker records as a completed run.
	const code = entry.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("//"));
	assert.deepEqual(code, ['import { superviseRunner } from "./src/supervise.mjs";', "superviseRunner();"]);
	assert.ok(!/import\.meta|process\.argv/.test(entry));
});

test("the entrypoint starts the supervisor under the exec-only node with --disable-sigusr1, and the supervisor is the file the Dockerfile copies", () => {
	const entrypoint = readFileSync(new URL("../../entrypoint.sh", import.meta.url), "utf8");
	// The supervisor holds the key: a tool's SIGUSR1 would otherwise open its inspector on 127.0.0.1:9229.
	assert.match(entrypoint, /\nexec \/opt\/pi-dispatch\/runner-node --disable-sigusr1 \/app\/image\/runner\/supervise\.mjs\n/);
	const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
	assert.match(dockerfile, /\nCOPY image\/runner \/app\/image\/runner\n/, "the whole runner directory, entry file and src/ alike");
});

test("the entry file, run by node, runs the supervisor: never a silent exit 0", async () => {
	// Run as the image runs it (node <entry file>). Outside the image /opt/pi-dispatch/runner-node does not exist, so the
	// shell's exec fails (126 or 127, by shell) and the supervisor exits with the runner's code. What matters is that the entry file RAN
	// the supervisor: a guard that read false exited 0 here with no output. (No --disable-sigusr1: the node running the
	// suite may predate it; the flag is pinned on the entrypoint above and in RUNNER_NODE_FLAGS.)
	const { spawnSync } = await import("node:child_process");
	const r = spawnSync(process.execPath, [new URL("../supervise.mjs", import.meta.url).pathname], { encoding: "utf8", env: { PATH: process.env.PATH }, timeout: 20000 });
	assert.ok(r.status === 126 || r.status === 127, `the runner's own code, got ${r.status}: ${r.stderr}`);
});
