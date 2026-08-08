import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	PI_LIMITS,
	PI_SEGMENT_RE,
	checkLimits,
	classifyPiPath,
	isAllowedPiPath,
	keepOnlyDeclaredSkills,
	materializePiDir,
	selectEntries,
} from "../src/materialize.mjs";
import { ENTRY_NAME_RE } from "../src/import-pi.mjs";

// --- pure selection logic: runs everywhere ---

test("isAllowedPiPath accepts the persona and any declared file inside a skill directory", () => {
	assert.ok(isAllowedPiPath(".pi/APPEND_SYSTEM.md"));
	assert.ok(isAllowedPiPath(".pi/skills/bug-fix/SKILL.md"));
	assert.ok(isAllowedPiPath(".pi/skills/bug_fix2/SKILL.md"));
	// Issue #60: the supporting files a skill ships. These were SILENTLY DROPPED before, which is the
	// whole defect -- pi tells the model to resolve a skill's relative paths against the skill dir,
	// so the skill loaded and pointed at files that were not in the container.
	assert.ok(isAllowedPiPath(".pi/skills/bug-fix/notes.md"));
	assert.ok(isAllowedPiPath(".pi/skills/bug-fix/references/api.md"));
	assert.ok(isAllowedPiPath(".pi/skills/bug-fix/scripts/run.sh"));
	assert.ok(isAllowedPiPath(".pi/skills/bug-fix/nested/deeper/x.md"));
	// Still refused, and these are the assertions that must NOT move.
	assert.ok(!isAllowedPiPath(".pi/settings.json"));
	assert.ok(!isAllowedPiPath(".pi/APPEND_SYSTEM.md.evil"));
	assert.ok(!isAllowedPiPath(".pi/skills/bug-fix")); // a blob AT the skill dir, not inside one
	assert.ok(!isAllowedPiPath(".pi/extensions/evil.ts"));
});

test("a skill name that could express traversal is rejected -- git ls-tree can emit `..` segments", () => {
	// gitshow-research: git does not sanitise tree-entry names, so ls-tree can report a path with
	// literal ../ in it. The name charset (no dots, no slashes) makes traversal impossible here.
	assert.equal(classifyPiPath(".pi/skills/../SKILL.md"), null);
	assert.equal(classifyPiPath(".pi/skills/../../etc/SKILL.md"), null);
	assert.equal(classifyPiPath(".pi/skills/a.b/SKILL.md"), null); // dots barred (no `..`)
	assert.equal(classifyPiPath(".pi/skills/UPPER/SKILL.md"), null); // case-sensitive, JS regex
});

test("every segment BELOW the skill name is charset-validated too, not just the name", () => {
	// The widened grammar splits and validates each piece, so a hostile piece anywhere in the tail is
	// refused exactly as a hostile skill name is.
	assert.equal(classifyPiPath(".pi/skills/good/../../../etc/passwd"), null);
	assert.equal(classifyPiPath(".pi/skills/good/../SKILL.md"), null);
	assert.equal(classifyPiPath(".pi/skills/good/./x.md"), null);
	assert.equal(classifyPiPath(".pi/skills/good/a//b.md"), null); // empty piece
	assert.equal(classifyPiPath(".pi/skills/good/..\\..\\x.md"), null); // backslash survives the split
	assert.equal(classifyPiPath(".pi/skills/good/x\u0000.md"), null); // NUL survives the split
	assert.equal(classifyPiPath(".pi/skills/good/x\n.md"), null);
});

test("a file segment may carry a dot for its extension but never leads or ends with one", () => {
	assert.ok(classifyPiPath(".pi/skills/good/references/api.v2.md"));
	assert.equal(classifyPiPath(".pi/skills/good/.hidden"), null); // leading dot: `.` and `..` lead too
	assert.equal(classifyPiPath(".pi/skills/good/.DS_Store"), null);
	// A trailing dot is stripped by Windows (`foo.` opens `foo`), so it must not reach a write.
	assert.equal(classifyPiPath(".pi/skills/good/x."), null);
});

test("a Windows device basename is refused -- writing CON on Windows is a silent no-op", () => {
	for (const name of ["CON", "con", "NUL", "nul.md", "COM1", "lpt9.txt", "AUX", "PRN"]) {
		assert.equal(classifyPiPath(`.pi/skills/good/${name}`), null, `${name} was accepted`);
	}
	// The rule is the STEM, so a name that merely starts with those letters is fine.
	assert.ok(classifyPiPath(".pi/skills/good/console.md"));
	assert.ok(classifyPiPath(".pi/skills/good/nullable.md"));
});

test("PI_SEGMENT_RE carries no `u` flag: with one, U+212A and U+017F would enter the charset", () => {
	// /[a-z]/iu additionally matches U+212A KELVIN SIGN and U+017F LATIN SMALL LETTER LONG S, so a
	// `u` added here for tidiness would silently widen a security charset by two invisible codepoints.
	assert.equal(PI_SEGMENT_RE.flags.includes("u"), false);
	assert.equal(PI_SEGMENT_RE.test("K"), false);
	assert.equal(PI_SEGMENT_RE.test("ſ"), false);
	// Proof the two really do differ, so this test cannot pass for the wrong reason.
	const withU = new RegExp(PI_SEGMENT_RE.source, `${PI_SEGMENT_RE.flags}u`);
	assert.equal(withU.test("K"), true);
	assert.equal(withU.test("ſ"), true);
});

test("PI_SEGMENT_RE and import-pi's ENTRY_NAME_RE agree, so the forced duplicate cannot drift", () => {
	// Deliberately not imported from import-pi.mjs: that module pulls in execFile and the npm package
	// stager, and this one is on the security-critical read path. This test is what keeps the copies
	// honest instead.
	const vectors = ["a", "ab", "a-b", "a_b", "a.b", "README.md", "SKILL.md", "x9", "A", "..", ".", ".x", "x.", "-x", "x-", "", "a/b", "a b", "a\\b", "K", "a".repeat(64), "a".repeat(65)];
	for (const v of vectors) {
		assert.equal(PI_SEGMENT_RE.test(v), ENTRY_NAME_RE.test(v), `charsets disagree on ${JSON.stringify(v)}`);
	}
});

test("the destination is built from a fixed template, never the raw git path", () => {
	assert.deepEqual(classifyPiPath(".pi/skills/bug-fix/SKILL.md"), { outRel: "pi/skills/bug-fix/SKILL.md", skill: "bug-fix" });
	assert.deepEqual(classifyPiPath(".pi/APPEND_SYSTEM.md"), { outRel: "pi/APPEND_SYSTEM.md", skill: null });
	assert.deepEqual(classifyPiPath(".pi/skills/bug-fix/references/a.md"), {
		outRel: "pi/skills/bug-fix/references/a.md",
		skill: "bug-fix",
	});
});

test("a path deeper than the tail cap, or longer than the length cap, is refused", () => {
	const deep = `.pi/skills/good/${Array.from({ length: PI_LIMITS.maxTailSegments }, (_, i) => `d${i}`).join("/")}/x.md`;
	assert.equal(classifyPiPath(deep), null);
	const ok = `.pi/skills/good/${Array.from({ length: PI_LIMITS.maxTailSegments - 1 }, (_, i) => `d${i}`).join("/")}/x.md`;
	assert.ok(classifyPiPath(ok));
	const long = `.pi/skills/good/${"a".repeat(60)}/${"b".repeat(60)}/${"c".repeat(60)}/${"d".repeat(60)}.md`;
	assert.equal(classifyPiPath(long), null);
});

// --- selectEntries: the mode gate and the size column ---

/** One `git ls-tree -r -l -z` record. The size column is space-padded, right-justified to 7. */
function rec(mode, type, oid, size, path) {
	return `${mode} ${type} ${oid} ${String(size).padStart(7)}\t${path}`;
}

test("selectEntries rejects symlinks (120000), submodules (160000), and executables (100755)", () => {
	const z = [
		rec("100644", "blob", "aaa", 10, ".pi/APPEND_SYSTEM.md"),
		rec("120000", "blob", "bbb", 11, ".pi/EVIL_SYMLINK.md"), // symlink -> host file
		`160000 commit ccc       -\t.pi/skills/sub`, // submodule: `-l` prints "-" for a commit
		rec("100755", "blob", "ddd", 12, ".pi/skills/x/SKILL.md"), // executable bit set
		rec("100644", "blob", "eee", 13, ".pi/skills/good/SKILL.md"),
		rec("100644", "blob", "fff", 14, ".pi/skills/good/references/a.md"), // issue #60: now kept
	].join("\0");
	const { entries, skipped } = selectEntries(z);
	assert.deepEqual(
		entries.map((e) => e.path),
		[".pi/APPEND_SYSTEM.md", ".pi/skills/good/SKILL.md", ".pi/skills/good/references/a.md"],
	);
	assert.equal(skipped, 3);
});

test("the blob size is read from ls-tree -l, and a size we cannot read THROWS", () => {
	// A zeroed or skipped size is an UNENFORCED cap that still reports success -- the silent class.
	const ok = selectEntries(rec("100644", "blob", "aaa", 4096, ".pi/skills/good/SKILL.md"));
	assert.equal(ok.entries[0].size, 4096);
	assert.throws(
		() => selectEntries("100644 blob aaa\t.pi/skills/good/SKILL.md"), // no -l => no size column
		/unreadable object size/,
	);
	assert.throws(() => selectEntries(rec("100644", "blob", "aaa", "nope", ".pi/skills/good/SKILL.md")), /unreadable object size/);
	// The message must not carry the attacker-chosen path.
	try {
		selectEntries("100644 blob deadbeef\t.pi/skills/good/SECRET-NAME.md");
		assert.fail("expected a throw");
	} catch (error) {
		assert.ok(!error.message.includes("SECRET-NAME"), "the thrown message leaked the tree path");
	}
});

// --- the SKILL.md requirement ---

test("a skills subtree with no SKILL.md anywhere is not materialised, and is counted in skipped", () => {
	// pi registers a skill only where a literal SKILL.md exists, so those bytes could never be
	// referenced -- materialising them would be a data-dump channel into the job container.
	const { entries } = selectEntries(
		[
			rec("100644", "blob", "a", 1, ".pi/skills/good/SKILL.md"),
			rec("100644", "blob", "b", 1, ".pi/skills/good/notes.md"),
			rec("100644", "blob", "c", 1, ".pi/skills/dump/data.md"),
			rec("100644", "blob", "d", 1, ".pi/APPEND_SYSTEM.md"),
		].join("\0"),
	);
	const { kept, skipped } = keepOnlyDeclaredSkills(entries);
	assert.deepEqual(kept.map((e) => e.outRel).sort(), ["pi/APPEND_SYSTEM.md", "pi/skills/good/SKILL.md", "pi/skills/good/notes.md"].sort());
	assert.equal(skipped, 1);
});

test("a NESTED SKILL.md declares its subtree -- pi recurses, so dropping it is this bug one level down", () => {
	const { entries } = selectEntries(
		[
			rec("100644", "blob", "a", 1, ".pi/skills/group/sub/SKILL.md"),
			rec("100644", "blob", "b", 1, ".pi/skills/group/sub/notes.md"),
		].join("\0"),
	);
	const { kept, skipped } = keepOnlyDeclaredSkills(entries);
	assert.equal(kept.length, 2);
	assert.equal(skipped, 0);
});

// --- the caps ---

function entriesOf(...specs) {
	return specs.map(([outRel, size, skill]) => ({ oid: "x", path: outRel, size, outRel, skill }));
}

test("the caps are the LITERAL numbers reviewed here, not whatever the constant currently says", () => {
	// Every other test in this file derives its vectors from PI_LIMITS, which makes them correct at any
	// value and therefore blind to a change IN that value -- a mutation run proved it: raising maxFiles
	// broke nothing. This is the pin that makes widening a bound a deliberate, reviewed edit. Same role
	// as the exact deepEqual on PROTECTED_SKILL_ROOTS. If you are here because this went red, change the
	// numbers on purpose and say why in the commit body.
	assert.deepEqual({ ...PI_LIMITS }, {
		maxFiles: 256,
		maxFilesPerSkill: 64,
		maxFileBytes: 1048576,
		maxTotalBytes: 8388608,
		maxTailSegments: 4,
		maxOutRelChars: 200,
	});
	assert.ok(Object.isFrozen(PI_LIMITS));
});

test("checkLimits names the cap that broke, and passes a tree inside every one of them", () => {
	assert.equal(checkLimits(entriesOf(["pi/skills/a/SKILL.md", 10, "a"])), null);
	assert.equal(
		checkLimits(Array.from({ length: PI_LIMITS.maxFiles + 1 }, (_, i) => ({ oid: "x", path: "p", size: 1, outRel: `pi/skills/a/f${i}.md`, skill: "a" }))),
		"pi-too-many-files",
	);
	assert.equal(
		checkLimits(Array.from({ length: PI_LIMITS.maxFilesPerSkill + 1 }, (_, i) => ({ oid: "x", path: "p", size: 1, outRel: `pi/skills/a/f${i}.md`, skill: "a" }))),
		"pi-too-many-files",
	);
	assert.equal(checkLimits(entriesOf(["pi/skills/a/SKILL.md", PI_LIMITS.maxFileBytes + 1, "a"])), "pi-file-too-large");
	// Each file is inside the per-file cap; only their SUM breaks the total. The two caps refuse
	// different mistakes (one huge blob vs many medium ones), so each needs its own vector.
	const perFile = PI_LIMITS.maxFileBytes;
	const many = Array.from({ length: Math.ceil(PI_LIMITS.maxTotalBytes / perFile) + 1 }, (_, i) => ["pi/skills/a/f" + i + ".md", perFile, "a"]);
	assert.ok(many.length <= PI_LIMITS.maxFilesPerSkill, "vector must break the BYTE cap, not the count cap");
	assert.equal(checkLimits(entriesOf(...many)), "pi-too-large");
});

test("two paths differing only in case are refused -- a case-insensitive host EACCESes the 0444 rewrite", () => {
	// The refusal is asserted, never the EACCES: macOS APFS collapses these and Linux CI does not, so
	// only OUR decision is deterministic on every host.
	assert.equal(checkLimits(entriesOf(["pi/skills/a/references/README.md", 1, "a"], ["pi/skills/a/references/readme.md", 1, "a"])), "pi-path-collision");
	// A file colliding with another file's DIRECTORY prefix collapses the same way.
	assert.equal(checkLimits(entriesOf(["pi/skills/a/Bar", 1, "a"], ["pi/skills/a/bar/x.md", 1, "a"])), "pi-path-collision");
	assert.equal(checkLimits(entriesOf(["pi/skills/a/bar.md", 1, "a"], ["pi/skills/a/baz/x.md", 1, "a"])), null);
});

// --- materializePiDir: refuse BEFORE spending, and the git failure classes ---

/** A git fake that records its ls-tree argv and counts cat-file spawns. */
function countingGit(lsTreeZ) {
	const calls = { catFile: 0, lsTreeArgs: null };
	const git = async (_dir, args) => {
		if (args[0] === "ls-tree") {
			calls.lsTreeArgs = args;
			return lsTreeZ;
		}
		if (args[0] === "cat-file") {
			calls.catFile++;
			return Buffer.from("body");
		}
		throw new Error(`unexpected git call: ${args[0]}`);
	};
	return { git, calls };
}

test("the size comes from ls-tree -l, so a cap breach costs no cat-file", async () => {
	const { git, calls } = countingGit(rec("100644", "blob", "a", 1, ".pi/skills/good/SKILL.md"));
	await materializePiDir({ gitDir: "/x", sha: "s", destDir: mkdtempSync(join(tmpdir(), "pi-dest-")), git });
	assert.ok(calls.lsTreeArgs.includes("-l"), "ls-tree must ask for the size column");
	assert.ok(calls.lsTreeArgs.includes("-z") && calls.lsTreeArgs.includes("-r"));
});

test("over a cap the job is REFUSED, and not a single blob is read or written", async () => {
	const big = [rec("100644", "blob", "a", 1, ".pi/skills/good/SKILL.md"), rec("100644", "blob", "b", PI_LIMITS.maxFileBytes + 1, ".pi/skills/good/huge.md")].join("\0");
	const { git, calls } = countingGit(big);
	const dest = mkdtempSync(join(tmpdir(), "pi-dest-"));
	const result = await materializePiDir({ gitDir: "/x", sha: "s", destDir: dest, git });
	assert.deepEqual(result, { outcome: "policy", reason: "pi-file-too-large" });
	assert.equal(calls.catFile, 0, "a blob was read despite the refusal");
	assert.deepEqual(readdirSync(dest), [], "a file was written despite the refusal");
});

test("a listing too large for the buffer is a policy refusal, not an infra retry", async () => {
	// Determinate: the same tree at the same sha overruns the buffer every time, so retrying it is
	// paying twice for the same answer.
	const git = async () => {
		const error = new RangeError("stdout maxBuffer length exceeded");
		error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
		throw error;
	};
	const result = await materializePiDir({ gitDir: "/x", sha: "s", destDir: "/y", git });
	assert.deepEqual(result, { outcome: "policy", reason: "pi-too-many-files" });
});

test("any other git failure still THROWS -- only the maxBuffer overrun is determinate", async () => {
	const git = async () => {
		throw new Error("fatal: not a git repository");
	};
	await assert.rejects(() => materializePiDir({ gitDir: "/x", sha: "s", destDir: "/y", git }), /not a git repository/);
});

// --- integration against a REAL git repo with REAL hostile objects ---

function git(dir, args) {
	return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

/** A repo whose .pi/ contains genuine symlink objects and gitlinks, plus real files. */
function hostileRepo() {
	const dir = mkdtempSync(join(tmpdir(), "pi-mat-"));
	git(dir, ["init", "-q"]);
	git(dir, ["config", "user.email", "t@t"]);
	git(dir, ["config", "user.name", "t"]);
	git(dir, ["config", "core.autocrlf", "false"]);

	const blob = (content) =>
		execFileSync("git", ["-C", dir, "hash-object", "-w", "--stdin"], { input: content, encoding: "utf8" }).trim();

	const persona = blob("REAL-PERSONA-SENTINEL");
	const skill = blob("---\nname: good\ndescription: real\n---\nsteps\n");
	const reference = blob("REAL-REFERENCE-SENTINEL");
	const dump = blob("UNDECLARED-DUMP");
	const evilTarget = blob("/etc/passwd"); // the symlink's blob content = its target path

	// Build the tree entirely through the index -- creates genuine 120000 symlinks and 160000
	// gitlinks without needing OS symlink privilege (which Windows dev boxes lack).
	git(dir, ["update-index", "--add", "--cacheinfo", `100644,${persona},.pi/APPEND_SYSTEM.md`]);
	git(dir, ["update-index", "--add", "--cacheinfo", `100644,${skill},.pi/skills/good/SKILL.md`]);
	git(dir, ["update-index", "--add", "--cacheinfo", `100644,${reference},.pi/skills/good/references/real.md`]);
	git(dir, ["update-index", "--add", "--cacheinfo", `120000,${evilTarget},.pi/EVIL_SYMLINK.md`]);
	// Issue #60's new surface: hostile objects INSIDE a skill's subdirectory, which the old one-file
	// allowlist could never have reached.
	git(dir, ["update-index", "--add", "--cacheinfo", `120000,${evilTarget},.pi/skills/good/references/EVIL_LINK.md`]);
	git(dir, ["update-index", "--add", "--cacheinfo", `120000,${evilTarget},.pi/skills/good/scripts`]);
	// An executable blob inside a skill: the documented limitation, dropped rather than written.
	git(dir, ["update-index", "--add", "--cacheinfo", `100755,${reference},.pi/skills/good/build.sh`]);
	// A subtree that declares no SKILL.md anywhere: registers nothing in pi, so it is not copied.
	git(dir, ["update-index", "--add", "--cacheinfo", `100644,${dump},.pi/skills/dump/data.md`]);
	// A submodule gitlink. git rejects a null sha, so use any valid nonzero oid (the blob's) --
	// update-index does not verify a gitlink points at a real commit, which is all we need here.
	git(dir, ["update-index", "--add", "--cacheinfo", `160000,${persona},.pi/skills/sub`]);
	git(dir, ["update-index", "--add", "--cacheinfo", `160000,${persona},.pi/skills/good/nested`]);
	git(dir, ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"]);
	const sha = git(dir, ["rev-parse", "HEAD"]).trim();
	return { dir, sha };
}

test("materialize writes real files and NEVER the symlink or submodule", async () => {
	const { dir, sha } = hostileRepo();
	const dest = mkdtempSync(join(tmpdir(), "pi-dest-"));

	const { written } = await materializePiDir({ gitDir: dir, sha, destDir: dest });

	assert.deepEqual(written.sort(), ["pi/APPEND_SYSTEM.md", "pi/skills/good/SKILL.md", "pi/skills/good/references/real.md"].sort());
	assert.equal(readFileSync(join(dest, "pi/APPEND_SYSTEM.md"), "utf8"), "REAL-PERSONA-SENTINEL");
	// The supporting file is the point of issue #60: it must actually arrive.
	assert.equal(readFileSync(join(dest, "pi/skills/good/references/real.md"), "utf8"), "REAL-REFERENCE-SENTINEL");

	// The symlinks must have produced NOTHING -- not a file containing "/etc/passwd", not anything --
	// including the one nested inside the skill's own references/ directory.
	const flat = JSON.stringify(readdirSync(dest, { recursive: true }));
	assert.ok(!flat.includes("EVIL_SYMLINK"), "the symlink entry was materialised");
	assert.ok(!flat.includes("EVIL_LINK"), "a symlink INSIDE a skill subdirectory was materialised");
	assert.ok(!flat.includes("scripts"), "a symlinked DIRECTORY inside a skill was materialised");
	assert.ok(!flat.includes("nested"), "a gitlink inside a skill was materialised");
	assert.ok(!flat.includes("sub"), "the submodule entry was materialised");
	assert.ok(!flat.includes("dump"), "a subtree declaring no SKILL.md was materialised");

	// And no host-file content leaked in either.
	const allContent = written.map((r) => readFileSync(join(dest, r), "utf8")).join("\n");
	assert.ok(!allContent.includes("root:x:0:0"), "host /etc/passwd content leaked into the prompt");
	assert.ok(!allContent.includes("/etc/passwd"), "symlink target path leaked into the prompt");
});

test("an executable blob inside a skill is dropped, not written -- the documented scripts limitation", async () => {
	// A skill's scripts arrive non-executable and are invoked as `bash script.sh`. Accepting 100755
	// and writing 0444 would accept the mode and silently strip it; writing 0555 would have the worker
	// grant execve on repo bytes. The drop is loud (the file is absent) rather than silent.
	const { dir, sha } = hostileRepo();
	const dest = mkdtempSync(join(tmpdir(), "pi-dest-"));
	const { written } = await materializePiDir({ gitDir: dir, sha, destDir: dest });
	assert.ok(!written.some((p) => p.endsWith("build.sh")), "an executable blob was materialised");
});

test("a repo with no .pi/ materialises nothing (guardrails-only job), no error", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-empty-"));
	git(dir, ["init", "-q"]);
	git(dir, ["config", "user.email", "t@t"]);
	git(dir, ["config", "user.name", "t"]);
	execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", "x"], {
		env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
	});
	const sha = git(dir, ["rev-parse", "HEAD"]).trim();
	const dest = mkdtempSync(join(tmpdir(), "pi-dest-"));
	const result = await materializePiDir({ gitDir: dir, sha, destDir: dest });
	assert.deepEqual(result, { written: [], skipped: 0 });
});
