import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { GIT_READ_FLAGS } from "../src/git-hardening.mjs";
import { gitDirty, localRepoProblem } from "../src/git-dirty.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// --- against a REAL git repo: the dirty/clean/not-a-repo contract ---

function gitRepo({ dirty }) {
	const dir = tempDir("gd-git-");
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
	assert.equal(gitDirty(tempDir("gd-plain-")), null);
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

// --- localRepoProblem (issue #524): the worker's folder rule, said before anything is queued ---

test("localRepoProblem: a committed repository's root passes", () => {
	assert.equal(localRepoProblem(gitRepo({ dirty: false })), null);
	assert.equal(localRepoProblem(gitRepo({ dirty: true })), null, "dirtiness is the --force guard's business, not this one's");
});

test("localRepoProblem: a plain folder is named as not a repository, with git init as the fix", () => {
	const plain = tempDir("gd-plain-");
	const said = localRepoProblem(plain);
	assert.match(said, /is not a git repository/);
	assert.ok(said.includes(plain), "the folder is named");
	assert.match(said, /git init/);
});

test("localRepoProblem: a subfolder of a repository names BOTH fixes, the root only as git confirms it", () => {
	const repo = realpathSync(gitRepo({ dirty: false }));
	const sub = join(repo, "src", "deep");
	mkdirSync(sub, { recursive: true });
	const said = localRepoProblem(sub);
	assert.equal(said, `${sub} is not the root of a git repository, and a local job needs one. Run \`git init\` here and commit, or, if this folder belongs to the repository at ${repo}, run it on ${repo}.`);
});

test("localRepoProblem: a parent with an empty .git directory is not a repository, so the folder reads as plain (PR #528 review)", () => {
	const parent = tempDir("gd-fakegit-");
	mkdirSync(join(parent, ".git"));
	const child = join(parent, "work");
	mkdirSync(child);
	assert.equal(localRepoProblem(child), `${child} is not a git repository. A local job needs one: run \`git init\` there and commit, then run again.`);
});

test("localRepoProblem: under a dotfiles-style repository (everything ignored) both options are named, never the root alone (PR #528 review)", () => {
	// `git init` in a home directory with `*` in .gitignore contains every folder under it. "Run it on <home>" alone
	// would read clean and hand the agent the whole home directory.
	const home = realpathSync(tempDir("gd-home-"));
	const g = (args) => execFileSync("git", ["-C", home, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
	g(["init", "-q"]);
	writeFileSync(join(home, ".gitignore"), "*\n");
	g(["add", "-f", ".gitignore"]);
	g(["commit", "-qm", "dotfiles"]);
	const project = join(home, "code", "project");
	mkdirSync(project, { recursive: true });
	const said = localRepoProblem(project);
	assert.match(said, /Run `git init` here and commit, or, if this folder belongs to the repository at /);
	assert.ok(said.includes(`at ${home}, run it on ${home}.`), said);
});

test("localRepoProblem: the parent question goes to git, hardened, and a git that does not answer reads as plain", () => {
	const seen = [];
	const exec = (_cmd, args) => {
		seen.push(args);
		throw Object.assign(new Error("fatal"), { status: 128 });
	};
	assert.match(localRepoProblem("/x/y", { exists: () => false, exec }), /is not a git repository\./);
	assert.deepEqual(seen, [[...GIT_READ_FLAGS, "-C", "/x/y", "rev-parse", "--show-toplevel"]]);
});

test("localRepoProblem: a repository with no commit is refused, since the worker reads HEAD", () => {
	const dir = tempDir("gd-empty-");
	execFileSync("git", ["-C", dir, "init", "-q"]);
	assert.match(localRepoProblem(dir), /no commit yet/);
});

test("localRepoProblem: the HEAD read is hardened, and a missing git is said as that, not as a missing commit", () => {
	const seen = [];
	const exists = () => true;
	assert.equal(localRepoProblem("/r", { exists, exec: (cmd, args) => (seen.push([cmd, args]), "abc\n") }), null);
	assert.deepEqual(seen[0][1].slice(0, GIT_READ_FLAGS.length), GIT_READ_FLAGS);
	const noGit = () => {
		throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
	};
	assert.match(localRepoProblem("/r", { exists, exec: noGit }), /git is not installed/);
	const unreadable = () => {
		throw Object.assign(new Error("fatal: not a git repository"), { status: 128 });
	};
	assert.match(localRepoProblem("/r", { exists, exec: unreadable }), /is not a usable git repository: git could not read it/, "only exit 1 means no commit");
});

test("localRepoProblem: a .git git refuses (a worktree whose gitdir is gone, exit 128) reads as unusable, matching the worker's local-folder-unreadable-repo", () => {
	// A missing gitdir rather than GIT_TEST_ASSUME_DIFFERENT_OWNER: the ownership switch refused here and did not on
	// CI's runner (measured on PR #528), while a gitdir that is gone fails the same way everywhere, trust settings or not.
	const dir = tempDir("gd-orphan-");
	writeFileSync(join(dir, ".git"), `gitdir: ${join(dir, "gone")}\n`);
	assert.match(localRepoProblem(dir), /is not a usable git repository: git could not read it/);
});

test("localRepoProblem: a garbage branch ref and a missing commit object read as unusable, never as no commit yet (PR #528 review, round 2)", () => {
	for (const content of ["zzzz-not-a-sha\n", `${"1".repeat(40)}\n`]) {
		const repo = gitRepo({ dirty: false });
		const branch = execFileSync("git", ["-C", repo, "symbolic-ref", "HEAD"], { encoding: "utf8" }).trim();
		writeFileSync(join(repo, ".git", branch), content);
		const said = localRepoProblem(repo);
		assert.match(said, /is not a usable git repository/, content);
		assert.doesNotMatch(said, /no commit yet/);
	}
});
