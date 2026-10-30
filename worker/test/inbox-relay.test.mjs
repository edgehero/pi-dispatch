import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { inboxFileName, makeInboxRelay, steerTargetOf } from "../src/inbox-relay.mjs";
import { frameMac, keyFrame, STEER_STDIN_BUDGET_BYTES, steerFileJson, steerFrame } from "../src/steer-framing.mjs";
import { steerTargetKey } from "../src/steer-inbox.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #646: the relay that writes a running job's inbox. Driven against an in-memory inbox (the same exports the relay
// calls on steer-inbox.mjs, with the scripts' compare-and-set semantics) and a real directory, one tick at a time.

const T0 = 1_800_000_000_000;
let seq = 0;
const hexId = () => (++seq).toString(16).padStart(32, "a");
const entry = (over = {}) => ({ v: 1, id: hexId(), mode: "steer", source: "cli", author: { kind: "operator", by: "cli" }, text: "please look at the tests first", at: T0, ...over });

/** An in-memory inbox: `entries` in push order, `state` id -> word, and every call recorded. `onMark` can interleave. */
function fakeInbox({ onMark = null, fail = {}, failMark = null } = {}) {
	const entries = [];
	const state = {};
	const calls = [];
	const box = { closed: false };
	return {
		entries,
		state,
		calls,
		box,
		async resetClosedInbox({ runId }) {
			calls.push(["reset", runId]);
			if (fail.reset) return { error: fail.reset };
			if (!box.closed) return { reset: false };
			entries.length = 0;
			for (const k of Object.keys(state)) delete state[k];
			box.closed = false;
			return { reset: true };
		},
		push(e, st = "queued") {
			entries.push(e);
			state[e.id] = st;
			return e;
		},
		async registerLive(args) {
			calls.push(["register", args.runId, args.targetKey, args.host, typeof args.now === "function" ? args.now() : args.now]);
			return fail.register ? { error: fail.register } : { ok: true };
		},
		async refreshLive(args) {
			calls.push(["refresh", args.runId]);
			return fail.refresh ? { error: fail.refresh } : { ok: true };
		},
		async unregisterLive(args) {
			calls.push(["unregister", args.runId, args.targetKey]);
			return { ok: true };
		},
		async holdLive(args) {
			calls.push(["hold", args.runId, args.targetKey, args.host, typeof args.now === "function" ? args.now() : args.now]);
			return fail.hold ? { error: fail.hold } : { held: true };
		},
		async readInbox({ runId }) {
			calls.push(["read", runId]);
			if (fail.read) return { error: fail.read };
			return { entries: entries.map((e) => ({ ...e })), state: { ...state }, count: entries.length, bytes: 0, closed: box.closed };
		},
		async markState({ id, from, to }) {
			calls.push(["mark", id, from.join("|"), to]);
			if (failMark?.({ id, from, to })) return { error: "ECONNRESET" };
			if (onMark) await onMark({ id, from, to, state });
			const cur = state[id] ?? null;
			if (cur !== null && from.includes(cur)) {
				state[id] = to;
				return { ok: true, prior: cur };
			}
			return { ok: false, prior: cur };
		},
	};
}

function relayWith(inbox, over = {}) {
	const dir = tempDir("pi-relay-");
	const logs = [];
	const relay = makeInboxRelay({ redis: {}, runId: "run-1", jobId: "run-1", inboxDir: dir, host: "h1", now: () => T0, log: (e, f) => logs.push([e, f]), pollMs: 3_600_000, inbox, ...over });
	return { relay, dir, logs };
}

const files = (dir) => readdirSync(dir).sort();

test("nothing is written before the tail's baseline; the liveness is registered and refreshed all the same", async () => {
	const inbox = fakeInbox();
	inbox.push(entry());
	const { relay, dir } = relayWith(inbox, { targetKey: steerTargetKey({ kind: "github", repo: "o/r", targetType: "issue", number: 7 }) });
	await relay.start();
	await relay.tick();
	assert.deepEqual(files(dir), [], "no file before the baseline");
	assert.equal(inbox.calls[0][0], "reset", "a closed inbox would be reset first (F1)");
	const reg = inbox.calls[1];
	assert.equal(reg[0], "register");
	assert.equal(reg[3], "h1", "the host name is the open key's value");
	assert.equal(reg[4], T0, "the injected clock reaches the registration");
	assert.ok(inbox.calls.some((c) => c[0] === "refresh"), "every tick refreshes");
	assert.ok(!inbox.calls.some((c) => c[0] === "read"), "and does not even read the inbox");
	await relay.stop();
});

test("after the baseline: every queued message, in order, as <seq>-<id>.json, mode 0444, the contract's five fields", async () => {
	const inbox = fakeInbox();
	const a = inbox.push(entry());
	const b = inbox.push(entry({ mode: "followUp", text: "and then the docs" }));
	const { relay, dir } = relayWith(inbox);
	await relay.start();
	relay.afterBaseline(new Set());
	await relay.tick();
	assert.deepEqual(files(dir), [inboxFileName(0, a.id), inboxFileName(1, b.id)].sort());
	assert.equal(inboxFileName(0, a.id), `000001-${a.id}.json`);
	const body = JSON.parse(readFileSync(join(dir, inboxFileName(1, b.id)), "utf8"));
	assert.deepEqual(Object.keys(body), ["v", "id", "mode", "source", "content"]);
	assert.equal(body.v, 1);
	assert.equal(body.id, b.id);
	assert.equal(body.mode, "followUp");
	assert.equal(body.source, "cli");
	assert.match(body.content, /data, not instructions/);
	assert.match(body.content, /and then the docs/);
	assert.equal(statSync(join(dir, inboxFileName(0, a.id))).mode & 0o777, 0o444, "read-only to everyone");
	assert.equal(inbox.state[a.id], "written");
	assert.equal(inbox.state[b.id], "written");
	assert.equal(relay.counts().written, 2);
	// A second tick writes nothing again.
	await relay.tick();
	assert.equal(relay.counts().written, 2);
	await relay.stop();
});

test("ATOMIC and mark-before-rename: while the mark is in flight only the temporary file exists, never the final name", async () => {
	let seenDuringMark = null;
	let dirRef = null;
	const inbox = fakeInbox({
		onMark: async ({ to }) => {
			if (to === "written") seenDuringMark = files(dirRef);
		},
	});
	const e = inbox.push(entry());
	const { relay, dir } = relayWith(inbox);
	dirRef = dir;
	await relay.start();
	relay.afterBaseline();
	await relay.tick();
	assert.deepEqual(seenDuringMark, [`.${e.id}.tmp`], "the runner's pattern cannot match a file whose mark is not yet taken");
	assert.deepEqual(files(dir), [inboxFileName(0, e.id)]);
	await relay.stop();
});

test("a queued message withdrawn while it is being written never becomes visible (the queued withdrawal is guaranteed)", async () => {
	const inbox = fakeInbox({
		onMark: async ({ id, to, state }) => {
			if (to === "written") state[id] = "withdrawn"; // the operator's withdraw wins the race
		},
	});
	inbox.push(entry());
	const { relay, dir } = relayWith(inbox);
	await relay.start();
	relay.afterBaseline();
	await relay.tick();
	assert.deepEqual(files(dir), [], "neither the final file nor the temporary one is left");
	assert.equal(relay.counts().written, 0);
	await relay.stop();
});

test("withdrawn messages are skipped, and a file whose message was withdrawn or delivered later is unlinked", async () => {
	const inbox = fakeInbox();
	const w = inbox.push(entry(), "withdrawn");
	const a = inbox.push(entry());
	const b = inbox.push(entry());
	const { relay, dir } = relayWith(inbox);
	await relay.start();
	relay.afterBaseline();
	await relay.tick();
	assert.deepEqual(files(dir), [inboxFileName(1, a.id), inboxFileName(2, b.id)], "the withdrawn one is skipped; positions stay the list's");
	assert.ok(!files(dir).some((f) => f.includes(w.id)));
	inbox.state[a.id] = "withdrawn";
	inbox.state[b.id] = "delivered";
	await relay.tick();
	assert.deepEqual(files(dir), []);
	assert.equal(relay.counts().unlinked, 2);
	await relay.stop();
});

test("delivered(id): written (or withdrawn best effort) becomes delivered, and the file goes", async () => {
	const inbox = fakeInbox();
	const a = inbox.push(entry());
	const b = inbox.push(entry());
	const { relay, dir } = relayWith(inbox);
	await relay.start();
	relay.afterBaseline();
	await relay.tick();
	inbox.state[b.id] = "withdrawn"; // withdrawn after it was written: best effort, and the agent read it anyway
	await relay.delivered(a.id);
	await relay.delivered(b.id);
	assert.equal(inbox.state[a.id], "delivered");
	assert.equal(inbox.state[b.id], "delivered", "a verified ack is proof of delivery, whatever the withdrawal hoped");
	assert.deepEqual(files(dir), []);
	assert.equal(relay.counts().delivered, 2);
	await relay.stop();
});

test("REBASELINE: a delivered message the restored transcript does not hold goes back to written and is handed over again", async () => {
	const inbox = fakeInbox();
	const kept = inbox.push(entry(), "delivered");
	const lost = inbox.push(entry(), "delivered");
	const waiting = inbox.push(entry(), "written"); // written by the lost attempt: this attempt's directory is new
	const { relay, dir } = relayWith(inbox);
	await relay.start();
	relay.afterBaseline(new Set([kept.id]));
	await relay.tick();
	assert.equal(inbox.state[kept.id], "delivered", "in the prior transcript: left alone, no file");
	assert.equal(inbox.state[lost.id], "written", "not in it: re-written");
	assert.deepEqual(files(dir), [inboxFileName(1, lost.id), inboxFileName(2, waiting.id)], "both waiting messages are on this attempt's disk");
	assert.equal(relay.counts().rebaselined, 1);
	assert.equal(relay.counts().rewritten, 2, "re-placed without a second mark");
	assert.ok(!inbox.calls.some((c) => c[0] === "mark" && c[1] === waiting.id), "a written message is placed with no state change");
	// The rebaseline happens once: a later delivered message stays delivered.
	inbox.state[lost.id] = "delivered";
	await relay.tick();
	assert.equal(inbox.state[lost.id], "delivered");
	await relay.stop();
});

test("a message the framing refuses is never written: it is answered as late, and said by id", async () => {
	const inbox = fakeInbox();
	const bad = inbox.push(entry({ source: "console", author: { kind: "operator", by: "has spaces!" } }));
	const { relay, dir, logs } = relayWith(inbox);
	await relay.start();
	relay.afterBaseline();
	await relay.tick();
	assert.deepEqual(files(dir), []);
	assert.equal(inbox.state[bad.id], "late");
	assert.deepEqual(logs.find((l) => l[0] === "steer_frame_refused")?.[1], { jobId: "run-1", id: bad.id });
	await relay.stop();
});

test("faults are logged once per step and code, by code only, and never throw; a failed read writes nothing", async () => {
	const inbox = fakeInbox({ fail: { read: "ECONNRESET", refresh: "ETIMEDOUT" } });
	inbox.push(entry({ text: "SECRET-TEXT" }));
	const { relay, dir, logs } = relayWith(inbox);
	await relay.start();
	relay.afterBaseline();
	await relay.tick();
	await relay.tick();
	assert.deepEqual(files(dir), []);
	const faults = logs.filter((l) => l[0] === "steer_relay_fault").map((l) => l[1]);
	assert.deepEqual(faults, [
		{ jobId: "run-1", step: "refresh", code: "ETIMEDOUT" },
		{ jobId: "run-1", step: "read", code: "ECONNRESET" },
	]);
	assert.ok(!JSON.stringify(logs).includes("SECRET-TEXT"), "no text in any line");
	assert.equal(relay.counts().faults, 4, "every fault counted");
	await relay.stop();
});

test("a write the disk refuses leaves the message queued for the next tick", async () => {
	const inbox = fakeInbox();
	const e = inbox.push(entry());
	let refuse = true;
	const realFs = await import("node:fs");
	const fsSeam = {
		writeFileSync: (...a) => {
			if (refuse) throw Object.assign(new Error("full"), { code: "ENOSPC" });
			return realFs.writeFileSync(...a);
		},
		renameSync: realFs.renameSync,
		unlinkSync: realFs.unlinkSync,
	};
	const { relay, dir, logs } = relayWith(inbox, { fs: fsSeam });
	await relay.start();
	relay.afterBaseline();
	await relay.tick();
	assert.equal(inbox.state[e.id], "queued", "not marked: nothing was written");
	assert.ok(logs.some((l) => l[0] === "steer_relay_fault" && l[1].code === "ENOSPC"));
	refuse = false;
	await relay.tick();
	assert.deepEqual(files(dir), [inboxFileName(0, e.id)]);
	await relay.stop();
});

test("the tick is re-entrancy guarded; stop waits for it, HOLDS the liveness keys (F3: never unregisters), and nothing runs after", async () => {
	let release;
	const gate = new Promise((r) => (release = r));
	const inbox = fakeInbox();
	const slowRefresh = inbox.refreshLive.bind(inbox);
	let refreshes = 0;
	inbox.refreshLive = async (args) => {
		refreshes += 1;
		await gate;
		return slowRefresh(args);
	};
	const { relay } = relayWith(inbox);
	await relay.start();
	const first = relay.tick();
	const second = relay.tick();
	assert.equal(first, second, "a tick in flight is returned, not doubled");
	const stopping = relay.stop();
	release();
	await stopping;
	assert.equal(refreshes, 1);
	assert.deepEqual(inbox.calls.at(-1), ["hold", "run-1", null, "h1", T0], "held, with the relay's host and clock");
	assert.equal(inbox.calls.some(([c]) => c === "unregister"), false, "the run stays reachable until its settle closes it");
	await relay.tick();
	assert.equal(refreshes, 1, "no tick after stop");
	relay.afterBaseline();
	assert.equal(refreshes, 1);
});

test("steerTargetOf: a forge job's pointer, ref and forge word; none for a local or cron job", () => {
	const gh = steerTargetOf({ kind: "github", repo: "o/r", target: { type: "pull_request", number: 12 } });
	assert.equal(gh.targetKey, steerTargetKey({ kind: "github", repo: "o/r", targetType: "pull_request", number: 12 }));
	assert.equal(gh.ref, "PR #12");
	assert.equal(gh.forge, "github");
	assert.equal(steerTargetOf({ kind: "github", repo: "o/r", target: { type: "issue", number: "7" } }).ref, "issue #7");
	assert.equal(steerTargetOf({ kind: "gitlab", repo: "g/p", target: { type: "pull_request", number: 3 } }).ref, "merge request !3");
	assert.equal(steerTargetOf({ kind: "azure", repo: "a/b", target: { type: "issue", number: 4 } }).ref, "work item #4");
	assert.deepEqual(steerTargetOf({ kind: "local", folder: "/x" }), { targetKey: null, ref: null, forge: null });
	assert.deepEqual(steerTargetOf(null), { targetKey: null, ref: null, forge: null });
	assert.equal(steerTargetOf({ kind: "github", repo: "o/r", target: { type: "issue", number: "7; rm" } }).targetKey, null, "a number that is not one names no target");
});

test("an existing temporary file from an earlier failure is replaced, not refused", async () => {
	const inbox = fakeInbox();
	const e = inbox.push(entry());
	const { relay, dir } = relayWith(inbox);
	const { writeFileSync } = await import("node:fs");
	writeFileSync(join(dir, `.${e.id}.tmp`), "stale");
	await relay.start();
	relay.afterBaseline();
	await relay.tick();
	assert.deepEqual(files(dir), [inboxFileName(0, e.id)]);
	assert.ok(!existsSync(join(dir, `.${e.id}.tmp`)));
	await relay.stop();
});

// --- review round 1 ------------------------------------------------------------------------------------------------

test("F1: a closed inbox under the run id (a console retry keeps the job id) is reset before the run registers; old deliveries are never re-handed", async () => {
	const inbox = fakeInbox();
	const old = inbox.push(entry(), "delivered");
	inbox.push(entry(), "late");
	inbox.box.closed = true;
	const { relay, dir, logs } = relayWith(inbox);
	await relay.start();
	assert.deepEqual(inbox.calls.slice(0, 2).map((c) => c[0]), ["reset", "register"], "reset first, then registered");
	assert.ok(logs.some(([e]) => e === "steer_inbox_reset"));
	relay.afterBaseline(new Set());
	await relay.tick();
	assert.equal(inbox.state[old.id], undefined, "the old run's messages are gone, not moved back to written");
	assert.deepEqual(files(dir), []);
	assert.equal(relay.counts().rebaselined, 0);
	// The new run's own message is written as any other.
	const fresh = inbox.push(entry());
	await relay.tick();
	assert.deepEqual(files(dir), [inboxFileName(0, fresh.id)]);
	await relay.stop();
});

test("F1: a closed inbox the reset could not reopen is never written into nor re-baselined, and is said once", async () => {
	const inbox = fakeInbox({ fail: { reset: "ETIMEDOUT" } });
	const old = inbox.push(entry(), "delivered");
	const waiting = inbox.push(entry(), "written");
	inbox.box.closed = true;
	const { relay, dir, logs } = relayWith(inbox);
	await relay.start();
	relay.afterBaseline(new Set());
	await relay.tick();
	await relay.tick();
	assert.equal(inbox.state[old.id], "delivered");
	assert.equal(inbox.state[waiting.id], "written");
	assert.deepEqual(files(dir), []);
	assert.ok(!inbox.calls.some((c) => c[0] === "mark"));
	assert.equal(logs.filter(([e]) => e === "steer_inbox_closed").length, 1);
	assert.ok(logs.some(([e, f]) => e === "steer_relay_fault" && f.step === "reset" && f.code === "ETIMEDOUT"));
	await relay.stop();
});

test("F1: an OPEN inbox (a recovery, an InfraRetry) is not reset", async () => {
	const inbox = fakeInbox();
	const kept = inbox.push(entry(), "delivered");
	const { relay } = relayWith(inbox);
	await relay.start();
	relay.afterBaseline(new Set([kept.id]));
	await relay.tick();
	assert.equal(inbox.state[kept.id], "delivered");
	assert.ok(!relay.counts().faults);
	await relay.stop();
});

test("F5: a waiting message whose verified ack is in the staged transcript is marked delivered at the baseline, never re-written", async () => {
	const inbox = fakeInbox();
	const acked = inbox.push(entry(), "written");
	const queued = inbox.push(entry(), "queued");
	const { relay, dir } = relayWith(inbox);
	await relay.start();
	relay.afterBaseline(new Set([acked.id, queued.id]), new Set([acked.id, queued.id]));
	await relay.tick();
	assert.equal(inbox.state[acked.id], "delivered");
	assert.equal(inbox.state[queued.id], "delivered");
	assert.deepEqual(files(dir), []);
	assert.equal(relay.counts().delivered, 2);
	await relay.stop();
});

test("R04: a mark fault during the rebaseline writes no file and takes no written mark that tick; the next tick finishes it", async () => {
	let failing = true;
	const inbox = fakeInbox({ failMark: ({ to }) => failing && to === "written" });
	const lost = inbox.push(entry(), "delivered");
	const fresh = inbox.push(entry());
	const { relay, dir } = relayWith(inbox);
	await relay.start();
	relay.afterBaseline(new Set());
	await relay.tick();
	assert.deepEqual(files(dir), [], "nothing written while the rebaseline is unfinished");
	assert.equal(inbox.state[fresh.id], "queued", "no written mark");
	assert.equal(inbox.state[lost.id], "delivered");
	failing = false;
	await relay.tick();
	assert.equal(inbox.state[lost.id], "written", "the rebaseline is retried before any write");
	assert.deepEqual(files(dir), [inboxFileName(0, lost.id), inboxFileName(1, fresh.id)]);
	await relay.stop();
});

test("R14: a file already on disk is not placed again: one write over several ticks", async () => {
	const inbox = fakeInbox();
	const e = inbox.push(entry());
	let writes = 0;
	const realFs = await import("node:fs");
	const fsSeam = { writeFileSync: (...a) => (writes++, realFs.writeFileSync(...a)), renameSync: realFs.renameSync, unlinkSync: realFs.unlinkSync };
	const { relay, dir } = relayWith(inbox, { fs: fsSeam });
	await relay.start();
	relay.afterBaseline();
	for (let i = 0; i < 4; i++) await relay.tick();
	assert.equal(writes, 1);
	assert.equal(relay.counts().written, 1);
	assert.equal(relay.counts().rewritten, 0);
	assert.deepEqual(files(dir), [inboxFileName(0, e.id)]);
	await relay.stop();
});

test("R12: a late message's file is unlinked", async () => {
	const inbox = fakeInbox();
	const e = inbox.push(entry());
	const { relay, dir } = relayWith(inbox);
	await relay.start();
	relay.afterBaseline();
	await relay.tick();
	assert.deepEqual(files(dir), [inboxFileName(0, e.id)]);
	inbox.state[e.id] = "late";
	await relay.tick();
	assert.deepEqual(files(dir), []);
	assert.equal(relay.counts().unlinked, 1);
	await relay.stop();
});

test("R26: a rebaseline whose compare-and-set lost counts nothing and writes nothing for that message", async () => {
	const inbox = fakeInbox({
		onMark: async ({ id, to, state }) => {
			if (to === "written") state[id] = "withdrawn"; // moved by someone else between the read and the mark
		},
	});
	const e = inbox.push(entry(), "delivered");
	const { relay, dir } = relayWith(inbox);
	await relay.start();
	relay.afterBaseline(new Set());
	await relay.tick();
	assert.equal(relay.counts().rebaselined, 0);
	assert.equal(inbox.state[e.id], "withdrawn");
	assert.deepEqual(files(dir), []);
	await relay.stop();
});

test("R19: a second afterBaseline has no effect: the first prior set rules", async () => {
	const inbox = fakeInbox();
	const e = inbox.push(entry(), "delivered");
	const { relay, dir } = relayWith(inbox);
	await relay.start();
	relay.afterBaseline(new Set());
	relay.afterBaseline(new Set([e.id]));
	await relay.tick();
	await relay.tick();
	assert.equal(inbox.state[e.id], "written", "re-baselined against the FIRST (empty) prior set");
	assert.deepEqual(files(dir), [inboxFileName(0, e.id)]);
	await relay.stop();
});

test("F3: a failed hold at stop is a logged fault by code, never a throw", async () => {
	const inbox = fakeInbox();
	inbox.holdLive = async () => ({ error: "ECONNRESET" });
	const { relay, logs } = relayWith(inbox);
	await relay.start();
	await relay.stop();
	assert.ok(logs.some(([e, f]) => e === "steer_relay_fault" && f.step === "hold" && f.code === "ECONNRESET"));
	const never = fakeInbox();
	const quiet = relayWith(never);
	await quiet.relay.stop();
	assert.equal(never.calls.some(([c]) => c === "hold"), false, "a relay that never started holds nothing");
});

// --- issue #686: the stdin frame transport ---------------------------------------------------------------------------

/** The exec's stdin as the relay sees it: records every write; `full` makes a write answer false until `drain`. */
function fakeStdin({ full = false } = {}) {
	const ee = new EventEmitter();
	const s = Object.assign(ee, {
		chunks: [],
		ended: false,
		full,
		write(buf) {
			s.chunks.push(Buffer.from(buf));
			return !s.full;
		},
		end() {
			s.ended = true;
		},
	});
	return s;
}
const FKEY = "ab".repeat(32);
const framesOf = (stdin) => {
	const all = Buffer.concat(stdin.chunks);
	const out = [];
	for (let off = 0; off < all.length; ) {
		const n = all.readUInt32BE(off);
		out.push(JSON.parse(all.subarray(off + 4, off + 4 + n).toString("utf8")));
		off += 4 + n;
	}
	return out;
};
function framedRelay(inbox, over = {}) {
	const logs = [];
	const relay = makeInboxRelay({ redis: {}, runId: "run-1", jobId: "run-1", inboxDir: null, host: "h1", now: () => T0, log: (e, f) => logs.push([e, f]), pollMs: 3_600_000, inbox, frames: { exitKey: FKEY, macRunId: "pi-job-run-1" }, ...over });
	return { relay, logs };
}

test("frames: after the baseline every queued message is one frame on stdin, seq from 2, marked written BEFORE the write, MAC'd under the key (#686)", async () => {
	const inbox = fakeInbox();
	const a = inbox.push(entry());
	const b = inbox.push(entry({ mode: "followUp" }));
	const stdin = fakeStdin();
	const { relay } = framedRelay(inbox);
	relay.attach(stdin, { written: keyFrame(FKEY).length });
	await relay.start();
	await relay.tick();
	assert.equal(stdin.chunks.length, 0, "nothing before the baseline");
	relay.afterBaseline(new Set());
	await relay.tick();
	const frames = framesOf(stdin);
	assert.deepEqual(frames.map((f) => [f.t, f.seq, f.id, f.mode]), [["steer", 2, a.id, "steer"], ["steer", 3, b.id, "followUp"]]);
	for (const f of frames) assert.equal(f.mac, frameMac(FKEY, "pi-job-run-1", f.seq, JSON.stringify({ v: f.v, id: f.id, mode: f.mode, source: f.source, content: f.content })));
	// The mark came first: the write happened only after `queued -> written` succeeded.
	const marks = inbox.calls.filter((c) => c[0] === "mark").map((c) => c.slice(1));
	assert.deepEqual(marks, [[a.id, "queued", "written"], [b.id, "queued", "written"]]);
	assert.deepEqual([inbox.state[a.id], inbox.state[b.id]], ["written", "written"]);
	await relay.tick();
	assert.equal(framesOf(stdin).length, 2, "never written twice in one attempt");
	await relay.stop();
	assert.equal(stdin.ended, true, "the stop closes stdin: EOF, no more messages");
});

test("frames: a message withdrawn while queued is never written; a WITHDRAW of a written one unlinks nothing and its ack still delivers (#686)", async () => {
	const inbox = fakeInbox({ onMark: async ({ id, to, state }) => { if (to === "written" && id === first.id) state[id] = "withdrawn"; } });
	const first = inbox.push(entry());
	const second = inbox.push(entry());
	const stdin = fakeStdin();
	const { relay } = framedRelay(inbox);
	relay.attach(stdin);
	await relay.start();
	relay.afterBaseline(new Set());
	await relay.tick();
	assert.deepEqual(framesOf(stdin).map((f) => f.id), [second.id], "the withdrawn one never reached the pipe");
	inbox.state[second.id] = "withdrawn"; // the sender's WITHDRAW of a `written` message: best effort
	await relay.tick();
	assert.equal(framesOf(stdin).length, 1, "nothing is written or taken back");
	await relay.delivered(second.id);
	assert.equal(inbox.state[second.id], "delivered", "the verified ack is proof the agent got it");
	await relay.stop();
});

test("frames: the budget, prefixes and the key frame counted; a frame past it is refused (late, steer_frame_refused), never cut (#686)", async () => {
	const inbox = fakeInbox();
	const fits = inbox.push(entry());
	const over = inbox.push(entry({ text: "x".repeat(4000) }));
	const after = inbox.push(entry());
	const stdin = fakeStdin();
	const body = steerFileJson({ entry: fits });
	const one = steerFrame({ exitKey: FKEY, runId: "pi-job-run-1", seq: 2, body }).length;
	const key = keyFrame(FKEY).length;
	// Room for the key frame and two small frames, never the large one between them.
	const { relay, logs } = framedRelay(inbox, { frames: { exitKey: FKEY, macRunId: "pi-job-run-1", budget: key + 2 * one + 10 } });
	relay.attach(stdin, { written: key });
	await relay.start();
	relay.afterBaseline(new Set());
	await relay.tick();
	assert.deepEqual(framesOf(stdin).map((f) => [f.id, f.seq]), [[fits.id, 2], [after.id, 3]], "the refused one takes no seq");
	assert.equal(inbox.state[over.id], "late");
	assert.deepEqual(logs.filter(([e]) => e === "steer_frame_refused"), [["steer_frame_refused", { jobId: "run-1", id: over.id }]]);
	assert.ok(!JSON.stringify(logs).includes("xxxx"), "never the text");
	assert.equal(STEER_STDIN_BUDGET_BYTES, 4 * 1024 * 1024 - 1024, "the default is the measured cap less its margin");
	await relay.stop();
});

test("frames: backpressure is waited out on drain, the stop releases a wait on a pipe nobody reads, and an EPIPE never throws (#686)", async () => {
	const inbox = fakeInbox();
	const a = inbox.push(entry());
	const b = inbox.push(entry());
	const stdin = fakeStdin({ full: true });
	const { relay, logs } = framedRelay(inbox);
	relay.attach(stdin);
	await relay.start();
	relay.afterBaseline(new Set());
	const pass = relay.tick();
	await new Promise((r) => setImmediate(r));
	assert.equal(stdin.chunks.length, 1, "the second frame waits for the pipe");
	stdin.full = false;
	stdin.emit("drain");
	await pass;
	assert.deepEqual(framesOf(stdin).map((f) => f.id), [a.id, b.id]);
	// A wait the stop must release: a full pipe and a new message.
	inbox.push(entry());
	stdin.full = true;
	const stuck = relay.tick();
	await new Promise((r) => setImmediate(r));
	await relay.stop();
	await stuck;
	// EPIPE: the exec is gone. Caught on the stream, logged once by step, never thrown.
	const inbox2 = fakeInbox();
	inbox2.push(entry());
	const dead = fakeStdin();
	dead.write = () => {
		throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
	};
	const r2 = framedRelay(inbox2);
	r2.relay.attach(dead);
	dead.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
	await r2.relay.start();
	r2.relay.afterBaseline(new Set());
	await r2.relay.tick();
	await r2.relay.stop();
	assert.ok(r2.logs.some(([e, f]) => e === "steer_relay_fault" && f.step === "stdin" && f.code === "EPIPE"));
	assert.ok(!logs.some(([e]) => e === "steer_relay_fault"));
});

test("frames: an unattached relay writes nothing and a stopped one closes a pipe handed to it at once; the file transport ignores attach (#686)", async () => {
	const inbox = fakeInbox();
	inbox.push(entry());
	const { relay } = framedRelay(inbox);
	await relay.start();
	relay.afterBaseline(new Set());
	await relay.tick();
	assert.equal(inbox.calls.filter((c) => c[0] === "mark").length, 0, "no pipe yet: nothing marked, the message stays queued");
	await relay.stop();
	const late = fakeStdin();
	relay.attach(late);
	assert.equal(late.ended, true);
	const fileInbox = fakeInbox();
	fileInbox.push(entry());
	const { relay: fileRelay, dir } = relayWith(fileInbox);
	const ignored = fakeStdin();
	fileRelay.attach(ignored);
	await fileRelay.start();
	fileRelay.afterBaseline(new Set());
	await fileRelay.tick();
	assert.equal(ignored.chunks.length, 0);
	assert.equal(files(dir).length, 1, "the mount transport is untouched");
	await fileRelay.stop();
	assert.equal(ignored.ended, false);
});

test("frames: the budget fits EXACTLY on the worker's side: a frame ending at the budget is written, one byte less refuses it (L7)", async () => {
	for (const [slack, written] of [[0, true], [-1, false]]) {
		const inbox = fakeInbox();
		const e = inbox.push(entry());
		const stdin = fakeStdin();
		const one = steerFrame({ exitKey: FKEY, runId: "pi-job-run-1", seq: 2, body: steerFileJson({ entry: e }) }).length;
		const key = keyFrame(FKEY).length;
		const { relay } = framedRelay(inbox, { frames: { exitKey: FKEY, macRunId: "pi-job-run-1", budget: key + one + slack } });
		relay.attach(stdin, { written: key });
		await relay.start();
		relay.afterBaseline(new Set());
		await relay.tick();
		assert.equal(framesOf(stdin).length, written ? 1 : 0, `slack ${slack}`);
		assert.equal(inbox.state[e.id], written ? "written" : "late", `slack ${slack}`);
		await relay.stop();
	}
});

test("frames: no pass before start has reset and registered; a baseline that came first is acted on when start is done (L6)", async () => {
	let releaseReset;
	const inbox = fakeInbox();
	const e = inbox.push(entry());
	const reset = inbox.resetClosedInbox;
	inbox.resetClosedInbox = (args) => new Promise((r) => (releaseReset = () => r(reset(args))));
	const stdin = fakeStdin();
	const { relay } = framedRelay(inbox);
	relay.attach(stdin);
	const starting = relay.start();
	relay.afterBaseline(new Set()); // the stdin transport's release at the spawn, before the reset resolved
	await relay.tick();
	assert.equal(inbox.calls.some((c) => c[0] === "read" || c[0] === "mark"), false, "nothing read or written into a possibly closed inbox");
	releaseReset();
	await starting;
	// No manual tick, and the poll an hour away: only start's own pass for the baseline that came first can write it.
	for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
	assert.deepEqual(framesOf(stdin).map((f) => f.id), [e.id], "written by start's pass once it was ready");
	assert.deepEqual(inbox.calls.map((c) => c[0]).slice(0, 2), ["reset", "register"]);
	await relay.stop();
});

test("frames: closeStdin ends the pipe at once and the relay goes on marking acks; later messages are not written (M1)", async () => {
	const inbox = fakeInbox();
	const a = inbox.push(entry());
	const stdin = fakeStdin();
	const { relay } = framedRelay(inbox);
	relay.attach(stdin);
	await relay.start();
	relay.afterBaseline(new Set());
	await relay.tick();
	relay.closeStdin();
	assert.equal(stdin.ended, true);
	const later = inbox.push(entry());
	await relay.tick();
	assert.equal(framesOf(stdin).length, 1, "nothing after the close");
	assert.equal(inbox.state[later.id], "queued", "never marked written: it settles late at the inbox's close");
	await relay.delivered(a.id);
	assert.equal(inbox.state[a.id], "delivered");
	await relay.stop();
});

test("touch provenance follows verified delivery only, once per inbox transition and without message text", async () => {
	const inbox = fakeInbox();
	const a = inbox.push(entry());
	const writes = [];
	const { relay } = relayWith(inbox, { onDelivered: async (event) => writes.push(event) });
	await relay.start(); relay.afterBaseline(); await relay.tick();
	assert.equal(writes.length, 0, "queued or written messages have not intervened in the run");
	await relay.delivered(a.id);
	await relay.delivered(a.id);
	assert.deepEqual(writes, [{ runId: "run-1", id: a.id, at: T0 }]);
	assert.ok(!JSON.stringify(writes).includes(a.text));
	await relay.stop();
});
