import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { TRIGGER_LOADER_ENV_KEYS, WORKER_HINT_UNKNOWN, cliDeploymentEnv, main, workerHint } from "../src/cli.mjs";
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
	// Issue #530: the closing line is the hint `run` asked the queue for, and without one the line true either way.
	assert.equal(runQueuedLine({ jobId: "local-abc", existing: null, folder: "/f", hint: "1 worker is connected to this queue and will pick it up." }), "queued local-abc for folder /f\n1 worker is connected to this queue and will pick it up.\n");
	assert.equal(runQueuedLine({ jobId: "local-abc", existing: null, folder: "/f" }), `queued local-abc for folder /f\n${WORKER_HINT_UNKNOWN}\n`);
	assert.doesNotMatch(runQueuedLine({ jobId: "local-abc", existing: { queuedAt: at, state: "waiting" }, folder: "/f", hint: "x" }), /^x$/m, "a run that queued nothing gets no hint");
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
	let out = "";
	const code = await main(["run", dir, "--task", "tidy the imports", "--force"], { VALKEY_URL: process.env.VALKEY_TEST_URL }, { write: (chunk) => ((out += chunk), true) });
	assert.equal(code, 0, "a clean enqueue against a real Valkey returns 0");
	// Issue #530: the closing line is what the queue shows. Other files may run a worker on this shared queue at the
	// same moment, so any of the queue's answers is right here; the hint's own tests below pin which is which.
	const [first, second, ...rest] = out.split("\n");
	assert.match(first, /^queued \S+ for folder /);
	assert.equal(first.slice(first.indexOf(" for folder ") + " for folder ".length), dir);
	assert.match(second, /^(?:no worker shows as connected to this queue: start one with `pi-dispatch worker`\.|\d+ workers? (?:is|are) connected to this queue and will pick it up\.|the queue is paused: no worker takes it until `pi-dispatch resume`\.)$/);
	assert.deepEqual(rest, [""]);
	assert.ok(!out.includes("to process it"), "the old line, false while a worker runs, is gone");
});

// Issue #530: `run`'s closing line used to say "run `pi-dispatch worker` to process it" while workers were running.
// Rows as bullmq's getWorkers returns them: CLIENT LIST fields, `db` a string. The fake client is on database 0.
const row = (name, db = "0") => ({ name, db });
const fakeQueue = ({ workers = [], paused = false, client = { options: { db: 0 } } } = {}) => ({
	getWorkers: typeof workers === "function" ? workers : async () => workers,
	isPaused: typeof paused === "function" ? paused : async () => paused,
	client: typeof client === "function" ? client() : Promise.resolve(client),
});

test("workerHint says what the queue shows, and falls back to a line true either way (#530)", async () => {
	assert.equal(await workerHint(fakeQueue()), "no worker shows as connected to this queue: start one with `pi-dispatch worker`.");
	assert.equal(await workerHint(fakeQueue({ workers: [row("a")] })), "1 worker is connected to this queue and will pick it up.");
	assert.equal(await workerHint(fakeQueue({ workers: [row("a"), row("b")] })), "2 workers are connected to this queue and will pick it up.");
	// PR #531's review: CLIENT LIST spans databases, so only the queue client's own database counts.
	assert.equal(await workerHint(fakeQueue({ workers: [row("a", "8")] })), "no worker shows as connected to this queue: start one with `pi-dispatch worker`.");
	assert.equal(await workerHint(fakeQueue({ workers: [row("a", "8"), row("b", "9")], client: { options: { db: 9 } } })), "1 worker is connected to this queue and will pick it up.");
	assert.equal(await workerHint(fakeQueue({ workers: [row("a")], client: { options: {} } })), "1 worker is connected to this queue and will pick it up.", "no db option is database 0");
	// A connected worker takes nothing from a paused queue, so that is said first.
	assert.equal(await workerHint(fakeQueue({ workers: [row("a")], paused: true })), "the queue is paused: no worker takes it until `pi-dispatch resume`.");
	const doubts = {
		"CLIENT LIST refused": fakeQueue({ workers: async () => { throw new Error("NOPERM this user has no permissions to run the 'client|list' command"); } }),
		"isPaused failed": fakeQueue({ workers: [row("a")], paused: async () => { throw new Error("Connection is closed."); } }),
		"a row with no db": fakeQueue({ workers: [{ name: "a" }] }),
		"the client's database unreadable": fakeQueue({ workers: [row("a")], client: () => Promise.reject(new Error("closed")) }),
		"a database that is not a number": fakeQueue({ workers: [row("a")], client: { options: { db: "x" } } }),
		"bullmq's no-CLIENT-LIST row": fakeQueue({ workers: [{ name: "GCP does not support client list" }] }),
		"not an array": fakeQueue({ workers: 3 }),
		"not a boolean": fakeQueue({ paused: "0" }),
		"a synchronous throw": { getWorkers() { throw new Error("boom"); }, isPaused: async () => false, client: Promise.resolve({ options: { db: 0 } }) },
	};
	for (const [why, queue] of Object.entries(doubts)) assert.equal(await workerHint(queue), WORKER_HINT_UNKNOWN, why);
	// An answer that never comes is not waited on past the bound.
	const start = Date.now();
	assert.equal(await workerHint(fakeQueue({ workers: () => new Promise(() => {}) }), { timeoutMs: 20 }), WORKER_HINT_UNKNOWN);
	assert.ok(Date.now() - start < 2000);
	assert.equal(WORKER_HINT_UNKNOWN, "a worker picks it up; start one with `pi-dispatch worker` if none is running.");
});

test("workerHint against a real Valkey: another database's worker, then one, then paused, on a queue of its own (#530, VALKEY_TEST_URL)", { skip: needsDeps || (process.env.VALKEY_TEST_URL ? false : "needs VALKEY_TEST_URL") }, async () => {
	const { Worker } = await import("bullmq");
	const { parseConnection } = await import("../src/connection.mjs");
	const { makeQueue } = await import("../src/queue.mjs");
	const onDb = (db) => {
		const u = new URL(process.env.VALKEY_TEST_URL);
		u.pathname = `/${db}`;
		return u.toString();
	};
	const name = `pi-jobs-test-530-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const queue = makeQueue(parseConnection(onDb(9), { failFast: true }), { name });
	const elsewhere = makeQueue(parseConnection(onDb(8), { failFast: true }), { name });
	const workers = [];
	const startWorker = async (db) => {
		const worker = new Worker(name, async () => {}, { connection: { ...parseConnection(onDb(db)), maxRetriesPerRequest: null }, name: `host530-db${db}` });
		worker.on("error", () => {});
		workers.push(worker);
		await worker.waitUntilReady();
	};
	const seen = async (n) => {
		const deadline = Date.now() + 10_000;
		while ((await queue.getWorkers()).length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
		assert.equal((await queue.getWorkers()).length, n, "bullmq's own list sees every same-named worker, whatever its database");
	};
	try {
		await queue.add("t", {}, { delay: 600_000 });
		assert.equal(await workerHint(queue), "no worker shows as connected to this queue: start one with `pi-dispatch worker`.");
		// PR #531's review: a same-named queue's Worker on database 8 never takes a job queued on database 9.
		await startWorker(8);
		await seen(1);
		assert.equal(await workerHint(queue), "no worker shows as connected to this queue: start one with `pi-dispatch worker`.");
		await startWorker(9);
		await seen(2);
		assert.equal(await workerHint(queue), "1 worker is connected to this queue and will pick it up.");
		await queue.pause();
		assert.equal(await workerHint(queue), "the queue is paused: no worker takes it until `pi-dispatch resume`.");
	} finally {
		for (const worker of workers) await worker.close();
		for (const q of [queue, elsewhere]) {
			await q.obliterate({ force: true }).catch(() => {});
			await q.close();
		}
	}
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

// --- pi-dispatch run --trigger <cron id> (issue #505): fire one cron trigger now, once, as its schedule would ---

const PM = (folder, run = {}) => ({ on: { type: "cron", id: "pm-weekly", pattern: "0 6 1 1 *" }, run: { kind: "local", folder, flow: "pm", task: "plan the week", provider: "ollama", model: "qwen2.5:3b", github: false, packages: false, resume: false, portfolio: true, ...run } });
const LABEL_WITH_ID = { on: { type: "label", id: "triage", any: ["pi:triage"] }, run: { kind: "github", flow: "triage" } };

/** `main` with stderr captured; the refusal seam fails the test if Valkey is asked, so "nothing queued" is measured. */
async function refusedTrigger(argv, env2) {
	const err = [];
	const realErr = process.stderr.write;
	process.stderr.write = (chunk) => (err.push(String(chunk)), true);
	let code;
	try {
		code = await main(argv, env2, { valkeyRefusal: async () => assert.fail("reached Valkey"), write: () => assert.fail("printed a queued line") });
	} finally {
		process.stderr.write = realErr;
	}
	return { code, err: err.join("") };
}

function triggersFile(triggers) {
	const dir = tempDir("cli-trigger-");
	const path = join(dir, "triggers.json");
	writeFileSync(path, JSON.stringify({ triggers }));
	return { dir, path };
}

test("run --trigger refuses an unknown id, a webhook trigger's id and a file the loader refuses, before Valkey (#505)", async () => {
	const { dir, path } = triggersFile([PM(tempDir("cli-pm-")), LABEL_WITH_ID]);
	const env2 = { VALKEY_URL: "redis://127.0.0.1:1", PI_TRIGGERS_FILE: path };
	const unknown = await refusedTrigger(["run", "--trigger", "nope"], env2);
	assert.equal(unknown.code, 1);
	assert.equal(unknown.err, `error: no cron trigger with id "nope" in ${path}. Nothing was queued.\n`);
	const webhook = await refusedTrigger(["run", "--trigger", "triage"], env2);
	assert.equal(webhook.code, 1);
	assert.equal(webhook.err, `error: trigger "triage" is a label trigger: only a cron trigger can be fired by hand. Nothing was queued.\n`);
	writeFileSync(path, JSON.stringify({ triggers: [PM(dir, { portfolio: "yes" })] }));
	const bad = await refusedTrigger(["run", "--trigger", "pm-weekly"], env2);
	assert.equal(bad.code, 1);
	assert.match(bad.err, /run\.portfolio must be true or false when present: .*\. Nothing was queued\.\n$/);
});

test("run --trigger takes no folder and no other run flag: the trigger's own fields are what runs (#505)", async () => {
	const { path } = triggersFile([PM(tempDir("cli-pm-"))]);
	const env2 = { VALKEY_URL: "redis://127.0.0.1:1", PI_TRIGGERS_FILE: path };
	for (const extra of [["/some/folder"], ["--task", "x"], ["--flow", "f"], ["--model", "m"], ["--provider", "p"], ["--max-turns", "3"], ["--image", "i:1"], ["--force"]]) {
		const r = await refusedTrigger(["run", "--trigger", "pm-weekly", ...extra], env2);
		assert.equal(r.code, 1, extra.join(" "));
		assert.match(r.err, /^error: --trigger takes no folder and no other flag \(got .+\): the trigger's own fields are what runs\. Nothing was queued\.\n$/);
	}
});

test("run --trigger with no file, and a trigger whose folder is another host's, both refuse before Valkey (#505)", async () => {
	const missing = await refusedTrigger(["run", "--trigger", "pm-weekly"], { VALKEY_URL: "redis://127.0.0.1:1", PI_TRIGGERS_FILE: join(tempDir("cli-none-"), "triggers.json") });
	assert.equal(missing.code, 1);
	assert.match(missing.err, /^error: no triggers file at .+triggers\.json\. Set PI_TRIGGERS_FILE or run this from the deployment folder\. Nothing was queued\.\n$/);
	// On a fleet a folder that is not here is another machine's (cronPlacement): queued here, no worker could run it.
	const { path } = triggersFile([PM("/no/such/folder/on/this/host")]);
	const elsewhere = await refusedTrigger(["run", "--trigger", "pm-weekly"], { VALKEY_URL: "redis://127.0.0.1:1", PI_TRIGGERS_FILE: path, PI_WORKER_NAME: "mini1" });
	assert.equal(elsewhere.code, 1);
	assert.equal(elsewhere.err, `error: cron trigger "pm-weekly" runs on another host: its folder is not on this machine. Run this command on the host that has the folder. Nothing was queued.\n`);
});

test("run --trigger enqueues the trigger's schedule data whole on this host's queue, and a second call in the same minute queues nothing (#505, VALKEY_TEST_URL)", { skip: needsDeps || (process.env.VALKEY_TEST_URL ? false : "needs VALKEY_TEST_URL") }, async () => {
	// Dirty on purpose: a scheduled tick runs on uncommitted changes, and so does a hand fire.
	const folder = gitRepo({ dirty: true });
	const { path } = triggersFile([PM(folder)]);
	// A worker name of this test's own, so the job lands on a host queue nothing drains: never on the shared one.
	const host = `t505-${process.pid}-${Date.now()}`;
	const env2 = { VALKEY_URL: process.env.VALKEY_TEST_URL, PI_TRIGGERS_FILE: path, PI_WORKER_NAME: host };
	const now = () => new Date("2026-10-05T06:00:31Z");
	const minute = Date.parse("2026-10-05T06:00:00Z");
	const { Queue } = await import("bullmq");
	const { parseConnection } = await import("../src/connection.mjs");
	const queue = new Queue(`pi-jobs@${host}`, { connection: parseConnection(process.env.VALKEY_TEST_URL) });
	try {
		let out = "";
		const write = (chunk) => ((out += chunk), true);
		assert.equal(await main(["run", "--trigger", "pm-weekly"], env2, { write, now }), 0);
		assert.match(out, new RegExp(`^queued manual:pm-weekly:${minute} for cron trigger pm-weekly\\n`));
		const job = await queue.getJob(`manual:pm-weekly:${minute}`);
		assert.ok(job, "stored under the BullMQ-accepted three-part id, on this host's queue");
		const { enqueueNonce, ...data } = job.data;
		assert.equal(typeof enqueueNonce, "string");
		// Exactly the schedule's data, as the scheduler would have stored it (JSON: undefined keys dropped).
		assert.deepEqual(data, { kind: "local", folder, flow: "pm", task: "plan the week", provider: "ollama", model: "qwen2.5:3b", github: false, packages: false, resume: false, portfolio: true, trigger: { id: "pm-weekly", pattern: "0 6 1 1 *" } });
		assert.equal(job.name, "local");
		assert.ok((job.opts.attempts ?? 0) <= 1, `run once, as a scheduled tick is (attempts ${job.opts.attempts}); \`pi-dispatch run\` sets 2`);
		assert.equal(job.opts.backoff, undefined);
		out = "";
		assert.equal(await main(["run", "--trigger", "pm-weekly"], env2, { write, now: () => new Date("2026-10-05T06:00:59Z") }), 0);
		assert.match(out, new RegExp(`^an identical run was queued at \\d\\d:\\d\\d as manual:pm-weekly:${minute} \\(waiting\\); nothing new was queued\\.\\nthe same trigger queues a new run from the next minute on\\.\\n$`));
		assert.equal((await queue.getJobCounts("waiting")).waiting, 1);
	} finally {
		await queue.obliterate({ force: true }).catch(() => {});
		await queue.close();
	}
});

test("run --trigger finds the cron trigger even when a webhook entry before it spells the same id (#505 review)", async () => {
	// The folder is not on this machine and the deployment is a fleet, so a found cron trigger ends at the placement
	// refusal: proof it was found, before Valkey. A webhook-first lookup said "is a label trigger" instead.
	const { path } = triggersFile([{ ...LABEL_WITH_ID, on: { ...LABEL_WITH_ID.on, id: "pm-weekly" } }, PM("/no/such/folder/on/this/host")]);
	const r = await refusedTrigger(["run", "--trigger", "pm-weekly"], { VALKEY_URL: "redis://127.0.0.1:1", PI_TRIGGERS_FILE: path, PI_WORKER_NAME: "mini1" });
	assert.equal(r.err, `error: cron trigger "pm-weekly" runs on another host: its folder is not on this machine. Run this command on the host that has the folder. Nothing was queued.\n`);
});

test("run --trigger refuses a trigger whose folder is not a git repository, as run <folder> does (#505 review)", async () => {
	const plain = tempDir("cli-pm-plain-");
	const { path } = triggersFile([PM(plain)]);
	const r = await refusedTrigger(["run", "--trigger", "pm-weekly"], { VALKEY_URL: "redis://127.0.0.1:1", PI_TRIGGERS_FILE: path });
	assert.equal(r.code, 1);
	assert.match(r.err, /^error: cron trigger "pm-weekly": .* is not a git repository\. .*Nothing was queued\.\n$/);
});

test("run --trigger reads PI_TRIGGERS_FILE and PI_WORKER_NAME from the deployment .env when this shell sets neither (#505 review)", async () => {
	const deploy = tempDir("cli-deploy-");
	const { path } = triggersFile([PM("/no/such/folder/on/this/host")]);
	writeFileSync(join(deploy, ".env"), `PI_TRIGGERS_FILE=${path}\nPI_WORKER_NAME=mini1\nVALKEY_URL=redis://127.0.0.1:1\n`);
	const prev = process.cwd();
	process.chdir(deploy);
	try {
		// Both from the file: the trigger is found in ITS triggers file, and the fleet placement (a named host) applies.
		const r = await refusedTrigger(["run", "--trigger", "pm-weekly"], {});
		assert.equal(r.err, `error: cron trigger "pm-weekly" runs on another host: its folder is not on this machine. Run this command on the host that has the folder. Nothing was queued.\n`);
		// A shell that disagrees with the file is refused, naming both: the job would land where the service is not.
		const d = await refusedTrigger(["run", "--trigger", "pm-weekly"], { PI_WORKER_NAME: "mini2" });
		assert.equal(d.err, `error: PI_WORKER_NAME is "mini2" in this shell and "mini1" in ${join(process.cwd(), ".env")}: make them agree (the service runs the file's). Nothing was queued.\n`);
	} finally {
		process.chdir(prev);
	}
});

test("cliDeploymentEnv: this shell's value, else the .env's, a disagreement or an unreadable line refused (#505 review)", () => {
	const at = (text) => ({ cwd: "/d", platform: "linux", readFile: () => Buffer.from(text) });
	const keys = ["PI_WORKER_NAME", "PI_TRIGGERS_FILE"];
	assert.deepEqual(cliDeploymentEnv({ X: "1" }, keys, at("PI_WORKER_NAME=mini1\n")).env, { X: "1", PI_WORKER_NAME: "mini1" });
	assert.deepEqual(cliDeploymentEnv({ PI_WORKER_NAME: "mini1" }, keys, at("PI_WORKER_NAME=mini1\n")).env, { PI_WORKER_NAME: "mini1" }, "agreeing values");
	assert.deepEqual(cliDeploymentEnv({ PI_WORKER_NAME: "mini1" }, keys, at("")).env, { PI_WORKER_NAME: "mini1" }, "a key only this shell sets is the shell's");
	assert.match(cliDeploymentEnv({ PI_WORKER_NAME: "a" }, keys, at("PI_WORKER_NAME=b\n")).problem, /^PI_WORKER_NAME is "a" in this shell and "b" in \/d\/\.env: make them agree/);
	assert.match(cliDeploymentEnv({}, keys, at('PI_TRIGGERS_FILE="$HOME/t.json"\n')).problem, /has a line for PI_TRIGGERS_FILE that the service's loader may read differently/);
	const missing = { cwd: "/d", readFile: () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); } };
	assert.deepEqual(cliDeploymentEnv({ A: "1" }, keys, missing).env, { A: "1" }, "no .env: this shell alone");
	const denied = { cwd: "/d", readFile: () => { throw Object.assign(new Error("nope"), { code: "EACCES" }); } };
	assert.match(cliDeploymentEnv({}, keys, denied).problem, /^\/d\/\.env could not be read \(EACCES\), so PI_WORKER_NAME and PI_TRIGGERS_FILE cannot be told$/);
	assert.deepEqual(cliDeploymentEnv({ PI_WORKER_NAME: "a", PI_TRIGGERS_FILE: "/t" }, keys, denied).env, { PI_WORKER_NAME: "a", PI_TRIGGERS_FILE: "/t" }, "both set here: nothing to tell");
});

test("run <folder> queues on the host queue the deployment .env names when this shell sets no PI_WORKER_NAME (#505 review, VALKEY_TEST_URL)", { skip: needsDeps || (process.env.VALKEY_TEST_URL ? false : "needs VALKEY_TEST_URL") }, async () => {
	const deploy = tempDir("cli-deploy-run-");
	const host = `t505run-${process.pid}-${Date.now()}`;
	writeFileSync(join(deploy, ".env"), `PI_WORKER_NAME=${host}\n`);
	const dir = gitRepo({ dirty: false });
	const { Queue } = await import("bullmq");
	const { parseConnection } = await import("../src/connection.mjs");
	const queue = new Queue(`pi-jobs@${host}`, { connection: parseConnection(process.env.VALKEY_TEST_URL) });
	const prev = process.cwd();
	process.chdir(deploy);
	try {
		let out = "";
		assert.equal(await main(["run", dir, "--task", "tidy", "--force"], { VALKEY_URL: process.env.VALKEY_TEST_URL }, { write: (c) => ((out += c), true) }), 0);
		const jobId = /^queued (\S+) for folder /m.exec(out)?.[1];
		assert.ok(jobId, out);
		assert.ok(await queue.getJob(jobId), "on the .env's host queue, never the shared one");
	} finally {
		process.chdir(prev);
		await queue.obliterate({ force: true }).catch(() => {});
		await queue.close();
	}
});

test("run --trigger refuses what the worker's loader refuses: PI_MAX_COST_USD from the deployment .env is applied (#505 review)", async () => {
	const deploy = tempDir("cli-deploy-cap-");
	const { path } = triggersFile([PM(gitRepo({ dirty: false }), { maxCostUsd: "2" })]);
	writeFileSync(join(deploy, ".env"), `PI_TRIGGERS_FILE=${path}\nPI_MAX_COST_USD=1\nVALKEY_URL=redis://127.0.0.1:1\n`);
	const prev = process.cwd();
	process.chdir(deploy);
	try {
		const r = await refusedTrigger(["run", "--trigger", "pm-weekly"], {});
		assert.equal(r.code, 1);
		assert.match(r.err, /^error: trigger at index 0: run\.maxCostUsd is above this deployment's PI_MAX_COST_USD\. .*Nothing was queued\.\n$/);
	} finally {
		process.chdir(prev);
	}
});

test("TRIGGER_LOADER_ENV_KEYS covers every config value loadSchedules reads, so run --trigger judges a file as the worker does (#505 review)", () => {
	// A bolt, not a hope: a new config input to the loader that this list misses would let the command fire an entry
	// the worker refuses. Read from loadSchedules' own source; `fleet` arrives as PI_WORKER_NAME (workerNameDeclared).
	const src = readFileSync(new URL("../src/schedules.mjs", import.meta.url), "utf8");
	const start = src.indexOf("export function loadSchedules(");
	const body = src.slice(start, src.indexOf("\n}\n", start));
	const read = [...new Set([...body.matchAll(/config\.(\w+)/g)].map((m) => m[1]))].sort();
	const ENV_OF = { triggersFile: "PI_TRIGGERS_FILE", maxCostUsd: "PI_MAX_COST_USD" };
	assert.deepEqual(read, Object.keys(ENV_OF).sort(), "loadSchedules reads a config value this bolt does not map");
	assert.deepEqual([...TRIGGER_LOADER_ENV_KEYS].sort(), [...Object.values(ENV_OF), "PI_WORKER_NAME"].sort());
});
