import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeSessionStore } from "../src/session-store.mjs";
import { FORK_SESSION_KEY_PATTERN, sessionKeyFor, sessionKeyOfRecord } from "../src/session-key.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const issue = { kind: "github", repo: "owner/repo", target: { type: "issue", number: 7 }, resume: true };
const forkId = "a".repeat(32);
const rootKey = sessionKeyFor(issue);
const job = { ...issue, fork: { rootKey, id: forkId } };
const piVersion = "1.2.0";

function fixture() {
	const root = tempDir("session-fork-");
	const sessionsDir = join(root, "sessions");
	mkdirSync(sessionsDir);
	const instant = Date.UTC(2026, 0, 1);
	const now = () => instant;
	const store = makeSessionStore({ sessionsDir, ttlDays: 14, now, defaultBackend: "local" });
	const body = (id) => `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(now()).toISOString(), cwd: "/workspace" })}\n`;
	const originalDir = join(sessionsDir, rootKey);
	mkdirSync(originalDir);
	writeFileSync(join(originalDir, "current.jsonl"), body("original"));
	writeFileSync(join(originalDir, "pi-version"), piVersion);
	return { root, sessionsDir, store, now, body, originalDir };
}

test("managed forks and their same-repo PR followups share only their own namespace", () => {
	const key = sessionKeyFor(job);
	assert.equal(key, `${rootKey}.${forkId}`);
	assert.match(key, FORK_SESSION_KEY_PATTERN);
	const request = { ...issue, target: { type: "pull_request", number: 99 } };
	const headRef = `pi/issue-7-fork-${forkId}`;
	assert.equal(sessionKeyFor(request, { headRef, headRepo: issue.repo }), key);
	assert.equal(sessionKeyFor(request, { headRef, headRepo: "stranger/repo" }), null);
	assert.notEqual(sessionKeyFor(issue), key);
	assert.equal(sessionKeyOfRecord({ kind: issue.kind, target: "owner/repo#7", fork: { id: forkId } }), key);
	assert.equal(sessionKeyOfRecord({ kind: issue.kind, target: "owner/repo#7", fork: { id: "../outside" } }), null);
	for (const fork of [null, {}, { id: forkId, rootKey: "b".repeat(32) }, { rootKey, id: "../outside" }, { rootKey, id: "A".repeat(32) }, { rootKey, id: [forkId] }]) assert.equal(sessionKeyFor({ ...issue, fork }), null);
	assert.equal(sessionKeyFor({ ...job, repo: "other/repo" }), null, "a claimed root cannot move across repositories");
	assert.equal(sessionKeyFor({ ...job, target: { type: "issue", number: 8 } }), null, "a claimed root cannot move across issues");
});

test("fork promotion, stamps and resume never modify the original canonical session", () => {
	const { root, sessionsDir, store, body, originalDir } = fixture();
	const original = readFileSync(join(originalDir, "current.jsonl"));
	const staged = store.resolveSession(job, { jobDir: join(root, "job"), piVersion });
	assert.equal(staged.resume, false);
	writeFileSync(join(staged.hostDir, "current.jsonl"), body("fork"));
	assert.equal(store.promoteSession(staged, { piVersion, parked: true }).promoted, true);
	const forkDir = join(sessionsDir, rootKey, "forks", forkId);
	assert.equal(readFileSync(join(forkDir, "current.jsonl"), "utf8"), body("fork"));
	assert.equal(existsSync(join(originalDir, "parked")), false);
	assert.equal(existsSync(join(forkDir, "parked")), true);
	assert.deepEqual(readFileSync(join(originalDir, "current.jsonl")), original);
	const resumed = store.resolveSession(job, { jobDir: join(root, "next"), piVersion });
	assert.equal(resumed.resume, true, JSON.stringify(resumed));
	assert.equal(readFileSync(join(resumed.hostDir, "current.jsonl"), "utf8"), body("fork"));
});

test("restored fork staging promotes into the fork namespace", () => {
	const { root, store, body, originalDir } = fixture();
	const transcriptPath = join(root, "checkpoint.jsonl");
	writeFileSync(transcriptPath, body("restored"));
	const staged = store.stageRecovered({ jobDir: join(root, "job"), transcriptPath, job, piVersion });
	assert.equal(staged.key, `${rootKey}.${forkId}`);
	assert.equal(store.promoteSession(staged, { piVersion }).promoted, true);
	assert.equal(readFileSync(join(originalDir, "forks", forkId, "current.jsonl"), "utf8"), body("restored"));
	assert.equal(readFileSync(join(originalDir, "current.jsonl"), "utf8"), body("original"));
});

test("a linked fork parent is refused on both read and promotion without writing through it", () => {
	const { root, store, originalDir } = fixture();
	const outside = join(root, "outside");
	mkdirSync(outside);
	symlinkSync(outside, join(originalDir, "forks"));
	const staged = store.resolveSession(job, { jobDir: join(root, "job"), piVersion });
	assert.equal(staged.resume, false);
	assert.equal(staged.reason, "key-not-a-directory");
	writeFileSync(join(staged.hostDir, "current.jsonl"), "{}\n");
	assert.equal(store.promoteSession(staged, { piVersion }).promoted, false);
	assert.equal(existsSync(join(outside, forkId)), false);
});

test("retention expires forks independently and never deletes a live fork with its expired original", () => {
	const { root, store, body, originalDir, now } = fixture();
	const old = new Date(now() - 20 * 86400000);
	const recent = new Date(now() - 86400000);
	utimesSync(join(originalDir, "current.jsonl"), old, old);
	for (const [id, date] of [[forkId, recent], ["b".repeat(32), old]]) {
		const dir = join(originalDir, "forks", id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "current.jsonl"), body(id));
		utimesSync(join(dir, "current.jsonl"), date, date);
	}
	store.reapSessions();
	assert.equal(existsSync(join(originalDir, "forks", forkId)), true);
	assert.equal(existsSync(join(originalDir, "forks", "b".repeat(32))), false);
	utimesSync(join(originalDir, "forks", forkId, "current.jsonl"), old, old);
	store.reapSessions();
	assert.equal(existsSync(originalDir), false);
	assert.equal(existsSync(root), true);
});
