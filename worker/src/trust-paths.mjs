/**
 * The trust-path reset of a recovered workspace (issue #645, durable runs).
 *
 * A recovery restores the crashed attempt's `/workspace` from its checkpoint, and that tree was written by the agent. Most
 * of it is the agent's work and is meant to come back. A few paths are not work: they are what pi LOADS when it starts,
 * as trusted configuration, before the agent says anything. A fresh job gets them from the base repository's
 * default-branch commit, which is merge-gated content ("a serviced repo's .pi/extensions really does load in a job",
 * AGENTS.md). A recovered job would get them from the agent: a `.pi/extensions/evil.js` it planted in attempt 1, or an
 * `AGENTS.md` it rewrote, would load as the repository's own code and instructions in the recovery's fresh pi. So
 * before the container starts, every such path is put back to its content at the base commit, and one absent there is
 * deleted.
 *
 * WHICH PATHS, and they are pi's, not ours (`TRUST_ROOT_NAMES`, held to the pinned pi by
 * worker/test/trust-paths.test.mjs, which reads pi's own resource loader and package manager):
 *   - `.pi/` whole (pi's `CONFIG_DIR_NAME`): extensions, skills, prompts, themes, SYSTEM.md, APPEND_SYSTEM.md, settings;
 *   - `.agents/` whole: pi loads `.agents/skills` from the working directory and its ancestors up to the repository root;
 *   - the root context files pi's `loadContextFileFromDir` tries, in its casings: `AGENTS.override.md`, `AGENTS.md`,
 *     `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`.
 * pi reads context files from the working directory and its ANCESTORS only, never from a subdirectory, and the job's
 * working directory is the workspace root, so a nested `AGENTS.md` is ordinary work and is left alone.
 *
 * CASE. The names are matched case-insensitively at the root: on a case-insensitive host filesystem (macOS, a Windows
 * share) `agents.md` IS `AGENTS.md` to pi's `existsSync`, so a planted lowercase file must go too. Removing every case
 * variant and writing back only what the base tree holds is exact on both kinds of filesystem.
 *
 * HOW, and why not the obvious `git checkout <base> -- .pi`: that runs git with the AGENT'S working tree, so its
 * `.gitattributes` choose filters and encodings and its symlinks sit in the paths git writes through. Here the working
 * tree is never consulted. The removal is `fs.rm` (which removes a link, never what it points at), and the content comes
 * by object id from the workspace's `.git` (`ls-tree`, `cat-file`) with `--git-dir` explicit, so git discovers nothing.
 * That `.git` is still the worker's own fresh clone from the checkpoint store: a checkpoint never carries a `.git`
 * segment (checkpoint-paths.mjs), so the restore cannot have written one, and it is lstat'd as a real directory first.
 * Every path written comes from the trusted base tree, regular files are created exclusively (`wx`), and symlinks the
 * base holds are written LAST, so no write of this reset can traverse a link it created.
 */
import { execFile } from "node:child_process";
import * as nodeFsp from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { GIT_READ_FLAGS } from "./git-hardening.mjs";

const exec = promisify(execFile);

/** pi's own config directory name (`CONFIG_DIR_NAME`, dist/config.js: the package's `piConfig.configDir`, `.pi` at the pin). */
export const PI_CONFIG_DIR = ".pi";
/** The directory pi loads `skills/` from in the working directory and its ancestors (dist/core/package-manager.js). */
export const AGENTS_DIR = ".agents";
/** pi's `loadContextFileFromDir` candidates, in pi's order and casings (dist/core/resource-loader.js). */
export const CONTEXT_FILE_NAMES = Object.freeze(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
/** Every root entry the reset owns. */
export const TRUST_ROOT_NAMES = Object.freeze([PI_CONFIG_DIR, AGENTS_DIR, ...CONTEXT_FILE_NAMES]);

const FOLDED = new Set(TRUST_ROOT_NAMES.map((n) => n.toLowerCase()));
/** The most entries one reset writes back. The base's `.pi/` was already held to the materialiser's caps (256 files). */
const MAX_ENTRIES = 10_000;
/** The largest single blob written back: a trust file is configuration, and execFile's buffer must stay bounded. */
const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const OID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Whether a root entry name is one the reset owns, in any casing. */
export function isTrustRootName(name) {
	return typeof name === "string" && FOLDED.has(name.toLowerCase());
}

/** The default git: one hardened read against an explicit git dir, buffer out. */
async function defaultGit(gitDir, args, { maxBuffer = MAX_BLOB_BYTES } = {}) {
	const { stdout } = await exec("git", [...GIT_READ_FLAGS, "--literal-pathspecs", `--git-dir=${gitDir}`, ...args], { encoding: "buffer", maxBuffer, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
	return stdout;
}

/** `ls-tree -z` records as `{ mode, type, oid, path }`; a record that does not parse throws (the base is git's own). */
function parseTree(buf) {
	const out = [];
	for (const rec of buf.toString("utf8").split("\0")) {
		if (rec === "") continue;
		const m = /^(\d{6}) (blob|tree|commit) ([0-9a-f]+)\t(.+)$/s.exec(rec);
		if (!m || !OID_RE.test(m[3])) throw Object.assign(new Error("ls-tree output did not parse"), { code: "TREE_PARSE" });
		out.push({ mode: m[1], type: m[2], oid: m[3], path: m[4] });
	}
	return out;
}

/** A path from the base tree, refused if it could leave the workspace (git never writes one, but this is the host). */
function safeRel(path) {
	const segs = path.split("/");
	if (segs.some((s) => s === "" || s === "." || s === ".." || s.includes("\\") || s.toLowerCase() === ".git")) throw Object.assign(new Error("unsafe path in the base tree"), { code: "TREE_PATH" });
	return segs;
}

/**
 * Whether the commit `baseSha` holds anything under `.pi/extensions/` (issue #645), read by object id from the
 * workspace's own `.git` (the worker's fresh clone, or the clone from the checkpoint store; never the working tree).
 * `.pi` and `extensions` are matched case-insensitively, for the reason the reset's names are. A run whose base answers
 * true is not recoverable: a merge-gated extension may import a file outside `.pi/` or a package from the workspace's
 * `node_modules`, which in a recovered run is agent-written, and no reset can enumerate an extension's imports.
 * Throws (with a code) when the tree cannot be read; the caller fails closed.
 */
export async function baseHasExtensions({ workspace, baseSha, git = defaultGit, fs = nodeFsp } = {}) {
	if (typeof workspace !== "string" || workspace === "" || typeof baseSha !== "string" || !OID_RE.test(baseSha)) {
		throw Object.assign(new Error("baseHasExtensions: bad arguments"), { code: "BAD_ARGS" });
	}
	const gitDir = join(workspace, ".git");
	if (!(await fs.lstat(gitDir)).isDirectory()) throw Object.assign(new Error("the workspace's .git is not a directory"), { code: "GIT_DIR" });
	for (const top of parseTree(await git(gitDir, ["ls-tree", "-z", baseSha]))) {
		if (top.type !== "tree" || top.path.toLowerCase() !== PI_CONFIG_DIR) continue;
		for (const sub of parseTree(await git(gitDir, ["ls-tree", "-z", baseSha, "--", `${top.path}/`]))) {
			const name = sub.path.split("/").at(-1);
			if (name.toLowerCase() === "extensions") return true;
		}
	}
	return false;
}

/**
 * Put every trust path of `workspace` back to its content at `baseSha`: `{ deleted, written }` (counts only), or a throw
 * with a `code` and no path in its message. The caller turns a throw into a never-started retry: a recovered run whose
 * trust paths could not be reset must not start, since it would start on the agent's configuration.
 */
export async function resetTrustPaths({ workspace, baseSha, git = defaultGit, fs = nodeFsp } = {}) {
	if (typeof workspace !== "string" || workspace === "" || typeof baseSha !== "string" || !OID_RE.test(baseSha)) {
		throw Object.assign(new Error("resetTrustPaths: bad arguments"), { code: "BAD_ARGS" });
	}
	const gitDir = join(workspace, ".git");
	const st = await fs.lstat(gitDir);
	if (!st.isDirectory()) throw Object.assign(new Error("the workspace's .git is not a directory"), { code: "GIT_DIR" });

	// 1. Remove every root entry the reset owns, in any casing. `rm` removes a link itself, never its target.
	let deleted = 0;
	for (const name of await fs.readdir(workspace)) {
		if (!isTrustRootName(name)) continue;
		await fs.rm(join(workspace, name), { recursive: true, force: true });
		deleted++;
	}

	// 2. What the base holds at those names: the root listing, then each owned tree recursively.
	const root = parseTree(await git(gitDir, ["ls-tree", "-z", baseSha])).filter((e) => isTrustRootName(e.path));
	const entries = [];
	for (const e of root) {
		if (e.type === "tree") entries.push(...parseTree(await git(gitDir, ["ls-tree", "-r", "-z", baseSha, "--", e.path])));
		else entries.push(e);
		if (entries.length > MAX_ENTRIES) throw Object.assign(new Error("too many trust entries in the base"), { code: "TOO_MANY" });
	}

	// 3. Write back: directories and regular files first, symlinks last.
	let written = 0;
	const links = [];
	for (const e of entries) {
		const segs = safeRel(e.path);
		const target = join(workspace, ...segs);
		if (e.type === "commit") {
			// A submodule: a checkout leaves an empty directory, and so does this.
			await fs.mkdir(target, { recursive: true });
			continue;
		}
		if (e.mode === "120000") {
			links.push({ target, oid: e.oid });
			continue;
		}
		if (e.mode !== "100644" && e.mode !== "100755") continue;
		await fs.mkdir(dirname(target), { recursive: true });
		const bytes = await git(gitDir, ["cat-file", "blob", e.oid]);
		await fs.writeFile(target, bytes, { flag: "wx", mode: e.mode === "100755" ? 0o755 : 0o644 });
		written++;
	}
	for (const l of links) {
		await fs.mkdir(dirname(l.target), { recursive: true });
		const to = (await git(gitDir, ["cat-file", "blob", l.oid], { maxBuffer: 4096 })).toString("utf8");
		await fs.symlink(to, l.target);
		written++;
	}
	return { deleted, written };
}
