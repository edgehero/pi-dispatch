import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createForkStore, forkPointEntry, forkSourceKey } from "../src/fork-store.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const NOW = 1_800_000_000_000;
const hash = (s) => createHash("sha256").update(s).digest("hex");
const user = { type: "message", id: "u1", parentId: null, message: { role: "user", content: "task" } };
const answer = { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } };
const next = { type: "message", id: "u2", parentId: "a1", message: { role: "user", content: "continue" } };
const transcript = (...entries) => `${[JSON.stringify({ type: "session", version: 3, id: "session", timestamp: "2026-01-01T00:00:00Z", cwd: "/workspace" }), ...entries.map((e) => JSON.stringify(e))].join("\n")}\n`;
function setup(extra = {}) {
	const root = tempDir("pi-fork-store-");
	const dir = join(root, "sources");
	const path = join(root, "current.jsonl");
	fs.writeFileSync(path, transcript(user, answer, next));
	const store = createForkStore({ dir, now: () => NOW, hostName: "worker-1", hostQueue: "pi-jobs@worker-1", ...extra });
	const args = { runId: "github:delivery:1", sessionKey: "1".repeat(32), baseSha: "a".repeat(40), venue: "local", piVersion: "1.2.0", transcriptPath: path };
	return { root, dir, path, store, args };
}

test("immutable source binds an old run even after canonical session advances, and exposes only entry metadata", () => {
	const { store, path, args, dir } = setup();
	const first = store.publish(args);
	assert.equal(first.ok, true);
	const source = store.read({ runId: args.runId });
	assert.equal(source.manifest.hostQueue, "pi-jobs@worker-1");
	assert.deepEqual(source.entries[0], { id: "u1", parentId: null, type: "message", role: "user", positions: ["before"] });
	assert.equal(JSON.stringify(source.entries).includes("task"), false);
	const original = fs.readFileSync(source.transcriptPath);
	assert.equal(fs.statSync(source.transcriptPath).mode & 0o777, 0o600);
	assert.equal(fs.statSync(join(dir, forkSourceKey(args.runId))).mode & 0o777, 0o700);
	assert.equal(store.publish(args).sourceDigest, first.sourceDigest);
	fs.appendFileSync(path, `${JSON.stringify({ ...answer, id: "a2", parentId: "u2" })}\n`);
	assert.equal(store.publish(args).refused, "fork-source-immutable");
	assert.deepEqual(fs.readFileSync(source.transcriptPath), original);
	assert.equal(store.read({ runId: args.runId, sourceDigest: "f".repeat(64) }).refused, "fork-source-changed");
});

test("first-user before starts from base; missing exact workspace points fail by name", () => {
	const { store, args } = setup();
	store.publish(args);
	assert.deepEqual(store.read({ runId: args.runId, entryId: "u1" }).point, { base: true });
	assert.equal(store.read({ runId: args.runId, entryId: "a1", position: "at" }).refused, "fork-source-checkpoint-missing");
	assert.equal(store.read({ runId: args.runId, entryId: "unknown" }).refused, "fork-source-entry-missing");
	assert.equal(store.read({ runId: "../escape" }).refused, "fork-source-invalid");
});

test("retention uses injected clock and sweep removes only expired owned sources", async () => {
	let clock = NOW;
	const { store, args, dir } = setup({ now: () => clock, limits: { ttlMs: 100 } });
	store.publish(args);
	clock += 100;
	assert.equal(store.read({ runId: args.runId }).ok, true);
	clock++;
	assert.equal(store.read({ runId: args.runId }).refused, "fork-source-expired");
	const outside = tempDir("pi-fork-outside-");
	fs.symlinkSync(outside, join(dir, "e".repeat(32)));
	assert.deepEqual(await store.sweep(), { removed: 1 });
	assert.equal(fs.existsSync(outside), true);
	assert.equal(store.read({ runId: args.runId }).refused, "fork-source-missing");
});

test("source and metadata corruption or symlink substitutions are refused", () => {
	for (const file of ["transcript.jsonl", "manifest.json"]) {
		const { store, args, dir, path } = setup();
		store.publish(args);
		const target = join(dir, forkSourceKey(args.runId), file);
		fs.unlinkSync(target);
		fs.symlinkSync(path, target);
		assert.equal(store.read({ runId: args.runId }).refused, "fork-source-unreadable");
	}
	const { store, args, dir } = setup();
	store.publish(args);
	fs.appendFileSync(join(dir, forkSourceKey(args.runId), "transcript.jsonl"), "changed");
	assert.equal(store.read({ runId: args.runId }).refused, "fork-source-corrupt");
});

test("bounded source count, byte caps, invalid trees and missing configuration fail closed", () => {
	const { store, args, path } = setup({ limits: { maxSources: 1 } });
	assert.equal(store.publish(args).ok, true);
	assert.equal(store.publish({ ...args, runId: "another" }).refused, "fork-source-capacity");
	const small = createForkStore({ dir: join(tempDir("pi-fork-small-"), "sources"), now: () => NOW, limits: { maxBytes: 10 } });
	assert.equal(small.publish(args).refused, "fork-source-unreadable");
	fs.writeFileSync(path, transcript({ ...answer, parentId: "missing" }));
	const bad = createForkStore({ dir: join(tempDir("pi-fork-bad-"), "sources"), now: () => NOW });
	assert.equal(bad.publish(args).refused, "fork-source-unreadable");
	assert.equal(createForkStore({ now: () => NOW }).read(args).refused, "fork-source-unconfigured");
});

test("quiet point follows ancestry and refuses pending calls rather than assuming tool effects", () => {
	const call = { ...answer, message: { role: "assistant", content: [{ type: "toolCall", id: "tool1", name: "bash", arguments: {} }] } };
	const result = { type: "message", id: "r1", parentId: "a1", message: { role: "toolResult", toolCallId: "tool1", content: [] } };
	assert.equal(forkPointEntry(Buffer.from(transcript(user, call))), null);
	assert.equal(forkPointEntry(Buffer.from(transcript(user, call, result))), "r1");
	// An abandoned side branch's orphan is outside the selected leaf's ancestry.
	assert.equal(forkPointEntry(Buffer.from(transcript(user, call, { ...next, parentId: "u1" }))), "u2");
});

test("exact archived prefix supports at and the next entry's before, rejects drift and partial trees", async () => {
	const saved = new Map();
	let restores = 0;
	const checkpointer = {
		primeBase: async () => ({ ok: true }),
		readManifest: async (_runId, { seq } = {}) => saved.has(seq ?? saved.size) ? { ok: true, manifest: saved.get(seq ?? saved.size) } : { absent: true },
		snapshot: async ({ seq, baseSha, transcript: t }) => {
			const bytes = fs.readFileSync(t.srcFile).subarray(0, t.offset);
			const manifest = { seq, transcript: { bytes: bytes.length, sha256: hash(bytes) }, workspace: { baseSha, partial: false, ignoredDropped: false } };
			saved.set(seq, manifest);
			return { ok: true, seq, manifest };
		},
		restore: async () => { restores++; return { written: 1, removed: 0 }; },
	};
	const { store, args, path } = setup({ checkpointer });
	await store.primeBase(args);
	fs.writeFileSync(path, transcript(user, answer));
	const offset = fs.statSync(path).size;
	assert.equal((await store.capturePoint({ ...args, offset, quiesced: "frozen" })).ok, true);
	fs.appendFileSync(path, `${JSON.stringify(next)}\n`);
	store.publish(args);
	assert.deepEqual(store.read({ runId: args.runId }).entries.map((e) => e.positions), [["before"], ["at"], ["before"]]);
	const options = { runId: args.runId, entryId: "u2", position: "before" };
	assert.equal((await store.readPoint(options)).ok, true);
	assert.equal((await store.restorePoint({ ...options, intoWorkspace: "/unused" })).ok, true);
	assert.equal(restores, 1);
	saved.get(1).workspace.partial = true;
	assert.equal((await store.readPoint(options)).refused, "fork-source-checkpoint-mismatch");
	saved.get(1).workspace.partial = false;
	saved.get(1).transcript.sha256 = "0".repeat(64);
	assert.equal((await store.readPoint(options)).refused, "fork-source-checkpoint-mismatch");
});

test("real archive restores selected files with the exact source prefix, while later source entries remain excluded", async () => {
	const { root, dir, path, args } = setup();
	const origin = join(root, "origin");
	fs.mkdirSync(origin);
	const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "test", GIT_COMMITTER_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_EMAIL: "test@example.invalid" };
	const git = (cwd, argv) => execFileSync("git", argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
	git(origin, ["init", "-q", "-b", "main"]);
	fs.writeFileSync(join(origin, "file.txt"), "original\n");
	git(origin, ["add", "."]);
	git(origin, ["commit", "-qm", "base"]);
	const baseSha = git(origin, ["rev-parse", "HEAD"]);
	const workspace = join(root, "workspace");
	git(root, ["clone", "-q", origin, workspace]);
	const store = createForkStore({ dir, now: () => NOW, hostName: "worker-1" });
	assert.equal((await store.primeBase({ runId: args.runId, workspace, baseSha })).ok, true);
	fs.writeFileSync(join(workspace, "file.txt"), "at chosen entry\n");
	fs.writeFileSync(path, transcript(user, answer));
	assert.equal((await store.capturePoint({ ...args, baseSha, workspace, quiesced: "frozen", offset: fs.statSync(path).size })).ok, true);
	fs.writeFileSync(join(workspace, "file.txt"), "later discarded edit\n");
	fs.appendFileSync(path, `${JSON.stringify(next)}\n`);
	assert.equal(store.publish({ ...args, baseSha }).ok, true);
	const into = join(root, "into");
	git(root, ["clone", "-q", origin, into]);
	const source = await store.readPoint({ runId: args.runId, entryId: "a1", position: "at" });
	assert.equal(source.ok, true);
	assert.equal(source.point.bytes < fs.statSync(path).size, true);
	const restored = await store.restorePoint({ runId: args.runId, entryId: "a1", position: "at", intoWorkspace: into });
	assert.equal(restored.ok, true);
	assert.equal(fs.readFileSync(join(into, "file.txt"), "utf8"), "at chosen entry\n");
	assert.equal(fs.readFileSync(join(workspace, "file.txt"), "utf8"), "later discarded edit\n");
	assert.equal(git(origin, ["rev-parse", "HEAD"]), baseSha);
});

test("a base with extensions is unavailable by name before any paid fork can select it", async () => {
	const { store, args, path } = setup({ checkpointer: { primeBase: async () => ({ ok: true, baseHasExtensions: true }) } });
	assert.deepEqual(await store.primeBase(args), { refused: "fork-unsafe-extensions" });
	assert.equal(store.publish({ ...args, transcriptPath: path }).refused, "fork-unsafe-extensions");
	assert.equal(store.read({ runId: args.runId }).refused, "fork-unsafe-extensions");
});

test("archive base admission is bounded before fetch, and concurrent archive mutations are refused", async () => {
	let calls = 0;
	const full = setup({ checkpointLimits: { maxStoreBytes: 100, maxBaseBytes: 20 }, checkpointer: {
		usage: async () => ({ bytes: 90 }),
		primeBase: async () => { calls++; return { ok: true }; },
	} });
	assert.equal((await full.store.primeBase(full.args)).refused, "fork-source-capacity");
	assert.equal(calls, 0);
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const concurrent = setup({ checkpointer: { primeBase: async () => { await gate; return { ok: true }; } } });
	const first = concurrent.store.primeBase(concurrent.args);
	await Promise.resolve();
	assert.equal((await concurrent.store.primeBase({ ...concurrent.args, runId: "second" })).refused, "fork-source-busy");
	release();
	assert.equal((await first).ok, true);
});

test("base-only forks refuse a missing archive before clone rather than retrying a vanished source", async () => {
	const { store, args } = setup();
	store.publish(args);
	assert.equal((await store.readPoint({ runId: args.runId, entryId: "u1", position: "before" })).refused, "fork-source-base-missing");
});

test("an unpublished prime is swept with its workspace archive using the injected creation clock", async () => {
	let clock = NOW;
	const removed = [];
	const { store, args } = setup({ now: () => clock, limits: { ttlMs: 100 }, checkpointer: {
		primeBase: async () => ({ ok: true }), remove: async (runId) => { removed.push(runId); return { removed: true }; },
	} });
	assert.equal((await store.primeBase(args)).ok, true);
	clock += 101;
	assert.deepEqual(await store.sweep(), { removed: 1 });
	assert.deepEqual(removed, [args.runId]);
});

test("the sweep ages a source a newer release published by its own publish time and still removes its archive; a v0 manifest is not read (issue #761)", async () => {
	let clock = NOW;
	const removed = [];
	const { store, args, dir } = setup({ now: () => clock, limits: { ttlMs: 100 }, checkpointer: {
		primeBase: async () => ({ ok: true }), remove: async (runId) => { removed.push(runId); return { removed: true }; },
	} });
	const other = { ...args, runId: "github:delivery:2" };
	const isoAt = { ...args, runId: "github:delivery:3" };
	const negativeAt = { ...args, runId: "github:delivery:4" };
	const stray = { ...args, runId: "github:delivery:5" };
	const all = [args, other, isoAt, negativeAt, stray];
	// All primed at NOW (their origin.json), all published at NOW + 50 (their manifest's `at`).
	for (const a of all) assert.equal((await store.primeBase(a)).ok, true);
	clock += 50;
	for (const a of all) assert.equal(store.publish(a).ok, true);
	const rewrite = (a, over) => {
		const path = join(dir, forkSourceKey(a.runId), "manifest.json");
		fs.writeFileSync(path, JSON.stringify({ ...JSON.parse(fs.readFileSync(path, "utf8")), ...over }));
	};
	rewrite(args, { v: 2, lineage: { parent: null } });
	rewrite(other, { v: 0 });
	// Newer sources whose publish time is not a millisecond count: read as one, an ISO string ages as NaN and -1 as the
	// whole epoch, and either young source would be removed with its archive. Neither is an age; each falls back to its
	// origin.json.
	rewrite(isoAt, { v: 2, at: new Date(NOW + 50).toISOString() });
	rewrite(negativeAt, { v: 2, at: -1 });
	// A folder whose manifest names ANOTHER run, with an old `at`: read as that run's, the sweep would remove the young
	// newer source's workspace archive. It is not this folder's manifest, so the folder ages by its own origin.json.
	rewrite(stray, { v: 2, runId: args.runId, at: 0 });
	assert.equal(store.read({ runId: args.runId }).refused, "fork-source-corrupt", "a newer source is never served by this build");
	// Inside every origin's age: nothing is old, so nothing goes, and no archive is touched.
	assert.deepEqual(await store.sweep(), { removed: 0 });
	assert.deepEqual(removed, [], "no young source and no other run's archive is removed");
	for (const a of all) assert.equal(fs.existsSync(join(dir, forkSourceKey(a.runId), "manifest.json")), true, a.runId);
	// Past the origin's age, inside the newer manifest's: the newer source is young by its own time; the v0 one, the two
	// whose `at` is no age and the stray fall back to their origin.json and go, each with its OWN archive.
	clock = NOW + 101;
	assert.deepEqual(await store.sweep(), { removed: 4 });
	assert.deepEqual([...removed].sort(), [other.runId, isoAt.runId, negativeAt.runId, stray.runId].sort());
	assert.equal(fs.existsSync(join(dir, forkSourceKey(args.runId), "manifest.json")), true);
	clock = NOW + 151;
	assert.deepEqual(await store.sweep(), { removed: 1 });
	assert.deepEqual(removed.at(-1), args.runId, "the newer source's workspace archive goes with it");
	assert.equal(removed.length, 5);
	assert.equal(fs.existsSync(join(dir, forkSourceKey(args.runId))), false);
});

test("transient source reads remain retryable through selection and restore, rather than policy refusals", async () => {
	const { store, args, dir } = setup();
	store.publish(args);
	for (const code of ["EIO", "EAGAIN", "EMFILE", "ENFILE", "ETIMEDOUT"]) {
		const reader = createForkStore({ dir, now: () => NOW, readRegular: () => { throw Object.assign(new Error("temporary read failure"), { code }); } });
		assert.deepEqual(reader.read({ runId: args.runId }), { unavailable: code });
		assert.deepEqual(await reader.readPoint({ runId: args.runId, entryId: "u1", position: "before" }), { unavailable: code });
		assert.deepEqual(await reader.restorePoint({ runId: args.runId, entryId: "u1", position: "before", intoWorkspace: "/unused" }), { unavailable: code });
	}
	const reader = createForkStore({ dir, now: () => NOW, checkpointer: { readBase: async () => ({ unavailable: "EIO" }) } });
	assert.deepEqual(await reader.readPoint({ runId: args.runId, entryId: "u1", position: "before" }), { unavailable: "EIO" });
});
