import assert from "node:assert/strict";
import { test } from "node:test";
import { SANDBOX_FOLLOWUP_DELAY_MS, SWEEP_INTERVAL_HOURS, SWEEP_INTERVAL_MAX_HOURS, makeRetentionSweep, makeSweepFollowUps } from "../src/retention-sweep.mjs";

/**
 * A recording timer pair. No production caller passes these; they exist because this repo has no
 * fake-timer infrastructure and its doctrine is to inject a seam rather than reach for a global. The
 * alternative -- a 1ms interval and a real sleep -- would make this the wall-clock-dependent test that
 * issue #293 exists to eliminate, in the same change that adds #293's guard.
 */
function timers() {
	const armed = [];
	const cleared = [];
	let handles = 0;
	return {
		armed,
		cleared,
		setIntervalFn: (fn, ms) => {
			const handle = { id: ++handles, unrefs: 0, unref() { this.unrefs += 1; } };
			armed.push({ fn, ms, handle });
			return handle;
		},
		clearIntervalFn: (handle) => cleared.push(handle),
		/**
		 * Fire the armed callback the way the event loop would, then drain.
		 *
		 * The drain is not decoration: the sweep yields to the macrotask queue between stores, and the
		 * interval callback is `void sweepOnce()`, so the callback returns long before the sweep settles.
		 * A fixed number of `setImmediate` turns is deterministic where a `setTimeout` would be a wall
		 * clock in a test file whose whole subject is not depending on one.
		 */
		tick: async () => {
			for (const a of armed) a.fn();
			for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
		},
	};
}

const recorder = () => {
	const ran = [];
	return {
		ran,
		reapers: [
			{ name: "log", reap: () => ran.push("log") },
			{ name: "sandbox", reap: async () => ran.push("sandbox") },
			{ name: "session", reap: () => ran.push("session") },
		],
	};
};

const logger = () => {
	const lines = [];
	return { lines, log: (event, fields) => lines.push([event, fields]) };
};

test("start arms exactly one interval, at the interval given, and unrefs it", () => {
	const t = timers();
	const s = makeRetentionSweep({ reapers: recorder().reapers, intervalMs: 86_400_000, ...t });
	s.start();
	assert.equal(t.armed.length, 1);
	assert.equal(t.armed[0].ms, 86_400_000);
	assert.equal(t.armed[0].handle.unrefs, 1, "unref'd, so it can never hold the process open");
});

test("start does NOT sweep immediately, because boot just did", async () => {
	// The one deliberate divergence from host-registry.start, which beats first. An immediate sweep would
	// double the boot work and land inside start-wiring's call-order pins.
	const t = timers();
	const r = recorder();
	makeRetentionSweep({ reapers: r.reapers, intervalMs: 1000, ...t }).start();
	assert.deepEqual(r.ran, [], "arming is not sweeping");
	await t.tick();
	assert.deepEqual(r.ran, ["log", "sandbox", "session"], "the first tick is the first sweep");
});

test("a second start arms nothing, so a re-entrant caller cannot leak the first interval", () => {
	const t = timers();
	const s = makeRetentionSweep({ reapers: recorder().reapers, intervalMs: 1000, ...t });
	s.start();
	s.start();
	assert.equal(t.armed.length, 1);
});

test("a non-positive interval arms NOTHING, because setInterval(fn, 0) is a hot loop over the filesystem", () => {
	for (const ms of [0, -1, undefined, Number.NaN]) {
		const t = timers();
		makeRetentionSweep({ reapers: recorder().reapers, intervalMs: ms, ...t }).start();
		assert.equal(t.armed.length, 0, `intervalMs=${ms}`);
	}
});

test("a tick runs all three reapers, in boot's own order", async () => {
	const t = timers();
	const r = recorder();
	const s = makeRetentionSweep({ reapers: r.reapers, intervalMs: 1000, ...t });
	await s.sweepOnce();
	await s.sweepOnce();
	assert.deepEqual(r.ran, ["log", "sandbox", "session", "log", "sandbox", "session"], "and it re-runs, which is the whole point");
});

test("one reaper throwing does not skip the other two, and is exactly one log line", async () => {
	// "every sweep failure is a log line, never a crash", mechanised. The event names are the EXISTING
	// per-store ones, so an operator greps one name and gets both the boot sweep and every tick.
	const l = logger();
	const ran = [];
	const s = makeRetentionSweep({
		reapers: [
			{ name: "log", reap: () => ran.push("log") },
			{ name: "sandbox", reap: () => { throw new Error("docker is down"); } },
			{ name: "session", reap: () => ran.push("session") },
		],
		intervalMs: 1000,
		log: l.log,
		...timers(),
	});
	await s.sweepOnce();
	assert.deepEqual(ran, ["log", "session"], "the siblings still ran");
	const skipped = l.lines.filter(([e]) => e === "sandbox_reaper_skipped");
	assert.equal(skipped.length, 1);
	assert.equal(skipped[0][1].reason, "docker is down");
	assert.equal(l.lines.filter(([e]) => e === "retention_sweep").length, 1, "and the sweep still reports completing");
});

test("a docker outage costs ONE tick, never a latch", async () => {
	// The property that makes a periodic sweep safe for the sandbox store: the reaper holds no state
	// between calls, so a failed listRunning is retried from scratch next time rather than disabling it.
	let attempt = 0;
	const swept = [];
	const s = makeRetentionSweep({
		reapers: [{ name: "sandbox", reap: () => { attempt += 1; if (attempt === 1) throw new Error("docker unreachable"); swept.push(attempt); } }],
		intervalMs: 1000,
		...timers(),
	});
	await s.sweepOnce();
	await s.sweepOnce();
	assert.deepEqual(swept, [2], "the second tick swept, so the first failure did not latch it off");
});

test("an overlapping tick is skipped, not stacked", async () => {
	// A sweep is unbounded I/O with rmSync in it; two of them racing each other's deletes buys nothing.
	const l = logger();
	let release;
	const gate = new Promise((r) => { release = r; });
	let entered = 0;
	const s = makeRetentionSweep({
		reapers: [{ name: "log", reap: async () => { entered += 1; await gate; } }],
		intervalMs: 1000,
		log: l.log,
		...timers(),
	});
	const first = s.sweepOnce();
	const second = s.sweepOnce();
	await second;
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(entered, 1, "the second tick did not enter the reaper");
	assert.equal(l.lines.filter(([e]) => e === "retention_sweep_overlapped").length, 1);
	release();
	await first;
});

test("close clears the interval once, is idempotent, and refuses to re-arm afterwards", async () => {
	const t = timers();
	const s = makeRetentionSweep({ reapers: recorder().reapers, intervalMs: 1000, ...t });
	s.start();
	await s.close();
	await s.close();
	assert.equal(t.cleared.length, 1, "idempotent: the second close clears nothing");
	s.start();
	assert.equal(t.armed.length, 1, "and a start after close arms nothing");
});

test("close DRAINS an in-flight sweep, so nothing rmSyncs behind a clean shutdown", async () => {
	let release;
	const gate = new Promise((r) => { release = r; });
	let finished = false;
	const s = makeRetentionSweep({
		reapers: [{ name: "log", reap: async () => { await gate; finished = true; } }],
		intervalMs: 1000,
		...timers(),
	});
	const sweeping = s.sweepOnce();
	let closed = false;
	const closing = s.close().then(() => { closed = true; });
	await Promise.resolve();
	assert.equal(closed, false, "close must not resolve while a sweep is still deleting");
	release();
	await closing;
	assert.equal(finished, true);
	await sweeping;
});

test("a sweep that starts after close returns without touching a reaper", async () => {
	const r = recorder();
	const s = makeRetentionSweep({ reapers: r.reapers, intervalMs: 1000, ...timers() });
	await s.close();
	await s.sweepOnce();
	assert.deepEqual(r.ran, [], "closed means closed, even for a tick already scheduled");
});

test("the exported cadence constants are the literals, so a bump is a reviewed edit", () => {
	// The PROTECTED_SKILL_ROOTS pattern: a constant-derived assertion is correct at any value and
	// therefore blind to a change IN that value.
	assert.equal(SWEEP_INTERVAL_HOURS, 24);
	assert.equal(SWEEP_INTERVAL_MAX_HOURS, 168);
});

test("close() is BOUNDED: a reaper that never settles delays exit, it does not prevent it", async () => {
	// `index.mjs`'s shutdown states that no closer here fails to settle, and an unbounded drain would have
	// made that false. The sweep's own docker call is NOT the backstop people assume: execFile's timeout
	// only sends SIGTERM and still waits for the child to close, so a `docker ps` against a dead daemon
	// socket hangs forever.
	const l = logger();
	const s = makeRetentionSweep({
		reapers: [{ name: "log", reap: () => new Promise(() => {}) }], // never settles, ever
		intervalMs: 1000,
		log: l.log,
		...timers(),
	});
	void s.sweepOnce();
	await new Promise((resolve) => setImmediate(resolve));
	const started = Date.now();
	await s.close();
	const waited = Date.now() - started;
	assert.ok(waited < 30_000, `close must return; waited ${waited}ms`);
	assert.equal(l.lines.filter(([e]) => e === "retention_sweep_drain_timeout").length, 1, "and it says it gave up rather than pretending it drained");
});

test("sweepOnce NEVER rejects, because the interval calls it with `void`", async () => {
	// An unhandled rejection kills the process by default and nothing in worker/src installs a handler.
	// A malformed reaper entry used to reject out of the destructure, above the per-reaper try.
	for (const reapers of [[null], [{ name: "log" }], [{ name: "log", reap: 42 }], [undefined]]) {
		const s = makeRetentionSweep({ reapers, intervalMs: 1000, ...timers() });
		await s.sweepOnce(); // must not throw
	}
	const l = logger();
	const s = makeRetentionSweep({ reapers: [null], intervalMs: 1000, log: l.log, ...timers() });
	await s.sweepOnce();
	assert.equal(l.lines.filter(([e]) => /_reaper_skipped$/.test(e)).length, 1, "a malformed entry is one log line like any other fault");
});

test("a tick yields between stores, so one sweep is never a single uninterruptible block", async () => {
	// The reapers delete synchronously. At boot that was free; on a timer beside draining jobs a long
	// block can outlast BullMQ's lock renewal, and `maxStalledCount: 0` turns that into a FAILED paid job.
	const order = [];
	const s = makeRetentionSweep({
		reapers: [
			{ name: "log", reap: () => order.push("log") },
			{ name: "sandbox", reap: () => order.push("sandbox") },
		],
		intervalMs: 1000,
		...timers(),
	});
	const sweeping = s.sweepOnce();
	setImmediate(() => order.push("<loop got a turn>"));
	await sweeping;
	assert.deepEqual(order, ["log", "<loop got a turn>", "sandbox"], "the event loop runs between stores, not only after all of them");
});

test("a reaper that throws on a TICK has its message scrubbed too (#339)", async () => {
	// THE PIN A BOOT-ONLY FIX FAILS. This line re-emits every `*_reaper_skipped` family by name on the timer,
	// so scrubbing only the catches in `start.mjs` would leave every tick after boot carrying the credential.
	const logged = [];
	const t = timers();
	const reapers = [{ name: "sandbox", reap: () => { throw new Error("Cannot connect to the Docker daemon at ssh://bob:hunter2@remote. Is the docker daemon running?"); } }];
	makeRetentionSweep({ reapers, intervalMs: 1000, log: (event, fields) => logged.push([event, fields]), ...t }).start();
	await t.tick();

	const line = logged.find(([event]) => event === "sandbox_reaper_skipped");
	assert.ok(line, "the family name is unchanged, which is OQ-007's one-grep property");
	assert.match(line[1].reason, /ssh:\/\/\[redacted\]@remote/, "the host survives");
	assert.match(line[1].reason, /Is the docker daemon running\?/, "and so does the daemon's own sentence");
	for (const needle of ["bob", "hunter2"]) assert.ok(!line[1].reason.includes(needle), needle);
});

// ── issue #978: the sandbox sweep's follow-up passes ────────────────────────────────────────────────

/**
 * A recording one-shot timer pair for the follow-ups: `fire(ms)` runs and forgets every armed callback of that delay, the
 * way the event loop would, then drains a fixed number of turns (no wall clock, the reason `timers()` above gives).
 */
function oneShots() {
	const armed = [];
	const cleared = [];
	let handles = 0;
	return {
		armed,
		cleared,
		setTimeoutFn: (fn, ms) => {
			const handle = { id: ++handles, ms, unrefs: 0, unref() { this.unrefs += 1; } };
			armed.push({ fn, ms, handle });
			return handle;
		},
		clearTimeoutFn: (handle) => cleared.push(handle),
		pending: (ms) => armed.filter((a) => a.ms === ms && !cleared.includes(a.handle)),
		fire: async (ms) => {
			const due = armed.filter((a) => a.ms === ms && !cleared.includes(a.handle));
			for (const a of due) armed.splice(armed.indexOf(a), 1);
			for (const a of due) a.fn();
			for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
		},
	};
}

test("follow-ups arm one unref'd timer only for a pass that left work, and the constant is the literal (issue #978)", () => {
	assert.equal(SANDBOX_FOLLOWUP_DELAY_MS, 60_000);
	const t = oneShots();
	const f = makeSweepFollowUps({ reap: async () => ({ more: false }), ...t });
	for (const result of [undefined, null, { more: false }, { busy: true }, { more: "yes" }, { held: 3, more: false }]) f.after(result);
	assert.equal(t.armed.length, 0, "no result, a finished pass, a busy answer and held entries arm nothing");
	f.after({ more: true });
	f.after({ more: true });
	assert.equal(t.armed.length, 1, "one timer, however often it is asked");
	assert.equal(t.armed[0].ms, SANDBOX_FOLLOWUP_DELAY_MS);
	assert.equal(t.armed[0].handle.unrefs, 1, "unref'd, so it never holds the worker open");
});

test("follow-ups repeat while a pass says more and stop at the first that does not, each told how to stop (issue #978)", async () => {
	const t = oneShots();
	const results = [{ more: true }, { more: true }, { more: false }];
	const calls = [];
	const f = makeSweepFollowUps({ reap: async (options) => (calls.push(options), results.shift()), ...t });
	f.after({ more: true });
	for (let i = 0; i < 3; i++) await t.fire(SANDBOX_FOLLOWUP_DELAY_MS);
	assert.equal(calls.length, 3);
	assert.equal(calls[0].stopped(), false, "each pass is handed the follow-ups' own stop");
	assert.equal(t.pending(SANDBOX_FOLLOWUP_DELAY_MS).length, 0, "the pass that left nothing arms nothing");
	await f.close();
	assert.equal(calls[0].stopped(), true, "and close turns it");
});

test("a pass that ends the lap, a daily tick's too, clears a follow-up already armed (issue #978)", async () => {
	const t = oneShots();
	let calls = 0;
	const f = makeSweepFollowUps({ reap: async () => (calls++, { more: true }), ...t });
	f.after({ more: true });
	f.after({ busy: true });
	assert.equal(t.cleared.length, 0, "a busy answer says nothing about the lap");
	f.after({ more: false, reaped: 3 });
	assert.deepEqual(t.cleared.map((h) => h.ms), [SANDBOX_FOLLOWUP_DELAY_MS], "the lap ended, so the armed follow-up goes");
	assert.equal(t.pending(SANDBOX_FOLLOWUP_DELAY_MS).length, 0);
	assert.equal(calls, 0, "and no pass of a new lap starts from it");
	f.after({ more: true });
	assert.equal(t.pending(SANDBOX_FOLLOWUP_DELAY_MS).length, 1, "a later pass that says more arms again");
	await f.close();
});

test("close clears an armed follow-up, and nothing arms after it (issue #978)", async () => {
	const t = oneShots();
	let calls = 0;
	const f = makeSweepFollowUps({ reap: async () => (calls++, { more: true }), ...t });
	f.after({ more: true });
	await f.close();
	assert.deepEqual(t.cleared.map((h) => h.ms), [SANDBOX_FOLLOWUP_DELAY_MS]);
	f.after({ more: true });
	assert.equal(t.pending(SANDBOX_FOLLOWUP_DELAY_MS).length, 0);
	assert.equal(calls, 0);
});

test("close waits for a follow-up pass in flight, BOUNDED, and says when it gave up (issue #978)", async () => {
	// Settles: close returns when the pass does, and the bound's timer is cleared.
	const t = oneShots();
	let finish;
	const f = makeSweepFollowUps({ reap: () => new Promise((resolve) => (finish = resolve)), ...t });
	f.after({ more: true });
	await t.fire(SANDBOX_FOLLOWUP_DELAY_MS);
	let closed = false;
	const closing = f.close().then(() => (closed = true));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(closed, false, "a pass in flight is waited for");
	assert.equal(t.pending(10_000).length, 1, "under a ten-second bound");
	finish({ more: true });
	await closing;
	assert.equal(t.pending(10_000).length, 0, "the bound is cleared once the pass is done");
	assert.equal(t.pending(SANDBOX_FOLLOWUP_DELAY_MS).length, 0, "and a closed follow-up does not re-arm from the pass's more");
	// Never settles: the bound ends the wait, with one line.
	const u = oneShots();
	const lines = [];
	const stuck = makeSweepFollowUps({ reap: () => new Promise(() => {}), log: (event, fields) => lines.push([event, fields]), ...u });
	stuck.after({ more: true });
	await u.fire(SANDBOX_FOLLOWUP_DELAY_MS);
	const waiting = stuck.close();
	await u.fire(10_000);
	await waiting;
	assert.deepEqual(lines, [["sandbox_followup_drain_timeout", { ms: 10_000 }]]);
});

test("a follow-up reap that throws is one scrubbed log line, never a rejection, and arms nothing (issue #978)", async () => {
	const t = oneShots();
	const lines = [];
	const f = makeSweepFollowUps({
		reap: async () => {
			throw new Error("Cannot connect to the Docker daemon at ssh://bob:hunter2@remote");
		},
		log: (event, fields) => lines.push([event, fields]),
		...t,
	});
	f.after({ more: true });
	await t.fire(SANDBOX_FOLLOWUP_DELAY_MS);
	assert.equal(lines.length, 1);
	assert.equal(lines[0][0], "sandbox_reaper_skipped", "the family's fault name, OQ-007's one grep");
	assert.ok(!lines[0][1].reason.includes("hunter2"));
	assert.equal(t.pending(SANDBOX_FOLLOWUP_DELAY_MS).length, 0);
});
