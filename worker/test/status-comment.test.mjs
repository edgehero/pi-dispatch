import assert from "node:assert/strict";
import { test } from "node:test";
import { commentIdOf, isStatusCommentId, makeStatusCommenter, makeStatusCommentRegistry, renderStatusText, STATUS_FALLBACK_MS, STATUS_LATE_SETTLE_MAX, STATUS_LATE_SETTLE_MS, STATUS_OUTCOMES, STATUS_RETRYING } from "../src/status-comment.mjs";

/** A fake clock and timer pair: `advance(ms)` moves the clock and fires every timer that came due, in order. */
function fakeClock(start = 1_000_000) {
	let t = start;
	let seq = 0;
	const timers = new Map();
	const clock = {
		now: () => t,
		setTimer(fn, ms) {
			const id = ++seq;
			timers.set(id, { fn, at: t + Math.max(0, ms) });
			return id;
		},
		clearTimer(id) {
			timers.delete(id);
		},
		pending: () => timers.size,
		async advance(ms) {
			const until = t + ms;
			for (;;) {
				const due = [...timers.entries()].filter(([, v]) => v.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				timers.delete(due[0]);
				t = due[1].at;
				due[1].fn();
				await flush();
			}
			t = until;
			await flush();
		},
	};
	return clock;
}

const flush = async () => {
	for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

/** A forge double: records posts and edits, answers what each test sets. */
function fakeForge({ postId = "100", editAnswer = () => ({ ok: true }) } = {}) {
	const forge = {
		posts: [],
		edits: [],
		async post(text) {
			forge.posts.push(text);
			return postId === null ? null : { id: postId };
		},
		async edit(id, text) {
			forge.edits.push({ id, text });
			return editAnswer(forge.edits.length);
		},
	};
	return forge;
}

function commenter(clock, forge, extra = {}) {
	const logs = [];
	const ids = [];
	const c = makeStatusCommenter({
		jobId: "job-1",
		post: forge.post,
		edit: forge.edit,
		onId: (id) => ids.push(id),
		now: clock.now,
		log: (event, fields) => logs.push({ event, ...fields }),
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
		...extra,
	});
	return { c, logs, ids };
}

const snap = (turn, steps = 0, more = {}) => ({ v: 1, turn, steps, failed: 0, ...more });

// --- the text ---

test("the running text is fixed words, the sanitized id and integers", () => {
	const text = renderStatusText({
		jobId: "abc",
		snapshot: { turn: 7, steps: 12, failed: 1, phase: { index: 1, done: 3, total: 10 }, phases: ["a", "b", "c", "d"] },
	});
	assert.equal(text, "pi-dispatch job `abc`: running. Turn 7, 12 steps (1 failed). Phase 2 of 4 (3/10).");
});

test("the final text names the outcome, and an unknown outcome is written as unknown", () => {
	assert.equal(renderStatusText({ jobId: "abc", snapshot: snap(3, 1), outcome: "completed" }), "pi-dispatch job `abc`: finished: completed. Turn 3, 1 step.");
	assert.match(renderStatusText({ jobId: "abc", snapshot: { turn: 1, steps: 2, interrupted: 1 }, outcome: "nonsense <b>" }), /finished: unknown\. Turn 1, 2 steps \(1 interrupted\)\.$/);
});

test("no phase name, note or tool name ever reaches the text, however hostile", () => {
	const hostile = "@everyone see https://evil.example/x `rm` ‮";
	const snapshot = {
		turn: 2,
		steps: 3,
		failed: 1,
		running: [{ tool: hostile, since: 1 }],
		recent: [{ tool: hostile, status: "ok", durationMs: 5, at: 1 }],
		phase: { index: 0, done: 1, total: 2 },
		phases: [hostile],
		note: hostile,
	};
	for (const outcome of [undefined, "failed"]) {
		const text = renderStatusText({ jobId: "job-1", snapshot, outcome });
		for (const needle of ["@", "http", "evil", "rm", "‮", "everyone"]) assert.ok(!text.includes(needle), `${needle} leaked into ${JSON.stringify(text)}`);
		assert.match(text, /^pi-dispatch job `[A-Za-z0-9._-]+`: [a-z :]+\. Turn \d+, \d+ steps? \(\d+ failed\)\. Phase \d+ of \d+ \(\d+\/\d+\)\.$/);
	}
});

test("the job id is sanitized before it goes between backticks", () => {
	const text = renderStatusText({ jobId: "x`@y <b>\n", snapshot: snap(0) });
	assert.equal(text, "pi-dispatch job `x__y__b__`: running. Turn 0, 0 steps.");
});

test("a non-integer counter is written as 0, never copied", () => {
	const text = renderStatusText({ jobId: "j", snapshot: { turn: "7 <x>", steps: -1, failed: 1.5, phase: { index: "1" } } });
	assert.equal(text, "pi-dispatch job `j`: running. Turn 0, 0 steps.");
	assert.equal(renderStatusText({ jobId: null, snapshot: null }), "pi-dispatch job `unknown-job`: running. Turn 0, 0 steps.");
});

test("comment ids: the charset and length are held, integers become strings", () => {
	assert.equal(isStatusCommentId("88:1"), true);
	assert.equal(isStatusCommentId("wi:4021"), true);
	assert.equal(isStatusCommentId("a".repeat(200)), true);
	for (const bad of ["", "a".repeat(201), "1/2", "1 2", "..", 5, null]) assert.equal(isStatusCommentId(bad), false, String(bad));
	assert.equal(commentIdOf(42), "42");
	assert.equal(commentIdOf(-1), null);
	assert.equal(commentIdOf(1.5), null);
	assert.equal(commentIdOf("x/y"), null);
});

// --- the commenter ---

test("start posts one comment and hands its id to onId", async () => {
	const clock = fakeClock();
	const forge = fakeForge();
	const { c, ids } = commenter(clock, forge);
	c.start(snap(0));
	await flush();
	assert.equal(forge.posts.length, 1);
	assert.match(forge.posts[0], /: running\. Turn 0, 0 steps\.$/);
	assert.deepEqual(ids, ["100"]);
	assert.equal(c.commentId(), "100");
});

test("a retry edits the comment it was given instead of posting a second one", async () => {
	const clock = fakeClock();
	const forge = fakeForge();
	const { c, ids } = commenter(clock, forge, { commentId: "88:1" });
	c.start(snap(1));
	await flush();
	assert.equal(forge.posts.length, 0);
	assert.deepEqual(forge.edits.map((e) => e.id), ["88:1"]);
	assert.deepEqual(ids, [], "a known id is not reported again");
	assert.equal(c.commentId(), "88:1");
});

test("updates are throttled to one edit an interval, and the trailing edit carries the latest snapshot", async () => {
	const clock = fakeClock();
	const forge = fakeForge();
	const { c } = commenter(clock, forge, { intervalMs: 30_000 });
	c.start(snap(0));
	await flush();
	c.update(snap(1));
	c.update(snap(2));
	await clock.advance(10_000);
	c.update(snap(3));
	assert.equal(forge.edits.length, 0, "nothing before the interval");
	await clock.advance(19_999);
	assert.equal(forge.edits.length, 0);
	await clock.advance(1);
	assert.equal(forge.edits.length, 1);
	assert.match(forge.edits[0].text, /Turn 3,/, "the trailing edit is the latest snapshot");
	c.update(snap(4));
	await clock.advance(29_999);
	assert.equal(forge.edits.length, 1);
	await clock.advance(1);
	assert.equal(forge.edits.length, 2);
	assert.match(forge.edits[1].text, /Turn 4,/);
});

test("an update whose text did not change schedules nothing", async () => {
	const clock = fakeClock();
	const forge = fakeForge();
	const { c } = commenter(clock, forge);
	c.start(snap(1, 2));
	await flush();
	// A note or phase name change alone does not change the text.
	c.update(snap(1, 2, { note: "new note", phases: ["x"] }));
	assert.equal(clock.pending(), 0);
	await clock.advance(120_000);
	assert.equal(forge.edits.length, 0);
});

test("edits stop at maxEdits, keeping the last one for the outcome", async () => {
	const clock = fakeClock();
	const forge = fakeForge();
	const { c, logs } = commenter(clock, forge, { intervalMs: 10, maxEdits: 3 });
	c.start(snap(0));
	await flush();
	for (let i = 1; i <= 6; i++) {
		c.update(snap(i));
		await clock.advance(10);
	}
	assert.equal(forge.edits.length, 2, "maxEdits - 1 progress edits");
	assert.equal(logs.filter((l) => l.event === "status_comment_capped").length, 1);
	await c.finish(snap(9), "completed");
	assert.equal(forge.edits.length, 3);
	assert.match(forge.edits[2].text, /finished: completed/);
});

for (const reason of ["403", "404", "http-403", "http-404"]) {
	test(`a {stop} answer (${reason}) ends editing for the run and is logged by job id and reason`, async () => {
		const clock = fakeClock();
		const forge = fakeForge({ editAnswer: () => ({ stop: reason }) });
		const { c, logs } = commenter(clock, forge, { intervalMs: 10 });
		c.start(snap(0));
		await flush();
		c.update(snap(1));
		await clock.advance(10);
		assert.equal(forge.edits.length, 1);
		c.update(snap(2));
		await clock.advance(100);
		await c.finish(snap(3), "failed");
		assert.equal(forge.edits.length, 1, "no edit after a stop, the final one included");
		assert.deepEqual(logs.filter((l) => l.event === "status_comment_stopped"), [{ event: "status_comment_stopped", jobId: "job-1", reason }]);
		assert.ok(!JSON.stringify(logs).includes("Turn"), "logs never carry the text");
	});
}

for (const reason of ["429", "http-429"]) {
	test(`a rate-limit stop (${reason}) ends the progress edits but not the final one`, async () => {
		const clock = fakeClock();
		const forge = fakeForge({ editAnswer: (n) => (n === 1 ? { stop: reason } : { ok: true }) });
		const { c, logs } = commenter(clock, forge, { intervalMs: 10 });
		c.start(snap(0));
		await flush();
		c.update(snap(1));
		await clock.advance(10);
		c.update(snap(2));
		await clock.advance(100);
		assert.equal(forge.edits.length, 1, "no progress edit after the 429");
		await c.finish(snap(3), "completed");
		assert.equal(forge.edits.length, 2);
		assert.match(forge.edits[1].text, /finished: completed/, "the comment does not say running after the run");
		assert.equal(logs.filter((l) => l.event === "status_comment_stopped").length, 1);
	});
}

test("the final edit is tried once more after a short pause on a failure or a 429, inside finalTimeoutMs", async () => {
	for (const first of [{ ok: false }, { stop: "http-429" }, undefined]) {
		const clock = fakeClock();
		const forge = fakeForge({ editAnswer: (n) => (n === 1 ? first : { ok: true }) });
		const { c } = commenter(clock, forge, { finalTimeoutMs: 4_000, finalRetryMs: 1_000 });
		c.start(snap(0));
		await flush();
		let done = false;
		const p = c.finish(snap(2), "failed").then(() => (done = true));
		await flush();
		assert.equal(forge.edits.length, 1);
		assert.equal(done, false, "waiting out the pause");
		await clock.advance(1_000);
		await p;
		assert.equal(forge.edits.length, 2, `retried after ${JSON.stringify(first)}`);
		assert.equal(forge.edits[1].text, forge.edits[0].text);
	}
	// Twice failed is the end of it: two attempts, never a third, and finish still returns.
	const clock = fakeClock();
	const forge = fakeForge({ editAnswer: () => ({ ok: false }) });
	const { c } = commenter(clock, forge, { finalRetryMs: 1_000 });
	c.start(snap(0));
	await flush();
	const p = c.finish(snap(2), "failed");
	await flush();
	await clock.advance(5_000);
	await p;
	assert.equal(forge.edits.length, 2);
	// A 403 on the final edit is not retried: the token may not edit the comment.
	const c403 = fakeClock();
	const f403 = fakeForge({ editAnswer: () => ({ stop: "http-403" }) });
	const { c: k } = commenter(c403, f403, { finalRetryMs: 1_000 });
	k.start(snap(0));
	await flush();
	const q = k.finish(snap(2), "failed");
	await flush();
	await c403.advance(5_000);
	await q;
	assert.equal(f403.edits.length, 1);
});

test("the retry text says the attempt ended and is being retried, never finished", () => {
	assert.equal(STATUS_RETRYING, "retrying");
	assert.deepEqual([...STATUS_OUTCOMES], ["completed", "policy", "failed", "unknown", "retrying"]);
	assert.equal(renderStatusText({ jobId: "j", snapshot: snap(3, 2), outcome: STATUS_RETRYING }), "pi-dispatch job `j`: attempt ended, retrying. Turn 3, 2 steps.");
});

test("the registry: the record's outcome makes the final edit, with the snapshot the container ended on", async () => {
	const clock = fakeClock();
	const forge = fakeForge();
	const reg = makeStatusCommentRegistry({ setTimer: clock.setTimer, clearTimer: clock.clearTimer });
	const { c } = commenter(clock, forge);
	const w = reg.register("job-1", c);
	w.start(snap(0));
	await flush();
	// An OOM kill: the exit said unknown, the record says policy.
	w.ended(snap(4, 3, { interrupted: 1 }), "unknown");
	assert.equal(reg.size(), 1);
	await reg.settle("job-1", "policy");
	assert.equal(forge.edits.at(-1).text, "pi-dispatch job `job-1`: finished: policy. Turn 4, 3 steps (1 interrupted).");
	assert.equal(reg.size(), 0, "the entry is gone");
	assert.equal(clock.pending(), 0, "and its fallback with it");
	await clock.advance(STATUS_FALLBACK_MS * 2);
	assert.equal(forge.edits.length, 1, "no second final edit");
	assert.equal(reg.settle("job-1", "failed"), undefined, "nothing left to settle");
});

test("the registry: an infrastructure retry says retrying, and the next attempt edits the same comment", async () => {
	const clock = fakeClock();
	const forge = fakeForge();
	const reg = makeStatusCommentRegistry({ setTimer: clock.setTimer, clearTimer: clock.clearTimer });
	const first = reg.register("job-1", commenter(clock, forge).c);
	first.start(snap(0));
	await flush();
	first.ended(snap(0), "failed");
	await reg.settle("job-1", STATUS_RETRYING);
	assert.match(forge.edits.at(-1).text, /attempt ended, retrying/);
	const second = reg.register("job-1", commenter(clock, forge, { commentId: "100" }).c);
	second.start(snap(0));
	await flush();
	assert.match(forge.edits.at(-1).text, /: running\./);
	assert.equal(forge.posts.length, 1, "one comment for the job");
});

test("the registry: with no record, the fallback finishes with the exit's outcome; a new attempt drops the old entry unedited", async () => {
	const clock = fakeClock();
	const forge = fakeForge();
	const reg = makeStatusCommentRegistry({ setTimer: clock.setTimer, clearTimer: clock.clearTimer });
	const w = reg.register("job-1", commenter(clock, forge).c);
	w.start(snap(0));
	await flush();
	w.ended(snap(2), "failed");
	await clock.advance(STATUS_FALLBACK_MS - 1);
	assert.equal(forge.edits.length, 0);
	await clock.advance(1);
	assert.equal(forge.edits.at(-1).text, "pi-dispatch job `job-1`: finished: failed. Turn 2, 0 steps.");
	assert.equal(reg.size(), 0);
	// A held attempt whose entry was still waiting: the new attempt takes over and the old one never edits.
	const forge2 = fakeForge();
	const old = reg.register("job-2", commenter(clock, forge2).c);
	old.start(snap(0));
	await flush();
	old.ended(snap(1), "unknown");
	const fresh = reg.register("job-2", commenter(clock, forge2, { commentId: "100" }).c);
	assert.equal(reg.size(), 1);
	await clock.advance(STATUS_FALLBACK_MS * 2);
	assert.equal(forge2.edits.length, 0, "the dropped entry's fallback never fired");
	await reg.settle("job-2", "completed");
	assert.equal(forge2.edits.length, 1);
	assert.equal(reg.size(), 0);
	void fresh;
});

test("the registry: a record slower than the fallback still corrects the comment once, within a bounded grace", async () => {
	assert.equal(STATUS_FALLBACK_MS, 5 * 60_000, "long enough for a slow record path to win");
	assert.equal(STATUS_LATE_SETTLE_MS, 10 * 60_000);
	const clock = fakeClock();
	const forge = fakeForge();
	const reg = makeStatusCommentRegistry({ setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now });
	const w = reg.register("job-1", commenter(clock, forge).c);
	w.start(snap(0));
	await flush();
	// An OOM kill: the exit said unknown, and the record (policy) arrives after the fallback fired.
	w.ended(snap(4, 3), "unknown");
	await clock.advance(STATUS_FALLBACK_MS);
	assert.match(forge.edits.at(-1).text, /finished: unknown/);
	assert.equal(reg.has("job-1"), true, "kept for a late settle");
	await reg.settle("job-1", "policy");
	assert.equal(forge.edits.at(-1).text, "pi-dispatch job `job-1`: finished: policy. Turn 4, 3 steps.", "the record's outcome corrects it");
	assert.equal(forge.edits.length, 2);
	await reg.settle("job-1", "failed");
	assert.equal(forge.edits.length, 2, "one correction, not one per settle");
	assert.equal(reg.has("job-1"), false);

	// A late settle with the same text edits nothing; one after the grace reaches nothing.
	const f2 = fakeForge();
	const same = reg.register("job-2", commenter(clock, f2).c);
	same.start(snap(0));
	await flush();
	same.ended(snap(1), "failed");
	await clock.advance(STATUS_FALLBACK_MS);
	await reg.settle("job-2", "failed");
	assert.equal(f2.edits.length, 1, "the same text is not written again");
	const f3 = fakeForge();
	const gone = reg.register("job-3", commenter(clock, f3).c);
	gone.start(snap(0));
	await flush();
	gone.ended(snap(1), "unknown");
	await clock.advance(STATUS_FALLBACK_MS + STATUS_LATE_SETTLE_MS);
	assert.equal(reg.has("job-3"), false, "forgotten after the grace");
	assert.equal(reg.settle("job-3", "policy"), undefined);
	assert.equal(f3.edits.length, 1);
	// A new attempt takes the late entry over: its record settles the new commenter, never the old one.
	const f4 = fakeForge();
	const old = reg.register("job-4", commenter(clock, f4).c);
	old.start(snap(0));
	await flush();
	old.ended(snap(1), "unknown");
	await clock.advance(STATUS_FALLBACK_MS);
	reg.register("job-4", commenter(clock, f4, { commentId: "100" }).c);
	assert.equal(reg.lateSize(), 0);
});

test("the registry's late list is capped: the oldest finished commenter is dropped first", async () => {
	const clock = fakeClock();
	const reg = makeStatusCommentRegistry({ setTimer: clock.setTimer, clearTimer: clock.clearTimer, now: clock.now, lateMax: 2 });
	for (const id of ["a", "b", "c"]) {
		const w = reg.register(id, commenter(clock, fakeForge()).c);
		w.start(snap(0));
		await flush();
		w.ended(snap(1), "unknown");
	}
	await clock.advance(STATUS_FALLBACK_MS);
	assert.equal(reg.lateSize(), 2);
	assert.deepEqual(["a", "b", "c"].map((id) => reg.has(id)), [false, true, true]);
	assert.ok(STATUS_LATE_SETTLE_MAX > 0 && Number.isSafeInteger(STATUS_LATE_SETTLE_MAX));
});

test("a failed edit that is not a stop is retried by the next update", async () => {
	const clock = fakeClock();
	const forge = fakeForge({ editAnswer: (n) => (n === 1 ? { ok: false } : { ok: true }) });
	const { c } = commenter(clock, forge, { intervalMs: 10 });
	c.start(snap(0));
	await flush();
	c.update(snap(1));
	await clock.advance(10);
	c.update(snap(1));
	await clock.advance(10);
	assert.equal(forge.edits.length, 2);
	assert.equal(forge.edits[1].text, forge.edits[0].text);
});

test("finish cancels the pending trailing edit and makes one final edit", async () => {
	const clock = fakeClock();
	const forge = fakeForge();
	const { c } = commenter(clock, forge);
	c.start(snap(0));
	await flush();
	c.update(snap(5));
	assert.equal(clock.pending(), 1);
	await c.finish(snap(6, 4), "completed");
	assert.equal(forge.edits.length, 1);
	assert.equal(forge.edits[0].text, "pi-dispatch job `job-1`: finished: completed. Turn 6, 4 steps.");
	assert.equal(clock.pending(), 0, "no timer outlives finish");
	c.update(snap(7));
	await clock.advance(60_000);
	await c.finish(snap(8), "failed");
	assert.equal(forge.edits.length, 1, "nothing after finish, and a second finish is a no-op");
});

test("finish is bounded: a forge that never answers costs finalTimeoutMs, not the job", async () => {
	const clock = fakeClock();
	const forge = fakeForge();
	forge.edit = () => new Promise(() => {});
	const { c, logs } = commenter(clock, forge, { finalTimeoutMs: 5_000 });
	c.start(snap(0));
	await flush();
	let done = false;
	const p = c.finish(snap(1), "completed").then(() => {
		done = true;
	});
	await flush();
	assert.equal(done, false);
	await clock.advance(5_000);
	await p;
	assert.equal(done, true);
	assert.ok(logs.some((l) => l.event === "status_comment_final_timeout"));
});

test("a post that found no id makes no edits and posts nothing more, since the first may have landed", async () => {
	const clock = fakeClock();
	const forge = fakeForge({ postId: null });
	const { c, ids } = commenter(clock, forge, { intervalMs: 10 });
	c.start(snap(0));
	await flush();
	c.update(snap(1));
	await clock.advance(10);
	await c.finish(snap(2), "completed");
	assert.equal(forge.posts.length, 1);
	assert.equal(forge.edits.length, 0);
	assert.deepEqual(ids, []);
	assert.equal(c.commentId(), null);
});

test("a run that finishes without start posts one comment carrying the outcome", async () => {
	const clock = fakeClock();
	const forge = fakeForge();
	const { c } = commenter(clock, forge);
	await c.finish(snap(0), "policy");
	assert.deepEqual(forge.posts, ["pi-dispatch job `job-1`: finished: policy. Turn 0, 0 steps."]);
});

test("nothing throws: throwing forge calls, logger and onId are all absorbed", async () => {
	const clock = fakeClock();
	const c = makeStatusCommenter({
		jobId: "j",
		post: async () => {
			throw new Error("boom");
		},
		edit: async () => {
			throw new Error("boom");
		},
		onId: () => {
			throw new Error("boom");
		},
		log: () => {
			throw new Error("boom");
		},
		now: clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
		intervalMs: 10,
	});
	assert.doesNotThrow(() => c.start(snap(0)));
	await flush();
	assert.doesNotThrow(() => c.update(snap(1)));
	await clock.advance(10);
	await assert.doesNotReject(() => c.finish(snap(2), "failed"));

	const withId = makeStatusCommenter({
		jobId: "j",
		commentId: "1",
		post: async () => ({ id: "2" }),
		edit: async () => {
			throw new Error("boom");
		},
		now: clock.now,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
	});
	withId.start(snap(0));
	await flush();
	await assert.doesNotReject(() => withId.finish(snap(1), "completed"));
});

test("an invalid given commentId is not trusted: the commenter posts a fresh comment", async () => {
	const clock = fakeClock();
	const forge = fakeForge();
	const { c } = commenter(clock, forge, { commentId: "../../x" });
	c.start(snap(0));
	await flush();
	assert.equal(forge.posts.length, 1);
	assert.equal(forge.edits.length, 0);
});
