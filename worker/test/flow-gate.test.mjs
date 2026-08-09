import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SKILL_NAME_RE, readFlowGate } from "../src/flow-gate.mjs";

// git is NEVER faked in this suite: readFlowGate's object-store discipline is only meaningfully
// tested against a REAL repo with REAL tree modes (a genuine 120000 symlink, a real prior commit).

function git(dir, args) {
	return execFileSync("git", ["-C", dir, ...args], {
		encoding: "utf8",
		env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
	});
}

function initRepo() {
	const dir = mkdtempSync(join(tmpdir(), "pi-gate-"));
	git(dir, ["init", "-q"]);
	git(dir, ["config", "core.autocrlf", "false"]);
	return dir;
}

function blob(dir, content) {
	return execFileSync("git", ["-C", dir, "hash-object", "-w", "--stdin"], { input: content, encoding: "utf8" }).trim();
}

/** Stage a blob at an exact path with an explicit git mode via the index, commit, return HEAD sha. */
function commitAt(dir, mode, oid, path) {
	git(dir, ["update-index", "--add", "--cacheinfo", `${mode},${oid},${path}`]);
	git(dir, ["commit", "-qm", "x"]);
	return git(dir, ["rev-parse", "HEAD"]).trim();
}

/** A repo whose sole commit holds `.pi/skills/<flow>/SKILL.md` = `body` at git `mode`. */
function repoWithSkill({ flow = "tidy", body, mode = "100644" }) {
	const dir = initRepo();
	const sha = commitAt(dir, mode, blob(dir, body), `.pi/skills/${flow}/SKILL.md`);
	return { dir, sha };
}

test("ai-trigger: allow in the frontmatter -> allow", async () => {
	const { dir, sha } = repoWithSkill({ body: "---\nname: tidy\nai-trigger: allow\ndescription: tidy up\n---\nsteps\n" });
	assert.deepEqual(await readFlowGate({ folder: dir, flow: "tidy", sha }), { gate: "allow" });
});

test("ai-trigger present but not exactly `allow` -> deny (deny / other value / prefix / absent key)", async () => {
	for (const body of [
		"---\nname: tidy\nai-trigger: deny\n---\n",
		"---\nname: tidy\nai-trigger: yes\n---\n",
		"---\nname: tidy\nai-trigger: allowed\n---\n", // prefix, not exact
		"---\nname: tidy\n---\n", // key absent
		"---\nai-trigger:allowdeny\n---\n",
	]) {
		const { dir, sha } = repoWithSkill({ body });
		assert.deepEqual(await readFlowGate({ folder: dir, flow: "tidy", sha }), { gate: "deny" }, JSON.stringify(body));
	}
});

test("no SKILL.md at that path/sha -> no-skill (valid commit, absent path)", async () => {
	const dir = initRepo();
	const sha = commitAt(dir, "100644", blob(dir, "hi"), "README.md");
	assert.deepEqual(await readFlowGate({ folder: dir, flow: "tidy", sha }), { gate: "no-skill" });
});

test("SKILL.md committed as a SYMLINK (mode 120000) -> deny (blob-only), even with allow content", async () => {
	// The symlink's blob content is an `ai-trigger: allow` frontmatter; the mode alone must deny it.
	const { dir, sha } = repoWithSkill({ mode: "120000", body: "---\nai-trigger: allow\n---\n" });
	assert.deepEqual(await readFlowGate({ folder: dir, flow: "tidy", sha }), { gate: "deny" });
});

test("a flow name with `../` or bad charset -> deny, never interpolated into a path", async () => {
	const { dir, sha } = repoWithSkill({ body: "---\nai-trigger: allow\n---\n" });
	for (const bad of ["../etc", "..", "a/b", "UPPER", "a.b", "", "-lead", "trail-"]) {
		assert.deepEqual(await readFlowGate({ folder: dir, flow: bad, sha }), { gate: "deny" }, JSON.stringify(bad));
	}
});

test("a bad/nonexistent sha -> deny (git error caught, no throw)", async () => {
	const { dir } = repoWithSkill({ body: "---\nai-trigger: allow\n---\n" });
	assert.deepEqual(await readFlowGate({ folder: dir, flow: "tidy", sha: "0".repeat(40) }), { gate: "deny" });
	assert.deepEqual(await readFlowGate({ folder: dir, flow: "tidy", sha: "not-a-real-ref" }), { gate: "deny" });
});

test("missing/empty sha -> deny, never falls back to HEAD", async () => {
	const { dir } = repoWithSkill({ body: "---\nai-trigger: allow\n---\n" });
	for (const sha of [undefined, "", "   ", null]) {
		assert.deepEqual(await readFlowGate({ folder: dir, flow: "tidy", sha }), { gate: "deny" }, JSON.stringify(sha));
	}
});

test("a working-tree-only SKILL.md is invisible: object store, not worktree -> no-skill at HEAD", async () => {
	const dir = initRepo();
	const sha = commitAt(dir, "100644", blob(dir, "hi"), "README.md");
	// Write an ALLOW skill into the working tree, but never stage or commit it.
	mkdirSync(join(dir, ".pi/skills/tidy"), { recursive: true });
	writeFileSync(join(dir, ".pi/skills/tidy/SKILL.md"), "---\nai-trigger: allow\n---\n");
	assert.deepEqual(await readFlowGate({ folder: dir, flow: "tidy", sha }), { gate: "no-skill" });
});

test("ai-trigger: allow only at a LATER commit, gated at the earlier sha -> deny (sha pinning)", async () => {
	const dir = initRepo();
	const earlier = commitAt(dir, "100644", blob(dir, "---\nname: tidy\n---\n"), ".pi/skills/tidy/SKILL.md");
	// Same path, later commit, now carrying the opt-in.
	git(dir, ["update-index", "--add", "--cacheinfo", `100644,${blob(dir, "---\nai-trigger: allow\n---\n")},.pi/skills/tidy/SKILL.md`]);
	git(dir, ["commit", "-qm", "y"]);
	const later = git(dir, ["rev-parse", "HEAD"]).trim();
	assert.deepEqual(await readFlowGate({ folder: dir, flow: "tidy", sha: earlier }), { gate: "deny" });
	assert.deepEqual(await readFlowGate({ folder: dir, flow: "tidy", sha: later }), { gate: "allow" });
});

test("no leading `---` frontmatter -> deny, even if an ai-trigger line exists in the body", async () => {
	const { dir, sha } = repoWithSkill({ body: "plain skill body\nai-trigger: allow\n" });
	assert.deepEqual(await readFlowGate({ folder: dir, flow: "tidy", sha }), { gate: "deny" });
});

test("CRLF frontmatter with a quoted value -> allow (CRLF normalised, quote optional)", async () => {
	const { dir, sha } = repoWithSkill({ body: '---\r\nname: tidy\r\nai-trigger: "allow"\r\n---\r\nsteps\r\n' });
	assert.deepEqual(await readFlowGate({ folder: dir, flow: "tidy", sha }), { gate: "allow" });
});

test("never throws even when the folder is not a git repo at all -> deny", async () => {
	const notRepo = mkdtempSync(join(tmpdir(), "pi-notrepo-"));
	assert.deepEqual(await readFlowGate({ folder: notRepo, flow: "tidy", sha: "0".repeat(40) }), { gate: "deny" });
});

test("SKILL_NAME_RE is exported as the single source of truth (issue #92) and holds its vectors", () => {
	// materialize.mjs imports this regex and the admin's setup wizard lists .pi/skills through it, so
	// the charset is API now: a loosening here loosens a traversal choke in three places at once.
	for (const ok of ["tidy", "bug-fix", "a", "x_1", "a".repeat(64)]) assert.ok(SKILL_NAME_RE.test(ok), ok);
	for (const bad of ["", "Tidy", "a..b", "a/b", "-lead", "trail-", ".hidden", "a".repeat(65)]) assert.ok(!SKILL_NAME_RE.test(bad), bad);
});

// --- Gap 5 of issue #60: an INJECTED skill is trigger-reachable and never AI-reachable ---

test("a flow that exists only in an injected skills dir is no-skill at the gate, so a chain refuses", async () => {
	// The property falls out rather than being built: this gate reads the serviced repo's git OBJECT STORE
	// at a pre-agent sha, and a skill copied from the worker host has no object-store presence at all. The
	// caller's test is `gate !== "allow"`, so `no-skill` refuses. Pinned here because it is a SAFETY
	// property of the injected tier, and a future change that made the gate consult the filesystem would
	// otherwise open it silently.
	const { dir, sha } = repoWithSkill({ flow: "committed", body: "---\nname: committed\nai-trigger: allow\n---\nsteps\n" });
	// Simulate the injected tree by putting the skill on DISK only, never in a commit.
	mkdirSync(join(dir, ".pi", "skills", "injected-only"), { recursive: true });
	writeFileSync(join(dir, ".pi", "skills", "injected-only", "SKILL.md"), "---\nname: injected-only\nai-trigger: allow\n---\nx\n");

	assert.equal((await readFlowGate({ folder: dir, flow: "committed", sha })).gate, "allow", "the committed flow is unaffected");
	const injected = await readFlowGate({ folder: dir, flow: "injected-only", sha });
	assert.equal(injected.gate, "no-skill", "a flow present only on disk must not open the gate");
	assert.notEqual(injected.gate, "allow");
});

test("an injected SKILL.md carrying ai-trigger: allow does not open the gate -- the frontmatter is never read", async () => {
	// The corollary an operator cannot discover unaided, which is why doctor warns about it. Writing the
	// opt-in into an injected skill is a silent no-op, and this test is what keeps it silent-but-refused
	// rather than quietly becoming allowed.
	const { dir, sha } = repoWithSkill({ flow: "committed", body: "---\nname: committed\n---\nsteps\n" });
	mkdirSync(join(dir, ".pi", "skills", "eager"), { recursive: true });
	writeFileSync(join(dir, ".pi", "skills", "eager", "SKILL.md"), "---\nname: eager\nai-trigger: allow\n---\nx\n");
	assert.equal((await readFlowGate({ folder: dir, flow: "eager", sha })).gate, "no-skill");
});
