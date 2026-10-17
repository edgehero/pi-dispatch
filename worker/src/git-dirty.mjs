import { execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { GIT_READ_FLAGS } from "./git-hardening.mjs";

/**
 * Report a folder's git working-tree state: `true` = dirty, `false` = clean, `null` = not a usable
 * git repository. Reads the WORKING TREE via `git status --porcelain`, distinct from flow-gate.mjs's
 * object-store read, which reads committed content at a pinned SHA; the two are kept separate on purpose.
 * `exec` and `fs` are injectable for tests.
 *
 * THE FOLDER'S OWN GIT CONFIG IS NEVER READ BY THE STATUS. The folder is the path a local job mounts at
 * /workspace with write access, so the agent can write its `.git/config` and `.git/info/attributes`, and
 * `git status` hashes every stat-dirty file through the clean filter those name: a command, run ON THE HOST
 * by the next `pi-dispatch run` or console start. `-c` cannot neutralise a filter whose driver name is not
 * known in advance, and git has no switch that skips a repository's local config. So the status runs
 * against a scratch git directory this function writes itself: HEAD at the folder's commit, the folder's
 * objects reached through `objects/info/alternates`, a copy of its index with every assume-unchanged and
 * skip-worktree bit cleared (an agent could set them to hide a change), and a config
 * holding only the `core` settings that change how a file is compared (each value checked to be a plain
 * word). Its `info/exclude` is not used either. A filter the working tree's `.gitattributes` names then has no
 * driver here and is not run, unless the operator's own global config defines one by that name: then the operator's
 * command runs, on content the agent chose (LFS needs exactly that).
 *
 * The operator's own global and system config still apply: this runs as the operator (the CLI, the
 * console), that config is theirs and outside the container, and an LFS repository needs its filter.
 *
 * The paths and the commit come from `rev-parse`, hardened, which reads config but refreshes no index and
 * so runs no filter and no fsmonitor. An unborn HEAD is `null`: every caller refuses that folder first.
 */
export function gitDirty(folder, { exec = execFileSync, fs = defaultFs } = {}) {
	let scratch = null;
	try {
		const read = (args) => String(exec("git", [...GIT_READ_FLAGS, "-C", folder, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
		const [gitDir, commonDir, format, head] = read(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-object-format", "--verify", "HEAD^{commit}"]).split("\n");
		if (!isAbsolute(gitDir ?? "") || !isAbsolute(commonDir ?? "") || !/^(sha1|sha256)$/.test(format ?? "") || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head ?? "")) return null;
		const core = compareSettings(read);
		scratch = fs.mkdtempSync(join(tmpdir(), "pi-dispatch-git-read-"));
		fs.mkdirSync(join(scratch, "refs"));
		fs.mkdirSync(join(scratch, "objects", "info"), { recursive: true });
		fs.mkdirSync(join(scratch, "info"));
		fs.writeFileSync(join(scratch, "HEAD"), `${head}\n`);
		fs.writeFileSync(join(scratch, "objects", "info", "alternates"), `${join(commonDir, "objects")}\n`);
		const sha256 = format === "sha256";
		const lines = ["[core]", `\trepositoryformatversion = ${sha256 ? 1 : 0}`, "\tbare = false", ...core.map(([k, v]) => `\t${k} = ${v}`)];
		if (sha256) lines.push("[extensions]", "\tobjectformat = sha256");
		fs.writeFileSync(join(scratch, "config"), `${lines.join("\n")}\n`);
		// `info/exclude` is NOT copied: it lives in the agent-writable `.git`, and `*` there would hide the operator's
		// untracked work. A personal exclude list then reads as dirty, which is the safe side (`--force` is the way past).
		copyRegular(fs, join(gitDir, "index"), join(scratch, "index"));
		// A split index keeps its shared part beside it; without it the copy cannot be read and the answer is null.
		for (const name of safeList(fs, gitDir)) if (/^sharedindex\.[0-9a-f]{40,64}$/.test(name)) copyRegular(fs, join(gitDir, name), join(scratch, name));
		const env = { ...withoutGitEnv(process.env), GIT_DIR: scratch, GIT_WORK_TREE: folder, GIT_INDEX_FILE: join(scratch, "index"), GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
		const scratchGit = (args, input) => exec("git", [...GIT_READ_FLAGS, ...args], { encoding: "utf8", env, cwd: scratch, ...(input === undefined ? { stdio: ["ignore", "pipe", "ignore"] } : { input, stdio: ["pipe", "pipe", "ignore"] }) });
		// The index is agent-written too, and an assume-unchanged or skip-worktree bit hides every later change to that
		// path from `status`. Both are cleared in the COPY (one flag per call: given together, git applies only one). A
		// sparse checkout's skipped paths then read as deleted, so dirty: the safe side again.
		const flagged = String(scratchGit(["ls-files", "-v", "-z"]))
			.split("\0")
			.filter((e) => e.length > 2 && e[1] === " " && (e[0] === "S" || (e[0] >= "a" && e[0] <= "z")))
			.map((e) => e.slice(2));
		if (flagged.length > 0) {
			const list = `${flagged.join("\0")}\0`;
			scratchGit(["update-index", "-z", "--no-skip-worktree", "--stdin"], list);
			scratchGit(["update-index", "-z", "--no-assume-unchanged", "--stdin"], list);
		}
		const out = scratchGit(["-c", "core.untrackedCache=false", "-c", "status.submoduleSummary=false", "status", "--porcelain", "--ignore-submodules=all"]);
		return String(out).trim().length > 0;
	} catch {
		return null;
	} finally {
		if (scratch) {
			try {
				fs.rmSync(scratch, { recursive: true, force: true });
			} catch {}
		}
	}
}

const defaultFs = { mkdtempSync, mkdirSync, writeFileSync, rmSync, openSync, fstatSync, closeSync, readFileSync, readdirSync };

/** The `core` settings that change how a working-tree file is compared, never one that names a command. */
const COMPARE_KEYS = ["autocrlf", "eol", "ignorecase", "precomposeunicode", "filemode", "symlinks", "checkstat", "trustctime"];

/** The folder's values for COMPARE_KEYS, each a plain word, read with `git config` (a read: no filter, no hook). */
function compareSettings(read) {
	let out = "";
	try {
		out = read(["config", "--get-regexp", `^core\\.(${COMPARE_KEYS.join("|")})$`]);
	} catch {
		return []; // exit 1: none set
	}
	const seen = new Map();
	for (const line of out.split("\n")) {
		const m = /^core\.([a-z]+) ([A-Za-z0-9]{1,16})$/.exec(line.trim());
		if (m && COMPARE_KEYS.includes(m[1])) seen.set(m[1], m[2]);
	}
	return [...seen];
}

/**
 * Copies `from` when it is a regular file of at most 512 MiB; anything else is skipped. Opened O_NOFOLLOW and judged by
 * the descriptor, so a link swapped in after a check can never be read through.
 */
function copyRegular(fs, from, to) {
	let fd = null;
	try {
		fd = fs.openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const st = fs.fstatSync(fd);
		if (!st.isFile() || st.size > 512 * 1024 * 1024) return;
		fs.writeFileSync(to, fs.readFileSync(fd));
	} catch {
		// absent, a link, or unreadable: the copy is skipped and git answers from what it has
	} finally {
		if (fd !== null) fs.closeSync(fd);
	}
}

function safeList(fs, dir) {
	try {
		return fs.readdirSync(dir);
	} catch {
		return [];
	}
}

/** The environment without any GIT_* variable, so the caller's own GIT_DIR or index cannot redirect the read. */
function withoutGitEnv(env) {
	return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("GIT_")));
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
