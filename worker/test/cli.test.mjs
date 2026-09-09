import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli.mjs";

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
	const dir = mkdtempSync(join(tmpdir(), "cli-"));
	assert.equal(await main(["run", dir, "--flow", "tidy"], env), 1);
});

function gitRepo({ dirty }) {
	const dir = mkdtempSync(join(tmpdir(), "cli-git-"));
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

test("run enqueues against a real Valkey (VALKEY_TEST_URL) and prints the job id", { skip: process.env.VALKEY_TEST_URL ? false : "needs VALKEY_TEST_URL" }, async () => {
	const dir = gitRepo({ dirty: false });
	const code = await main(["run", dir, "--task", "tidy the imports", "--force"], { VALKEY_URL: process.env.VALKEY_TEST_URL });
	assert.equal(code, 0, "a clean enqueue against a real Valkey returns 0");
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
