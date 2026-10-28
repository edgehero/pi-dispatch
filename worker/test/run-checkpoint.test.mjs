import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	CHECKPOINT_POINTER_PREFIX,
	CHECKPOINT_POINTER_TTL_MS,
	DEFAULT_RUN_CHECKPOINT_LIMITS,
	HOST_SNAPSHOT_CONCURRENCY,
	UNPAUSE_TRIES,
	checkpointPointerKey,
	lastCompleteLineEnd,
	makeQuietTracker,
	makeRunCheckpointer,
	makeSemaphore,
	readCheckpointPointer,
	removeCheckpointPointer,
	validPointer,
	writeCheckpointPointer,
} from "../src/run-checkpoint.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #645: when a running job is checkpointed, how the freeze is balanced, and the Valkey pointer. Every
// collaborator is a recording fake (the venue's verbs, the store, the client) with an injected clock; the pointer's
// read, validation and removal also run against a real Valkey, DATABASE 10, flushed first (the worker and admin
// Valkey tests already use 0, 2, 5, 7, 8, 9 and 11 to 15; 10 was free when this file was written).

const SHA = "a".repeat(40);
const AT = "2026-10-17T10:00:00.000Z";
const line = (o) => `${JSON.stringify(o)}\n`;
const header = () => ({ type: "session", version: 3, id: "s1", timestamp: AT, cwd: "/workspace" });
const assistant = (calls = [], text = "ok") => ({ type: "message", timestamp: AT, message: { role: "assistant", content: [{ type: "text", text }, ...calls.map((id) => ({ type: "toolCall", id, name: "bash", arguments: { cmd: "ls" } }))], stopReason: calls.length ? "toolUse" : "stop" } });
const result = (id) => ({ type: "message", timestamp: AT, message: { role: "toolResult", toolCallId: id, toolName: "bash", isError: false, content: [{ type: "text", text: "out" }] } });

/** A transcript file the test appends to, returning each line's end offset as the tailer would hand it. */
function transcript() {
	const dir = tempDir("pi-ckpt-");
	const file = join(dir, "current.jsonl");
	writeFileSync(file, "");
	let size = 0;
	return {
		dir,
		file,
		append(o) {
			const text = line(o);
			appendFileSync(file, text);
			size += Buffer.byteLength(text);
			return size;
		},
		raw(text) {
			appendFileSync(file, text);
			size += Buffer.byteLength(text);
			return size;
		},
	};
}

/** The recording world: the order of every verb, snapshot and pointer write, on one clock. */
function world({ snapshot, pause, unpause, manifestSeq = null, pointerReply = "OK" } = {}) {
	const order = [];
	const store = new Map();
	let t = Date.parse(AT);
	const clock = { now: () => t, advance: (ms) => (t += ms) };
	const checkpointer = {
		readManifest: async () => (manifestSeq ? { ok: true, manifest: { seq: manifestSeq } } : { absent: true }),
		snapshot: async (args) => {
			order.push(["snapshot", args.kind, args.quiesced, args.transcript.offset, args.seq]);
			if (snapshot) return snapshot(args, order);
			return { ok: true, seq: args.seq, manifest: { host: "host-a" } };
		},
	};
	const redis = {
		set: async (key, value, px, ttl) => {
			order.push(["pointer", key, JSON.parse(value).seq]);
			assert.equal(px, "PX");
			assert.equal(ttl, CHECKPOINT_POINTER_TTL_MS);
			if (pointerReply === "OK") store.set(key, value);
			return pointerReply;
		},
		get: async (key) => store.get(key) ?? null,
		del: async (key) => (store.delete(key) ? 1 : 0),
	};
	const verbs = {
		pause: async (name) => (order.push(["pause", name]), pause ? pause(name, order) : { ok: true }),
		unpause: async (name) => (order.push(["unpause", name]), unpause ? unpause(name, order) : { ok: true }),
	};
	return { order, store, clock, checkpointer, redis, verbs };
}

function makeHandle(w, { limits = {}, args = {}, semaphore, logs = [], forkStore = null } = {}) {
	const rc = makeRunCheckpointer({
		checkpointer: w.checkpointer,
		forkStore,
		redis: w.redis,
		hostName: "host-a",
		hostQueue: "pi-jobs@host-a",
		now: w.clock.now,
		log: (e, f) => logs.push([e, f]),
		limits: { minIntervalMs: 60_000, pauseMaxMs: 1_000, maxFailures: 3, ...limits },
		sleep: async () => {},
		...(semaphore ? { semaphore } : {}),
	});
	return rc.open({ runId: "run-1", attempt: 0, jobDir: "/jobs/job-ab12cd", workspace: "/jobs/job-ab12cd/workspace", containerName: "pi-job-run-1", baseSha: SHA, ...w.verbs, ...args });
}

// --- the pieces ---------------------------------------------------------------------------------------------------

test("the constants, and the pointer key follows the sanitized run id", () => {
	assert.equal(CHECKPOINT_POINTER_PREFIX, "run:checkpoint:");
	assert.equal(checkpointPointerKey("repeat:abc:17"), "run:checkpoint:repeat_abc_17");
	assert.equal(CHECKPOINT_POINTER_TTL_MS, 7 * 24 * 3600 * 1000);
	assert.equal(HOST_SNAPSHOT_CONCURRENCY, 2);
	assert.equal(UNPAUSE_TRIES, 3);
	assert.deepEqual({ ...DEFAULT_RUN_CHECKPOINT_LIMITS }, { minIntervalMs: 60_000, pauseMaxMs: 15_000, maxFailures: 3 });
});

test("quiet points over pi-shaped entries: an assistant without calls, or the result that answers the last call", () => {
	const q = makeQuietTracker();
	assert.equal(q.take(header()), false, "the header is not a point");
	assert.equal(q.take({ type: "message", message: { role: "user", content: "go" } }), false);
	assert.equal(q.take(assistant([], "thinking out loud")), true, "an answer with no tool calls");
	assert.equal(q.take(assistant(["c1", "c2"])), false, "calls outstanding");
	assert.equal(q.take(result("c1")), false, "one of two answered");
	assert.equal(q.take({ type: "compaction", summary: "x" }), false, "other entries change nothing");
	assert.equal(q.take(result("zz")), false, "an unknown id answers nothing");
	assert.equal(q.take(result("c2")), true, "the last one answered");
	assert.equal(q.take(result("c2")), false, "a duplicate after the point is not another point");
	// A call with no id can never be answered by id: the point stays closed until the next assistant message.
	assert.equal(q.take({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] } }), false);
	assert.equal(q.take(result(undefined)), false);
	assert.equal(q.pending, 1);
	q.reset();
	assert.equal(q.pending, 0);
	assert.equal(q.take(null), false);
	assert.equal(q.take({ type: "message" }), false);
});

test("lastCompleteLineEnd is the byte past the last newline, a partial tail left out; null for a missing file or a link", async () => {
	const t = transcript();
	assert.equal(await lastCompleteLineEnd(t.file), 0, "empty");
	const e1 = t.append(header());
	assert.equal(await lastCompleteLineEnd(t.file), e1);
	t.raw('{"type":"message","partial');
	assert.equal(await lastCompleteLineEnd(t.file), e1, "the half-written line is not in it");
	assert.equal(await lastCompleteLineEnd(join(t.dir, "absent.jsonl")), null);
	const { symlinkSync } = await import("node:fs");
	symlinkSync(t.file, join(t.dir, "link.jsonl"));
	assert.equal(await lastCompleteLineEnd(join(t.dir, "link.jsonl")), null, "O_NOFOLLOW: a link is never followed");
	// A tail longer than the scan bound with no newline in it: unknown, never a guess.
	const big = transcript();
	big.raw("x".repeat(200));
	assert.equal(await lastCompleteLineEnd(big.file, { maxScanBytes: 64 }), null);
});

test("the semaphore: tryAcquire never waits, acquire queues, and a release is idempotent", async () => {
	const s = makeSemaphore(2);
	const a = s.tryAcquire();
	const b = s.tryAcquire();
	assert.ok(a && b);
	assert.equal(s.tryAcquire(), null, "the third is refused, not queued");
	let got = null;
	const waiting = s.acquire().then((r) => (got = r));
	await Promise.resolve();
	assert.equal(got, null);
	a();
	a();
	await waiting;
	assert.equal(typeof got, "function");
	assert.equal(s.active, 2, "the double release freed one slot, which the waiter took");
	b();
	got();
	assert.equal(s.active, 0);
});

test("validPointer: exactly the pointer's keys, every value typed; anything loose is null", () => {
	const good = { v: 1, host: "host-a", hostQueue: "pi-jobs@host-a", seq: 3, attempt: 1, at: 1, jobDir: "job-ab12cd" };
	assert.deepEqual(validPointer(good), good);
	assert.deepEqual(validPointer({ ...good, hostQueue: null }), { ...good, hostQueue: null });
	for (const bad of [null, [], "x", { ...good, v: 2 }, { ...good, extra: 1 }, { ...good, host: "a/b" }, { ...good, hostQueue: "-q" }, { ...good, seq: 0 }, { ...good, seq: 1.5 }, { ...good, attempt: -1 }, { ...good, at: "1" }, { ...good, jobDir: "../job-x" }, { ...good, jobDir: "/jobs/job-ab12cd" }, { ...good, jobDir: "other" }]) {
		assert.equal(validPointer(bad), null, JSON.stringify(bad));
	}
	const { jobDir, ...missing } = good;
	assert.equal(validPointer(missing), null, `no ${Object.keys({ jobDir })[0]}`);
});

// --- the live checkpoint --------------------------------------------------------------------------------------------

test("ORDER: pause, snapshot with the offset read while paused, unpause, then the pointer", async () => {
	const t = transcript();
	const w = world({
		// The freeze lands after pi appended one more complete line and half of the next: the offset is the end of that
		// complete line, read while frozen, never the tailer's last end and never into the half line.
		pause: async () => {
			frozenEnd = t.append(result("c1"));
			t.raw('{"type":"message","half');
			return { ok: true };
		},
	});
	let frozenEnd = null;
	const h = makeHandle(w, { args: { sessionFile: t.file } });
	t.append(header());
	h.consume(header(), 0, t.append(assistant(["c0"])));
	h.consume(result("c0"), 0, t.append(result("c0")));
	assert.equal(h.pending(), null, "a quiet point inside the first interval starts nothing");
	w.clock.advance(60_000);
	const tailerEnd = t.append(assistant([], "done"));
	h.consume(assistant([], "done"), 0, tailerEnd);
	const outcome = await h.pending();
	assert.deepEqual(outcome, { seq: 1 });
	assert.deepEqual(w.order, [
		["pause", "pi-job-run-1"],
		["snapshot", "live", "frozen", frozenEnd, 1],
		["unpause", "pi-job-run-1"],
		["pointer", "run:checkpoint:run-1", 1],
	]);
	assert.ok(frozenEnd > tailerEnd);
	assert.deepEqual(JSON.parse(w.store.get("run:checkpoint:run-1")), { v: 1, host: "host-a", hostQueue: "pi-jobs@host-a", seq: 1, attempt: 0, at: Date.parse(AT) + 60_000, jobDir: "job-ab12cd" });
	assert.deepEqual(await h.close(), { written: 1, failed: 0, skipped: 0, lastSeq: 1 });
});

test("only quiet points trigger, and never a prior or replayed line", async () => {
	const t = transcript();
	const w = world();
	const h = makeHandle(w, { args: { sessionFile: t.file }, limits: { minIntervalMs: 0 } });
	h.consume(assistant(["c1"]), 0, t.append(assistant(["c1"])));
	assert.equal(h.pending(), null, "a call outstanding is not quiet");
	h.consume(assistant([]), 0, t.append(assistant([])), { prior: true });
	assert.equal(h.pending(), null, "an earlier attempt's line re-read at the baseline");
	h.consume(assistant([]), 0, t.append(assistant([])), { prior: false, replay: true });
	assert.equal(h.pending(), null, "a line replayed after a rewrite");
	h.consume(assistant([]), 0, t.append(assistant([])));
	assert.ok(h.pending(), "a live quiet point does");
	await h.pending();
	assert.equal(w.order.filter((o) => o[0] === "pause").length, 1);
});

test("one in flight: a quiet point during a checkpoint starts nothing; the next is a minInterval later", async () => {
	const t = transcript();
	let releaseSnapshot;
	const gate = new Promise((r) => (releaseSnapshot = r));
	const w = world({ snapshot: async (args) => (await gate, { ok: true, seq: args.seq, manifest: { host: "host-a" } }) });
	const h = makeHandle(w, { args: { sessionFile: t.file }, limits: { minIntervalMs: 1_000 } });
	w.clock.advance(1_000);
	h.consume(assistant([]), 0, t.append(assistant([])));
	const first = h.pending();
	h.consume(assistant([]), 0, t.append(assistant([])));
	assert.equal(h.pending(), first, "the same one");
	releaseSnapshot();
	await first;
	h.consume(assistant([]), 0, t.append(assistant([])));
	assert.equal(h.pending(), null, "inside the interval");
	w.clock.advance(999);
	h.consume(assistant([]), 0, t.append(assistant([])));
	assert.equal(h.pending(), null);
	w.clock.advance(1);
	h.consume(assistant([]), 0, t.append(assistant([])));
	assert.ok(h.pending());
	await h.pending();
	assert.equal(h.stats().written, 2);
});

test("backoff on the clock: each failure doubles the wait, and maxFailures in a row degrades the attempt", async () => {
	const t = transcript();
	const logs = [];
	const w = world({ snapshot: async () => ({ skipped: "disk-low" }) });
	const h = makeHandle(w, { args: { sessionFile: t.file }, limits: { minIntervalMs: 1_000 }, logs });
	const quiet = () => h.consume(assistant([]), 0, t.append(assistant([])));
	w.clock.advance(1_000);
	quiet();
	assert.deepEqual(await h.pending(), { skipped: "disk-low" });
	// After one failure: 2 x 1 s.
	w.clock.advance(1_999);
	quiet();
	assert.equal(h.pending(), null);
	w.clock.advance(1);
	quiet();
	await h.pending();
	// After two: 4 s.
	w.clock.advance(3_999);
	quiet();
	assert.equal(h.pending(), null);
	w.clock.advance(1);
	quiet();
	await h.pending();
	assert.ok(logs.some(([e, f]) => e === "checkpoint_degraded" && f.failures === 3 && f.runId === "run-1"));
	w.clock.advance(3_600_000);
	quiet();
	assert.equal(h.pending(), null, "degraded: no more live checkpoints this attempt");
	assert.deepEqual(h.stats(), { written: 0, failed: 0, skipped: 3, lastSeq: null });
	assert.equal(w.order.filter((o) => o[0] === "pointer").length, 0, "no pointer for a skipped snapshot");
	assert.equal(w.order.filter((o) => o[0] === "pause").length, w.order.filter((o) => o[0] === "unpause").length, "every pause thawed");
	// A success resets the run of failures: a fresh handle that fails once, then commits, is backed off from zero again.
	const w2 = world();
	let fail = true;
	w2.checkpointer.snapshot = async (args) => (fail ? ((fail = false), { skipped: "timeout" }) : { ok: true, seq: args.seq, manifest: { host: "host-a" } });
	const h2 = makeHandle(w2, { args: { sessionFile: t.file }, limits: { minIntervalMs: 1_000 } });
	w2.clock.advance(1_000);
	h2.consume(assistant([]), 0, 1);
	await h2.pending();
	w2.clock.advance(2_000);
	h2.consume(assistant([]), 0, 1);
	assert.deepEqual(await h2.pending(), { seq: 1 });
	w2.clock.advance(1_000);
	h2.consume(assistant([]), 0, 1);
	assert.ok(h2.pending(), "back to the plain interval after the commit");
	await h2.pending();
});

test("a refused or skipped snapshot writes no pointer, and a permanent answer turns live checkpoints off at once", async () => {
	const t = transcript();
	for (const answer of [{ refused: "job-secret-in-tree" }, { skipped: "over-byte-cap" }, { skipped: "not-primed" }]) {
		const logs = [];
		const w = world({ snapshot: async () => answer });
		const h = makeHandle(w, { args: { sessionFile: t.file }, limits: { minIntervalMs: 0 }, logs });
		h.consume(assistant([]), 0, t.append(assistant([])));
		await h.pending();
		assert.equal(w.store.size, 0, JSON.stringify(answer));
		assert.deepEqual(w.order.map((o) => o[0]), ["pause", "snapshot", "unpause"]);
		assert.equal(h.stats().skipped, 1);
		h.consume(assistant([]), 0, t.append(assistant([])));
		if (answer.skipped === "not-primed") {
			assert.equal(h.pending(), null, "never primed: no second freeze for an answer that cannot change");
			assert.ok(logs.some(([e, f]) => e === "checkpoint_live_off" && f.reason === "not-primed"));
		}
		await h.pending();
	}
	// A pointer write Valkey refuses: committed, counted written, said, and the store still holds no pointer.
	const logs = [];
	const w = world({ pointerReply: null });
	const h = makeHandle(w, { args: { sessionFile: t.file }, limits: { minIntervalMs: 0 }, logs });
	h.consume(assistant([]), 0, t.append(assistant([])));
	assert.deepEqual(await h.pending(), { seq: 1 });
	assert.ok(logs.some(([e, f]) => e === "checkpoint_pointer_failed" && f.reason === "write"));
});

test("an unpause that fails UNPAUSE_TRIES times reports stop and calls onStop; the committed checkpoint keeps its pointer", async () => {
	const t = transcript();
	const logs = [];
	const stops = [];
	const w = world({ unpause: async () => ({ ok: false, reason: "exit-1" }) });
	const h = makeHandle(w, { args: { sessionFile: t.file, onStop: async () => stops.push(w.order.length) }, limits: { minIntervalMs: 0 }, logs });
	h.consume(assistant([]), 0, t.append(assistant([])));
	const outcome = await h.pending();
	assert.deepEqual(outcome, { stop: true, seq: 1 });
	assert.deepEqual(w.order.map((o) => o[0]), ["pause", "snapshot", "unpause", "unpause", "unpause", "pointer"]);
	assert.equal(stops.length, 1, "onStop once, after the pointer");
	assert.ok(logs.some(([e]) => e === "checkpoint_unpause_failed"));
	h.consume(assistant([]), 0, t.append(assistant([])));
	assert.equal(h.pending(), null, "a stopped container is never paused again");
	// A thrown unpause and a hanging one count as failures too, and the hang is bounded by pauseMaxMs.
	const w2 = world({ unpause: () => new Promise(() => {}) });
	const stops2 = [];
	const h2 = makeHandle(w2, { args: { sessionFile: t.file, onStop: () => stops2.push(1) }, limits: { minIntervalMs: 0, pauseMaxMs: 5 } });
	h2.consume(assistant([]), 0, 1);
	assert.equal((await h2.pending()).stop, true);
	assert.equal(stops2.length, 1);
});

test("a pause that does not take: counted failed and nothing snapshotted; a timed-out one is thawed without escalation", async () => {
	const t = transcript();
	const stops = [];
	const w = world({ pause: async () => ({ ok: false, reason: "timeout" }), unpause: async () => ({ ok: false, reason: "exit-1" }) });
	const h = makeHandle(w, { args: { sessionFile: t.file, onStop: () => stops.push(1) }, limits: { minIntervalMs: 0 } });
	h.consume(assistant([]), 0, 1);
	assert.deepEqual(await h.pending(), { failed: "pause" });
	assert.deepEqual(w.order.map((o) => o[0]), ["pause", "unpause"], "the freeze may still land, so it is thawed once");
	assert.equal(stops.length, 0, "a failed thaw of a container that may never have frozen stops nothing");
	assert.equal(h.stats().failed, 1);
	// podman's cgroup v1 gate: an answer that will not change, so live checkpoints are off, with no thaw at all.
	const w2 = world({ pause: async () => ({ ok: false, reason: "cgroup-v1-rootless" }) });
	const h2 = makeHandle(w2, { args: { sessionFile: t.file }, limits: { minIntervalMs: 0 } });
	h2.consume(assistant([]), 0, 1);
	await h2.pending();
	h2.consume(assistant([]), 0, 1);
	assert.equal(h2.pending(), null);
	assert.deepEqual(w2.order.map((o) => o[0]), ["pause"]);
});

test("the host semaphore: two snapshots at once across runs; a third run's quiet point is skipped, not queued", async () => {
	const t = transcript();
	const sem = makeSemaphore(HOST_SNAPSHOT_CONCURRENCY);
	let open;
	const gate = new Promise((r) => (open = r));
	const worlds = [0, 1, 2].map(() => world({ snapshot: async (args) => (await gate, { ok: true, seq: args.seq, manifest: { host: "host-a" } }) }));
	const handles = worlds.map((w, i) => makeHandle(w, { semaphore: sem, args: { runId: `run-${i}`, sessionFile: t.file }, limits: { minIntervalMs: 0 } }));
	handles[0].consume(assistant([]), 0, 1);
	handles[1].consume(assistant([]), 0, 1);
	handles[2].consume(assistant([]), 0, 1);
	assert.ok(handles[0].pending() && handles[1].pending());
	assert.equal(handles[2].pending(), null);
	assert.equal(worlds[2].order.length, 0, "the third never paused its container");
	assert.equal(handles[2].stats().skipped, 1);
	// The exit checkpoint WAITS for a slot: its container is dead, so waiting costs nothing.
	let exited = false;
	const exit = handles[2].exit().then((r) => ((exited = true), r));
	await new Promise((r) => setImmediate(r));
	assert.equal(exited, false);
	open();
	await Promise.all([handles[0].pending(), handles[1].pending()]);
	assert.deepEqual(await exit, { seq: 1 });
	assert.equal(sem.active, 0);
});

test("a venue that cannot pause gets no live checkpoints, and exit() still works", async () => {
	const t = transcript();
	const logs = [];
	const w = world();
	const h = makeHandle(w, { args: { sessionFile: t.file, pause: null, unpause: null }, limits: { minIntervalMs: 0 }, logs });
	h.consume(assistant([]), 0, t.append(assistant([])));
	assert.equal(h.pending(), null);
	assert.ok(logs.some(([e, f]) => e === "checkpoint_live_off" && f.reason === "not-pausable"));
	assert.deepEqual(await h.exit(), { seq: 1 });
	assert.deepEqual(w.order.map((o) => o[0]), ["snapshot", "pointer"]);
});

test("exit(): after the container, no pause, kind exit and quiesced dead, waiting for a live one in flight; idempotent", async () => {
	const t = transcript();
	let open;
	const gate = new Promise((r) => (open = r));
	let first = true;
	const w = world({ snapshot: async (args) => (first ? ((first = false), await gate) : null, { ok: true, seq: args.seq, manifest: { host: "host-a" } }) });
	const h = makeHandle(w, { args: { sessionFile: t.file }, limits: { minIntervalMs: 0 } });
	h.consume(assistant(["c1"]), 0, t.append(assistant(["c1"])));
	h.consume(result("c1"), 0, t.append(result("c1")));
	const live = h.pending();
	const end = t.raw('{"partial');
	assert.ok(end > 0);
	const exit = h.exit();
	assert.equal(h.exit(), exit, "the same promise");
	open();
	await live;
	assert.deepEqual(await exit, { seq: 2 });
	const snaps = w.order.filter((o) => o[0] === "snapshot");
	assert.deepEqual(snaps[1].slice(0, 3), ["snapshot", "exit", "dead"]);
	assert.equal(snaps[1][3], (await lastCompleteLineEnd(t.file)), "the exit's offset is the last complete line too");
	assert.equal(w.order.filter((o) => o[0] === "pause").length, 1, "only the live one paused");
	assert.deepEqual(JSON.parse(w.store.get("run:checkpoint:run-1")).seq, 2);
	assert.deepEqual(h.stats(), { written: 2, failed: 0, skipped: 0, lastSeq: 2 });
	// A salvage is an exit by another kind, and a snapshot that skips is returned as skipped with no pointer.
	const w2 = world({ snapshot: async () => ({ skipped: "base-too-large" }) });
	const h2 = makeHandle(w2, { args: { sessionFile: t.file } });
	assert.deepEqual(await h2.exit({ kind: "salvage" }), { skipped: "base-too-large" });
	assert.equal(w2.order[0][1], "salvage");
	assert.equal(w2.store.size, 0);
});

test("close() awaits the live checkpoint in flight, its pointer included, and no live one starts after it", async () => {
	const t = transcript();
	let open;
	const gate = new Promise((r) => (open = r));
	const w = world({ snapshot: async (args) => (await gate, { ok: true, seq: args.seq, manifest: { host: "host-a" } }) });
	const h = makeHandle(w, { args: { sessionFile: t.file }, limits: { minIntervalMs: 0 } });
	h.consume(assistant([]), 0, 1);
	// The offset is read from the file while frozen (real I/O), so wait for the snapshot to be under way.
	for (let i = 0; i < 1000 && w.order.length < 2; i++) await new Promise((r) => setImmediate(r));
	assert.deepEqual(w.order.map((o) => o[0]), ["pause", "snapshot"], "frozen, the snapshot running");
	let closed = null;
	const closing = h.close().then((s) => (closed = s));
	await new Promise((r) => setImmediate(r));
	assert.equal(closed, null, "still waiting on the snapshot");
	open();
	await closing;
	assert.deepEqual(closed, { written: 1, failed: 0, skipped: 0, lastSeq: 1 });
	assert.equal(w.order.at(-1)[0], "pointer", "the pointer landed before close resolved");
	h.consume(assistant([]), 0, 1);
	assert.equal(h.pending(), null);
	assert.deepEqual(await h.close(), closed, "idempotent");
	// Closed before the freeze: the checkpoint that was about to pause does not.
	const w2 = world();
	const h2 = makeHandle(w2, { args: { sessionFile: t.file }, limits: { minIntervalMs: 0 } });
	h2.consume(assistant([]), 0, 1);
	await h2.close();
	assert.deepEqual(w2.order, [], "nothing paused after close");
});

test("the seq continues the run: past the manifest and the pointer, and past a stale-seq answer", async () => {
	const t = transcript();
	const w = world({ manifestSeq: 4 });
	w.store.set("run:checkpoint:run-1", JSON.stringify({ v: 1, host: "host-b", hostQueue: null, seq: 6, attempt: 0, at: 1, jobDir: "job-zz" }));
	let refuseBelow = 9;
	w.checkpointer.snapshot = async (args) => (w.order.push(["snapshot", args.seq]), args.seq <= refuseBelow ? { skipped: "stale-seq" } : { ok: true, seq: args.seq, manifest: { host: "host-a" } });
	const h = makeHandle(w, { args: { sessionFile: t.file, attempt: 2 } });
	const r = await h.exit();
	assert.deepEqual(w.order.filter((o) => o[0] === "snapshot").map((o) => o[1]), [7, 8, 10], "7 is past the pointer's 6, then a growing jump");
	assert.deepEqual(r, { seq: 10 });
	assert.equal(JSON.parse(w.store.get("run:checkpoint:run-1")).attempt, 2);
});

test("never throws into the tailer: a hostile line, a throwing store and a throwing client are absorbed", async () => {
	const t = transcript();
	const w = world();
	w.checkpointer.snapshot = async () => {
		throw new Error("boom");
	};
	w.checkpointer.readManifest = async () => {
		throw new Error("boom");
	};
	w.redis.get = () => {
		throw new Error("boom");
	};
	const h = makeHandle(w, { args: { sessionFile: t.file }, limits: { minIntervalMs: 0 } });
	assert.doesNotThrow(() => h.consume({ get type() { throw new Error("getter"); } }, 0, 1));
	assert.doesNotThrow(() => h.consume(assistant([]), 0, 1));
	const out = await h.pending();
	assert.equal(out.skipped, "internal-error");
	assert.equal(h.stats().failed, 1);
	assert.deepEqual(w.order.map((o) => o[0]), ["pause", "unpause"], "balanced although the snapshot threw");
	assert.deepEqual(await h.exit(), { skipped: "internal-error" });
});

// --- the pointer against a real Valkey ---------------------------------------------------------------------------------

const valkeyUrl = process.env.VALKEY_TEST_URL;
if (!valkeyUrl && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("run-checkpoint tests REQUIRE VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
const live = valkeyUrl ? false : "VALKEY_TEST_URL not set; the pointer needs a real Valkey";

let redis = null;
async function client() {
	if (redis) return redis;
	const { makeRedisClient } = await import("../src/connection.mjs");
	const url = new URL(valkeyUrl);
	url.pathname = "/10";
	redis = makeRedisClient(url.toString());
	redis.on("error", () => {});
	await redis.flushdb();
	return redis;
}
test.after(async () => {
	await redis?.quit().catch(() => {});
});

test("the pointer round trip: written with its TTL, read back validated, removed", { skip: live }, async () => {
	const r = await client();
	const pointer = { v: 1, host: "host-a", hostQueue: "pi-jobs@host-a", seq: 2, attempt: 0, at: Date.parse(AT), jobDir: "job-ab12cd" };
	assert.equal(await readCheckpointPointer({ redis: r, runId: "rt:1" }), null, "none yet");
	assert.equal(await writeCheckpointPointer({ redis: r, runId: "rt:1", pointer }), true);
	assert.deepEqual(await readCheckpointPointer({ redis: r, runId: "rt:1" }), pointer);
	const ttl = await r.pttl("run:checkpoint:rt_1");
	assert.ok(ttl > CHECKPOINT_POINTER_TTL_MS - 60_000 && ttl <= CHECKPOINT_POINTER_TTL_MS, String(ttl));
	assert.equal(await removeCheckpointPointer({ redis: r, runId: "rt:1" }), true);
	assert.equal(await r.exists("run:checkpoint:rt_1"), 0);
	assert.equal(await writeCheckpointPointer({ redis: r, runId: "rt:1", pointer: { ...pointer, jobDir: "../x" } }), false, "an invalid pointer is never written");
	assert.equal(await r.exists("run:checkpoint:rt_1"), 0);
});

test("a malformed pointer reads as null, whatever wrote it", { skip: live }, async () => {
	const r = await client();
	const key = checkpointPointerKey("bad:1");
	for (const raw of ["not json", "null", "[]", JSON.stringify({ v: 1 }), JSON.stringify({ v: 1, host: "h", hostQueue: null, seq: 1, attempt: 0, at: 1, jobDir: "job-a", path: "/etc" }), "x".repeat(5000)]) {
		await r.set(key, raw);
		assert.equal(await readCheckpointPointer({ redis: r, runId: "bad:1" }), null, raw.slice(0, 40));
	}
	await r.hset("run:checkpoint:wrongtype", "a", "b");
	assert.equal(await readCheckpointPointer({ redis: r, runId: "wrongtype" }), null, "a WRONGTYPE reply is null, never a throw");
	assert.equal(await readCheckpointPointer({ redis: null, runId: "x" }), null);
	assert.equal(await removeCheckpointPointer({ redis: null, runId: "x" }), false);
});

test("a live checkpoint's pointer lands in a real Valkey and a recovery reads it back", { skip: live }, async () => {
	const r = await client();
	const t = transcript();
	const w = world();
	const rc = makeRunCheckpointer({ checkpointer: w.checkpointer, redis: r, hostName: "host a!", hostQueue: "pi-jobs@host-a", now: w.clock.now, limits: { minIntervalMs: 0 }, sleep: async () => {} });
	const h = rc.open({ runId: "real:1", attempt: 1, jobDir: "/jobs/job-q1w2e3", workspace: "/w", containerName: "pi-job-real-1", baseSha: SHA, sessionFile: t.file, ...w.verbs });
	w.checkpointer.snapshot = async (args) => ({ ok: true, seq: args.seq, manifest: {} });
	h.consume(assistant([]), 0, t.append(assistant([])));
	await h.pending();
	assert.deepEqual(await readCheckpointPointer({ redis: r, runId: "real:1" }), { v: 1, host: "host_a_", hostQueue: "pi-jobs@host-a", seq: 1, attempt: 1, at: Date.parse(AT), jobDir: "job-q1w2e3" }, "the host normalised as the store normalises it");
});

// --- review round 1: the edges a mutant survived -----------------------------------------------------------------------

test("quiet tracker edges: an empty toolCallId answers no id-less call, and a reset forgets the calls before it", () => {
	const q = makeQuietTracker();
	const idless = { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }, { type: "toolCall", id: "", name: "read" }] } };
	assert.equal(q.take(idless), false);
	assert.equal(q.take(result("")), false, "an empty id matches no synthetic one");
	assert.equal(q.pending, 2);
	assert.equal(q.take(assistant(["c1"])), false);
	q.reset();
	assert.equal(q.take(result("c1")), false, "the call it answers was before the reset");
	assert.equal(q.pending, 0);
});

test("the first live checkpoint waits a full minIntervalMs after open, to the millisecond", async () => {
	const t = transcript();
	const w = world();
	const h = makeHandle(w, { args: { sessionFile: t.file }, limits: { minIntervalMs: 60_000 } });
	h.consume(assistant([]), 0, t.append(assistant([])));
	assert.equal(h.pending(), null, "at open");
	w.clock.advance(59_999);
	h.consume(assistant([]), 0, t.append(assistant([])));
	assert.equal(h.pending(), null, "one millisecond early");
	assert.deepEqual(w.order, []);
	w.clock.advance(1);
	h.consume(assistant([]), 0, t.append(assistant([])));
	assert.deepEqual(await h.pending(), { seq: 1 });
});

test("a commit resets the run of failures: fail, commit, fail, fail does not degrade", async () => {
	const t = transcript();
	const logs = [];
	const answers = [{ skipped: "timeout" }, null, { skipped: "timeout" }, { skipped: "timeout" }, null];
	const w = world({ snapshot: async (args) => answers.shift() ?? { ok: true, seq: args.seq, manifest: { host: "host-a" } } });
	const h = makeHandle(w, { args: { sessionFile: t.file }, limits: { minIntervalMs: 1_000, maxFailures: 3 }, logs });
	for (let i = 0; i < 5; i++) {
		w.clock.advance(3_600_000);
		h.consume(assistant([]), 0, 1);
		assert.ok(h.pending(), `checkpoint ${i + 1} started`);
		await h.pending();
	}
	assert.equal(logs.some(([e]) => e === "checkpoint_degraded"), false);
	assert.deepEqual(h.stats(), { written: 2, failed: 0, skipped: 3, lastSeq: 2 });
});

test("the backoff is capped at 16 times minIntervalMs however many failures", async () => {
	const t = transcript();
	const w = world({ snapshot: async () => ({ skipped: "disk-low" }) });
	const h = makeHandle(w, { args: { sessionFile: t.file }, limits: { minIntervalMs: 1_000, maxFailures: 100 } });
	for (let i = 0; i < 8; i++) {
		w.clock.advance(3_600_000);
		h.consume(assistant([]), 0, 1);
		await h.pending();
	}
	w.clock.advance(15_999);
	h.consume(assistant([]), 0, 1);
	assert.equal(h.pending(), null, "still inside 16 x 1 s");
	w.clock.advance(1);
	h.consume(assistant([]), 0, 1);
	assert.ok(h.pending(), "due at exactly 16 x 1 s, never 2^8 x");
	await h.pending();
});

test("a commit frozen past pauseMaxMs logs checkpoint_pause_long and backs off like a failure", async () => {
	const t = transcript();
	const logs = [];
	let w;
	w = world({ snapshot: async (args) => (w.clock.advance(1_001), { ok: true, seq: args.seq, manifest: { host: "host-a" } }) });
	const h = makeHandle(w, { args: { sessionFile: t.file }, limits: { minIntervalMs: 1_000, pauseMaxMs: 1_000 }, logs });
	w.clock.advance(1_000);
	h.consume(assistant([]), 0, 1);
	assert.deepEqual(await h.pending(), { seq: 1 });
	assert.ok(logs.some(([e, f]) => e === "checkpoint_pause_long" && f.frozenMs === 1_001));
	assert.equal(w.order.at(-1)[0], "pointer", "still committed and published");
	// Backed off to 2 x 1 s from the end of that checkpoint, not the plain interval.
	w.clock.advance(1_999);
	h.consume(assistant([]), 0, 1);
	assert.equal(h.pending(), null);
	w.clock.advance(1);
	h.consume(assistant([]), 0, 1);
	assert.ok(h.pending());
	await h.pending();
	// Exactly at the bound is not long.
	const logs2 = [];
	let w2;
	w2 = world({ snapshot: async (args) => (w2.clock.advance(1_000), { ok: true, seq: args.seq, manifest: { host: "host-a" } }) });
	const h2 = makeHandle(w2, { args: { sessionFile: t.file }, limits: { minIntervalMs: 0, pauseMaxMs: 1_000 }, logs: logs2 });
	h2.consume(assistant([]), 0, 1);
	await h2.pending();
	assert.equal(logs2.some(([e]) => e === "checkpoint_pause_long"), false);
});

test("the pointer's host is the manifest's when it names one, the checkpointer's own otherwise", async () => {
	const t = transcript();
	const w = world({ snapshot: async (args) => ({ ok: true, seq: args.seq, manifest: { host: "store-host" } }) });
	const h = makeHandle(w, { args: { sessionFile: t.file }, limits: { minIntervalMs: 0 } });
	h.consume(assistant([]), 0, 1);
	await h.pending();
	assert.equal(JSON.parse(w.store.get("run:checkpoint:run-1")).host, "store-host");
	const w2 = world({ snapshot: async (args) => ({ ok: true, seq: args.seq }) });
	const h2 = makeHandle(w2, { args: { sessionFile: t.file }, limits: { minIntervalMs: 0 } });
	h2.consume(assistant([]), 0, 1);
	await h2.pending();
	assert.equal(JSON.parse(w2.store.get("run:checkpoint:run-1")).host, "host-a");
});

test("fork archive captures the exact frozen prefix before thaw, and a failed archive does not lose recovery", async () => {
	for (const fails of [false, true]) {
		const tr = transcript();
		tr.append(header());
		const w = world();
		const forkStore = { capturePoint: async (args) => {
			w.order.push(["fork", args.quiesced, args.offset]);
			assert.equal(args.transcriptPath, tr.file);
			if (fails) throw new Error("archive unavailable");
			return { ok: true };
		} };
		const h = makeHandle(w, { args: { sessionFile: tr.file }, forkStore });
		w.clock.advance(60_000);
		const entry = assistant();
		const end = tr.append(entry);
		h.consume(entry, AT, end);
		assert.deepEqual(await h.pending(), { seq: 1 });
		assert.deepEqual(w.order.map((e) => e[0]), ["pause", "snapshot", "fork", "unpause", "pointer"]);
		assert.deepEqual(w.order.find((e) => e[0] === "fork"), ["fork", "frozen", end]);
		await h.close();
	}
});
