import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { PI_LIMITS } from "../src/materialize.mjs";
import { prepareLocalWorkspace } from "../src/prepare-local.mjs";

function git(dir, args) {
	return execFileSync("git", ["-C", dir, ...args], {
		encoding: "utf8",
		env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
	});
}

/** A local git repo with a .pi/ persona and skill, plus a working-tree file to "edit". */
function localRepo() {
	const dir = mkdtempSync(join(tmpdir(), "pi-local-"));
	git(dir, ["init", "-q"]);
	git(dir, ["config", "core.autocrlf", "false"]);
	const blob = (c) => execFileSync("git", ["-C", dir, "hash-object", "-w", "--stdin"], { input: c, encoding: "utf8" }).trim();
	git(dir, ["update-index", "--add", "--cacheinfo", `100644,${blob("LOCAL-PERSONA-SENTINEL")},.pi/APPEND_SYSTEM.md`]);
	git(dir, [
		"update-index",
		"--add",
		"--cacheinfo",
		`100644,${blob("---\nname: tidy\ndescription: tidy up\n---\nsteps\n")},.pi/skills/tidy/SKILL.md`,
	]);
	// a hostile symlink object, to prove the local path is as safe as the GitHub path
	git(dir, ["update-index", "--add", "--cacheinfo", `120000,${blob("/etc/passwd")},.pi/EVIL.md`]);
	git(dir, ["commit", "-qm", "x"]);
	return dir;
}

test("prepares a local git folder: materialises .pi/ from HEAD, writes the task, folder is /workspace", async () => {
	const folder = localRepo();
	const jobDir = mkdtempSync(join(tmpdir(), "pi-job-"));
	const result = await prepareLocalWorkspace({ folder, task: "please tidy the imports", jobDir });

	assert.equal(result.workspace, folder, "the folder itself is the workspace (edited in place)");
	assert.equal(readFileSync(join(jobDir, "prompt.md"), "utf8"), "please tidy the imports");
	assert.equal(readFileSync(join(jobDir, "pi/APPEND_SYSTEM.md"), "utf8"), "LOCAL-PERSONA-SENTINEL");
	assert.ok(result.materialised.includes("pi/skills/tidy/SKILL.md"));
	// the symlink is NOT materialised -- the local path inherits the git materialiser's safety
	assert.ok(!result.materialised.some((p) => p.includes("EVIL")), "a hostile symlink must not materialise locally either");
});

test("a .pi/ over a materialiser cap refuses the local job, writing no prompt.md (issue #60)", async () => {
	// Driven with a real oversized blob rather than a fake, because prepareLocalWorkspace calls the
	// materialiser directly and has no seam for it. One file past maxFileBytes is the cheapest breach.
	const dir = mkdtempSync(join(tmpdir(), "pi-local-big-"));
	git(dir, ["init", "-q"]);
	git(dir, ["config", "core.autocrlf", "false"]);
	const blob = (c) => execFileSync("git", ["-C", dir, "hash-object", "-w", "--stdin"], { input: c, encoding: "utf8" }).trim();
	git(dir, ["update-index", "--add", "--cacheinfo", `100644,${blob("---\nname: tidy\n---\nsteps\n")},.pi/skills/tidy/SKILL.md`]);
	git(dir, ["update-index", "--add", "--cacheinfo", `100644,${blob("x".repeat(PI_LIMITS.maxFileBytes + 1))},.pi/skills/tidy/huge.md`]);
	git(dir, ["commit", "-qm", "x"]);

	const jobDir = mkdtempSync(join(tmpdir(), "pi-job-"));
	const result = await prepareLocalWorkspace({ folder: dir, task: "tidy", jobDir });

	assert.deepEqual(result, { outcome: "policy", reason: "pi-file-too-large" });
	assert.equal(existsSync(join(jobDir, "prompt.md")), false, "prompt.md was written despite the refusal");
	assert.equal(existsSync(join(jobDir, "event.json")), false, "event.json was written despite the refusal");
	assert.equal(existsSync(join(jobDir, "pi")), false, "a partial /job/pi was written despite the refusal");
});

test("creates a writable /outbox host dir and returns its path (the container's chain-request channel)", async () => {
	const folder = localRepo();
	const jobDir = mkdtempSync(join(tmpdir(), "pi-job-"));
	const result = await prepareLocalWorkspace({ folder, task: "x", jobDir });
	assert.equal(result.outboxDir, join(jobDir, "outbox"), "outboxDir is <jobDir>/outbox");
	assert.ok(existsSync(result.outboxDir), "the outbox dir must exist on disk for the bind mount");
});

test("no GitHub anything: a local job needs no token, no repo, no network", async () => {
	// This test passing at all -- with no octokit, no token, no clone URL -- IS the assertion.
	const folder = localRepo();
	const jobDir = mkdtempSync(join(tmpdir(), "pi-job-"));
	const result = await prepareLocalWorkspace({ folder, task: "x", jobDir });
	assert.ok(result.sha.match(/^[0-9a-f]{40}$/), "resolved HEAD locally, offline");
});

test("writes /job/event.json unconditionally: read-only, parseable, defaulting to the manual shape", async () => {
	const folder = localRepo();
	const jobDir = mkdtempSync(join(tmpdir(), "pi-job-"));
	const result = await prepareLocalWorkspace({ folder, task: "x", jobDir });

	const path = join(jobDir, "event.json");
	assert.ok(existsSync(path), "event.json exists even when no event was passed");
	assert.equal(statSync(path).mode & 0o777, 0o444, "read-only, like prompt.md");

	const parsed = JSON.parse(readFileSync(path, "utf8"));
	assert.deepEqual(parsed, { source: "manual", folder: basename(folder), sha: result.sha }, "exactly the frozen manual shape");
	assert.deepEqual(Object.keys(parsed), ["source", "folder", "sha"], "frozen key order");
	assert.ok(parsed.sha.match(/^[0-9a-f]{40}$/), "sha is the resolved HEAD");
});

test("event.json carries the folder BASENAME only -- the full path (OS account name) never lands in /job", async () => {
	const folder = localRepo();
	const jobDir = mkdtempSync(join(tmpdir(), "pi-job-"));
	await prepareLocalWorkspace({ folder, task: "x", jobDir });

	const bytes = readFileSync(join(jobDir, "event.json"), "utf8");
	assert.ok(!bytes.includes(folder), "the full tmp folder path must not appear in the file bytes");
	assert.ok(bytes.includes(basename(folder)), "the basename identifies the folder");
});

test("a cron-shaped event lands as the full frozen cron shape with nulls preserved", async () => {
	const folder = localRepo();
	const jobDir = mkdtempSync(join(tmpdir(), "pi-job-"));
	const trigger = { id: "nightly-tidy", pattern: "0 3 * * *" };
	const result = await prepareLocalWorkspace({
		folder,
		task: "x",
		jobDir,
		event: { source: "cron", trigger, scheduledFor: null, previousRunAt: null },
	});

	const parsed = JSON.parse(readFileSync(join(jobDir, "event.json"), "utf8"));
	assert.deepEqual(parsed, {
		source: "cron",
		trigger,
		folder: basename(folder),
		sha: result.sha,
		scheduledFor: null,
		previousRunAt: null,
	});
	assert.deepEqual(
		Object.keys(parsed),
		["source", "trigger", "folder", "sha", "scheduledFor", "previousRunAt"],
		"frozen key order for the cron shape",
	);
});

test("a non-git folder is a clear config error, not a crash", async () => {
	const plain = mkdtempSync(join(tmpdir(), "pi-plain-"));
	await assert.rejects(
		() => prepareLocalWorkspace({ folder: plain, task: "x", jobDir: mkdtempSync(join(tmpdir(), "j-")) }),
		(e) => e.piDispatchConfig === true && /not a git repository/.test(e.message),
	);
});

test("a missing folder is a clear config error", async () => {
	await assert.rejects(
		() => prepareLocalWorkspace({ folder: "/does/not/exist/anywhere", task: "x", jobDir: "/tmp/x" }),
		(e) => e.piDispatchConfig === true,
	);
});
