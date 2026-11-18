import assert from "node:assert/strict";
import * as fs from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { makeSandboxReaper } from "../src/sandbox-store.mjs";
import { makeSessionStore } from "../src/session-store.mjs";
import { makeRetentionRemover } from "../src/retention-remove.mjs";
import { makeRetentionSweep } from "../src/retention-sweep.mjs";

const NOW = Date.UTC(2026, 10, 18);
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise((r) => setImmediate(r));

test("a slow sandbox delete yields, stays detached, and cannot remove a replacement under the run's name", async () => {
	const root = tempDir("pd-retention-async-");
	const path = join(root, "old"); fs.mkdirSync(path);
	fs.writeFileSync(join(path, "manifest.json"), JSON.stringify({ jobId: "old", createdAt: new Date(NOW - 2 * 86400000).toISOString() }));
	const entered = deferred(), gate = deferred();
	const reap = makeSandboxReaper({ sandboxDir: root, retentionHours: 24, now: () => NOW, remove: async (p, options) => { entered.resolve(p); await gate.promise; await rm(p, options); } });
	const running = reap();
	const tomb = await entered.promise;
	assert.match(tomb, /\.reap-/);
	assert.equal(fs.existsSync(path), false);
	fs.mkdirSync(path); fs.writeFileSync(join(path, "new"), "replacement");
	await turn();
	assert.ok(fs.existsSync(tomb), "event loop runs while deletion is pending");
	gate.resolve(); await running;
	assert.equal(fs.readFileSync(join(path, "new"), "utf8"), "replacement");
});

test("session deletion detaches under its promotion lock, preserves a new canonical name, and leaves live locks alone", async () => {
	const root = tempDir("pd-session-retire-");
	const key = "a".repeat(32), path = join(root, key);
	fs.mkdirSync(path); fs.writeFileSync(join(path, "current.jsonl"), "expired");
	fs.utimesSync(join(path, "current.jsonl"), new Date(0), new Date(0));
	const entered = deferred(), gate = deferred();
	const store = makeSessionStore({ sessionsDir: root, ttlDays: 1, now: () => NOW, remove: async (p, options) => { entered.resolve(p); await gate.promise; await rm(p, options); } });
	const sweep = store.reapSessions();
	const tomb = await entered.promise;
	assert.match(tomb, /\.retired-/);
	fs.mkdirSync(path); fs.writeFileSync(join(path, "current.jsonl"), "new");
	gate.resolve(); await sweep;
	assert.equal(fs.readFileSync(join(path, "current.jsonl"), "utf8"), "new");
	fs.utimesSync(join(path, "current.jsonl"), new Date(0), new Date(0));
	fs.writeFileSync(join(path, "lock"), ""); fs.utimesSync(join(path, "lock"), new Date(NOW), new Date(NOW));
	await store.reapSessions();
	assert.ok(fs.existsSync(path), "a live promotion lock holds the key");
});

test("a failed detached removal is retried by the next pass, with no guessed directory names", async () => {
	const root = tempDir("pd-retire-leftovers-");
	const path = join(root, "expired"), other = join(root, ".retired-not-ours");
	fs.mkdirSync(path); fs.mkdirSync(other);
	const retire = makeRetentionRemover({ now: () => NOW });
	const tomb = retire.detach(path);
	await retire.leftovers(root);
	assert.equal(fs.existsSync(tomb), false);
	assert.ok(fs.existsSync(other));
});

test("closing a sweep stops the next store and tells an in-flight reaper to stop taking entries", async () => {
	const gate = deferred(), entered = deferred(); const ran = [];
	let stop;
	const sweep = makeRetentionSweep({ intervalMs: 1000, now: () => NOW, reapers: [
		{ name: "one", reap: async ({ stopped }) => { stop = stopped; entered.resolve(); await gate.promise; } },
		{ name: "two", reap: () => ran.push("two") },
	] });
	const running = sweep.sweepOnce(); await entered.promise;
	const closing = sweep.close(); assert.equal(stop(), true);
	gate.resolve(); await running; await closing;
	assert.deepEqual(ran, []);
});

test("production recursive removal lets the event loop observe a detached tree before it disappears", async () => {
	const root = tempDir("pd-retire-real-");
	const path = join(root, "expired"); fs.mkdirSync(path);
	for (let i = 0; i < 256; i++) fs.writeFileSync(join(path, `file-${i}`), "sample");
	let observed = 0, finished = false;
	const ticking = (async () => {
		while (!finished) {
			await turn();
			if (fs.readdirSync(root).some((name) => name.startsWith(".reap-"))) observed++;
		}
	})();
	try { await makeSandboxReaper({ sandboxDir: root, retentionHours: 1, now: () => NOW })(); }
	finally { finished = true; await ticking; }
	assert.ok(observed > 0, "a synchronous recursive delete cannot expose its tombstone to another callback");
	assert.deepEqual(fs.readdirSync(root), []);
});

test("already committed session tombstones are retried even after retention becomes keep-forever", async () => {
	const root = tempDir("pd-retire-disabled-");
	fs.mkdirSync(join(root, ".retired-1-1000-0"));
	const key = join(root, "a".repeat(32)); fs.mkdirSync(key);
	await makeSessionStore({ sessionsDir: root, ttlDays: 0, now: () => NOW }).reapSessions();
	assert.deepEqual(fs.readdirSync(root), ["a".repeat(32)]);
});

test("a fork published after the child sweep holds its expired parent at the final decision", async () => {
	const root = tempDir("pd-retire-fork-race-");
	const key = "a".repeat(32), dir = join(root, key), transcript = join(dir, "current.jsonl");
	fs.mkdirSync(dir); fs.writeFileSync(transcript, "old"); fs.utimesSync(transcript, new Date(0), new Date(0));
	const child = join(dir, "forks", "b".repeat(32));
	let published = false;
	const store = makeSessionStore({ sessionsDir: root, ttlDays: 1, now: () => NOW, fs: { ...fs, lstatSync(path) {
		if (path === transcript && !published) {
			published = true; fs.mkdirSync(child, { recursive: true }); fs.writeFileSync(join(child, "current.jsonl"), "new fork");
		}
		return fs.lstatSync(path);
	} } });
	await store.reapSessions();
	assert.equal(published, true);
	assert.equal(fs.readFileSync(join(child, "current.jsonl"), "utf8"), "new fork");
});
