import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ENTRY_NAME_RE, INJECT_LIMITS, copySkillTree } from "../src/copy-tree.mjs";

/** A host skills dir: `<root>/<name>/SKILL.md`, the `~/.pi/agent/skills` layout. */
function skillsDir({ skills = { tidy: { "SKILL.md": "---\nname: tidy\n---\nTidy.\n" } } } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-inject-"));
	for (const [name, files] of Object.entries(skills)) {
		for (const [rel, body] of Object.entries(files)) {
			const p = join(root, name, rel);
			mkdirSync(join(p, ".."), { recursive: true });
			writeFileSync(p, body);
		}
	}
	return root;
}

const destDir = () => mkdtempSync(join(tmpdir(), "pi-inject-dest-"));
const flat = (d) => JSON.stringify(readdirSync(d, { recursive: true }));

test("a skill directory is copied whole, and the receipt counts what landed", () => {
	const src = skillsDir({
		skills: { tidy: { "SKILL.md": "---\nname: tidy\n---\nTidy.\n", "references/api.md": "REF-SENTINEL" } },
	});
	const dest = destDir();
	const result = copySkillTree(src, dest);

	assert.equal(result.refused, undefined);
	assert.equal(result.dirs, 1);
	assert.equal(result.files, 2);
	assert.equal(readFileSync(join(dest, "tidy", "references", "api.md"), "utf8"), "REF-SENTINEL");
});

test("copied files are 0444, so nothing on the host can rewrite a job's inputs by accident", () => {
	const dest = destDir();
	copySkillTree(skillsDir(), dest);
	assert.equal(statSync(join(dest, "tidy", "SKILL.md")).mode & 0o777, 0o444);
});

test("mode null preserves the source mode, which is what import-pi needs to re-stage without EACCES", () => {
	const src = skillsDir();
	const dest = destDir();
	copySkillTree(src, dest, { mode: null });
	// A second stage over the first must not fail: copyFileSync onto a 0444 file is EACCES, which is
	// exactly the trap that makes the mode a parameter rather than a constant.
	const again = copySkillTree(src, dest, { mode: null });
	assert.equal(again.refused, undefined);
});

// --- the symlink guard: the bug this module exists to fix ---

test("a symlinked SKILL.md is skipped, and no host file content reaches the destination", () => {
	const src = skillsDir();
	const secret = join(mkdtempSync(join(tmpdir(), "pi-secret-")), "env");
	writeFileSync(secret, "HOST-SECRET-SENTINEL");
	symlinkSync(secret, join(src, "tidy", "stolen.md"));

	const dest = destDir();
	const result = copySkillTree(src, dest);

	assert.equal(result.skipped.symlinks, 1);
	assert.ok(!flat(dest).includes("stolen"), "the symlink was materialised");
	const bodies = readdirSync(dest, { recursive: true })
		.map((r) => join(dest, r))
		.filter((p) => statSync(p).isFile())
		.map((p) => readFileSync(p, "utf8"))
		.join("\n");
	assert.ok(!bodies.includes("HOST-SECRET-SENTINEL"), "host file content leaked through a symlink");
});

test("a symlinked DIRECTORY is skipped -- statSync would have FOLLOWED it, which is the repaired bug", () => {
	// This is the case the old `statSync(p).isSymbolicLink?.()` guard could never catch: statSync
	// resolves the link, so the expression was permanently false and the target's CONTENTS were copied.
	// A directory symlink pointing at / would have walked the host filesystem into a job container.
	const src = skillsDir();
	const elsewhere = mkdtempSync(join(tmpdir(), "pi-elsewhere-"));
	writeFileSync(join(elsewhere, "secret.md"), "HOST-TREE-SENTINEL");
	symlinkSync(elsewhere, join(src, "tidy", "linked"));

	const dest = destDir();
	const result = copySkillTree(src, dest);

	assert.equal(result.skipped.symlinks, 1);
	assert.ok(!flat(dest).includes("linked"), "a symlinked directory was followed");
	assert.ok(!flat(dest).includes("secret.md"), "a symlinked directory's CONTENTS were copied");
});

test("a symlinked TOP-LEVEL skill directory is skipped and reported to the caller", () => {
	const src = skillsDir();
	const elsewhere = mkdtempSync(join(tmpdir(), "pi-elsewhere-"));
	writeFileSync(join(elsewhere, "SKILL.md"), "---\nname: sneaky\n---\nx\n");
	symlinkSync(elsewhere, join(src, "sneaky"));

	const skips = [];
	const dest = destDir();
	const result = copySkillTree(src, dest, { onSkip: (n, r) => skips.push([n, r]) });

	assert.equal(result.dirs, 1, "only the real skill was copied");
	assert.deepEqual(skips, [["sneaky", "symlink"]]);
	assert.ok(!flat(dest).includes("sneaky"));
});

// --- names, and the destination template ---

test("a badly named entry is skipped and reported, never joined into a path", () => {
	// The charset is checked BEFORE the name reaches join(), which is the traversal choke point --
	// ENTRY_NAME_RE's leading class excludes ".", so "." and ".." cannot match.
	const src = skillsDir();
	mkdirSync(join(src, "not a skill"), { recursive: true });
	writeFileSync(join(src, "not a skill", "SKILL.md"), "x");

	const skips = [];
	const result = copySkillTree(src, destDir(), { onSkip: (n, r) => skips.push([n, r]) });
	assert.equal(result.dirs, 1);
	assert.deepEqual(skips, [["not a skill", "unexpected name"]]);
});

test("a dotfile is skipped, the same rule pi's own loader applies", () => {
	const src = skillsDir();
	writeFileSync(join(src, "tidy", ".DS_Store"), "junk");
	const dest = destDir();
	const result = copySkillTree(src, dest);
	assert.equal(result.files, 1, "only SKILL.md should land");
	assert.ok(!flat(dest).includes("DS_Store"));
});

// --- the caps ---

test("the directory cap refuses, and the reason names the breach", () => {
	const skills = {};
	for (let i = 0; i <= INJECT_LIMITS.maxDirs; i++) skills[`s${i}`] = { "SKILL.md": "x" };
	assert.equal(copySkillTree(skillsDir({ skills }), destDir()).refused, "skills-dir-too-large");
});

test("the byte cap refuses mid-walk rather than copying most of a skill", () => {
	const big = "x".repeat(1 << 20);
	const files = { "SKILL.md": "x" };
	for (let i = 0; i < 5; i++) files[`f${i}.md`] = big;
	assert.equal(copySkillTree(skillsDir({ skills: { tidy: files } }), destDir()).refused, "skills-dir-too-large");
});

test("the file-count cap refuses", () => {
	const files = {};
	for (let i = 0; i <= INJECT_LIMITS.maxFiles; i++) files[`f${i}.md`] = "x";
	assert.equal(copySkillTree(skillsDir({ skills: { tidy: files } }), destDir()).refused, "skills-dir-too-many-files");
});

test("the depth cap refuses a tree nested past it", () => {
	const deep = `${Array.from({ length: INJECT_LIMITS.maxDepth + 1 }, (_, i) => `d${i}`).join("/")}/x.md`;
	assert.equal(copySkillTree(skillsDir({ skills: { tidy: { "SKILL.md": "x", [deep]: "x" } } }), destDir()).refused, "skills-dir-too-deep");
});

test("the caps are the LITERAL numbers reviewed here, not whatever the constant says", () => {
	// Same role as materialize.mjs's PI_LIMITS pin: every other test derives its vector from the
	// constant and so is blind to a change IN it. Widening a bound must be a deliberate edit.
	assert.deepEqual({ ...INJECT_LIMITS }, { maxDirs: 64, maxFiles: 512, maxBytes: 4194304, maxDepth: 8 });
	assert.ok(Object.isFrozen(INJECT_LIMITS));
});

test("limits null lifts every cap, which is how import-pi stages an overlay", () => {
	const skills = {};
	for (let i = 0; i <= INJECT_LIMITS.maxDirs; i++) skills[`s${i}`] = { "SKILL.md": "x" };
	const result = copySkillTree(skillsDir({ skills }), destDir(), { limits: null, mode: null });
	assert.equal(result.refused, undefined);
	assert.equal(result.dirs, INJECT_LIMITS.maxDirs + 1);
});

// --- refusals that are not caps ---

test("an empty or absent source refuses rather than silently copying nothing", () => {
	// A trigger that named a skills dir and got a job with no skills is the silent no-op this project
	// treats as the worst outcome available.
	assert.equal(copySkillTree(mkdtempSync(join(tmpdir(), "pi-empty-")), destDir()).refused, "skills-dir-empty");
	assert.equal(copySkillTree(join(tmpdir(), "pi-absent-xyz-123"), destDir()).refused, "skills-dir-unreadable");
});

test("the receipt carries COUNTS only -- no name and no path a caller could log", () => {
	const src = skillsDir();
	symlinkSync(join(src, "tidy"), join(src, "alias"));
	const result = copySkillTree(src, destDir());
	const serialised = JSON.stringify(result);
	assert.ok(!serialised.includes(src), "the receipt carries the host path");
	assert.ok(!serialised.includes("tidy"), "the receipt carries a skill name");
	assert.deepEqual(Object.keys(result).sort(), ["bytes", "dirs", "files", "skipped"]);
});

test("ENTRY_NAME_RE lives here now, and import-pi re-exports the same object", async () => {
	const { ENTRY_NAME_RE: reExported } = await import("../src/import-pi.mjs");
	assert.equal(reExported, ENTRY_NAME_RE, "the re-export must be the same regex, not a copy");
});
