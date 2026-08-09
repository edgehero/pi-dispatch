import { lstatSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

/**
 * A valid skill/extension entry name: lowercase kebab/underscore, no leading dot (so no ".." and no
 * dotfiles) and no slashes.
 *
 * It MOVED here from import-pi.mjs, which still re-exports it so every existing import path keeps
 * working -- this codebase does not rename an address that already has readers. The owner is now the
 * module that actually enforces it, because import-pi.mjs importing the copier while the copier
 * imported the charset back would be a cycle for one regex.
 */
export const ENTRY_NAME_RE = /^[a-z0-9](?:[a-z0-9_.-]{0,62}[a-z0-9])?$/i;

/**
 * Copy a directory of skills from the HOST filesystem into a destination the job container will read.
 *
 * Two callers, deliberately one implementation: `import-pi` staging `~/.pi/agent/skills` into the
 * operator's global overlay, and the per-trigger `run.skillsDir` injection (issue #60). They differ
 * only in whether caps apply and what mode the copies get, both of which are parameters.
 *
 * THE SYMLINK GUARD IS THE REASON THIS MODULE EXISTS. The code it replaces tested
 * `fs.statSync(p).isSymbolicLink?.()`, and `statSync` FOLLOWS links, so that expression is
 * permanently `false`: a symlinked skill directory under `~/.pi/agent/skills` was copied AS ITS
 * TARGET'S CONTENTS into an overlay that is `:ro`-mounted into every adversarial-input container.
 * The repo already knew -- `import-pi.mjs` says so where it explains why package staging uses
 * `renameSync` instead -- but the skills path still had the broken guard. `lstatSync` is the fix, and
 * it is the habit two other modules already keep for exactly this reason (`outbox.mjs`:
 * "lstat (NOT stat) so a symlink is rejected on its own inode, not followed"; `sandbox-store.mjs`).
 *
 * Every other rule here mirrors `materialize.mjs`, which solves the same problem against a git tree
 * rather than a filesystem: regular files only, destination paths rebuilt from validated name
 * segments rather than taken from the source string, containment re-checked, and caps that refuse
 * rather than truncate.
 *
 * NEVER THROWS for a per-entry problem: a symlink, a device node, a badly named entry is SKIPPED and
 * counted. A cap breach, an unreadable root, or an empty result returns `{ refused: "<reason>" }` and
 * the caller decides the outcome class. A read error past the caller's own existence check is also a
 * refusal rather than a throw, and that is deliberate: the reflex is to call an EIO infrastructure and
 * retry it, but this directory is operator-side layout that a retry cannot change.
 *
 * The receipt carries COUNTS ONLY -- no names, no paths. It is built to be logged, and a host path in
 * a log line is the leak `packages.mjs`'s `dropped` record is shaped to avoid.
 */

/** The bounds on one trigger's injected skills. `import-pi` passes none: the overlay is not per job. */
export const INJECT_LIMITS = Object.freeze({
	// The binding one, and its reason is NOT disk. Every loaded skill contributes a <name> and a
	// description (spec-capped at 1024 chars) to the SYSTEM PROMPT of every job of that trigger, so
	// this bounds the cached prefix rather than the filesystem. UNVERIFIED figure, in the sense
	// ISOLATION_FLAGS' --pids-limit=512 is: a ceiling on absurdity, not a measured budget.
	maxDirs: 64,
	maxFiles: 512,
	maxBytes: 4 << 20,
	maxDepth: 8,
});

/**
 * Copy `<src>/<name>/**` for every valid child directory of `src`.
 *
 * @param src   host directory whose CHILDREN are skill directories (the `~/.pi/agent/skills` layout)
 * @param dest  destination root; `<dest>/<name>/...` is created
 * @param fs    injected for tests; defaults to the real sync fs
 * @param limits  caps to enforce, or `null` for none (import-pi's staging path)
 * @param mode  file mode for each copy, or `null` to preserve the source's
 * @param onSkip  called with (name, reason) for a skipped TOP-LEVEL entry, so import-pi can print it
 */
export function copySkillTree(
	src,
	dest,
	{ fs = defaultFs, limits = INJECT_LIMITS, mode = 0o444, onSkip = () => {} } = {},
) {
	const tally = blankTally();

	let names;
	try {
		names = fs.readdirSync(src);
	} catch {
		return { refused: "skills-dir-unreadable" };
	}

	for (const name of names) {
		// The name charset is the traversal choke point, and it is checked BEFORE the name is joined
		// into any path -- the same ordering flow-gate.mjs uses on `flow`. ENTRY_NAME_RE's leading
		// character class excludes ".", so "." and ".." cannot match and no separate test is needed.
		if (!ENTRY_NAME_RE.test(name)) {
			tally.skipped.badNames++;
			onSkip(name, "unexpected name");
			continue;
		}
		const childSrc = join(src, name);
		const st = statOrNull(fs, childSrc);
		if (!st) {
			tally.skipped.nonRegular++;
			continue;
		}
		if (st.isSymbolicLink()) {
			tally.skipped.symlinks++;
			onSkip(name, "symlink");
			continue;
		}
		if (!st.isDirectory()) {
			tally.skipped.nonRegular++;
			continue;
		}
		if (limits && tally.dirs >= limits.maxDirs) return { refused: "skills-dir-too-large" };
		const refusal = copyDirContents(childSrc, join(dest, name), { fs, limits, mode, tally, depth: 1 });
		if (refusal) return refusal;
		tally.dirs++;
	}

	// An operator who pointed at the wrong directory and got a silently unchanged job is the "a silent
	// no-op is the worst outcome available here" failure this project refuses. The CALLER decides
	// whether emptiness is fatal (it is, for a trigger that asked for skills; it is not for import-pi,
	// where an absent skills/ dir just means the operator has none).
	if (tally.dirs === 0) return { refused: "skills-dir-empty", tally };
	return tally;
}

/**
 * Recursively copy the CONTENTS of one directory. Exported because `import-pi` needs exactly this and
 * must not carry a second walker: its old one guarded symlinks with `statSync`, which follows them.
 *
 * Returns a `{ refused }` object or `null`. `tally` and `depth` are internal and default for an
 * external caller, who gets an uncapped, mode-preserving copy.
 */
export function copyDirContents(src, dest, { fs = defaultFs, limits = null, mode = null, tally = blankTally(), depth = 1 } = {}) {
	const ctx = { fs, limits, mode, tally, depth };
	if (ctx.limits && ctx.depth > ctx.limits.maxDepth) return { refused: "skills-dir-too-deep" };
	try {
		fs.mkdirSync(dest, { recursive: true });
	} catch {
		return { refused: "skills-dir-unreadable" };
	}
	let entries;
	try {
		entries = fs.readdirSync(src);
	} catch {
		return { refused: "skills-dir-unreadable" };
	}
	for (const entry of entries) {
		// Nested names get the same charset as the top level. A dotfile fails it, which matches pi's own
		// loader (it skips entries starting with "."), so nothing is dropped that pi would have read.
		if (!ENTRY_NAME_RE.test(entry)) {
			ctx.tally.skipped.badNames++;
			continue;
		}
		const s = join(src, entry);
		const st = statOrNull(fs, s);
		if (!st) {
			ctx.tally.skipped.nonRegular++;
			continue;
		}
		// lstat, so this is the LINK's own inode. Never followed, for a file or a directory: a directory
		// symlink pointing at / would otherwise turn a skill copy into a copy of the host filesystem.
		if (st.isSymbolicLink()) {
			ctx.tally.skipped.symlinks++;
			continue;
		}
		// The destination is rebuilt from the VALIDATED entry name, never from any source-supplied
		// string, and containment is re-checked behind that as defence in depth.
		const d = safeJoin(dest, entry);
		if (st.isDirectory()) {
			const refusal = copyDirContents(s, d, { ...ctx, depth: ctx.depth + 1 });
			if (refusal) return refusal;
			continue;
		}
		if (!st.isFile()) {
			ctx.tally.skipped.nonRegular++; // fifo, socket, device node
			continue;
		}
		if (ctx.limits) {
			if (ctx.tally.files >= ctx.limits.maxFiles) return { refused: "skills-dir-too-many-files" };
			if (ctx.tally.bytes + st.size > ctx.limits.maxBytes) return { refused: "skills-dir-too-large" };
		}
		try {
			if (ctx.mode === null) {
				fs.copyFileSync(s, d);
			} else {
				// Written rather than copied, because copyFileSync onto an existing 0444 file is EACCES and
				// a re-stage must not fail on its own previous output.
				fs.writeFileSync(d, fs.readFileSync(s), { mode: ctx.mode });
			}
		} catch {
			return { refused: "skills-dir-unreadable" };
		}
		ctx.tally.files++;
		ctx.tally.bytes += st.size;
	}
	return null;
}

function blankTally() {
	return { dirs: 0, files: 0, bytes: 0, skipped: { symlinks: 0, badNames: 0, nonRegular: 0 } };
}

function statOrNull(fs, p) {
	try {
		return fs.lstatSync(p);
	} catch {
		return null;
	}
}

/** Mirrors materialize.mjs's safeJoin: path.relative, not a string prefix, so it is correct on Windows. */
function safeJoin(root, segment) {
	const resolved = join(root, segment);
	const rel = relative(root, resolved);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error("path escapes destination");
	}
	return resolved;
}

const defaultFs = { lstatSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, readFileSync };
