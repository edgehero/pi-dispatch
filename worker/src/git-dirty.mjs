import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { GIT_READ_FLAGS } from "./git-hardening.mjs";

/**
 * Report a folder's git working-tree state: `true` = dirty, `false` = clean, `null` = not a usable
 * git repository. Reads the WORKING TREE via `git status --porcelain` — distinct from
 * flow-gate.mjs's object-store read, which reads committed content at a pinned SHA; the two are kept
 * separate on purpose. `exec` is injectable for tests.
 *
 * HARDENED, and this is the site where it is not hypothetical. `git status` REFRESHES THE INDEX, so it
 * invokes `core.fsmonitor` -- an operator-supplied command -- where `rev-parse` does not. The folder this
 * reads is the same path a local job mounts at /workspace with write access, so the agent can write
 * `.git/config` and the next `pi-dispatch run` on that folder executes it ON THE HOST, outside any
 * container. This file was invisible to the sweep that hardened its six siblings, because that census
 * grepped for the flags that were PRESENT and this one had none.
 */
export function gitDirty(folder, { exec = execFileSync } = {}) {
	try {
		const out = exec("git", [...GIT_READ_FLAGS, "-C", folder, "status", "--porcelain"], { encoding: "utf8" });
		return out.trim().length > 0;
	} catch {
		return null;
	}
}

/**
 * Why `folder` cannot be a local job's folder, as one sentence with its fix, or null when it can (issue #524).
 *
 * The worker's own rule, stated here so `pi-dispatch run` refuses before anything is queued. `prepare-local.mjs`
 * requires `.git` AT the folder (a directory, or the file a worktree or submodule has) and reads the job's
 * instructions from HEAD. So a subfolder of a repository is refused like a plain folder, and a repository with no
 * commit yet is refused too, as the worker's `local-folder-no-commit`. Before this the CLI skipped every check when
 * `.git` was missing, the worker refused the job as a generic `config-refused`, and nothing said which folder or why.
 *
 * Only the folder's root counts, and that is the worker's requirement rather than a choice made here. When the folder
 * has no `.git`, git itself is asked whether the folder sits inside a repository (`rev-parse --show-toplevel`,
 * hardened), and a root is named only when git confirms one. A walk up the parents for a `.git` entry was refuted in
 * PR #528's review: an empty `.git` directory is not a repository, and it named one anyway. Even a confirmed root is
 * never offered as the only fix. A dotfiles repository (`git init` in the home directory, `*` ignored) contains
 * every folder under home, so "run it on <home>" reads clean and hands the agent the whole home directory. Both
 * options are always named, and the operator picks.
 *
 * `exists` and `exec` are seams; `exec` runs HARDENED for the same reason `gitDirty` does.
 */
export function localRepoProblem(folder, { exists = existsSync, exec = execFileSync } = {}) {
	if (!exists(join(folder, ".git"))) {
		const root = enclosingRepoRoot(folder, exec);
		if (root) return `${folder} is not the root of a git repository, and a local job needs one. Run \`git init\` here and commit, or, if this folder belongs to the repository at ${root}, run it on ${root}.`;
		return `${folder} is not a git repository. A local job needs one: run \`git init\` there and commit, then run again.`;
	}
	const git = (args) => exec("git", [...GIT_READ_FLAGS, "-C", folder, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	try {
		git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
	} catch (error) {
		// A missing `git` is not a missing commit, and the fix is a different one.
		if (error?.code === "ENOENT") return "git is not installed or not on PATH, so the folder cannot be checked. Install git, then run again.";
		// Exit 1 is also a missing commit object, a garbage branch ref or an unreadable `refs/heads` (PR #528's review,
		// measured): "commit once" is said only for an unborn HEAD, the worker's own test (`prepare-local.mjs`).
		if (error?.status === 1 && unbornHead(git)) return `${folder} is a git repository with no commit yet. A local job reads its instructions from HEAD: commit once, then run again.`;
		return `${folder} is not a usable git repository: git could not read it. Check it with \`git -C ${folder} status\`, then run again.`;
	}
	return null;
}

/** An unborn HEAD: HEAD names no object at all, and names a branch (the worker's `unbornHead`, by the same exit codes). */
function unbornHead(git) {
	try {
		git(["rev-parse", "--verify", "--quiet", "HEAD"]);
		return false;
	} catch (error) {
		if (error?.status !== 1) return false;
	}
	try {
		git(["symbolic-ref", "-q", "HEAD"]);
		return true;
	} catch {
		return false;
	}
}

/** The repository git says `folder` is inside, or null when git confirms none (or cannot run). Hardened like the rest. */
function enclosingRepoRoot(folder, exec) {
	try {
		const top = String(exec("git", [...GIT_READ_FLAGS, "-C", folder, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).trim();
		return top === "" ? null : top;
	} catch {
		return null;
	}
}
