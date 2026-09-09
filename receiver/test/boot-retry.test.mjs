import assert from "node:assert/strict";
import { test } from "node:test";
import { entryExitCode } from "../src/cli.mjs";
import { retryIdentity } from "../src/boot-retry.mjs";

// Everything time-shaped is injected (CLAUDE.md: a window takes an injected clock, always): `now` is a
// hand-advanced counter, `sleep` records and advances it, and the FUSE's setTimeout/clearTimeout pair is
// a handle bag so the tests can prove the clearing instead of trusting it. No test here waits real time
// except the two that exist to census real timers.

function fakeTimers() {
	const handles = [];
	const setTimeoutFn = (cb, ms) => {
		const h = {
			cb,
			ms,
			cleared: false,
			unrefCalled: false,
			unref() {
				h.unrefCalled = true;
				return h;
			},
		};
		handles.push(h);
		return h;
	};
	// Tolerates null, like the real clearTimeout: the sync-throw path clears a fuse that was never armed.
	const clearTimeoutFn = (h) => {
		if (h) h.cleared = true;
	};
	return { handles, setTimeoutFn, clearTimeoutFn };
}

function makeRun({ windowMs = 600_000, ...rest } = {}) {
	let t = 0;
	const sleeps = [];
	const logs = [];
	const timers = fakeTimers();
	const opts = {
		forge: "gitlab",
		windowMs,
		log: (obj) => logs.push(obj),
		now: () => t,
		sleep: async (ms) => {
			sleeps.push(ms);
			t += ms;
		},
		setTimeoutFn: timers.setTimeoutFn,
		clearTimeoutFn: timers.clearTimeoutFn,
		...rest,
	};
	return { opts, sleeps, logs, timers };
}

test("transient failures retry with the documented gaps, then the answer comes back", async () => {
	let calls = 0;
	const resolve = async () => {
		calls++;
		if (calls < 3) throw new Error(`boom ${calls}`);
		return { selfId: 7 };
	};
	const { opts, sleeps, logs } = makeRun();
	const out = await retryIdentity(resolve, opts);
	assert.deepEqual(out, { selfId: 7 });
	assert.equal(calls, 3);
	assert.deepEqual(sleeps, [5_000, 10_000], "first gap is what RestartSec=5 gave, then it doubles");
	// The line's key set is pinned EXACTLY: these lines cross a real stdout, and the field carrying a
	// value nobody meant to log is how a secret first leaks. `reason` is the error MESSAGE, nothing else.
	assert.equal(logs.length, 2);
	for (const [i, line] of logs.entries()) {
		assert.deepEqual(Object.keys(line), ["event", "forge", "attempt", "reason", "delayMs"]);
		assert.equal(line.event, "identity_retry");
		assert.equal(line.forge, "gitlab");
		assert.equal(line.attempt, i + 1);
		assert.equal(line.reason, `boom ${i + 1}`);
	}
	assert.deepEqual(logs.map((l) => l.delayMs), [5_000, 10_000]);
});

test("the backoff doubles to the cap and stays there", async () => {
	// Window sized so the sixth sleep ends EXACTLY at the deadline: the schedule, the cap and the
	// exhaustion edge are all visible in one array, and no gap needed clamping to get there.
	const { opts, sleeps } = makeRun({ windowMs: 125_000 });
	const err = await retryIdentity(async () => {
		throw new Error("still down");
	}, opts).then(() => null, (e) => e);
	assert.ok(err);
	assert.deepEqual(sleeps, [5_000, 10_000, 20_000, 30_000, 30_000, 30_000], "5s doubling to a 30s cap, never flattened and never past the cap");
});

test("a tagged refusal on the FIRST attempt rethrows same-tick: no sleep, no line, the original object", async () => {
	const original = Object.assign(new Error("bad token"), { piDispatchConfig: true });
	let calls = 0;
	const { opts, sleeps, logs } = makeRun();
	const err = await retryIdentity(async () => {
		calls++;
		throw original;
	}, opts).then(() => null, (e) => e);
	assert.equal(err, original, "the SAME object: re-wrapping would cost the entry the piDispatchConfig mapping");
	assert.equal(calls, 1);
	assert.deepEqual(sleeps, [], "retrying a misconfiguration only hides the message from the operator");
	assert.deepEqual(logs, [], "and a determinate refusal is not retry noise");
	assert.equal(entryExitCode(err), 2);
});

test("a tagged refusal AFTER transient attempts still wins immediately", async () => {
	// A forge can come back wrong: two 502s while it restarts, then a 401 because the token was rotated.
	// The moment the answer turns determinate, the loop must stop being helpful.
	const tagged = Object.assign(new Error("token not authorized"), { piDispatchConfig: true });
	let calls = 0;
	const { opts, sleeps } = makeRun();
	const err = await retryIdentity(async () => {
		calls++;
		if (calls < 3) throw new Error(`502 number ${calls}`);
		throw tagged;
	}, opts).then(() => null, (e) => e);
	assert.equal(err, tagged);
	assert.equal(calls, 3);
	assert.deepEqual(sleeps, [5_000, 10_000], "the transient attempts slept; the tagged one did not add a third");
});

test("exhaustion rethrows the LAST transient error, exits 1, and the final attempt lands at the window's edge", async () => {
	// windowMs 12000: gap one is the full 5s, gap two is CLAMPED from 10s to the 7s that remain, and
	// the third attempt runs exactly at the deadline -- the whole window is spent retrying (measured
	// before the clamp: a 60s window gave up at 35s and missed a forge that came back late). After the
	// edge attempt fails there is NO further sleep: a timer armed past the last attempt would outlive
	// the refusal, the defect class issue #300 exists for.
	const errors = [];
	const { opts, sleeps, logs } = makeRun({ windowMs: 12_000 });
	const err = await retryIdentity(async () => {
		const e = new Error(`down ${errors.length + 1}`);
		errors.push(e);
		throw e;
	}, opts).then(() => null, (e) => e);
	assert.equal(err, errors.at(-1), "the last real failure, not a synthetic wrapper: its message is the operator's evidence");
	assert.equal(err.piDispatchConfig, undefined);
	assert.equal(entryExitCode(err), 1, "exit 1: the supervisor restarts into a fresh window");
	assert.deepEqual(sleeps, [5_000, 7_000], "the second gap is clamped to the remaining window, and nothing sleeps after the edge attempt");
	const exhausted = logs.at(-1);
	assert.deepEqual(Object.keys(exhausted), ["event", "forge", "attempts", "windowMs", "reason"]);
	assert.equal(exhausted.event, "identity_retry_exhausted");
	assert.equal(exhausted.attempts, 3);
	assert.equal(exhausted.windowMs, 12_000);
	assert.equal(exhausted.reason, "down 3");
});

test("a windowless caller fails loud, never retrying unbounded", async () => {
	// NaN or a missing window would make the remaining-time test never exhaust: an unbounded boot
	// retry is the silent no-op this project refuses, so the helper refuses the caller instead. The
	// guard runs before the first attempt on purpose -- a bad window is a bug at the seam, not a
	// property of whether the forge happened to answer.
	for (const bad of [undefined, Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
		await assert.rejects(
			retryIdentity(async () => 1, { forge: "github", windowMs: bad, log: () => {} }),
			/windowMs must be a positive finite number/,
			`windowMs=${bad} must refuse instead of retrying unbounded`,
		);
	}
});

test("the fuse bounds an attempt that never answers, and a fused-out attempt is transient", async () => {
	// A forge that ACCEPTS and never answers is the case the fuse exists for: the resolvers pass no
	// AbortSignal and undici's header timeout is five minutes, so without the fuse one mute attempt
	// spends the whole window. windowMs 5000: fuse loss one sleeps the full remaining 5s, and fuse
	// loss two lands exactly at the deadline, so the second failure exhausts.
	const { opts, sleeps, timers } = makeRun({ windowMs: 5_000 });
	const p = retryIdentity(() => new Promise(() => {}), opts);
	assert.equal(timers.handles.length, 1, "the fuse armed with the attempt");
	assert.equal(timers.handles[0].ms, 10_000, "at the documented per-attempt bound");
	timers.handles[0].cb();
	// The loop's turnaround is all microtasks (the fake sleep never waits); a macrotask flushes them.
	for (let i = 0; i < 50 && timers.handles.length < 2; i++) await new Promise((r) => setImmediate(r));
	assert.equal(timers.handles.length, 2, "the loop slept and re-attempted: a fused-out attempt counts as transient");
	timers.handles[1].cb();
	const err = await p.then(() => null, (e) => e);
	assert.match(err.message, /gitlab identity did not answer within 10000ms/);
	assert.equal(err.piDispatchConfig, undefined, "untagged BY DECISION: indistinguishable from a forge that is down");
	assert.deepEqual(sleeps, [5_000]);
});

test("every armed fuse is cleared, on every exit, and none is ever unref'd", async () => {
	// Three exits: the win, the transient loss, the tagged rethrow. The unref ban is load-bearing, not
	// style: the github arm runs before the queue exists, so an unref'd fuse can be the only pending
	// handle -- settleWithin's documented bare-context boundary, where the fuse never fires and node
	// abandons the await with exit 13.
	const win = makeRun();
	await retryIdentity(async () => 42, win.opts);

	const tagged = makeRun();
	await retryIdentity(async () => {
		throw Object.assign(new Error("nope"), { piDispatchConfig: true });
	}, tagged.opts).catch(() => {});

	// The clamp guarantees at least two attempts (the first failure always has window left), so the
	// lost scenario fires BOTH fuses: gap one is clamped to the whole 4s window, and the second
	// failure lands at the deadline and exhausts.
	const lost = makeRun({ windowMs: 4_000 });
	const p = retryIdentity(() => new Promise(() => {}), lost.opts);
	lost.timers.handles[0].cb();
	for (let i = 0; i < 50 && lost.timers.handles.length < 2; i++) await new Promise((r) => setImmediate(r));
	lost.timers.handles[1].cb();
	await p.catch(() => {});

	const all = [...win.timers.handles, ...tagged.timers.handles, ...lost.timers.handles];
	assert.ok(all.length >= 3, "each scenario armed its fuse");
	assert.ok(all.every((h) => h.cleared), "a ref'd fuse left armed holds the loop for its full term (issue #295's lesson, the ref'd twin)");
	assert.ok(all.every((h) => !h.unrefCalled), "never unref'd -- see the bare-context boundary above");
});

test("with the REAL timers, a resolved attempt leaves no live Timeout behind (async_hooks census)", async () => {
	// `process.getActiveResourcesInfo()` cannot see this either way; async_hooks init/destroy is the
	// honest meter (the settleWithin pin's pattern, worker/test/start-wiring.test.mjs). destroy fires a
	// tick late, so the census settles across two setImmediates.
	const { createHook } = await import("node:async_hooks");
	const live = new Set();
	const hook = createHook({
		init(id, type) {
			if (type === "Timeout") live.add(id);
		},
		destroy(id) {
			live.delete(id);
		},
	});
	hook.enable();
	try {
		const out = await retryIdentity(async () => 99, { forge: "github", windowMs: 60_000, log: () => {} });
		assert.equal(out, 99);
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		assert.equal(live.size, 0, "the real fuse must be DESTROYED by the finally clear, not left to burn its 10s");
	} finally {
		hook.disable();
	}
});

test("an abandoned attempt's late rejection never surfaces as an unhandledRejection", async () => {
	// The fuse can win the race while the real attempt is still pending, and when that attempt finally
	// rejects there must already be a handler on it. Today that handler is Promise.race's OWN
	// subscription (measured: it subscribes a reject handler to every contestant, which is why the
	// helper carries no explicit catch, unlike the worker's ensureAuth whose promise outlives its race
	// in a map). This test pins the PROPERTY, so any refactor that stops racing the raw attempt --
	// wrapping it first, racing conditionally -- has to bring its own handler or go red here.
	const trapped = [];
	const onUR = (err) => trapped.push(err);
	process.on("unhandledRejection", onUR);
	try {
		const { opts, timers } = makeRun({ windowMs: 4_000 });
		const rejecters = [];
		const p = retryIdentity(() => new Promise((_, rej) => rejecters.push(rej)), opts);
		timers.handles[0].cb();
		for (let i = 0; i < 50 && timers.handles.length < 2; i++) await new Promise((r) => setImmediate(r));
		timers.handles[1].cb();
		const err = await p.then(() => null, (e) => e);
		assert.match(err.message, /did not answer/);
		assert.equal(rejecters.length, 2, "both attempts were abandoned by their fuses");
		for (const rej of rejecters) rej(new Error("the mute forge finally answered, with a failure, after everyone left"));
		await new Promise((r) => setImmediate(r));
		await new Promise((r) => setImmediate(r));
		assert.deepEqual(trapped, [], "an abandoned attempt with no handler would land here");
	} finally {
		process.off("unhandledRejection", onUR);
	}
});

test("a SYNCHRONOUSLY throwing resolver is caught, counted and retried, and arms no fuse", async () => {
	// Pins the arm-fuse-after-resolve ordering: the fuse exists to bound a PENDING attempt, and a sync
	// throw never produced one, so the only handle in the bag must belong to the retry that followed.
	let calls = 0;
	const resolve = () => {
		calls++;
		if (calls === 1) throw new Error("sync boom");
		return Promise.resolve("ok");
	};
	const { opts, sleeps, timers } = makeRun();
	const out = await retryIdentity(resolve, opts);
	assert.equal(out, "ok");
	assert.equal(calls, 2);
	assert.deepEqual(sleeps, [5_000]);
	assert.equal(timers.handles.length, 1, "one fuse, for the one attempt that returned a promise");
	assert.ok(timers.handles[0].cleared);
});
