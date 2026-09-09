import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GIT_READ_FLAGS } from "../src/git-hardening.mjs";
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

test("a folder that cannot be STATTED is retryable, not 'does not exist'", async () => {
	// Issue #316. `existsSync` returns false for every stat error, not only ENOENT, so EACCES on a parent
	// directory, EIO on a failing disk and a hung or not-yet-mounted autofs path all reported "local folder
	// does not exist". Since #310 that verdict refunds the reserve, never retries the delivery, and posts a
	// public comment telling the issue author the operator's deployment is misconfigured, about a folder
	// that is right there.
	//
	// The `fs` seam exists because a chmod cannot express this: root ignores permissions, Windows differs,
	// and EIO has no filesystem you can build in a test at all.
	for (const code of ["EACCES", "EIO", "ETIMEDOUT", "ESTALE", "EMFILE", "EAGAIN"]) {
		const fs = { ...realFs, statSync: () => { throw Object.assign(new Error(`${code}: simulated`), { code }); } };
		await assert.rejects(
			() => prepareLocalWorkspace({ folder: "/mnt/project", task: "x", jobDir: "/tmp/x", fs }),
			(e) => e.piDispatchRetry === true && e.piDispatchConfig === undefined,
			`${code} means the folder is out of reach, never that it is absent`,
		);
	}
});

test("ENOENT and ENOTDIR still refuse determinately, and still name which check failed", async () => {
	// The bound on the test above: absence is genuinely determinate, and the two messages must stay
	// distinguishable or an operator cannot tell "wrong path" from "not a git repository".
	// ELOOP and ENAMETOOLONG join absence: a symlink cycle and an over-long name resolve identically
	// forever, so retrying either is paying to be told so twice.
	for (const code of ["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"]) {
		const fs = { ...realFs, statSync: () => { throw Object.assign(new Error(`${code}: simulated`), { code }); } };
		await assert.rejects(
			() => prepareLocalWorkspace({ folder: "/mnt/project", task: "x", jobDir: "/tmp/x", fs }),
			(e) => e.piDispatchConfig === true && /local folder does not exist/.test(e.message),
			`${code} is absence`,
		);
	}
});

test("a transient fault on .git alone is retryable, and does not read as 'not a git repository'", async () => {
	// The second check has the same hazard as the first and a worse message: telling an operator their
	// repository is not a repository, because one stat of `.git` hit EACCES.
	const fs = {
		...realFs,
		statSync: (p) => {
			if (String(p).endsWith(".git")) throw Object.assign(new Error("EACCES: simulated"), { code: "EACCES" });
			return { isDirectory: () => true };
		},
	};
	await assert.rejects(
		() => prepareLocalWorkspace({ folder: "/mnt/project", task: "x", jobDir: "/tmp/x", fs }),
		(e) => e.piDispatchRetry === true && !/not a git repository/.test(e.message),
	);
});

test("the transient-fault message carries the BASENAME, never the absolute path (issue #289)", async () => {
	// An InfraRetry survives retries and its message becomes the queue's failedReason and the job_failed
	// line -- and a full host path there carries an OS account name, buildRecord's own reason for
	// reducing folders to basenames. The FAILED panel section renders exactly this string.
	const fs = {
		...realFs,
		statSync: () => {
			throw Object.assign(new Error("EIO: simulated"), { code: "EIO" });
		},
	};
	await assert.rejects(
		() => prepareLocalWorkspace({ folder: "/Users/some-account/secret-client-project", task: "x", jobDir: "/tmp/x", fs }),
		(e) => e.piDispatchRetry === true && e.message.includes("secret-client-project") && !e.message.includes("/Users/") && !e.message.includes("some-account"),
		"the basename is diagnostic; the account name above it is not the queue's to keep for 7 days",
	);
});

test("a worktree's .git is a FILE, and statSync accepts it exactly as existsSync did", async () => {
	// The reason this check uses `statSync` rather than a directory test: `.git` is a FILE in a worktree
	// and in a submodule, and both are ordinary things to point a local job at.
	const seen = [];
	const fs = {
		...realFs,
		statSync: (p) => {
			seen.push(String(p));
			return { isDirectory: () => false, isFile: () => true };
		},
	};
	// Fails later, at the git call, which is past both existence checks: reaching that proves neither
	// refused, and reaching it is the whole assertion.
	await assert.rejects(
		() => prepareLocalWorkspace({ folder: "/mnt/wt", task: "x", jobDir: "/tmp/x", fs, git: async () => { throw new Error("past the checks"); } }),
		(e) => /past the checks/.test(e.message),
	);
	assert.deepEqual(seen, ["/mnt/wt", "/mnt/wt/.git"], "both paths are statted, in order, and a file is accepted");
});

// ── The host-side git argv (issue #286's sweep) ─────────────────────────────────────────────────
//
// `prepare-local`'s own git was the one copy of seven missing `core.fsmonitor=false`. The existing tests
// here drive the REAL default git against a temp repo, so they exercise the flags and can never see them
// -- which is how the omission survived, and why the guard below reads SOURCE rather than behaviour.
test("prepare-local's host-side git spreads the shared hardening, not a copy of it", () => {
	// Asserted against the SOURCE, deliberately. `prepareLocalWorkspace` takes an injected `git` that
	// replaces `defaultGit` wholesale, so the flags are structurally invisible through the seam: a test
	// driving the seam and then asserting GIT_READ_FLAGS' own contents proves only that the constant is
	// what it is, and stays green with the fix reverted. That test was written first and it was hollow.
	const src = readFileSync(fileURLToPath(new URL("../src/prepare-local.mjs", import.meta.url)), "utf8");
	assert.match(src, /exec\("git", \[\.\.\.GIT_READ_FLAGS,/, "prepare-local must spread the shared constant into its git argv");
});

/**
 * EVERY host-side `git` invocation carries the hardening -- a COVERAGE scan, not a copy detector.
 *
 * The first version of this guard grepped for the flag names as quoted argv tokens, which finds a file
 * that spells them out and misses the two failure modes that actually happened. It could be evaded by
 * writing the same literals in single quotes -- verified, the original defect reinstated that way shipped
 * green -- and, worse, it was blind by construction to a site carrying NO flags at all. That is exactly
 * how `git-dirty.mjs` was missed: the census that found "seven sites" grepped for flags that were
 * PRESENT, and the one running `git status` on an agent-writable folder had none.
 *
 * So this enumerates the call sites instead and requires each argv to begin with the shared constant.
 * `receiver/` and `image/runner` are deliberately not scanned: neither invokes git at all, checked.
 */
test("every host-side git invocation begins with the shared hardening flags", () => {
	const offenders = [];
	for (const root of ["worker/src", "admin/src"]) {
		const dir = fileURLToPath(new URL(`../../${root}`, import.meta.url));
		for (const name of readdirSync(dir)) {
			if (!/\.(mjs|ts)$/.test(name) || name === "git-hardening.mjs") continue;
			const src = readFileSync(join(dir, name), "utf8");
			// Both call shapes in the tree: `exec("git", [ ... ])` and `runCmd(spawn, "git", [ ... ])`.
			for (const m of src.matchAll(/["'`]git["'`],\s*\[([^\]]*)/g)) {
				const argv = m[1].trimStart();
				if (!argv.startsWith("...GIT_READ_FLAGS") && !argv.startsWith("...GIT_SAFE_CONFIG") && !argv.startsWith("...HARDEN_FLAGS") && !argv.startsWith("...hardened")) {
					offenders.push(`${root}/${name}: git ${argv.split("\n")[0].trim().slice(0, 60)}`);
				}
			}
		}
	}
	assert.deepEqual(
		offenders,
		[],
		"every host-side git argv must start by spreading worker/src/git-hardening.mjs's constants -- a hostile repo config runs code on the HOST, outside any container, and `git status`/`check-ignore` really do invoke core.fsmonitor",
	);
});
