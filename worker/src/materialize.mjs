import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { SKILL_NAME_RE } from "./flow-gate.mjs";

const exec = promisify(execFile);

/**
 * Materialise a serviced repo's `.pi/` (its persona and skills) from a pinned commit into a
 * read-only `/job/pi/` directory the container mounts.
 *
 * This is security-critical: the content becomes the agent's SYSTEM PROMPT, and the repo is only
 * trusted at maintainer level. Four properties, the first three PROVEN with a hostile fixture:
 *
 *   1. NO SYMLINK FOLLOWING. A `.pi/APPEND_SYSTEM.md` symlinked to the worker's `.env` or
 *      `/etc/passwd` must never pull a host file into the prompt. We enumerate with `git ls-tree`
 *      and REJECT any entry that is not a regular blob (mode 100644): symlinks are 120000,
 *      submodules 160000. We never touch the working tree, so there is no link to follow.
 *   2. NO PATH TRAVERSAL. Every output path is rebuilt from SEGMENTS THAT EACH MATCHED AN ANCHORED,
 *      SEPARATOR-FREE CHARSET -- never from git's own path string. See classifyPiPath.
 *   3. NO EXECUTION. `git cat-file blob <oid>` dumps raw bytes by object id -- no working-tree
 *      checkout, no smudge/clean filters, no hooks, no diff drivers. Nothing in the repo runs.
 *   4. BOUNDED. A repo skill is now materialised WHOLE (issue #60), so the file count and byte total
 *      are repo-controlled where they used to be one file per skill. Every cap is decided from the
 *      single `git ls-tree -r -l -z` listing, BEFORE the first `cat-file` and BEFORE the first
 *      write -- CONST-BUDGET-BEFORE-TOKENS' ordering, one layer down. A breach REFUSES the job.
 *
 * The SHA is an input, resolved by the caller from a fresh default-branch API call -- NEVER a
 * webhook field, and NEVER the triggering (possibly fork) branch.
 *
 * WHY NOT `git cat-file --batch` (one process instead of N): it does preserve the by-oid,
 * no-working-tree property, so that is not the objection. `promisify(execFile)` cannot drive it --
 * it needs `spawn` plus a hand-rolled, binary-safe parser for the `<oid> <type> <size>\n<bytes>\n`
 * framing, with partial-chunk handling and missing-object lines, which is ~60 lines of new bug
 * surface at the one place in this codebase whose whole argument is "simple enough to prove". It
 * would also replace a PER-FILE buffer bound with a shared one, undoing what makes maxFileBytes
 * able to keep execFile's maxBuffer unreachable. The caps make the spawn cost a non-issue: 256
 * files is a second or two, on a path that just did a network clone. Revisit if maxFiles ever rises
 * past ~1000, or a profiler shows prepare dominated by spawns.
 * WHY NOT `git archive | tar -x`: it would reconstruct output paths from the ARCHIVE's own strings,
 * which is precisely the property property 2 exists to refuse.
 */

const PI_DIR = ".pi";
const APPEND_SYSTEM = `${PI_DIR}/APPEND_SYSTEM.md`;
const SKILLS_PREFIX = `${PI_DIR}/skills/`;
const SKILL_FILE = "SKILL.md";

/**
 * The bounds on what one repo may put into one job's `/job/pi`. Frozen and exported so the tests
 * name the same numbers the code enforces rather than restating them.
 *
 * maxFileBytes does double duty: at 1 MiB it makes the 16 MiB execFile maxBuffer on the `cat-file`
 * path UNREACHABLE, which converts an opaque RangeError (retried as infrastructure, forever, on a
 * repo that will overrun it every time) into a named policy refusal.
 */
export const PI_LIMITS = Object.freeze({
	maxFiles: 256, // ~50 typical skills; also bounds cat-file spawns per job
	maxFilesPerSkill: 64, // SKILL.md + references/ + scripts/ + assets/ runs to a handful
	maxFileBytes: 1 << 20, // 1 MiB: ~250k words of markdown. Larger is a dataset, not a skill.
	maxTotalBytes: 8 << 20, // 8 MiB: trivial beside the clone, and it bounds host disk under retention
	maxTailSegments: 4, // references/x.md is 2, scripts/lib/util.sh is 3
	maxOutRelChars: 200, // Windows MAX_PATH is 260 and jobDir is an OS temp path (~40-70)
});

/**
 * The bound on the LISTING itself, and it is separate from PI_LIMITS on purpose: the caps above are
 * computed FROM this buffer, so they cannot bound it. ~4000 records fit.
 */
const LS_TREE_MAX_BYTES = 1 << 20;

/**
 * ONE path segment BELOW the skill name: 1-64 chars, starts AND ends alphanumeric, with `.`, `_`
 * and `-` allowed inside.
 *
 * The leading-alnum rule IS the traversal guard, and it needs no separate `!== ".."` test: `.` and
 * `..` both LEAD with a dot, so neither can match. The trailing-alnum rule bars a trailing dot,
 * which Windows silently strips (`foo.` opens `foo`) -- and this worker is cross-platform.
 *
 * Case-INSENSITIVE, unlike SKILL_NAME_RE, because `SKILL.md` and `README.md` are the whole point of
 * issue #60. DELIBERATELY NO `u` FLAG: `/[a-z]/iu` additionally matches U+212A KELVIN SIGN and
 * U+017F LATIN SMALL LETTER LONG S, so adding one would silently widen a security charset by two
 * invisible codepoints. Verified by running it, not assumed.
 *
 * Same shape as import-pi.mjs's ENTRY_NAME_RE by design, and deliberately NOT imported from it:
 * that module pulls in execFile and the npm package stager, and this one is on the security-critical
 * read path. The duplication is pinned by a drift test in materialize.test.mjs.
 */
export const PI_SEGMENT_RE = /^[a-z0-9](?:[a-z0-9_.-]{0,62}[a-z0-9])?$/i;

/**
 * Windows reserved device names. `CON`, `NUL` and friends pass the charset above, and on Windows
 * `writeFileSync(".../CON")` writes to a DEVICE: no file appears, no error is raised, and the skill
 * silently arrives incomplete -- the exact silent-drop class issue #60 exists to remove. Matched on
 * the part before the first dot, case-insensitively, because `con.md` is the device too.
 */
const WINDOWS_DEVICE_NAMES = new Set([
	"con", "prn", "aux", "nul",
	"com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
	"lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

function isWindowsDeviceName(segment) {
	const stem = segment.split(".")[0].toLowerCase();
	return WINDOWS_DEVICE_NAMES.has(stem);
}

/**
 * Classify a git tree path into the destination we will WRITE, or null to reject.
 *
 * The output path is REBUILT from validated pieces, never taken from git's string. gitshow-research
 * proved `git ls-tree` can emit path strings containing literal `../` segments (git does not
 * sanitise tree-entry names), so deriving the output from git's string is unsafe even behind a
 * containment check.
 *
 * Splitting on "/" first is what makes the rebuild safe, and it is stronger than the single regex it
 * replaced: any OTHER separator (a backslash, a NUL, a CR) survives INSIDE a piece and is then
 * refused by the anchored charset, and a literal `..` piece is refused by the leading-alnum rule.
 * Only the validated pieces reach the join.
 *
 * Returns `{ outRel, skill }`; `skill` is null for the persona, which is a fixed path with no name
 * and no subtree and so stays an EXACT match. Widening `.pi/*` would admit `settings.json`, and
 * keeping a serviced repo's settings out of the runner is a constitutional property
 * (INT-SDK-SESSION-OPTIONS: the runner uses SettingsManager.inMemory deliberately).
 */
export function classifyPiPath(path) {
	if (path === APPEND_SYSTEM) return { outRel: "pi/APPEND_SYSTEM.md", skill: null };
	if (!path.startsWith(SKILLS_PREFIX)) return null;

	const segments = path.slice(SKILLS_PREFIX.length).split("/");
	// Fewer than 2 means a blob AT `.pi/skills/<name>` rather than inside a skill directory.
	if (segments.length < 2 || segments.length > 1 + PI_LIMITS.maxTailSegments) return null;

	const [name, ...tail] = segments;
	// The skill DIRECTORY name stays lowercase-only: SKILL_NAME_RE is the single source of truth
	// (issue #92), shared with flow-gate.mjs, the outbox chain gate and the admin setup wizard. A
	// name this module accepted but the gate rejected would be a skill that materialises and can
	// never be chained.
	if (!SKILL_NAME_RE.test(name)) return null;
	for (const seg of tail) {
		if (!PI_SEGMENT_RE.test(seg)) return null;
		if (isWindowsDeviceName(seg)) return null;
	}

	const outRel = ["pi", "skills", name, ...tail].join("/");
	if (outRel.length > PI_LIMITS.maxOutRelChars) return null;
	return { outRel, skill: name };
}

/** Back-compat predicate used by callers/tests that only care whether a path is accepted. */
export function isAllowedPiPath(path) {
	return classifyPiPath(path) !== null;
}

/**
 * Parse `git ls-tree -r -l -z` output into entries, keeping ONLY regular blobs (100644) at allowed
 * paths, each carrying its rebuilt output path and its blob size. Symlinks (120000), submodules
 * (160000), executables (100755), and anything outside the allowlist are dropped here -- the single
 * choke point for the reject-by-mode rule.
 *
 * `100755` STAYS REJECTED, and it is a decision rather than an oversight. `/job` is mounted `:ro`
 * and every file lands `0444`, so accepting the mode and writing `0444` anyway would accept what the
 * repo asked for and silently strip it -- a no-op wearing a fix's clothes. Writing `0555` instead
 * would grant "this path is execve-able" to repo bytes the worker placed there, which is not the
 * worker's job. So a skill's scripts arrive non-executable and are invoked as `bash script.sh`; the
 * failure is LOUD (Permission denied) and the agent recovers from it, which is the opposite of the
 * silent class issue #60 is about. Keeping this gate byte-identical also keeps flow-gate.mjs's
 * mirrored check honest and DES-AI-TRIGGER-FLOW-GATE's citation of it true.
 *
 * Returns `{ entries, skipped }`. `skipped` counts every enumerated record we did not keep.
 */
export function selectEntries(lsTreeZ) {
	const entries = [];
	let skipped = 0;
	for (const record of lsTreeZ.split("\0")) {
		if (!record) continue;
		// "<mode> <type> <oid> <size>\t<path>" -- the size column is space-padded, right-justified to
		// a minimum width of 7 (git-ls-tree(1)), which the existing \s+ split already collapses.
		const tab = record.indexOf("\t");
		if (tab === -1) continue;
		const [mode, type, oid, sizeField] = record.slice(0, tab).split(/\s+/);
		const path = record.slice(tab + 1);
		if (mode !== "100644" || type !== "blob") {
			skipped++;
			continue; // rejects symlink/submodule/exec
		}
		// Read the size AFTER the mode gate, never before: `-l` prints "-" for a tree or a commit, and
		// those are exactly what the gate above has already dropped.
		//
		// A size we cannot read THROWS rather than defaulting to 0 or skipping. If `-l` were ever
		// dropped from the argv, every sizeField would be `undefined`; skipping would then materialise
		// NOTHING and report success, and defaulting to 0 would leave every byte cap unenforced. Both
		// are silent. The message carries mode/type/oid and never the attacker-chosen path.
		const size = Number(sizeField);
		if (!Number.isSafeInteger(size) || size < 0) {
			throw new Error(`git ls-tree: unreadable object size (is -l still in the argv?) for ${type} ${mode} ${oid}`);
		}
		const classified = classifyPiPath(path);
		if (!classified) {
			skipped++;
			continue;
		}
		entries.push({ oid, path, size, outRel: classified.outRel, skill: classified.skill });
	}
	return { entries, skipped };
}

/**
 * Drop every entry under a `.pi/skills/<name>/` that declares no SKILL.md ANYWHERE beneath it.
 *
 * Verified against the pinned pi: loadSkillsFromDirInternal registers a skill only where a literal
 * `SKILL.md` exists, and loose `.md` files load only at the skills ROOT (`includeRootFiles`). So a
 * `.pi/skills/notes/` holding only `a.md` contributes nothing an agent can ever reference -- and
 * materialising it would hand anyone with merge access a data-dump channel into the job container
 * that never has to look like a skill.
 *
 * The test is "SKILL.md anywhere under <name>/", NOT "at <name>/SKILL.md", because pi keeps
 * RECURSING while a directory has no SKILL.md: `.pi/skills/group/sub/SKILL.md` is a genuine,
 * loadable skill. A root-only rule would re-create this issue's own bug one level down.
 */
export function keepOnlyDeclaredSkills(entries) {
	const declared = new Set();
	for (const e of entries) {
		if (e.skill !== null && e.outRel.endsWith(`/${SKILL_FILE}`)) declared.add(e.skill);
	}
	const kept = entries.filter((e) => e.skill === null || declared.has(e.skill));
	return { kept, skipped: entries.length - kept.length };
}

/**
 * Decide every cap from the listing alone. Returns a reason string, or null to proceed.
 *
 * Reason tokens carry a `pi-` prefix on purpose: INT-RUN-HISTORY-FILE-CONTRACT's nested
 * `session.reason` enum already contains a bare `too-large`, and two enums in one record sharing a
 * token is how a reader misattributes a refusal.
 */
export function checkLimits(entries) {
	if (entries.length > PI_LIMITS.maxFiles) return "pi-too-many-files";

	const perSkill = new Map();
	let total = 0;
	for (const e of entries) {
		if (e.size > PI_LIMITS.maxFileBytes) return "pi-file-too-large";
		total += e.size;
		if (total > PI_LIMITS.maxTotalBytes) return "pi-too-large";
		if (e.skill !== null) {
			const n = (perSkill.get(e.skill) ?? 0) + 1;
			if (n > PI_LIMITS.maxFilesPerSkill) return "pi-too-many-files";
			perSkill.set(e.skill, n);
		}
	}

	// A case-insensitive host (APFS, NTFS) collapses `references/README.md` and
	// `references/readme.md` -- two distinct git blobs -- onto ONE file. The second write would open
	// an existing 0444 file O_WRONLY and EACCES, surfacing as an opaque throw that a retry cannot
	// fix. Unreachable before issue #60 (one file per skill, and the name charset was lowercase-only)
	// and reachable now, so it is refused here rather than discovered there. The same collapse
	// applies between a FILE and a DIRECTORY prefix (`foo/Bar` beside `foo/bar/x.md`), which is why
	// the ancestor prefixes are collected too.
	const files = new Set();
	const dirs = new Set();
	for (const e of entries) {
		const lower = e.outRel.toLowerCase();
		if (files.has(lower)) return "pi-path-collision";
		files.add(lower);
		const parts = lower.split("/");
		for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
	}
	for (const d of dirs) {
		if (files.has(d)) return "pi-path-collision";
	}
	return null;
}

/**
 * Assert a resolved output path stays under root. Defence in depth behind the path allowlist.
 * Uses path.relative rather than string-prefix so it is correct on Windows too -- the worker is
 * cross-platform and destDir may be a Windows path with backslash separators.
 */
function safeJoin(root, ...segments) {
	const resolved = join(root, ...segments);
	const rel = relative(root, resolved);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
		throw new Error(`path escapes destination: ${segments.join("/")}`);
	}
	return resolved;
}

/**
 * Materialise `.pi/` at `sha` from the clone at `gitDir` into `destDir` (which becomes /job/pi).
 *
 * Returns `{ written, skipped }` -- `written` being the relative paths written, under `pi/` -- or
 * `{ outcome: "policy", reason }` when a cap is breached. The refusal is a determinate POLICY result
 * and therefore RETURNS rather than throws (CONST-RETRY-INFRA-ONLY): the same tree at the same sha
 * breaches the same cap on every retry, so throwing would clone twice and land the job in the failed
 * set with a message nobody maps to "prune your skill directory". Truncating instead was rejected
 * outright -- a truncated skill IS the bug this change fixes, and which files survived would be
 * decided by git's tree order, which no operator can predict.
 *
 * NOTHING IS WRITTEN before every cap has passed, so a refused job leaves no partial /job/pi behind.
 *
 * `git` is injected for tests; defaults to a thin wrapper over the real binary.
 */
export async function materializePiDir({ gitDir, sha, destDir, git = defaultGit }) {
	let lsTreeZ;
	try {
		// `-l` adds the blob size, which is what lets every cap be decided here rather than after N
		// reads. maxBuffer is scoped down from the default 16 MiB: this is a LISTING, and a `.pi/`
		// whose listing alone overruns a megabyte is already past maxFiles by two orders of magnitude.
		lsTreeZ = await git(gitDir, ["ls-tree", "-r", "-l", "-z", sha, `${PI_DIR}/`], { maxBuffer: LS_TREE_MAX_BYTES });
	} catch (error) {
		// A listing too large for the buffer is DETERMINATE -- the same tree overruns it every time --
		// so it becomes the same policy refusal a counted breach gets, rather than an opaque RangeError
		// retried as infrastructure. Narrow on purpose: every other git failure (a bad sha, a missing
		// binary, an unreadable object store) still throws and is still retried.
		if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
			return { outcome: "policy", reason: "pi-too-many-files" };
		}
		throw error;
	}

	const selected = selectEntries(lsTreeZ);
	const declared = keepOnlyDeclaredSkills(selected.entries);
	const skipped = selected.skipped + declared.skipped;

	const breach = checkLimits(declared.kept);
	if (breach) return { outcome: "policy", reason: breach };

	const written = [];
	for (const { oid, outRel } of declared.kept) {
		const content = await git(gitDir, ["cat-file", "blob", oid], { raw: true });
		// outRel is REBUILT from validated segments, never the raw git path -- so it cannot contain
		// traversal. safeJoin re-checks containment as defence in depth, and splits the posix outRel
		// into host path segments so it is correct on Windows too.
		const out = safeJoin(destDir, ...outRel.split("/"));
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, content, { mode: 0o444 });
		// Report posix-style: this names a CONTAINER path (/job/pi/...), stable across host OSes.
		written.push(outRel);
	}
	return { written, skipped };
}

async function defaultGit(gitDir, args, { raw = false, maxBuffer = 16 * 1024 * 1024 } = {}) {
	// -c protecting against a hostile repo config: no hooks, no external filters, no pager.
	const hardened = [
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		"core.fsmonitor=false",
		"--no-pager",
		"-C",
		gitDir,
		...args,
	];
	const { stdout } = await exec("git", hardened, {
		encoding: raw ? "buffer" : "utf8",
		maxBuffer,
	});
	return stdout;
}
