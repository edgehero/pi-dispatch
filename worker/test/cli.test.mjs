import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// cli.mjs dynamic-imports bullmq/ioredis (in the `run` enqueue and `worker` paths), so the
// VALIDATION paths -- which return before any enqueue -- run everywhere. That is exactly the safety
// surface worth testing: nothing should reach the queue if the inputs are bad. Tests that DO reach
// the enqueue need the queue deps; they skip below the node floor and run in CI.
let depsOk = false;
try {
	await import("../src/connection.mjs");
	depsOk = true;
} catch {}
const needsDeps = depsOk ? false : `queue deps not installed (node ${process.version} < 22.19.0); CI runs these`;

const env = { VALKEY_URL: "redis://127.0.0.1:6399" };

test("`doctor --live` reaches runDoctor as live: true, and the usage names the flag (#278)", async () => {
	// A source pin rather than a run: `main` would call the real doctor, which spawns docker. The flag must reach the
	// deps bag, where runDoctor reads it strictly as `=== true`.
	const { readFileSync } = await import("node:fs");
	const src = readFileSync(new URL("../src/cli.mjs", import.meta.url), "utf8");
	assert.match(src, /runDoctor\(env, \{ fix: argv\.slice\(1\)\.includes\("--fix"\), live: argv\.slice\(1\)\.includes\("--live"\) \}\)/);
	assert.match(src, /pi-dispatch doctor \[--fix\] \[--live\]/);
});

test("no args prints usage and exits 0", async () => {
	assert.equal(await main([], env), 0);
});

test("an unknown command exits 1", async () => {
	assert.equal(await main(["frobnicate"], env), 1);
});

test("run with no folder fails", async () => {
	assert.equal(await main(["run"], env), 1);
});

test("run with a missing folder fails before touching the queue", async () => {
	assert.equal(await main(["run", "/no/such/folder", "--task", "x"], env), 1);
});

test("run with no --task fails", async () => {
	const dir = tempDir("cli-");
	assert.equal(await main(["run", dir, "--flow", "tidy"], env), 1);
});

function gitRepo({ dirty }) {
	const dir = tempDir("cli-git-");
	const g = (args) =>
		execFileSync("git", ["-C", dir, ...args], {
			env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
		});
	g(["init", "-q"]);
	g(["config", "core.autocrlf", "false"]);
	writeFileSync(join(dir, "f.txt"), "one\n");
	g(["add", "-A"]);
	g(["commit", "-qm", "init"]);
	if (dirty) writeFileSync(join(dir, "f.txt"), "one\ntwo\n"); // uncommitted change
	return dir;
}

test("run refuses a dirty git working tree (edits are in place, no undo)", async () => {
	const dir = gitRepo({ dirty: true });
	assert.equal(await main(["run", dir, "--task", "x"], env), 1);
});

// Issue #524: the worker's folder rule, said before anything is queued. No Valkey is reachable here and the refusal
// seam fails the test if it is asked, so "before anything is queued" is what is measured, not assumed.
test("run refuses a folder that is not a git repository before queueing, naming it and the fix (#524)", async () => {
	const { mkdirSync } = await import("node:fs");
	const plain = tempDir("cli-plain-");
	const repo = gitRepo({ dirty: false });
	const sub = join(repo, "pkg");
	mkdirSync(sub);
	const empty = tempDir("cli-empty-");
	execFileSync("git", ["-C", empty, "init", "-q"]);
	const cases = [
		[plain, /is not a git repository\. A local job needs one: run `git init` there and commit/],
		[sub, /is not the root of a git repository, and a local job needs one\. Run `git init` here and commit, or, if this folder belongs to the repository at /],
		[empty, /no commit yet/],
	];
	for (const [folder, said] of cases) {
		for (const force of [[], ["--force"]]) {
			const err = [];
			const realErr = process.stderr.write;
			process.stderr.write = (chunk) => (err.push(String(chunk)), true);
			let code;
			try {
				code = await main(["run", folder, "--task", "t", ...force], { VALKEY_URL: "redis://127.0.0.1:1" }, { valkeyRefusal: async () => assert.fail("reached Valkey") });
			} finally {
				process.stderr.write = realErr;
			}
			assert.equal(code, 1, `${folder} ${force}`);
			assert.match(err.join(""), said);
			assert.match(err.join(""), /Nothing was queued\./);
		}
	}
});

test("runQueuedLine says a deduplicated run queued nothing, with the first job's time, id and state (#524)", { skip: needsDeps }, async () => {
	const { runQueuedLine: line } = await import("../src/cli.mjs");
	const { swallowedRunSentence } = await import("../src/queue.mjs");
	const runQueuedLine = (args) => line(args, { swallowedRunSentence });
	const at = new Date(2026, 9, 2, 9, 5, 30).getTime(); // local 09:05, the terminal's own clock
	assert.equal(
		runQueuedLine({ jobId: "local-abc", existing: { queuedAt: at, state: "completed" }, folder: "/f" }),
		"an identical run was queued at 09:05 as local-abc (completed); nothing new was queued.\nthe same folder and task queue a new run from the next minute on.\n",
	);
	assert.match(runQueuedLine({ jobId: "local-abc", existing: { queuedAt: at, state: null }, folder: "/f" }), /as local-abc \(already queued or done\); nothing new was queued/);
	assert.doesNotMatch(runQueuedLine({ jobId: "local-abc", existing: { queuedAt: at, state: "waiting" }, folder: "/f" }), /^queued /m, "never the queued line");
	assert.match(runQueuedLine({ jobId: "local-abc", existing: null, folder: "/f" }), /^queued local-abc for folder \/f\n/);
	assert.match(runQueuedLine({ jobId: "local-abc", existing: undefined, folder: "/f" }), /could not check whether an identical run/);
});

test("run twice in one minute: the second says an identical run was queued and queued nothing (#524)", { skip: process.env.VALKEY_TEST_URL ? false : "needs VALKEY_TEST_URL" }, async () => {
	const dir = gitRepo({ dirty: false });
	const env2 = { VALKEY_URL: process.env.VALKEY_TEST_URL };
	const now = () => new Date("2026-10-02T10:15:20Z"); // both runs inside one minute, by construction
	let out = "";
	const write = (chunk) => ((out += chunk), true);
	assert.equal(await main(["run", dir, "--task", "dedup me", "--force"], env2, { write, now }), 0);
	const jobId = /^queued (\S+) for folder /m.exec(out)?.[1];
	assert.ok(jobId, `the first run queues (got: ${out})`);
	out = "";
	try {
		assert.equal(await main(["run", dir, "--task", "dedup me", "--force"], env2, { write, now }), 0);
		assert.match(out, new RegExp(`^an identical run was queued at \\d\\d:\\d\\d as ${jobId} \\(waiting\\); nothing new was queued\\.$`, "m"));
		assert.doesNotMatch(out, /^queued /m);
	} finally {
		await main(["cancel", jobId], env2, { write: () => true });
	}
});

test("run enqueues against a real Valkey (VALKEY_TEST_URL) and prints the job id", { skip: process.env.VALKEY_TEST_URL ? false : "needs VALKEY_TEST_URL" }, async () => {
	const dir = gitRepo({ dirty: false });
	const code = await main(["run", dir, "--task", "tidy the imports", "--force"], { VALKEY_URL: process.env.VALKEY_TEST_URL });
	assert.equal(code, 0, "a clean enqueue against a real Valkey returns 0");
});

// Issue #464 (gate round 3): a refused Valkey is said as its refusal before anything is sent, from any directory.
test("run stops on the Valkey refusal before it enqueues anything (#464)", { skip: process.env.VALKEY_TEST_URL ? false : "needs VALKEY_TEST_URL" }, async () => {
	const dir = gitRepo({ dirty: false });
	const asked = [];
	const valkeyRefusal = async (url) => (asked.push(url), "the Valkey VALKEY_URL reaches is refused: 127.0.0.1:6399 is held by op2 (uid 1235)");
	const code = await main(["run", dir, "--task", "must not be sent", "--force"], { VALKEY_URL: process.env.VALKEY_TEST_URL }, { valkeyRefusal });
	assert.equal(code, 1, "refused, though the Valkey answers and would have taken the job");
	assert.deepEqual(asked, [process.env.VALKEY_TEST_URL]);
});

test("run --image refuses, before anything is queued, an image the one image rule refuses (#471)", async () => {
	const dir = gitRepo({ dirty: false });
	for (const bad of ["--privileged", " img", "img\u0007"]) {
		// No VALKEY_URL is reachable here: the refusal comes before any connection is made.
		const code = await main(["run", dir, "--task", "t", `--image=${bad}`, "--force"], { VALKEY_URL: "redis://127.0.0.1:1" }, { valkeyRefusal: async () => assert.fail("reached Valkey") });
		assert.equal(code, 1, JSON.stringify(bad));
	}
});

test("run --image enqueues against a real Valkey (the operator-at-the-terminal path for a per-trigger image)", { skip: process.env.VALKEY_TEST_URL ? false : "needs VALKEY_TEST_URL" }, async () => {
	// The CLI is the operator-trusted path -- same class as the existing free-form --provider/--model -- and
	// it is what lets an operator see the preflight refusal once, deliberately, instead of discovering it at
	// 03:00 from a cron tick.
	const dir = gitRepo({ dirty: false });
	const code = await main(["run", dir, "--task", "tidy", "--image", "my-python:1.2.0", "--force"], { VALKEY_URL: process.env.VALKEY_TEST_URL });
	assert.equal(code, 0, "an explicit --image is a clean enqueue");

	// `--image ""` must collapse to absent: a falsy string would reach buildDockerRunArgs and throw there,
	// AFTER a budget slot was reserved.
	const blank = await main(["run", dir, "--task", "tidy", "--image", "", "--force"], { VALKEY_URL: process.env.VALKEY_TEST_URL });
	assert.equal(blank, 0, "a blank --image resolves the deployment default rather than failing mid-job");
});

test("cancel removes a queued job against a real Valkey (VALKEY_TEST_URL) -- the acceptance's queued half", { skip: process.env.VALKEY_TEST_URL ? false : "needs VALKEY_TEST_URL" }, async () => {
	// Enqueue a real local job (no worker is draining, so it sits waiting), then cancel it by id and
	// verify the second cancel finds nothing: the first one really removed it, neighbours untouched.
	const dir = gitRepo({ dirty: false });
	const env2 = { VALKEY_URL: process.env.VALKEY_TEST_URL };
	let out = "";
	const write = (chunk) => ((out += chunk), true);
	assert.equal(await main(["run", dir, "--task", "sit there", "--force"], env2, { write }), 0);
	const jobId = /queued (\S+)/.exec(out)?.[1];
	assert.ok(jobId, `the run output must name the job id (got: ${out})`);
	out = "";
	assert.equal(await main(["cancel", jobId], env2, { write }), 0, "a waiting job cancels clean");
	assert.match(out, /never ran; no record written/);
	assert.equal(await main(["cancel", jobId], env2, { write }), 1, "the job is really gone; a second cancel refuses");
});

test("run fails FAST (does not hang) when Valkey is unreachable", { skip: needsDeps }, async () => {
	// The whole point of failFast: a one-shot enqueue against a down Valkey must error in seconds,
	// not hang forever on ioredis's null retry policy. Port 1 is closed.
	const dir = gitRepo({ dirty: false });
	const start = Date.now();
	const code = await main(["run", dir, "--task", "x"], { VALKEY_URL: "redis://127.0.0.1:1" });
	assert.equal(code, 1, "an unreachable Valkey is a clean error, not a hang");
	assert.ok(Date.now() - start < 15000, "must fail fast, well under any CI timeout");
});

test("`pi-dispatch init` hands the CLI's environment to init: PI_BACKENDS=podman in the shell gets the podman ladder (#453 gate)", { skip: process.platform !== "linux" ? "the podman ladder is Linux's; off Linux init says the venue refuses the host, pinned in init.test.mjs" : false }, () => {
	const dir = tempDir("pi-cli-init-");
	const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
	const printed = execFileSync(process.execPath, [cli, "init"], { cwd: dir, env: { ...process.env, PI_BACKENDS: "podman" }, encoding: "utf8" });
	assert.match(printed, /\nNext \(the podman venue; run these as the worker's own account\./);
	const docker = execFileSync(process.execPath, [cli, "init"], { cwd: tempDir("pi-cli-init-"), env: { ...process.env, PI_BACKENDS: "local" }, encoding: "utf8" });
	assert.match(docker, /\nNext:\n {2}1\. docker pull/);
});

test("`pi-dispatch init` off Linux with PI_BACKENDS=podman in the shell says the venue refuses the host (#453 gate)", { skip: process.platform === "linux" ? "covered on Linux by the ladder test beside this one" : false }, () => {
	const dir = tempDir("pi-cli-init-");
	const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
	const printed = execFileSync(process.execPath, [cli, "init"], { cwd: dir, env: { ...process.env, PI_BACKENDS: "podman" }, encoding: "utf8" });
	assert.match(printed, /\nNext: PI_BACKENDS lists only the podman venue, which runs on Linux alone/);
});

// Issue #503, gate round 1: a reader that closes early (`pi-dispatch egress render | head -1`) left an uncaught EPIPE
// after the verb's work was done. The CLI now ends quietly with the verb's own exit code. Run as the real bin, with the
// pipe closed before the child writes anything, so every write the verb makes meets EPIPE.
test("a pi-dispatch verb whose stdout reader has gone ends quietly, with no uncaught EPIPE (#503)", async () => {
	const { spawn } = await import("node:child_process");
	const cwd = tempDir("pi-cli-epipe-");
	writeFileSync(join(cwd, "model-endpoints.json"), '{"version":1,"endpoints":[]}\n');
	writeFileSync(join(cwd, "model-endpoints.conf"), "");
	const bin = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
	const { PI_MODEL_ENDPOINTS_FILE: _f, ...env } = process.env;
	for (let i = 0; i < 3; i++) {
		const result = await new Promise((resolve) => {
			const child = spawn(process.execPath, [bin, "egress", "render"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
			child.stdout.destroy();
			let stderr = "";
			child.stderr.on("data", (d) => (stderr += d));
			child.on("close", (code) => resolve({ code, stderr }));
		});
		// The exit code an unhandled EPIPE gave, 1: the guard quiets the trace and changes nothing else (gate round 2).
		assert.equal(result.code, 1, result.stderr);
		assert.doesNotMatch(result.stderr, /EPIPE|Unhandled 'error' event|at /, result.stderr);
	}
});

// Gate round 2: the guard never turns a broken pipe into success. A long-running writer (the worker, whose log reader
// died) must exit non-zero so systemd's Restart=on-failure and launchd's SuccessfulExit=false restart it; a verb that
// set its own exit code keeps it; any other stdout error is one stderr line and exit 1.
test("installStdoutPipeGuard keeps the exit code an unhandled EPIPE gives, or the verb's own (#503)", async () => {
	const { EventEmitter } = await import("node:events");
	const { installStdoutPipeGuard } = await import("../src/exit-code.mjs");
	const run = (exitCode, error) => {
		const stream = new EventEmitter();
		const exits = [];
		const lines = [];
		installStdoutPipeGuard({ stream, proc: { exitCode, exit: (c) => exits.push(c) }, write: (l) => lines.push(l) });
		stream.emit("error", error);
		return { exits, lines };
	};
	const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
	assert.deepEqual(run(undefined, epipe), { exits: [1], lines: [] }, "nothing set: 1, as the uncaught exception gave");
	assert.deepEqual(run(2, epipe), { exits: [2], lines: [] }, "a verb's own code is kept");
	assert.deepEqual(run(0, epipe), { exits: [0], lines: [] }, "an explicit 0 the verb set is its own too");
	assert.deepEqual(run(undefined, Object.assign(new Error("no space"), { code: "ENOSPC" })), { exits: [1], lines: ["error: writing to stdout failed: ENOSPC\n"] });
	const { spawn } = await import("node:child_process");
	const guard = fileURLToPath(new URL("../src/exit-code.mjs", import.meta.url));
	const script = `import(${JSON.stringify(guard)}).then((m)=>{m.installStdoutPipeGuard();setInterval(()=>process.stdout.write("tick\\n"),5)})`;
	const result = await new Promise((resolve) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.destroy();
		let stderr = "";
		child.stderr.on("data", (d) => (stderr += d));
		const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stderr });
		});
	});
	assert.equal(result.code, 1, `a long-running writer whose reader died exits non-zero, so its supervisor restarts it: ${result.stderr}`);
	assert.equal(result.stderr, "", "and quietly");
});
