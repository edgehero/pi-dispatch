import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as realFs from "node:fs";
import { existsSync, mkdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
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

/** An exec double answering rev-parse, config and status like git would, recording every call. */
function fakeGit({ status = "", revParse = "/r/.git\n/r/.git\nsha1\n" + "a".repeat(40) + "\n", fail = null } = {}) {
	const calls = [];
	const exec = (bin, args, opts) => {
		calls.push({ bin, args, opts });
		if (fail && args.includes(fail)) throw new Error("fatal: not a git repository");
		if (args.includes("rev-parse")) return revParse;
		if (args.includes("config")) throw Object.assign(new Error("none"), { status: 1 });
		return status;
	};
	return { exec, calls };
}

test("injected exec: nonempty porcelain output -> true", () => {
	assert.equal(gitDirty("/any", { exec: fakeGit({ status: " M f.txt\n" }).exec }), true);
});

test("injected exec: empty or whitespace-only output -> false", () => {
	assert.equal(gitDirty("/any", { exec: fakeGit({ status: "" }).exec }), false);
	assert.equal(gitDirty("/any", { exec: fakeGit({ status: "   \n" }).exec }), false);
});

test("injected exec: a throwing rev-parse (not a repo) or status -> null", () => {
	assert.equal(gitDirty("/any", { exec: fakeGit({ fail: "rev-parse" }).exec }), null);
	assert.equal(gitDirty("/any", { exec: fakeGit({ fail: "status" }).exec }), null);
	assert.equal(gitDirty("/any", { exec: fakeGit({ revParse: "relative\n/r/.git\nsha1\n" + "a".repeat(40) + "\n" }).exec }), null, "a path git did not make absolute");
	assert.equal(gitDirty("/any", { exec: fakeGit({ revParse: "/r/.git\n/r/.git\nsha1\nnot-a-sha\n" }).exec }), null);
});

test("injected exec: the status runs hardened against a scratch GIT_DIR, never with -C on the folder", () => {
	const { exec, calls } = fakeGit();
	gitDirty("/some/folder", { exec });
	assert.equal(calls[0].bin, "git");
	assert.deepEqual(calls[0].args.slice(0, GIT_READ_FLAGS.length + 2), [...GIT_READ_FLAGS, "-C", "/some/folder"], "the reads ride the hardening");
	const status = calls.find((c) => c.args.includes("status"));
	assert.ok(status.args.includes("core.fsmonitor=false"));
	assert.ok(!status.args.includes("-C"), "the status never names the folder as a repository");
	assert.equal(status.opts.env.GIT_WORK_TREE, "/some/folder");
	assert.notEqual(status.opts.env.GIT_DIR, "/r/.git", "the folder's own git directory is never the status's");
	assert.ok(status.args.includes("--ignore-submodules=all"), "a submodule's own config is never read either");
});

// --- the folder's git config is agent-writable (a local job mounts the folder): nothing in it may run on the host ---

/** A committed repository whose config and attributes name a filter that would touch `sentinel` if git ran it. */
function hostileRepo(how) {
	const dir = gitRepo({ dirty: false });
	const sentinel = join(tempDir("gd-sentinel-"), "ran");
	const cmd = `sh -c 'touch ${sentinel}; cat'`;
	const g = (args) => execFileSync("git", ["-C", dir, ...args]);
	if (how === "config") {
		g(["config", "filter.x.clean", cmd]);
		writeFileSync(join(dir, ".git", "info", "attributes"), "* filter=x\n");
	} else if (how === "process") {
		g(["config", "filter.x.process", cmd]);
		writeFileSync(join(dir, ".gitattributes"), "* filter=x\n");
	} else if (how === "include") {
		const inc = join(tempDir("gd-inc-"), "inc");
		// Quoted: in a config file an unquoted `;` starts a comment and would cut the command short.
		writeFileSync(inc, `[filter "x"]\n\tclean = "${cmd}"\n`);
		g(["config", "include.path", inc]);
		writeFileSync(join(dir, ".gitattributes"), "* filter=x\n");
	} else if (how === "fsmonitor") {
		g(["config", "core.fsmonitor", cmd]);
	}
	// Stat-dirty with the same bytes, then a real change: each forces git to hash the file through the filter.
	const later = new Date(Date.now() + 5000);
	utimesSync(join(dir, "f.txt"), later, later);
	return { dir, sentinel };
}

for (const how of ["config", "process", "include", "fsmonitor"]) {
	test(`a filter or monitor in the folder's own git config never runs on the host (${how})`, () => {
		const { dir, sentinel } = hostileRepo(how);
		// Stat-dirty with the same bytes is clean; the two that wrote an in-tree .gitattributes are dirty by that untracked file.
		assert.equal(gitDirty(dir), how === "process" || how === "include", "the answer is still right");
		writeFileSync(join(dir, "f.txt"), "changed\n");
		assert.equal(gitDirty(dir), true);
		assert.equal(existsSync(sentinel), false, "the agent-written command never ran");
	});
}

test("dirtiness the scratch read must still see: staged, untracked, and an untracked file info/exclude ignores", () => {
	const staged = gitRepo({ dirty: true });
	execFileSync("git", ["-C", staged, "add", "-A"]);
	assert.equal(gitDirty(staged), true, "a staged change");
	const untracked = gitRepo({ dirty: false });
	writeFileSync(join(untracked, "new.txt"), "x\n");
	assert.equal(gitDirty(untracked), true, "an untracked file");
	writeFileSync(join(untracked, ".git", "info", "exclude"), "*\n");
	assert.equal(gitDirty(untracked), true, "an exclude list inside the agent-writable .git cannot hide the operator's untracked work");
	writeFileSync(join(untracked, ".gitignore"), "new.txt\n");
	assert.equal(gitDirty(untracked), true, "a working-tree .gitignore is itself untracked, so still dirty");
});

test("a linked worktree is read through its own index, and an unborn HEAD is null", () => {
	const main = gitRepo({ dirty: false });
	const wt = join(tempDir("gd-wt-"), "wt");
	execFileSync("git", ["-C", main, "worktree", "add", "-q", "--detach", wt]);
	assert.equal(gitDirty(wt), false);
	writeFileSync(join(wt, "f.txt"), "changed\n");
	assert.equal(gitDirty(wt), true);
	assert.equal(gitDirty(main), false, "the main tree is not the worktree");
	const unborn = tempDir("gd-unborn-");
	execFileSync("git", ["-C", unborn, "init", "-q"]);
	assert.equal(gitDirty(unborn), null);
});

test("the caller's own GIT_DIR or index cannot redirect the read", () => {
	const dir = gitRepo({ dirty: true });
	const other = gitRepo({ dirty: false });
	const before = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
	process.env.GIT_DIR = join(other, ".git");
	process.env.GIT_INDEX_FILE = join(other, ".git", "index");
	try {
		// rev-parse reads with -C, so an inherited GIT_DIR would point it elsewhere; the status env never inherits one.
		const { exec, calls } = { calls: [], exec: null };
		const spy = (bin, args, opts) => (calls.push(opts?.env ?? null), execFileSync(bin, args, { ...opts, env: opts?.env ?? withoutGit() }));
		assert.equal(gitDirty(dir, { exec: spy }), true);
		const statusEnv = calls.find((e) => e && e.GIT_WORK_TREE);
		assert.ok(statusEnv && !statusEnv.GIT_DIR.startsWith(other));
		void exec;
	} finally {
		for (const [k, v] of Object.entries(before)) v === undefined ? delete process.env[k] : (process.env[k] = v);
	}
});

function withoutGit() {
	return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
}

test("an assume-unchanged or skip-worktree bit in the agent-written index cannot hide a change", () => {
	for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
		const dir = gitRepo({ dirty: false });
		execFileSync("git", ["-C", dir, "update-index", flag, "f.txt"]);
		writeFileSync(join(dir, "f.txt"), "the operator's uncommitted edit\n");
		assert.equal(gitDirty(dir), true, flag);
		assert.match(String(execFileSync("git", ["-C", dir, "ls-files", "-v"])), flag === "--skip-worktree" ? /^S f\.txt/m : /^h f\.txt/m, "only the copy was changed");
	}
});

test("a symlinked index is never read through", () => {
	const dir = gitRepo({ dirty: false });
	// An index that is a link to another repository's index: never read, so git answers with no index, which is dirty.
	const other = gitRepo({ dirty: false });
	realFs.rmSync(join(dir, ".git", "index"));
	realFs.symlinkSync(join(other, ".git", "index"), join(dir, ".git", "index"));
	assert.equal(gitDirty(dir), true, "the linked index was not used");
});

test("the scratch directory is removed, also when git fails", () => {
	const made = [];
	const fs = { ...realFs, mkdtempSync: (p) => { const d = realFs.mkdtempSync(p); made.push(d); return d; } };
	gitDirty(gitRepo({ dirty: true }), { fs });
	gitDirty("/nonexistent-folder", { fs });
	const { exec } = fakeGit({ fail: "status" });
	gitDirty("/any", { fs, exec });
	assert.ok(made.length >= 2);
	for (const d of made) assert.equal(existsSync(d), false, d);
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
