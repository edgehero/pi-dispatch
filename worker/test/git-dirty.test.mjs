import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GIT_READ_FLAGS } from "../src/git-hardening.mjs";
import { gitDirty } from "../src/git-dirty.mjs";

// --- against a REAL git repo: the dirty/clean/not-a-repo contract ---

function gitRepo({ dirty }) {
	const dir = mkdtempSync(join(tmpdir(), "gd-git-"));
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

test("a clean working tree -> false", () => {
	assert.equal(gitDirty(gitRepo({ dirty: false })), false);
});

test("a dirty working tree -> true", () => {
	assert.equal(gitDirty(gitRepo({ dirty: true })), true);
});

test("a non-git folder -> null", () => {
	assert.equal(gitDirty(mkdtempSync(join(tmpdir(), "gd-plain-"))), null);
});

// --- injected exec unit cases: no real git needed ---

test("injected exec: nonempty porcelain output -> true", () => {
	assert.equal(gitDirty("/any", { exec: () => " M f.txt\n" }), true);
});

test("injected exec: empty or whitespace-only output -> false", () => {
	assert.equal(gitDirty("/any", { exec: () => "" }), false);
	assert.equal(gitDirty("/any", { exec: () => "   \n" }), false);
});

test("injected exec: a throwing exec (not a repo) -> null", () => {
	assert.equal(
		gitDirty("/any", {
			exec: () => {
				throw new Error("fatal: not a git repository");
			},
		}),
		null,
	);
});

test("injected exec receives the porcelain status args for the folder", () => {
	let received;
	gitDirty("/some/folder", {
		exec: (bin, args) => {
			received = { bin, args };
			return "";
		},
	});
	assert.equal(received.bin, "git");
	// The hardening rides in FRONT of the subcommand, and this is the site where it is load-bearing rather
	// than defensive: `status` refreshes the index, so it invokes `core.fsmonitor`, and the folder it reads
	// is the one a local job mounts writable at /workspace. An agent that writes `.git/config` there gets
	// its command run on the HOST by the next `pi-dispatch run`.
	assert.deepEqual(received.args, [...GIT_READ_FLAGS, "-C", "/some/folder", "status", "--porcelain"]);
	assert.ok(received.args.includes("core.fsmonitor=false"), "the flag that actually stops the hook must be present");
});
