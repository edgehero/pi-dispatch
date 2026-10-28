/**
 * The workspace checkpointer against REAL git in temp directories (issue #645). Real git because the
 * properties under test are git's: which config it reads, which filters it runs, what fast-import and
 * diff-tree accept. A fake git would test the fake.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as realFs from "node:fs";
import * as realFsp from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { STORE_GIT_FLAGS, storeGitEnv } from "../src/git-hardening.mjs";
import { checkpointKey, DEFAULT_CHECKPOINT_LIMITS, defaultSpawnGit, makeWorkspaceCheckpointer } from "../src/workspace-checkpoint.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/** A fixed clock: the checkpointer's lock staleness and sweep TTL read it, so it is always injected. */
const NOW = 1_800_000_000_000;
const PLENTY = async () => ({ bavail: 1e9, bsize: 4096, blocks: 2e9 });
const IS_ROOT = process.getuid?.() === 0;
const MiB = 1024 * 1024;

/** The test's OWN git, never the subject's: a clean config so the developer's signing or hooks cannot leak in. */
const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.invalid",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.invalid",
};
function git(cwd, args, opts = {}) {
	return execFileSync("git", args, { cwd, env: { ...GIT_ENV, ...opts.env }, input: opts.input, stdio: ["pipe", "pipe", "pipe"] });
}
const gitText = (cwd, args, opts) => git(cwd, args, opts).toString("utf8").trim();
const storeGit = (storeDir, runId, args, opts = {}) =>
	git(storeDir, args, { ...opts, env: { GIT_DIR: join(storeDir, checkpointKey(runId), "repo.git") } });

/** An origin repository with `files` committed, cloned into a fresh workspace: the trusted start of a run. */
function setup(files = { "a.txt": "hello\n", "d/b.txt": "bee\n", "run.sh": "#!/bin/sh\n" }, { objectFormat = "sha1" } = {}) {
	const root = tempDir("pi-ck-");
	const origin = join(root, "origin");
	realFs.mkdirSync(origin);
	git(origin, ["init", "-q", "-b", "main", `--object-format=${objectFormat}`]);
	for (const [p, content] of Object.entries(files)) {
		realFs.mkdirSync(join(origin, p, ".."), { recursive: true });
		realFs.writeFileSync(join(origin, p), content);
	}
	if (files["run.sh"]) realFs.chmodSync(join(origin, "run.sh"), 0o755);
	git(origin, ["add", "-A"]);
	git(origin, ["commit", "-qm", "base"]);
	const ws = join(root, "ws");
	git(root, ["clone", "-q", origin, ws]);
	return { root, origin, ws, baseSha: gitText(ws, ["rev-parse", "HEAD"]), storeDir: join(root, "store") };
}

function checkpointer(storeDir, extra = {}) {
	const logs = [];
	const ck = makeWorkspaceCheckpointer({ storeDir, now: () => NOW, statfs: PLENTY, hostName: "worker-1", log: (e, f) => logs.push([e, f]), ...extra });
	return { ck, logs };
}

async function primed(env, extra = {}, runId = "run-1") {
	const made = checkpointer(env.storeDir, extra);
	const primedResult = await made.ck.primeBase({ runId, workspace: env.ws, baseSha: env.baseSha, objectFormat: extra.objectFormat ?? "sha1" });
	assert.equal(primedResult.ok, true, `primeBase: ${JSON.stringify(primedResult)}`);
	return made;
}

/** The caller's half of a restore: a fresh base checkout fetched from the store itself. */
function freshBase(ck, runId, baseSha, objectFormat = "sha1") {
	const dir = tempDir("pi-ck-into-");
	git(dir, ["init", "-q", `--object-format=${objectFormat}`]);
	git(dir, ["-c", "protocol.file.allow=always", "fetch", "-q", "--depth=1", ck.baseSourceUrl(runId), baseSha]);
	git(dir, ["checkout", "-q", "--detach", baseSha]);
	return dir;
}

/** Every file and link under `dir`, by path, with exact bytes and the exec bit; dotgit segments excluded. */
function nodeWalk(dir) {
	const out = {};
	const visit = (rel) => {
		for (const name of realFs.readdirSync(rel ? join(dir, rel) : dir)) {
			if (name.toLowerCase() === ".git") continue;
			const p = rel ? `${rel}/${name}` : name;
			const st = realFs.lstatSync(join(dir, p));
			if (st.isDirectory()) visit(p);
			else if (st.isSymbolicLink()) out[p] = `link:${realFs.readlinkSync(join(dir, p))}`;
			else out[p] = `${st.mode & 0o111 ? "x" : "-"}:${realFs.readFileSync(join(dir, p)).toString("base64")}`;
		}
	};
	visit("");
	return out;
}

function treePaths(env, runId, commit) {
	return storeGit(env.storeDir, runId, ["ls-tree", "-r", "-z", "--name-only", commit]).toString("utf8").split("\0").filter(Boolean).sort();
}

const blobId = (bytes) => createHash("sha1").update(`blob ${Buffer.byteLength(bytes)}\0`).update(bytes).digest("hex");

function storeHas(env, runId, oid) {
	try {
		storeGit(env.storeDir, runId, ["cat-file", "-e", oid]);
		return true;
	} catch {
		return false;
	}
}

// ── round trip ──────────────────────────────────────────────────────────────────────────────────────────

test("snapshot then restore into a fresh base clone reproduces the tree byte for byte (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env);
	realFs.writeFileSync(join(env.ws, "a.txt"), "changed\n");
	realFs.rmSync(join(env.ws, "d/b.txt"));
	realFs.mkdirSync(join(env.ws, "new/deep"), { recursive: true });
	realFs.writeFileSync(join(env.ws, "new/deep/c.bin"), Buffer.from([0, 1, 2, 255, 10, 13]));
	realFs.writeFileSync(join(env.ws, "we\"ird name\\.txt"), "q\n");
	realFs.writeFileSync(join(env.ws, "日本.txt"), "u\n");
	realFs.writeFileSync(join(env.ws, "tool"), "#!/bin/sh\necho\n", { mode: 0o755 });
	realFs.chmodSync(join(env.ws, "run.sh"), 0o644);
	realFs.symlinkSync("/etc", join(env.ws, "etc-link"));
	realFs.symlinkSync("a.txt", join(env.ws, "rel-link"));
	const transcript = join(env.root, "t.jsonl");
	realFs.writeFileSync(transcript, "{\"a\":1}\n{\"b\":2}\n");

	const snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1, branch: "main", transcript: { srcFile: transcript, offset: 8 }, meta: { piVersion: "1.2.0", model: "gpt-5.5" } });
	assert.equal(snap.ok, true, JSON.stringify(snap));
	assert.equal(snap.manifest.workspace.git.branch, "main");
	assert.equal(snap.manifest.workspace.git.tip, env.baseSha);
	assert.equal(snap.manifest.piVersion, "1.2.0");
	assert.equal(snap.manifest.host, "worker-1");
	const commitText = storeGit(env.storeDir, "run-1", ["cat-file", "-p", snap.manifest.workspace.commit]).toString();
	assert.match(commitText, new RegExp(`^parent ${env.baseSha}$`, "m"), "every checkpoint's parent is the base");
	assert.match(commitText, /^committer pi-dispatch <checkpoint@pi-dispatch\.invalid> 1800000000 \+0000$/m, "the injected clock, in seconds");

	const read = await ck.readManifest("run-1");
	assert.equal(read.ok, true, JSON.stringify(read));
	assert.equal(realFs.readFileSync(read.transcriptPath, "utf8"), "{\"a\":1}\n", "exactly bytes [0, offset)");

	const into = freshBase(ck, "run-1", env.baseSha);
	const restored = await ck.restore({ runId: "run-1", manifest: read.manifest, intoWorkspace: into });
	assert.ok(restored.written > 0 && restored.removed === 1, JSON.stringify(restored));
	assert.deepEqual(nodeWalk(into), nodeWalk(env.ws));
	assert.equal(realFs.existsSync(join(into, "d")), false, "a directory emptied by deletions is pruned, as a checkout would");
});

test("a sha256 repository round-trips too: oids are computed in the store's own format (#645)", async () => {
	const env = setup(undefined, { objectFormat: "sha256" });
	const { ck } = await primed(env, { objectFormat: "sha256" });
	realFs.writeFileSync(join(env.ws, "a.txt"), "two five six\n");
	const snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 });
	assert.equal(snap.ok, true, JSON.stringify(snap));
	assert.match(snap.manifest.workspace.commit, /^[0-9a-f]{64}$/);
	const into = freshBase(ck, "run-1", env.baseSha, "sha256");
	await ck.restore({ runId: "run-1", manifest: (await ck.readManifest("run-1")).manifest, intoWorkspace: into });
	assert.deepEqual(nodeWalk(into), nodeWalk(env.ws));
});

test("unchanged base files are not re-read: the primed stat cache supplies their oids (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env);
	realFs.writeFileSync(join(env.ws, "new.txt"), "n\n");
	const snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 });
	assert.equal(snap.manifest.workspace.counts.newBytes, 2, "only the new file's bytes were read");
	assert.equal(snap.manifest.workspace.counts.files, 4);
});

test(".gitattributes ident, eol=crlf and working-tree-encoding: the restored bytes are the workspace's bytes (#645)", async () => {
	const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
	const env = setup({
		".gitattributes": "*.crlf eol=crlf\n*.id ident\n*.u16 working-tree-encoding=UTF-16\n",
		"a.crlf": "one\ntwo\n",
		"b.id": "$Id$\n",
		"c.u16": utf16("hello\n"),
	});
	const { ck } = await primed(env);
	realFs.writeFileSync(join(env.ws, "a.crlf"), "one\r\nmixed\nthree\r\n");
	realFs.writeFileSync(join(env.ws, "new.id"), "$Id$ and $Id: deadbeef $\n");
	realFs.writeFileSync(join(env.ws, "c.u16"), utf16("héllo\r\n"));
	const snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 });
	assert.equal(snap.ok, true, JSON.stringify(snap));
	const into = freshBase(ck, "run-1", env.baseSha);
	await ck.restore({ runId: "run-1", manifest: snap.manifest, intoWorkspace: into });
	assert.deepEqual(nodeWalk(into), nodeWalk(env.ws), "no filter ran in either direction");
});

// ── the agent's .git is never run ───────────────────────────────────────────────────────────────────────

test("a hostile .git/config (clean filter, fsmonitor, gpg program, include) never runs, through snapshot, the ignore tier and restore (#645)", async () => {
	const env = setup({ "a.txt": "a\n", ".gitignore": "junk/\n" });
	const sentinel = join(env.root, "SENTINEL");
	const touch = `touch ${sentinel}`;
	const { ck } = await primed(env);
	const evilInclude = join(env.root, "evil.config");
	realFs.writeFileSync(evilInclude, `[core]\n\tfsmonitor = ${touch}\n[core]\n\thooksPath = ${env.root}/hooks\n`);
	realFs.appendFileSync(
		join(env.ws, ".git", "config"),
		`[filter "evil"]\n\tclean = sh -c '${touch}; cat'\n\tsmudge = sh -c '${touch}; cat'\n\trequired = true\n` +
			`[core]\n\tfsmonitor = ${touch}\n[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = ${sentinel}.sh\n[include]\n\tpath = ${evilInclude}\n`,
	);
	realFs.writeFileSync(`${sentinel}.sh`, `#!/bin/sh\n${touch}\n`, { mode: 0o755 });
	realFs.mkdirSync(join(env.root, "hooks"));
	realFs.writeFileSync(join(env.root, "hooks", "post-checkout"), `#!/bin/sh\n${touch}\n`, { mode: 0o755 });
	realFs.writeFileSync(join(env.ws, ".gitattributes"), "* filter=evil\n");
	realFs.writeFileSync(join(env.ws, "a.txt"), "changed\n");
	realFs.mkdirSync(join(env.ws, "junk"));
	realFs.writeFileSync(join(env.ws, "junk", "big"), "x".repeat(4000));

	const snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1, branch: "main" });
	assert.equal(snap.ok, true, JSON.stringify(snap));
	// A second checkpointer on the same store with a tiny byte cap forces the check-ignore tier.
	const tight = checkpointer(env.storeDir, { limits: { maxNewBytes: 1000 } }).ck;
	realFs.writeFileSync(join(env.ws, "a.txt"), "changed again\n");
	const snap2 = await tight.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 2 });
	assert.equal(snap2.ok, true, JSON.stringify(snap2));
	assert.equal(snap2.manifest.workspace.ignoredDropped, true);
	const into = freshBase(ck, "run-1", env.baseSha);
	await ck.restore({ runId: "run-1", manifest: snap2.manifest, intoWorkspace: into });
	assert.equal(realFs.existsSync(sentinel), false, "no command from the agent's repository ran on the host");
});

test("a `gitdir:` redirect as .git is unreadable state, never followed; nothing of the target lands in the store (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env);
	const other = join(env.root, "other");
	realFs.mkdirSync(other);
	git(other, ["init", "-q"]);
	realFs.writeFileSync(join(other, "secret-ish"), "unique-to-other-repo\n");
	git(other, ["add", "-A"]);
	git(other, ["commit", "-qm", "o"]);
	realFs.rmSync(join(env.ws, ".git"), { recursive: true });
	realFs.writeFileSync(join(env.ws, ".git"), `gitdir: ${join(other, ".git")}\n`);
	const snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1, branch: "main" });
	assert.equal(snap.ok, true, JSON.stringify(snap));
	assert.equal(snap.manifest.workspace.git.state, "unreadable");
	assert.equal(snap.manifest.workspace.counts.skipped.dotgit, 1, "the redirect file itself is a dotgit, excluded");
	assert.equal(storeHas(env, "run-1", blobId("unique-to-other-repo\n")), false);
});

test("objects/info/alternates and a symlinked objects/ in the agent's .git pull nothing into the store (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env);
	const other = join(env.root, "other");
	realFs.mkdirSync(other);
	git(other, ["init", "-q"]);
	realFs.writeFileSync(join(other, "f"), "only-in-the-alternate\n");
	git(other, ["add", "-A"]);
	git(other, ["commit", "-qm", "o"]);
	realFs.mkdirSync(join(env.ws, ".git", "objects", "info"), { recursive: true });
	realFs.writeFileSync(join(env.ws, ".git", "objects", "info", "alternates"), `${join(other, ".git", "objects")}\n`);
	const snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1, branch: "main" });
	assert.equal(snap.ok, true);
	assert.equal(storeHas(env, "run-1", blobId("only-in-the-alternate\n")), false);

	realFs.rmSync(join(env.ws, ".git", "objects"), { recursive: true });
	realFs.symlinkSync(join(other, ".git", "objects"), join(env.ws, ".git", "objects"));
	const snap2 = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 2, branch: "main" });
	assert.equal(snap2.ok, true, JSON.stringify(snap2));
	assert.equal(storeHas(env, "run-1", blobId("only-in-the-alternate\n")), false);
});

test("the git state comes from files: detached HEAD, another branch, packed-refs (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env);
	git(env.ws, ["checkout", "-q", "-b", "agent-branch"]);
	let snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1, branch: "issue-7" });
	assert.deepEqual(snap.manifest.workspace.git, { state: "parsed", branch: null, tip: null, detached: false }, "an agent-chosen branch name is never recorded");
	git(env.ws, ["checkout", "-q", "-b", "issue-7"]);
	git(env.ws, ["pack-refs", "--all"]);
	snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 2, branch: "issue-7" });
	assert.deepEqual(snap.manifest.workspace.git, { state: "parsed", branch: "issue-7", tip: env.baseSha, detached: false }, "found in packed-refs");
	git(env.ws, ["checkout", "-q", "--detach"]);
	snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 3, branch: "issue-7" });
	assert.deepEqual(snap.manifest.workspace.git, { state: "parsed", branch: null, tip: env.baseSha, detached: true });
	realFs.rmSync(join(env.ws, ".git"), { recursive: true });
	snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 4 });
	assert.equal(snap.manifest.workspace.git.state, "none");
});

// ── what the walk excludes ──────────────────────────────────────────────────────────────────────────────

test("nested repositories' files are captured and their .git is not; .GIT and git~1 are excluded at any depth (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env);
	const nested = join(env.ws, "nested");
	realFs.mkdirSync(nested);
	git(nested, ["init", "-q"]);
	realFs.writeFileSync(join(nested, "file"), "n\n");
	realFs.mkdirSync(join(env.ws, "sub", ".GIT"), { recursive: true });
	realFs.writeFileSync(join(env.ws, "sub", ".GIT", "config"), "x");
	realFs.mkdirSync(join(env.ws, "sub", "git~1"));
	realFs.writeFileSync(join(env.ws, "sub", "git~1", "y"), "y");
	realFs.writeFileSync(join(env.ws, "sub", "keep"), "k");
	const snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 });
	const paths = treePaths(env, "run-1", snap.manifest.workspace.commit);
	assert.ok(paths.includes("nested/file") && paths.includes("sub/keep"));
	assert.equal(paths.filter((p) => /(^|\/)(\.git|\.GIT|git~1)(\/|$)/.test(p)).length, 0, paths.join(","));
	assert.equal(snap.manifest.workspace.counts.skipped.dotgit, 4, "ws/.git, nested/.git, sub/.GIT, sub/git~1");
});

test("control-character names are skipped and counted, never stored (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env);
	realFs.writeFileSync(join(env.ws, "bad\x01name"), "x");
	realFs.writeFileSync(join(env.ws, "esc\x1b[31mred"), "x");
	realFs.writeFileSync(join(env.ws, "tab\tname"), "x");
	const snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 });
	assert.equal(snap.manifest.workspace.counts.skipped.badName, 3);
	assert.equal(treePaths(env, "run-1", snap.manifest.workspace.commit).some((p) => /[\x00-\x1f]/.test(p)), false);
});

test("a FIFO is skipped and counted, and the snapshot does not hang on it (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env);
	execFileSync("mkfifo", [join(env.ws, "pipe")]);
	const snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 });
	assert.equal(snap.ok, true);
	assert.equal(snap.manifest.workspace.counts.skipped.special, 1);
});

test("an unreadable file or directory is counted and marks the checkpoint partial; modes are never changed (#645)", { skip: IS_ROOT && "root reads mode 000" }, async () => {
	const env = setup();
	const { ck } = await primed(env);
	const locked = join(env.ws, "locked.txt");
	const lockedDir = join(env.ws, "locked-dir");
	realFs.writeFileSync(locked, "no");
	realFs.mkdirSync(lockedDir);
	realFs.writeFileSync(join(lockedDir, "x"), "x");
	realFs.chmodSync(locked, 0o000);
	realFs.chmodSync(lockedDir, 0o000);
	try {
		const snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 });
		assert.equal(snap.ok, true, JSON.stringify(snap));
		assert.equal(snap.manifest.workspace.partial, true);
		assert.equal(snap.manifest.workspace.counts.skipped.unreadable, 2);
		assert.equal(realFs.statSync(locked).mode & 0o777, 0, "never chmod'ed");
	} finally {
		realFs.chmodSync(locked, 0o644);
		realFs.chmodSync(lockedDir, 0o755);
	}
});

test("a file over maxFileBytes is skipped and counted tooLarge (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env, { limits: { maxFileBytes: 100 } });
	realFs.writeFileSync(join(env.ws, "huge"), "x".repeat(101));
	const snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 });
	assert.equal(snap.manifest.workspace.counts.skipped.tooLarge, 1);
	assert.equal(treePaths(env, "run-1", snap.manifest.workspace.commit).includes("huge"), false);
});

// ── caps ────────────────────────────────────────────────────────────────────────────────────────────────

test("over the byte cap: tier 2 drops ignored paths; still over refuses over-byte-cap; over the file cap refuses (#645)", async () => {
	const env = setup({ "a.txt": "a\n", ".gitignore": "build/\n" });
	const { ck } = await primed(env, { limits: { maxNewBytes: 1000, maxFiles: 10 } });
	realFs.mkdirSync(join(env.ws, "build"));
	realFs.writeFileSync(join(env.ws, "build", "out.bin"), "x".repeat(5000));
	realFs.writeFileSync(join(env.ws, "small.txt"), "s\n");
	const ok = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 });
	assert.equal(ok.ok, true, JSON.stringify(ok));
	assert.equal(ok.manifest.workspace.ignoredDropped, true);
	const paths = treePaths(env, "run-1", ok.manifest.workspace.commit);
	assert.ok(paths.includes("small.txt") && !paths.includes("build/out.bin"));

	realFs.writeFileSync(join(env.ws, "tracked-big.bin"), "y".repeat(5000));
	assert.deepEqual(await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 2 }), { skipped: "over-byte-cap" });
	realFs.rmSync(join(env.ws, "tracked-big.bin"));
	for (let i = 0; i < 12; i++) realFs.writeFileSync(join(env.ws, `f${i}`), "f");
	assert.deepEqual(await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 2 }), { skipped: "over-file-cap" });
});

test("a FIFO named .gitignore never reaches check-ignore: over the cap it refuses instead of hanging (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env, { limits: { maxNewBytes: 100 } });
	execFileSync("mkfifo", [join(env.ws, ".gitignore")]);
	realFs.writeFileSync(join(env.ws, "big"), "x".repeat(500));
	assert.deepEqual(await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 }), { skipped: "over-byte-cap" });
});

test("disk low and store full skip before anything is read (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env, { statfs: async () => ({ bavail: 100, bsize: 4096, blocks: 1e9 }) });
	assert.deepEqual(await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 }), { skipped: "disk-low" });
	const fivePct = checkpointer(env.storeDir, { statfs: async () => ({ bavail: 1e6, bsize: 4096, blocks: 1e9 }) }).ck;
	assert.deepEqual(await fivePct.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 }), { skipped: "disk-low" }, "4 GB free of 4 TB is under 5%");
	const full = checkpointer(env.storeDir, { limits: { maxStoreBytes: 1 } }).ck;
	assert.deepEqual(await full.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 }), { skipped: "store-full" });
});

test("a base over maxBaseBytes is skipped at prime, and every later snapshot says so (#645)", async () => {
	const env = setup();
	const { ck } = checkpointer(env.storeDir, { limits: { maxBaseBytes: 5 } });
	assert.deepEqual(await ck.primeBase({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, objectFormat: "sha1" }), { skipped: "base-too-large" });
	assert.deepEqual(await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 }), { skipped: "base-too-large" });
	assert.deepEqual(await ck.snapshot({ runId: "never-primed", workspace: env.ws, baseSha: env.baseSha, seq: 1 }), { skipped: "not-primed" });
});

test("a seq at or below CURRENT is stale; a live lock skips; a stale lock still holding its tag is taken over (#645)", async () => {
	const env = setup();
	const { ck, logs } = await primed(env);
	assert.equal((await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 2 })).ok, true);
	assert.deepEqual(await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 2 }), { skipped: "stale-seq" });
	const lock = join(env.storeDir, checkpointKey("run-1"), "lock");
	realFs.writeFileSync(lock, "999999 deadbeef\n");
	realFs.utimesSync(lock, new Date(NOW - 60_000), new Date(NOW - 60_000));
	assert.deepEqual(await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 3 }), { skipped: "locked" });
	realFs.utimesSync(lock, new Date(NOW - 2 * 3600_000), new Date(NOW - 2 * 3600_000));
	assert.equal((await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 3 })).ok, true);
	assert.ok(logs.some(([e]) => e === "checkpoint_lock_stale_taken"));
	assert.equal(realFs.existsSync(lock), false, "released after the snapshot");
});

// ── secrets ─────────────────────────────────────────────────────────────────────────────────────────────

test("a job secret anywhere in the tree refuses the whole snapshot and leaves no trace in the store (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env);
	assert.equal((await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 })).ok, true);
	const leaked = "config:\n  key: sk-live-0123456789abcdef\n";
	realFs.writeFileSync(join(env.ws, "a-first.txt"), "innocent new file\n");
	realFs.writeFileSync(join(env.ws, "leak.yml"), leaked);
	const repo = join(env.storeDir, checkpointKey("run-1"), "repo.git");
	// What a fast-import killed mid-stream leaves, planted so the cleanup is observed doing something
	// rather than asserted over a directory that happened to be empty.
	realFs.writeFileSync(join(repo, "objects", "pack", "tmp_pack_planted"), "half a pack");
	realFs.writeFileSync(join(repo, "fast_import_crash_4242"), "fast-import crash report: leak.yml");
	const res = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 2, secretValues: ["", "sk-live-0123456789abcdef"] });
	assert.deepEqual(res, { refused: "job-secret-in-tree" });
	assert.equal((await ck.readManifest("run-1")).manifest.seq, 1, "CURRENT still names the previous checkpoint");
	assert.equal(storeHas(env, "run-1", blobId(leaked)), false);
	assert.deepEqual(realFs.readdirSync(join(repo, "objects", "pack")).filter((n) => n.startsWith("tmp_")), []);
	assert.deepEqual(realFs.readdirSync(repo).filter((n) => n.startsWith("fast_import_crash")), []);
	realFs.symlinkSync("sk-live-0123456789abcdef", join(env.ws, "link"));
	realFs.rmSync(join(env.ws, "leak.yml"));
	assert.deepEqual(await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 2, secretValues: ["sk-live-0123456789abcdef"] }), { refused: "job-secret-in-tree" }, "a link target is content too");
});

// ── restore refusals ────────────────────────────────────────────────────────────────────────────────────

/** Write a raw tree object (entries already in git's order) into the store, bypassing every git check. */
function rawTree(env, runId, entries) {
	const body = Buffer.concat(entries.map(([mode, name, oid]) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, "hex")])));
	return storeGit(env.storeDir, runId, ["hash-object", "-t", "tree", "--literally", "-w", "--stdin"], { input: body }).toString().trim();
}
function rawBlob(env, runId, content) {
	return storeGit(env.storeDir, runId, ["hash-object", "-w", "--stdin"], { input: content }).toString().trim();
}

async function forged(env, entries) {
	const { ck } = await primed(env);
	const snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 });
	const baseTree = storeGit(env.storeDir, "run-1", ["rev-parse", `${env.baseSha}^{tree}`]).toString().trim();
	const baseEntries = storeGit(env.storeDir, "run-1", ["ls-tree", baseTree]).toString().trim().split("\n").map((l) => {
		const [meta, name] = l.split("\t");
		const [mode, , oid] = meta.split(" ");
		return [mode === "040000" ? "40000" : mode, name, oid];
	});
	const all = [...baseEntries, ...entries(env)].sort((a, b) => {
		const ka = a[0] === "40000" ? `${a[1]}/` : a[1];
		const kb = b[0] === "40000" ? `${b[1]}/` : b[1];
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});
	const tree = rawTree(env, "run-1", all);
	const commit = storeGit(env.storeDir, "run-1", ["commit-tree", tree, "-p", env.baseSha, "-m", "forged"]).toString().trim();
	const manifest = { ...snap.manifest, workspace: { ...snap.manifest.workspace, commit } };
	return { ck, manifest, into: freshBase(ck, "run-1", env.baseSha) };
}

test("restore refuses a tree with a link and a file under it, and writes nothing through the link (#645)", async () => {
	const env = setup();
	const outside = tempDir("pi-ck-outside-");
	const { ck, manifest, into } = await forged(env, (e) => {
		const child = rawTree(e, "run-1", [["100644", "child", rawBlob(e, "run-1", "pwned\n")]]);
		return [
			["120000", "link", rawBlob(e, "run-1", outside)],
			["40000", "link", child],
		];
	});
	assert.deepEqual(await ck.restore({ runId: "run-1", manifest, intoWorkspace: into }), { refused: "path-through-symlink" });
	assert.deepEqual(realFs.readdirSync(outside), []);
});

test("restore refuses a dotgit path as tampering and a case collision as such (#645)", async () => {
	for (const [label, entries, reason] of [
		["dotgit", (e) => [["40000", ".GIT", rawTree(e, "run-1", [["100644", "config", rawBlob(e, "run-1", "[core]\n")]])]], "tampered"],
		["case", (e) => [["100644", "A.txt", rawBlob(e, "run-1", "1")], ["100644", "a.txt", rawBlob(e, "run-1", "2")]], "case-collision"],
	]) {
		const env = setup({ "z.txt": "z\n" });
		const { ck, manifest, into } = await forged(env, entries);
		assert.deepEqual(await ck.restore({ runId: "run-1", manifest, intoWorkspace: into }), { refused: reason }, label);
	}
});

test("restore refuses a symlinked ancestor already on disk (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env);
	realFs.writeFileSync(join(env.ws, "d", "new.txt"), "n\n");
	const snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 });
	const into = freshBase(ck, "run-1", env.baseSha);
	const outside = tempDir("pi-ck-outside-");
	realFs.rmSync(join(into, "d"), { recursive: true });
	realFs.symlinkSync(outside, join(into, "d"));
	assert.deepEqual(await ck.restore({ runId: "run-1", manifest: snap.manifest, intoWorkspace: into }), { refused: "path-through-symlink" });
	assert.deepEqual(realFs.readdirSync(outside), []);
});

// ── the commit point ────────────────────────────────────────────────────────────────────────────────────

/** `node:fs/promises` with ONE operation failing, to stand in for a crash at that step of the commit point. */
function failingFs(step) {
	const boom = () => Object.assign(new Error(`injected at ${step}`), { code: "EIO" });
	const wrapHandle = (fh, path) =>
		new Proxy(fh, {
			get(target, prop) {
				if (prop === "sync") {
					return async () => {
						if (step === "manifest-fsync" && /manifest\.json\..*\.incoming$/.test(path)) throw boom();
						if (step === "manifest-dirsync" && /cp-\d+$/.test(path)) throw boom();
						if (step === "current-dirsync" && /[0-9a-f]{32}$/.test(path)) throw boom();
						return target.sync();
					};
				}
				const v = target[prop];
				return typeof v === "function" ? v.bind(target) : v;
			},
		});
	return {
		...realFsp,
		async open(path, ...rest) {
			const p = String(path);
			if (step === "transcript-write" && /transcript\.jsonl\..*\.incoming$/.test(p)) throw boom();
			if (step === "manifest-write" && /manifest\.json\..*\.incoming$/.test(p)) throw boom();
			if (step === "current-write" && /CURRENT\..*\.incoming$/.test(p)) throw boom();
			return wrapHandle(await realFsp.open(path, ...rest), p);
		},
		async rename(from, to) {
			const t = String(to);
			if (step === "transcript-rename" && t.endsWith("transcript.jsonl")) throw boom();
			if (step === "manifest-rename" && t.endsWith("manifest.json")) throw boom();
			if (step === "current-rename" && t.endsWith("CURRENT")) throw boom();
			return realFsp.rename(from, to);
		},
	};
}

test("a crash at every step of the commit point leaves CURRENT naming a complete, valid checkpoint (#645)", async () => {
	const steps = ["transcript-write", "transcript-rename", "manifest-write", "manifest-fsync", "manifest-rename", "manifest-dirsync", "current-write", "current-rename", "current-dirsync"];
	for (const step of steps) {
		const env = setup();
		const { ck } = await primed(env);
		const transcript = join(env.root, "t.jsonl");
		realFs.writeFileSync(transcript, "one\ntwo\n");
		assert.equal((await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1, transcript: { srcFile: transcript, offset: 4 } })).ok, true);
		realFs.writeFileSync(join(env.ws, "a.txt"), `after ${step}\n`);
		const crashing = checkpointer(env.storeDir, { fs: failingFs(step) }).ck;
		const res = await crashing.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 2, transcript: { srcFile: transcript, offset: 8 } });
		assert.deepEqual(res, { skipped: "internal-error" }, `${step}: reported, never thrown`);
		const read = await ck.readManifest("run-1");
		assert.equal(read.ok, true, `${step}: ${JSON.stringify(read)}`);
		// Only a failure AFTER the CURRENT rename may leave the new checkpoint current, and then it is complete.
		assert.equal(read.manifest.seq, step === "current-dirsync" ? 2 : 1, step);
		assert.equal((await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 3 })).ok, true, `${step}: the lock was released`);
	}
});

test("readManifest: absent, a transcript sha mismatch, every bad field, closed nested objects, a malformed CURRENT, a seq mismatch (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env);
	assert.deepEqual(await ck.readManifest("run-1"), { absent: true });
	assert.deepEqual(await ck.readManifest("nobody"), { absent: true });
	const transcript = join(env.root, "t.jsonl");
	realFs.writeFileSync(transcript, "abc\n");
	await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1, transcript: { srcFile: transcript, offset: 4 } });
	const run = join(env.storeDir, checkpointKey("run-1"));
	const mpath = join(run, "cp-1", "manifest.json");
	const good = realFs.readFileSync(mpath, "utf8");
	assert.equal((await ck.readManifest("run-1")).ok, true);

	realFs.appendFileSync(join(run, "cp-1", "transcript.jsonl"), "x");
	assert.deepEqual(await ck.readManifest("run-1"), { invalid: true, reason: "transcript-mismatch" });
	realFs.writeFileSync(join(run, "cp-1", "transcript.jsonl"), "abd\n");
	assert.deepEqual(await ck.readManifest("run-1"), { invalid: true, reason: "transcript-mismatch" }, "same length, different bytes");
	realFs.writeFileSync(join(run, "cp-1", "transcript.jsonl"), "abc\n");

	const m = JSON.parse(good);
	for (const [label, mutate, reason] of [
		["host", (x) => (x.host = "evil host/../"), "field:host"],
		["kind", (x) => (x.kind = "other"), "field:kind"],
		["commit", (x) => (x.workspace.commit = "../../etc"), "field:commit"],
		["model", (x) => (x.model = "a model with spaces"), "field:model"],
		["extra", (x) => (x.path = "/etc/passwd"), "field:keys"],
		["seq", (x) => (x.seq = 1.5), "field:seq"],
		["v", (x) => (x.v = 2), "field:v"],
		["runId", (x) => (x.runId = "run 1/.."), "field:runId"],
		["quiesced", (x) => (x.quiesced = "paused"), "field:quiesced"],
		["transcript extra key", (x) => (x.transcript.path = "/tmp/t"), "field:transcript"],
		["workspace extra key", (x) => (x.workspace.dir = "/workspace"), "field:workspace"],
		["counts extra key", (x) => (x.workspace.counts.names = ["a"]), "field:counts"],
		["counts.skipped extra key", (x) => (x.workspace.counts.skipped.other = 1), "field:counts"],
		["git extra key", (x) => (x.workspace.git.headText = "ref: x"), "field:git"],
		["baseSha", (x) => (x.workspace.baseSha = "abc"), "field:baseSha"],
		["git.branch", (x) => (x.workspace.git.branch = "../../x"), "field:git"],
		["git.tip", (x) => (x.workspace.git.tip = "nothex"), "field:git"],
		["partial", (x) => (x.workspace.partial = "yes"), "field:flags"],
		["ignoredDropped", (x) => (x.workspace.ignoredDropped = 0), "field:flags"],
	]) {
		const copy = structuredClone(m);
		mutate(copy);
		realFs.writeFileSync(mpath, JSON.stringify(copy));
		assert.deepEqual(await ck.readManifest("run-1"), { invalid: true, reason }, label);
	}
	realFs.writeFileSync(mpath, good);
	realFs.writeFileSync(join(run, "CURRENT"), "../1\n");
	assert.deepEqual(await ck.readManifest("run-1"), { invalid: true, reason: "current-malformed" }, "a CURRENT that is not a bare seq");
	realFs.writeFileSync(join(run, "CURRENT"), "1\ngarbage\n");
	assert.deepEqual(await ck.readManifest("run-1"), { invalid: true, reason: "current-malformed" }, "a trailing line");
	// CURRENT says 2, and cp-2 holds a complete copy of cp-1 whose manifest says 1.
	realFs.cpSync(join(run, "cp-1"), join(run, "cp-2"), { recursive: true });
	realFs.writeFileSync(join(run, "CURRENT"), "2\n");
	assert.deepEqual(await ck.readManifest("run-1"), { invalid: true, reason: "seq-mismatch" });
});

// ── sweep, remove, usage ────────────────────────────────────────────────────────────────────────────────

test("sweep removes only stale 32-hex run directories, skips active runs, never follows a link (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env, {}, "stale-run");
	await ck.snapshot({ runId: "stale-run", workspace: env.ws, baseSha: env.baseSha, seq: 1 });
	await ck.primeBase({ runId: "active-run", workspace: env.ws, baseSha: env.baseSha, objectFormat: "sha1" });
	const outside = tempDir("pi-ck-outside-");
	realFs.writeFileSync(join(outside, "precious"), "p");
	realFs.symlinkSync(outside, join(env.storeDir, "0123456789abcdef0123456789abcdef"));
	realFs.mkdirSync(join(env.storeDir, "not-a-run"));
	// Ages are measured from the filesystem's own mtime, so the test holds under a shifted Date as well.
	const madeAt = realFs.statSync(join(env.storeDir, checkpointKey("stale-run"), "cp-1", "manifest.json")).mtimeMs;

	const young = checkpointer(env.storeDir, { now: () => madeAt + 60_000 }).ck;
	assert.deepEqual(await young.sweep({ active: ["active-run"] }), { removed: 0, kept: 3 });

	const later = checkpointer(env.storeDir, { now: () => madeAt + 399 * 24 * 3600_000 }).ck;
	assert.deepEqual(await later.sweep({ active: ["active-run"] }), { removed: 1, kept: 2 });
	assert.equal(realFs.existsSync(join(env.storeDir, checkpointKey("stale-run"))), false);
	assert.equal(realFs.existsSync(join(env.storeDir, checkpointKey("active-run"))), true);
	assert.equal(realFs.readFileSync(join(outside, "precious"), "utf8"), "p", "the link was not followed");
	assert.ok(realFs.lstatSync(join(env.storeDir, "0123456789abcdef0123456789abcdef")).isSymbolicLink());
	assert.ok(realFs.existsSync(join(env.storeDir, "not-a-run")));
});

test("remove deletes a run's store; usage counts the store's bytes (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env);
	assert.ok((await ck.usage()).bytes > 0);
	assert.deepEqual(await ck.remove("run-1"), { removed: true });
	assert.equal(realFs.existsSync(join(env.storeDir, checkpointKey("run-1"))), false);
	assert.deepEqual(await ck.readManifest("run-1"), { absent: true });
});

test("writeTranscript copies exactly [0, offset) and refuses to follow a link at the source (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env);
	const src = join(env.root, "t.jsonl");
	realFs.writeFileSync(src, "0123456789");
	const got = await ck.writeTranscript("run-1", 5, src, 4);
	assert.deepEqual(got, { ok: true, bytes: 4, sha256: createHash("sha256").update("0123").digest("hex") });
	realFs.symlinkSync(src, join(env.root, "link.jsonl"));
	assert.deepEqual(await ck.writeTranscript("run-1", 6, join(env.root, "link.jsonl"), 4), { skipped: "transcript-failed" });
	assert.deepEqual(await ck.writeTranscript("run-1", 7, src, 50), { skipped: "transcript-failed" }, "a short source is not padded");
});

// ── the flags bolt ──────────────────────────────────────────────────────────────────────────────────────

test("every git spawn carries STORE_GIT_FLAGS and exactly storeGitEnv; only check-ignore gets GIT_WORK_TREE (#645)", async () => {
	const env = setup({ "a.txt": "a\n", ".gitignore": "junk/\n" });
	const calls = [];
	const spy = (argv, opts) => {
		calls.push({ argv, env: opts.env });
		return defaultSpawnGit(argv, opts);
	};
	const { ck } = await primed(env, { spawnGit: spy, limits: { maxNewBytes: 1000, repackEvery: 1 } });
	realFs.mkdirSync(join(env.ws, "junk"));
	realFs.writeFileSync(join(env.ws, "junk", "big"), "x".repeat(4000));
	realFs.writeFileSync(join(env.ws, "a.txt"), "changed\n");
	const snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 });
	assert.equal(snap.ok, true, JSON.stringify(snap));
	await ck.restore({ runId: "run-1", manifest: snap.manifest, intoWorkspace: freshBase(ck, "run-1", env.baseSha) });

	const run = join(env.storeDir, checkpointKey("run-1"));
	const expected = storeGitEnv({ gitDir: join(run, "repo.git"), home: join(run, "home") });
	const subcommands = new Set();
	for (const { argv, env: e } of calls) {
		assert.deepEqual(argv.slice(0, STORE_GIT_FLAGS.length), [...STORE_GIT_FLAGS], argv.join(" "));
		const rest = argv.slice(STORE_GIT_FLAGS.length).filter((a, i, all) => a !== "-c" && all[i - 1] !== "-c");
		subcommands.add(rest[0]);
		if (rest[0] === "check-ignore") assert.deepEqual(e, { ...expected, GIT_WORK_TREE: env.ws });
		else assert.deepEqual(e, expected, rest[0]);
	}
	for (const sub of ["init", "fetch", "ls-tree", "check-ignore", "fast-import", "rev-parse", "repack", "diff-tree", "cat-file"]) {
		assert.ok(subcommands.has(sub), `${sub} was exercised (saw ${[...subcommands].join(",")})`);
	}
});

// ── review round 1: literal pins ────────────────────────────────────────────────────────────────────────

test("storeGitEnv is a LITERAL closed map built from nothing; empty and relative PATH entries are dropped (#645)", () => {
	process.env.PI_CK_INHERITED_PROBE = "must-not-leak";
	try {
		assert.deepEqual(storeGitEnv({ gitDir: "/s/repo.git", home: "/s/home", path: "/usr/bin::rel/bin:./x:/bin:" }), {
			PATH: "/usr/bin:/bin",
			HOME: "/s/home",
			XDG_CONFIG_HOME: "/s/home",
			GIT_DIR: "/s/repo.git",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_ATTR_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
			GIT_OPTIONAL_LOCKS: "0",
			GIT_NO_REPLACE_OBJECTS: "1",
			GIT_PROTOCOL_FROM_USER: "0",
			LC_ALL: "C",
		});
		const dflt = storeGitEnv({ gitDir: "/g", home: "/h" });
		assert.equal("PI_CK_INHERITED_PROBE" in dflt, false, "an inherited variable never appears");
		assert.equal(storeGitEnv({ gitDir: "/g", home: "/h", path: "rel:" }).PATH, "/usr/bin:/bin", "nothing absolute left: a fixed fallback");
	} finally {
		delete process.env.PI_CK_INHERITED_PROBE;
	}
});

test("STORE_GIT_FLAGS is pinned literally (#645)", () => {
	assert.deepEqual(
		[...STORE_GIT_FLAGS],
		[
			"-c", "core.hooksPath=/dev/null",
			"-c", "core.fsmonitor=false",
			"-c", "protocol.ext.allow=never",
			"-c", "credential.helper=",
			"-c", "commit.gpgSign=false",
			"-c", "tag.gpgSign=false",
			"-c", "gc.auto=0",
			"-c", "maintenance.auto=false",
			"-c", "core.protectNTFS=true",
			"-c", "core.protectHFS=true",
			"-c", "transfer.fsckObjects=true",
			"-c", "fetch.fsckObjects=true",
			"-c", "core.untrackedCache=false",
			"--no-pager",
		],
	);
});

// ── review round 1: read hardening through a fake fs ────────────────────────────────────────────────────

/**
 * Real fs, except opens of ONE path, which emulate the kernel: a link there refuses `O_NOFOLLOW`, a FIFO
 * there blocks unless `O_NONBLOCK`, or the opened handle reports another inode or reads short. Every
 * numeric flag set used on that path is recorded so the flags themselves are pinned too.
 */
function trickFs(target, mode, flagsSeen) {
	const statWith = (fh, patch) =>
		new Proxy(fh, {
			get(t, prop) {
				if (prop === "stat") return async (o) => Object.assign(Object.create(await t.stat(o)), patch(await t.stat(o)));
				if (prop === "read" && mode === "short") return async (buf) => ({ bytesRead: 0, buffer: buf });
				const v = t[prop];
				return typeof v === "function" ? v.bind(t) : v;
			},
		});
	return {
		...realFsp,
		async open(path, flags, ...rest) {
			if (String(path) !== target) return realFsp.open(path, flags, ...rest);
			flagsSeen.push(flags);
			if (mode === "link" && flags & realFs.constants.O_NOFOLLOW) throw Object.assign(new Error("loop"), { code: "ELOOP" });
			if (mode === "fifo" && !(flags & realFs.constants.O_NONBLOCK)) throw new Error("would block forever: a FIFO opened without O_NONBLOCK");
			const fh = await realFsp.open(path, flags, ...rest);
			if (mode === "fifo") return statWith(fh, () => ({ isFile: () => false }));
			if (mode === "inode") return statWith(fh, (st) => ({ ino: st.ino + 1n }));
			if (mode === "short") return statWith(fh, () => ({}));
			return fh;
		},
	};
}

test("a swapped link, a FIFO, another inode and a short read each abandon the snapshot as tree-changed; the open flags are pinned (#645)", async () => {
	for (const mode of ["link", "fifo", "inode", "short"]) {
		const env = setup();
		await primed(env);
		const target = join(env.ws, "target.txt");
		realFs.writeFileSync(target, "agent output\n");
		const flagsSeen = [];
		const { ck } = checkpointer(env.storeDir, { fs: trickFs(target, mode, flagsSeen) });
		assert.deepEqual(await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 }), { skipped: "tree-changed" }, mode);
		assert.equal(flagsSeen.length, 1, mode);
		assert.ok(flagsSeen[0] & realFs.constants.O_NOFOLLOW && flagsSeen[0] & realFs.constants.O_NONBLOCK, `${mode}: O_NOFOLLOW|O_NONBLOCK`);
		assert.equal((await ck.readManifest("run-1")).absent, true, `${mode}: nothing committed`);
	}
});

test("on a host with /proc/self/fd, an open that resolved outside the workspace is tree-changed; inside passes; no procfs passes (#645)", async () => {
	for (const [label, answer, expectOk] of [
		["outside", () => "/etc/passwd", false],
		["sibling prefix", (root) => `${root}-evil/target.txt`, false],
		["inside", (root) => `${root}/target.txt`, true],
		["no procfs", () => {
			throw Object.assign(new Error("no proc"), { code: "ENOENT" });
		}, true],
	]) {
		const env = setup();
		await primed(env);
		realFs.writeFileSync(join(env.ws, "target.txt"), "x\n");
		const root = realFs.realpathSync(env.ws);
		const fakeFs = {
			...realFsp,
			async readlink(p, ...rest) {
				if (String(p).startsWith("/fakeproc/")) return answer(root);
				return realFsp.readlink(p, ...rest);
			},
		};
		const { ck } = checkpointer(env.storeDir, { fs: fakeFs, procFdDir: "/fakeproc" });
		const res = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 });
		if (expectOk) assert.equal(res.ok, true, `${label}: ${JSON.stringify(res)}`);
		else assert.deepEqual(res, { skipped: "tree-changed" }, label);
	}
});

test("the agent's HEAD is read O_NOFOLLOW: a HEAD that is a link, or a .git that is a link to a real repository, is never parsed through (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env);
	const other = join(env.root, "other");
	realFs.mkdirSync(other);
	git(other, ["init", "-q", "-b", "main"]);
	git(other, ["commit", "-q", "--allow-empty", "-m", "o"]);
	realFs.rmSync(join(env.ws, ".git", "HEAD"));
	realFs.symlinkSync(join(other, ".git", "HEAD"), join(env.ws, ".git", "HEAD"));
	let snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1, branch: "main" });
	assert.equal(snap.manifest.workspace.git.state, "unreadable");
	realFs.rmSync(join(env.ws, ".git"), { recursive: true });
	realFs.symlinkSync(join(other, ".git"), join(env.ws, ".git"));
	snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 2, branch: "main" });
	assert.deepEqual(snap.manifest.workspace.git, { state: "unreadable", branch: null, tip: null, detached: false });

	const flagsSeen = [];
	const spyFs = { ...realFsp, async open(p, flags, ...rest) {
		if (String(p).endsWith(`${join(".git", "HEAD")}`)) flagsSeen.push(flags);
		return realFsp.open(p, flags, ...rest);
	} };
	realFs.unlinkSync(join(env.ws, ".git"));
	git(env.ws, ["init", "-q", "-b", "main"]);
	await checkpointer(env.storeDir, { fs: spyFs }).ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 3, branch: "main" });
	assert.ok(flagsSeen.length > 0 && flagsSeen.every((f) => typeof f === "number" && f & realFs.constants.O_NOFOLLOW && f & realFs.constants.O_NONBLOCK));
});

// ── review round 1: walk limits and caps ────────────────────────────────────────────────────────────────

test("a tree deeper than 64 segments is cut at the cap and counted; a file at depth 64 is kept (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env);
	const d63 = join(env.ws, ...Array(63).fill("d"));
	realFs.mkdirSync(join(d63, "d"), { recursive: true });
	realFs.writeFileSync(join(d63, "ok.txt"), "64 segments\n");
	realFs.writeFileSync(join(d63, "d", "deep.txt"), "65 segments\n");
	const snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 });
	const paths = treePaths(env, "run-1", snap.manifest.workspace.commit);
	assert.ok(paths.includes(`${Array(63).fill("d").join("/")}/ok.txt`));
	assert.equal(paths.some((p) => p.endsWith("deep.txt")), false);
	assert.equal(snap.manifest.workspace.counts.skipped.badName, 1);
});

test("a path over 4096 bytes is skipped and counted (a virtual tree: no host accepts such a path in one syscall) (#645)", async () => {
	const env = setup();
	await primed(env);
	const v = join(env.ws, "v");
	realFs.mkdirSync(v);
	const vStat = await realFsp.lstat(v, { bigint: true });
	const seg = "x".repeat(240);
	let virtualReads = 0;
	const fakeFs = {
		...realFsp,
		async readdir(p, o) {
			if (String(p) === v || String(p).startsWith(`${v}/`)) {
				virtualReads++;
				return [{ name: Buffer.from(seg) }];
			}
			return realFsp.readdir(p, o);
		},
		async lstat(p, o) {
			if (String(p).startsWith(`${v}/`)) return vStat;
			return realFsp.lstat(p, o);
		},
	};
	const { ck } = checkpointer(env.storeDir, { fs: fakeFs });
	const snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 });
	assert.equal(snap.ok, true, JSON.stringify(snap));
	assert.equal(snap.manifest.workspace.counts.skipped.badName, 1, "the one name that pushed the path over 4096");
	// 16 levels of 241 bytes fit under 4096 with the `v/` prefix; the 17th would not. Without the length rule the
	// walk would descend to the depth cap (64) instead, which also counts one bad name, so the reads are the proof.
	assert.equal(virtualReads, 17, "the walk stopped at the length cap, not the depth cap");
});

test("maxFiles is a boundary: exactly max is fine, max + 1 refuses (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env, { limits: { maxFiles: 4 } });
	realFs.writeFileSync(join(env.ws, "four"), "4");
	assert.equal((await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 })).ok, true);
	realFs.writeFileSync(join(env.ws, "five"), "5");
	assert.deepEqual(await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 2 }), { skipped: "over-file-cap" });

	// The same boundary when the entry that reaches the cap is a LINK: subdirectories are walked after the root's
	// own entries, so `z/link` is counted last.
	const env2 = setup({ "a.txt": "a\n" });
	const two = (await primed(env2, { limits: { maxFiles: 2 } })).ck;
	realFs.mkdirSync(join(env2.ws, "z"));
	realFs.symlinkSync("../a.txt", join(env2.ws, "z", "link"));
	assert.equal((await two.snapshot({ runId: "run-1", workspace: env2.ws, baseSha: env2.baseSha, seq: 1 })).ok, true, "a link as the max-th entry");
	realFs.symlinkSync("../a.txt", join(env2.ws, "z", "link2"));
	assert.deepEqual(await two.snapshot({ runId: "run-1", workspace: env2.ws, baseSha: env2.baseSha, seq: 2 }), { skipped: "over-file-cap" });
});

test("a big UNCHANGED base under a small maxNewBytes is not over the byte cap: cached bytes are not new (#645)", async () => {
	const env = setup({ "big.bin": "b".repeat(5000), "a.txt": "a\n" });
	const { ck, logs } = await primed(env, { limits: { maxNewBytes: 1000 } });
	realFs.writeFileSync(join(env.ws, "a.txt"), "changed\n");
	const snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 });
	assert.equal(snap.ok, true, JSON.stringify(snap));
	assert.equal(snap.manifest.workspace.ignoredDropped, false);
	assert.equal(snap.manifest.workspace.counts.newBytes, 8);
	assert.equal(logs.some(([e]) => e === "checkpoint_ignore_tier"), false, "the ignore tier never ran");
});

test("the ignore tier: a failing check-ignore keeps nothing back (over-byte-cap); exit 1 means nothing ignored (#645)", async () => {
	const env = setup({ "a.txt": "a\n", ".gitignore": "nothing-matches/\n" });
	const breakIt = (argv, opts) => defaultSpawnGit(argv.includes("check-ignore") ? [...argv, "--no-such-option"] : argv, opts);
	const { ck, logs } = await primed(env, { spawnGit: breakIt, limits: { maxNewBytes: 100 } });
	realFs.writeFileSync(join(env.ws, "big"), "x".repeat(500));
	assert.deepEqual(await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 }), { skipped: "over-byte-cap" });
	assert.deepEqual(logs.find(([e]) => e === "checkpoint_ignore_tier")?.[1], { outcome: "failed" });

	const plain = checkpointer(env.storeDir, { limits: { maxNewBytes: 100 } });
	assert.deepEqual(await plain.ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 }), { skipped: "over-byte-cap" });
	assert.deepEqual(plain.logs.find(([e]) => e === "checkpoint_ignore_tier")?.[1], { outcome: "none-ignored", dropped: 0 });
});

test("a failed statfs is disk-low, never a pass (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env, {
		statfs: async () => {
			throw Object.assign(new Error("nope"), { code: "ENOSYS" });
		},
	});
	assert.deepEqual(await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 }), { skipped: "disk-low" });
});

test("the exec bit is set by ANY of the three x bits (#645)", async () => {
	const env = setup({ "a.txt": "a\n" });
	const { ck } = await primed(env);
	for (const [name, mode] of [["user-x", 0o744], ["group-x", 0o654], ["other-x", 0o645], ["none", 0o644]]) {
		realFs.writeFileSync(join(env.ws, name), name);
		realFs.chmodSync(join(env.ws, name), mode);
	}
	const snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 });
	const modes = Object.fromEntries(
		storeGit(env.storeDir, "run-1", ["ls-tree", snap.manifest.workspace.commit]).toString().trim().split("\n").map((l) => [l.split("\t")[1], l.split(" ")[0]]),
	);
	assert.deepEqual([modes["user-x"], modes["group-x"], modes["other-x"], modes.none], ["100755", "100755", "100755", "100644"]);
});

// ── review round 1: secrets ─────────────────────────────────────────────────────────────────────────────

test("a secret in a file NAME, a directory name or a link target refuses; an empty secret on a clean tree does not (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env);
	const secret = "tok_9f8e7d6c5b4a";
	assert.equal((await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1, secretValues: [""] })).ok, true, "an empty value matches nothing");
	for (const [label, plant, unplant] of [
		["file name", () => realFs.writeFileSync(join(env.ws, `${secret}.txt`), "x"), () => realFs.rmSync(join(env.ws, `${secret}.txt`))],
		["directory name", () => {
			realFs.mkdirSync(join(env.ws, "cache", secret), { recursive: true });
			realFs.writeFileSync(join(env.ws, "cache", secret, "f"), "x");
		}, () => realFs.rmSync(join(env.ws, "cache"), { recursive: true })],
		["link target", () => realFs.symlinkSync(`/run/${secret}`, join(env.ws, "l")), () => realFs.rmSync(join(env.ws, "l"))],
	]) {
		plant();
		assert.deepEqual(await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 2, secretValues: [secret] }), { refused: "job-secret-in-tree" }, label);
		unplant();
	}
	assert.equal((await ck.readManifest("run-1")).manifest.seq, 1);
});

test("the stat cache: a secret written in place with its mtime restored is still re-read (ctime moved); an unchanged tree reads nothing new (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env);
	realFs.writeFileSync(join(env.ws, "new.txt"), "fresh\n");
	assert.equal((await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 })).manifest.workspace.counts.newBytes, 6);
	const again = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 2 });
	assert.equal(again.manifest.workspace.counts.newBytes, 0, "every file served from the cache");

	// A whole-second mtime, so `utimes` (which cannot carry nanoseconds) puts it back EXACTLY: then only the
	// ctime differs, and it alone must force the re-read.
	const a = join(env.ws, "a.txt");
	const second = new Date(Math.floor(realFs.statSync(a).mtimeMs / 1000) * 1000);
	realFs.utimesSync(a, second, second);
	assert.equal((await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 3 })).ok, true, "caches a.txt at that mtime");
	realFs.writeFileSync(a, "SECRT\n"); // same 6 bytes as "hello\n"
	realFs.utimesSync(a, second, second);
	const st = realFs.statSync(a, { bigint: true });
	assert.equal(st.mtimeNs, BigInt(second.getTime()) * 1_000_000n, "mtime restored to the nanosecond");
	assert.deepEqual(await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 4, secretValues: ["SECRT"] }), { refused: "job-secret-in-tree" });
});

// ── review round 1: manifest metadata ───────────────────────────────────────────────────────────────────

test("a malformed meta value is stored as null and its NAME logged; a bad host name is sanitised into a valid one (#645)", async () => {
	const env = setup();
	const { ck, logs } = await primed(env, { hostName: "bad host/../x" });
	const snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1, meta: { piVersion: "1.2.0; rm -rf /", model: "gpt-5.5", venue: "docker" } });
	assert.equal(snap.manifest.piVersion, null);
	assert.equal(snap.manifest.model, "gpt-5.5");
	assert.match(snap.manifest.host, /^[A-Za-z0-9._-]{1,64}$/);
	assert.deepEqual(logs.filter(([e]) => e === "checkpoint_meta_dropped").map(([, f]) => f), [{ field: "piVersion" }]);
	assert.equal((await ck.readManifest("run-1")).ok, true);
});

// ── review round 1: restore ─────────────────────────────────────────────────────────────────────────────

async function snapAndBase(files, change) {
	const env = setup(files);
	const made = await primed(env);
	change?.(env);
	const snap = await made.ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 });
	assert.equal(snap.ok, true, JSON.stringify(snap));
	return { env, ...made, manifest: snap.manifest, into: freshBase(made.ck, "run-1", env.baseSha) };
}

test("restore refuses a malformed manifest, another run's manifest and a checkout not at baseSha; a branch checkout at baseSha is fine (#645)", async () => {
	const { ck, manifest, into, env } = await snapAndBase(undefined, (e) => realFs.writeFileSync(join(e.ws, "a.txt"), "z\n"));
	assert.deepEqual(await ck.restore({ runId: "run-1", manifest: { ...manifest, extra: 1 }, intoWorkspace: into }), { refused: "bad-manifest" });
	assert.deepEqual(await ck.restore({ runId: "run-2", manifest, intoWorkspace: into }), { refused: "run-mismatch" });
	const head = join(into, ".git", "HEAD");
	const real = realFs.readFileSync(head);
	realFs.writeFileSync(head, `${"0".repeat(40)}\n`);
	assert.deepEqual(await ck.restore({ runId: "run-1", manifest, intoWorkspace: into }), { refused: "base-mismatch" });
	realFs.writeFileSync(head, real);
	git(into, ["checkout", "-q", "-b", "resume"]);
	assert.equal((await ck.restore({ runId: "run-1", manifest, intoWorkspace: into })).written, 1);
	assert.equal(realFs.readFileSync(join(into, "a.txt"), "utf8"), "z\n");
	void env;
});

test("restore writes symlinks LAST, after every regular file (#645)", async () => {
	const order = [];
	const env = setup();
	const { ck } = await primed(env);
	realFs.symlinkSync("z.txt", join(env.ws, "a-link"));
	realFs.writeFileSync(join(env.ws, "m.txt"), "m\n");
	realFs.writeFileSync(join(env.ws, "z.txt"), "z\n");
	const snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 });
	const into = freshBase(ck, "run-1", env.baseSha);
	const spyFs = {
		...realFsp,
		async open(p, flags, ...rest) {
			if (typeof flags === "number" && flags & realFs.constants.O_CREAT) order.push(`file:${String(p).slice(into.length + 1)}`);
			return realFsp.open(p, flags, ...rest);
		},
		async symlink(t, p) {
			order.push(`link:${String(p).slice(into.length + 1)}`);
			return realFsp.symlink(t, p);
		},
	};
	await checkpointer(env.storeDir, { fs: spyFs }).ck.restore({ runId: "run-1", manifest: snap.manifest, intoWorkspace: into });
	assert.deepEqual(order, ["file:m.txt", "file:z.txt", "link:a-link"]);
	assert.deepEqual(nodeWalk(into), nodeWalk(env.ws));
});

test("restore never writes through a final-component link on disk, and refuses a directory where a file goes (#645)", async () => {
	const outside = join(tempDir("pi-ck-outside-"), "victim");
	realFs.writeFileSync(outside, "untouched\n");
	let r = await snapAndBase(undefined, (e) => realFs.writeFileSync(join(e.ws, "a.txt"), "new\n"));
	realFs.rmSync(join(r.into, "a.txt"));
	realFs.symlinkSync(outside, join(r.into, "a.txt"));
	assert.deepEqual(await r.ck.restore({ runId: "run-1", manifest: r.manifest, intoWorkspace: r.into }), { refused: "path-through-symlink" });
	assert.equal(realFs.readFileSync(outside, "utf8"), "untouched\n");

	r = await snapAndBase(undefined, (e) => realFs.writeFileSync(join(e.ws, "a.txt"), "new\n"));
	realFs.rmSync(join(r.into, "a.txt"));
	realFs.mkdirSync(join(r.into, "a.txt"));
	assert.deepEqual(await r.ck.restore({ runId: "run-1", manifest: r.manifest, intoWorkspace: r.into }), { refused: "path-conflict" });
});

test("restore refuses a blob over maxFileBytes and a cat-file answer naming another object (#645)", async () => {
	const r = await snapAndBase(undefined, (e) => realFs.writeFileSync(join(e.ws, "a.txt"), "twelve bytes"));
	const small = checkpointer(r.env.storeDir, { limits: { maxFileBytes: 4 } }).ck;
	assert.deepEqual(await small.restore({ runId: "run-1", manifest: r.manifest, intoWorkspace: r.into }), { refused: "tampered" });

	const otherOid = blobId("bee\n");
	const swap = (argv, opts) => {
		const child = defaultSpawnGit(argv, opts);
		if (argv.includes("cat-file")) {
			const write = child.stdin.write.bind(child.stdin);
			child.stdin.write = () => write(`${otherOid}\n`);
		}
		return child;
	};
	const swapped = checkpointer(r.env.storeDir, { spawnGit: swap }).ck;
	assert.deepEqual(await swapped.restore({ runId: "run-1", manifest: r.manifest, intoWorkspace: r.into }), { refused: "tampered" });
	assert.equal(realFs.readFileSync(join(r.into, "a.txt"), "utf8"), "hello\n", "nothing written from the wrong object");
});

test("restore refuses a link target holding a NUL (#645)", async () => {
	const env = setup({ "z.txt": "z\n" });
	const { ck, manifest, into } = await forged(env, (e) => [["120000", "lnk", rawBlob(e, "run-1", "a\0b")]]);
	assert.deepEqual(await ck.restore({ runId: "run-1", manifest, intoWorkspace: into }), { refused: "tampered" });
	assert.equal(realFs.existsSync(join(into, "lnk")), false);
});

test("a gitlink in the snapshot tree is refused by the change judge before anything is written (#645)", async () => {
	const env = setup({ "z.txt": "z\n" });
	const { ck, manifest, into } = await forged(env, (e) => [
		["100644", "a-written-first.txt", rawBlob(e, "run-1", "would be written\n")],
		["160000", "sub", e.baseSha],
	]);
	const logs = [];
	const judged = checkpointer(env.storeDir, { log: (e, f) => logs.push([e, f]) }).ck;
	const before = nodeWalk(into);
	assert.deepEqual(await judged.restore({ runId: "run-1", manifest, intoWorkspace: into }), { refused: "tampered" });
	assert.deepEqual(nodeWalk(into), before, "nothing written");
	assert.deepEqual(logs.find(([e]) => e === "checkpoint_restore_refused")?.[1], { reason: "tampered" }, "the judge refused it, not a cat-file accident");
	void ck;
});

test("a gitlink on the BASE side is skipped, not refused: the snapshot cannot record a submodule (#645)", async () => {
	const root = tempDir("pi-ck-sub-");
	const origin = join(root, "origin");
	realFs.mkdirSync(origin);
	git(origin, ["init", "-q", "-b", "main"]);
	realFs.writeFileSync(join(origin, "a.txt"), "a\n");
	git(origin, ["add", "-A"]);
	git(origin, ["commit", "-qm", "one"]);
	const first = gitText(origin, ["rev-parse", "HEAD"]);
	git(origin, ["update-index", "--add", "--cacheinfo", `160000,${first},sub`]);
	git(origin, ["commit", "-qm", "with a submodule entry"]);
	const ws = join(root, "ws");
	git(root, ["clone", "-q", origin, ws]);
	const env = { root, ws, baseSha: gitText(ws, ["rev-parse", "HEAD"]), storeDir: join(root, "store") };
	const { ck } = await primed(env);
	realFs.writeFileSync(join(ws, "a.txt"), "changed\n");
	const snap = await ck.snapshot({ runId: "run-1", workspace: ws, baseSha: env.baseSha, seq: 1 });
	const into = freshBase(ck, "run-1", env.baseSha);
	assert.deepEqual(await ck.restore({ runId: "run-1", manifest: snap.manifest, intoWorkspace: into }), { written: 1, removed: 0 });
	assert.equal(realFs.readFileSync(join(into, "a.txt"), "utf8"), "changed\n");
});

test("readManifest and restore treat a symlinked run directory as no store at all (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env);
	const snap = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 });
	const real = join(env.storeDir, checkpointKey("run-1"));
	const moved = join(env.root, "elsewhere");
	realFs.renameSync(real, moved);
	realFs.symlinkSync(moved, real);
	assert.deepEqual(await ck.readManifest("run-1"), { absent: true });
	assert.deepEqual(await ck.restore({ runId: "run-1", manifest: snap.manifest, intoWorkspace: env.ws }), { skipped: "not-primed" });
});

// ── review round 1: sweep, lock, temp files ─────────────────────────────────────────────────────────────

test("sweep ages a run by its NEWEST manifest, not its directory; uppercase hex and 33-character names are never judged (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env, {}, "young-manifest");
	await ck.snapshot({ runId: "young-manifest", workspace: env.ws, baseSha: env.baseSha, seq: 1 });
	const dir = join(env.storeDir, checkpointKey("young-manifest"));
	const madeAt = realFs.statSync(join(dir, "cp-1", "manifest.json")).mtimeMs;
	const old = new Date(madeAt - 30 * 24 * 3600_000);
	realFs.utimesSync(dir, old, old);
	const odd = ["ABCDEF0123456789ABCDEF0123456789", "0123456789abcdef0123456789abcdef0"];
	for (const n of odd) {
		realFs.mkdirSync(join(env.storeDir, n));
		realFs.utimesSync(join(env.storeDir, n), old, old);
	}
	const soon = checkpointer(env.storeDir, { now: () => madeAt + 24 * 3600_000 }).ck;
	assert.deepEqual(await soon.sweep(), { removed: 0, kept: 1 }, "a 30-day-old directory with a day-old manifest is young");
	const much = checkpointer(env.storeDir, { now: () => madeAt + 399 * 24 * 3600_000 }).ck;
	assert.deepEqual(await much.sweep(), { removed: 1, kept: 0 });
	for (const n of odd) assert.ok(realFs.existsSync(join(env.storeDir, n)), n);
});

test("a stale lock taken over by a rival between judgement and move is put back, not removed (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env);
	const lock = join(env.storeDir, checkpointKey("run-1"), "lock");
	realFs.writeFileSync(lock, "1 stale-tag\n");
	realFs.utimesSync(lock, new Date(NOW - 2 * 3600_000), new Date(NOW - 2 * 3600_000));
	const racing = {
		...realFsp,
		async rename(from, to) {
			// The rival wins the takeover in the gap: a NEW tag sits at the lock when our move runs.
			if (String(from) === lock && String(to).includes(".stale.")) realFs.writeFileSync(lock, "2 rival-tag\n");
			return realFsp.rename(from, to);
		},
	};
	const raced = checkpointer(env.storeDir, { fs: racing }).ck;
	assert.deepEqual(await raced.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 }), { skipped: "locked" });
	assert.equal(realFs.readFileSync(lock, "utf8"), "2 rival-tag\n", "the rival's live lock is back in place");
	assert.deepEqual(realFs.readdirSync(join(env.storeDir, checkpointKey("run-1"))).filter((n) => n.startsWith("lock.")), [], "no moved file left behind");
	void ck;
});

test("release removes only a lock that still holds OUR tag (#645)", async () => {
	const env = setup();
	await primed(env);
	const lock = join(env.storeDir, checkpointKey("run-1"), "lock");
	const stolen = {
		...realFsp,
		async rename(from, to) {
			if (String(from) === lock && String(to).includes(".release.")) realFs.writeFileSync(lock, "3 someone-else\n");
			return realFsp.rename(from, to);
		},
	};
	const ck = checkpointer(env.storeDir, { fs: stolen }).ck;
	assert.equal((await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 })).ok, true);
	assert.equal(realFs.readFileSync(lock, "utf8"), "3 someone-else\n", "not ours, so not removed");
});

test("every temp file is created with an exclusive flag (#645)", async () => {
	const env = setup();
	await primed(env);
	const flags = [];
	const spyFs = {
		...realFsp,
		async open(p, f, ...rest) {
			if (String(p).endsWith(".incoming")) flags.push(f);
			return realFsp.open(p, f, ...rest);
		},
	};
	const transcript = join(env.root, "t.jsonl");
	realFs.writeFileSync(transcript, "t\n");
	const res = await checkpointer(env.storeDir, { fs: spyFs }).ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1, transcript: { srcFile: transcript, offset: 2 } });
	assert.equal(res.ok, true);
	assert.deepEqual(flags, ["wx", "wx", "wx"], "transcript, manifest, CURRENT");
});

// ── attack review: the transcript copy ──────────────────────────────────────────────────────────────────

test("a sparse 1 GiB transcript over maxTranscriptBytes is skipped before a byte is written; the previous checkpoint stays (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env, { limits: { maxTranscriptBytes: MiB } });
	assert.equal((await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 })).ok, true);
	const sparse = join(env.root, "current.jsonl");
	realFs.writeFileSync(sparse, "");
	realFs.truncateSync(sparse, 1024 * MiB); // the `truncate -s` attack: 1 GiB logical, no blocks
	realFs.appendFileSync(sparse, "{}\n");
	const offset = 1024 * MiB + 3;
	const before = (await ck.usage()).bytes;
	assert.deepEqual(await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 2, transcript: { srcFile: sparse, offset } }), { skipped: "transcript-too-large" });
	assert.deepEqual(await ck.writeTranscript("run-1", 2, sparse, offset), { skipped: "transcript-too-large" });
	assert.equal(realFs.existsSync(join(env.storeDir, checkpointKey("run-1"), "cp-2")), false, "nothing reserved, nothing written");
	assert.equal((await ck.usage()).bytes, before);
	assert.equal((await ck.readManifest("run-1")).manifest.seq, 1);
	assert.equal(DEFAULT_CHECKPOINT_LIMITS.maxTranscriptBytes, 256 * MiB);
});

test("the transcript copy honours the snapshot deadline: a slow source aborts as timeout and commits nothing (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env);
	assert.equal((await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1 })).ok, true);
	const src = join(env.root, "slow.jsonl");
	realFs.writeFileSync(src, "");
	realFs.truncateSync(src, 8 * MiB);
	let reads = 0;
	const slowFs = {
		...realFsp,
		async open(p, ...rest) {
			const fh = await realFsp.open(p, ...rest);
			if (String(p) !== src) return fh;
			return new Proxy(fh, {
				get(t, prop) {
					if (prop === "read") {
						return async (...a) => {
							reads++;
							await new Promise((r) => setTimeout(r, 300));
							return t.read(...a);
						};
					}
					const v = t[prop];
					return typeof v === "function" ? v.bind(t) : v;
				},
			});
		},
	};
	const slow = checkpointer(env.storeDir, { fs: slowFs, limits: { snapshotTimeoutMs: 1500 } }).ck;
	realFs.writeFileSync(join(env.ws, "a.txt"), "moved on\n");
	assert.deepEqual(await slow.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 2, transcript: { srcFile: src, offset: 8 * MiB } }), { skipped: "timeout" });
	assert.ok(reads < 8, `stopped early, after ${reads} of 8 chunks`);
	assert.equal(realFs.existsSync(join(env.storeDir, checkpointKey("run-1"), "cp-2", "transcript.jsonl")), false);
	assert.deepEqual(realFs.readdirSync(join(env.storeDir, checkpointKey("run-1"), "cp-2")).filter((n) => n.endsWith(".incoming")), [], "the temp copy is removed");
	assert.equal((await ck.readManifest("run-1")).manifest.seq, 1);
});

test("the transcript's bytes count in the disk-low and store-full checks (#645)", async () => {
	const env = setup();
	const statfs = async () => ({ bavail: 3000, bsize: 1, blocks: 3000 });
	const { ck } = await primed(env, { statfs, limits: { maxNewBytes: 1000 } });
	const src = join(env.root, "t.jsonl");
	realFs.writeFileSync(src, "x".repeat(2000));
	assert.deepEqual(await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1, transcript: { srcFile: src, offset: 2000 } }), { skipped: "disk-low" }, "2 x 1000 + 2000 > 3000 free");
	assert.equal((await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1, transcript: { srcFile: src, offset: 500 } })).ok, true);

	const used = (await ck.usage()).bytes;
	const tight = checkpointer(env.storeDir, { limits: { maxStoreBytes: used + 1000 } }).ck;
	assert.deepEqual(await tight.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 2, transcript: { srcFile: src, offset: 2000 } }), { skipped: "store-full" });
});

test("after each committed checkpoint only the current and the previous remain, directories and refs both (#645)", async () => {
	const env = setup();
	const { ck, logs } = await primed(env);
	const run = join(env.storeDir, checkpointKey("run-1"));
	const cpRefs = () => storeGit(env.storeDir, "run-1", ["for-each-ref", "--format=%(refname)", "refs/pi-dispatch/cp/"]).toString().trim().split("\n").filter(Boolean).sort();
	for (const seq of [1, 2, 3, 4]) {
		realFs.writeFileSync(join(env.ws, "a.txt"), `round ${seq}\n`);
		assert.equal((await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq })).ok, true);
	}
	assert.deepEqual(realFs.readdirSync(run).filter((n) => n.startsWith("cp-")).sort(), ["cp-3", "cp-4"]);
	assert.deepEqual(cpRefs(), ["refs/pi-dispatch/cp/3", "refs/pi-dispatch/cp/4"]);
	assert.ok(logs.some(([e]) => e === "checkpoint_pruned"));
	const read = await ck.readManifest("run-1");
	assert.equal(read.manifest.seq, 4);
	const into = freshBase(ck, "run-1", env.baseSha);
	await ck.restore({ runId: "run-1", manifest: read.manifest, intoWorkspace: into });
	assert.equal(realFs.readFileSync(join(into, "a.txt"), "utf8"), "round 4\n", "the kept checkpoint still restores");
});

test("a crash between the commit and the prune leaves CURRENT valid; the next snapshot prunes the leftovers (#645)", async () => {
	const env = setup();
	const { ck } = await primed(env);
	const run = join(env.storeDir, checkpointKey("run-1"));
	for (const seq of [1, 2]) assert.equal((await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq })).ok, true);
	const crashing = {
		...realFsp,
		async rm(p, o) {
			if (/cp-\d+$/.test(String(p))) throw Object.assign(new Error("killed mid-prune"), { code: "EIO" });
			return realFsp.rm(p, o);
		},
	};
	const made = checkpointer(env.storeDir, { fs: crashing });
	realFs.writeFileSync(join(env.ws, "a.txt"), "three\n");
	assert.equal((await made.ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 3 })).ok, true, "the snapshot had already committed");
	assert.deepEqual(made.logs.find(([e]) => e === "checkpoint_prune_failed")?.[1], { code: "EIO" });
	const read = await ck.readManifest("run-1");
	assert.equal(read.ok, true);
	assert.equal(read.manifest.seq, 3);
	assert.ok(realFs.existsSync(join(run, "cp-1")), "the leftover is still there");
	assert.equal((await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 4 })).ok, true);
	assert.deepEqual(realFs.readdirSync(run).filter((n) => n.startsWith("cp-")).sort(), ["cp-3", "cp-4"]);
});

test("fork archive keeps entry-addressable snapshots while ordinary recovery still prunes", async () => {
	const env = setup();
	const { ck } = await primed(env, { keepHistory: true });
	for (let seq = 1; seq <= 3; seq++) {
		realFs.writeFileSync(join(env.ws, "a.txt"), `state ${seq}\n`);
		const saved = await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq, quiesced: "dead" });
		assert.equal(saved.ok, true);
	}
	const first = await ck.readManifest("run-1", { seq: 1 });
	assert.equal(first.ok, true, "the third checkpoint must not discard the selected first point");
	assert.equal(first.manifest.seq, 1);
	const into = freshBase(ck, "run-1", env.baseSha);
	const restored = await ck.restore({ runId: "run-1", manifest: first.manifest, intoWorkspace: into });
	assert.equal(restored.written > 0, true);
	assert.equal(realFs.readFileSync(join(into, "a.txt"), "utf8"), "state 1\n");
	assert.equal((await ck.readManifest("run-1")).manifest.seq, 3);
	assert.equal((await ck.readManifest("run-1", { seq: 0 })).reason, "bad-seq");
	const ordinary = checkpointer(env.storeDir).ck;
	assert.equal((await ordinary.readManifest("run-1", { seq: 1 })).reason, "bad-seq");
});

test("trusted base priming reports extensions even with case variants or a file instead of a directory", async () => {
	for (const extensionPath of [".pi/extensions/file.mjs", ".PI/Extensions/file.mjs", ".pi/extensions"]) {
		const env = setup({ "file.txt": "base", [extensionPath]: "export default () => {};\n" });
		const { ck } = checkpointer(env.storeDir);
		const primed = await ck.primeBase({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, objectFormat: "sha1" });
		assert.equal(primed.ok, true);
		assert.equal(primed.baseHasExtensions, true);
	}
});

test("archive base validation rejects a dangling commit even while its valid-looking ref survives", async () => {
	const env = setup();
	const { ck } = await primed(env, { keepHistory: true });
	assert.deepEqual(await ck.readBase("run-1"), { ok: true, baseSha: env.baseSha });
	const repo = join(env.storeDir, checkpointKey("run-1"), "repo.git");
	const packs = join(repo, "objects", "pack");
	const pack = realFs.readdirSync(packs).find((name) => name.endsWith(".pack"));
	if (pack) {
		const contents = realFs.readFileSync(join(packs, pack));
		for (const name of realFs.readdirSync(packs)) realFs.unlinkSync(join(packs, name));
		storeGit(env.storeDir, "run-1", ["unpack-objects", "-q"], { input: contents });
	}
	const object = join(repo, "objects", env.baseSha.slice(0, 2), env.baseSha.slice(2));
	assert.equal(realFs.existsSync(object), true);
	realFs.unlinkSync(object);
	assert.equal(realFs.readFileSync(join(repo, "refs", "pi-dispatch", "base"), "utf8").trim(), env.baseSha);
	assert.deepEqual(await ck.readBase("run-1"), { absent: true });
});

test("history reads classify transient filesystem errors as unavailable without changing recovery's existing answer", async () => {
	const env = setup();
	const { ck } = await primed(env, { keepHistory: true });
	assert.equal((await ck.snapshot({ runId: "run-1", workspace: env.ws, baseSha: env.baseSha, seq: 1, quiesced: "dead" })).ok, true);
	const fs = { ...realFsp, open: async (path, ...args) => {
		if (String(path).endsWith("manifest.json")) throw Object.assign(new Error("temporary disk error"), { code: "EIO" });
		return realFsp.open(path, ...args);
	} };
	const history = checkpointer(env.storeDir, { fs, keepHistory: true }).ck;
	assert.deepEqual(await history.readManifest("run-1", { seq: 1 }), { unavailable: "EIO" });
	const recovery = checkpointer(env.storeDir, { fs }).ck;
	assert.deepEqual(await recovery.readManifest("run-1"), { invalid: true, reason: "manifest-unreadable" });
});
