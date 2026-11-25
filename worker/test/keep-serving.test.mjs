import assert from "node:assert/strict";
import { test } from "node:test";
import { abortableSleep, keepServing, keepServingWaitMs } from "../src/keep-serving.mjs";

// Issue #1096: a channel subscription that fails at boot is tried again on a bounded backoff, with one line at the first
// failure and one at the recovery. Everything here runs on an injected sleep and clock: no real wait.

const settle = async () => {
	for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * A keepServing driven by a script: `attempt(n)` is what the n-th start does (throw to fail, return a service). The sleep
 * advances the clock by what it was asked and answers at once, until `waitsBeforeHold` waits: then it holds until the
 * stop signal aborts, which is how a test looks at a loop that would otherwise go on.
 */
function drive({ attempt, waitsBeforeHold = Infinity }) {
	let clock = 1_000_000;
	const waits = [];
	const lines = [];
	let starts = 0;
	const ended = [];
	const sleep = (ms, signal) => {
		waits.push(ms);
		if (waits.length > waitsBeforeHold) return new Promise((resolve) => signal.addEventListener("abort", () => { ended.push(ms); resolve(false); }, { once: true }));
		clock += ms;
		return Promise.resolve(!signal.aborted);
	};
	const keeper = keepServing({
		start: async () => attempt(++starts),
		log: (event, fields) => lines.push([event, fields]),
		unavailable: "history_reader_unavailable",
		recovered: "history_reader_recovered",
		sleep,
		now: () => clock,
	});
	return { keeper, waits, lines, ended, starts: () => starts };
}

const service = (closes) => ({ close: async () => { closes.push("close"); } });

test("the waits are 5, 10, 20, 40 and 60 s, and 60 s from then on", () => {
	assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 40, 4000].map(keepServingWaitMs), [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000, 60_000]);
});

test("a subscription that holds at once says nothing and waits for nothing", async () => {
	const closes = [];
	const run = drive({ attempt: () => service(closes) });
	await settle();
	assert.deepEqual([run.starts(), run.waits, run.lines], [1, [], []]);
	await run.keeper.close();
	assert.deepEqual(closes, ["close"]);
});

test("after N failures, one line at the first, the backoff between, and one recovery line naming N and the seconds", async () => {
	const closes = [];
	const run = drive({ attempt: (n) => { if (n <= 6) throw new Error("history subscription timed out, redis://:secret@valkey:6379"); return service(closes); } });
	await settle();
	assert.equal(run.starts(), 7);
	assert.deepEqual(run.waits, [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
	assert.deepEqual(run.lines, [["history_reader_unavailable", {}], ["history_reader_recovered", { failedAttempts: 6, waitedSeconds: 195 }]], "two lines in all, counts only, never the error's text");
	assert.deepEqual(closes, [], "the service that held is kept, not closed");
	await run.keeper.close();
	await run.keeper.close();
	assert.deepEqual(closes, ["close"], "shutdown closes what held, once");
});

test("a subscription that never holds keeps trying at the cap and says nothing more", async () => {
	const run = drive({ attempt: () => { throw new Error("no"); }, waitsBeforeHold: 30 });
	await settle();
	assert.equal(run.starts(), 31);
	assert.deepEqual(run.waits.slice(0, 5), [5_000, 10_000, 20_000, 40_000, 60_000]);
	assert.ok(run.waits.slice(4).every((ms) => ms === 60_000), "never past the cap");
	assert.deepEqual(run.lines, [["history_reader_unavailable", {}]]);
	await run.keeper.close();
	await settle();
	assert.equal(run.starts(), 31, "and stops at shutdown");
});

test("shutdown during a wait ends the wait at once and starts nothing more, with nothing to close", async () => {
	const run = drive({ attempt: () => { throw new Error("no"); }, waitsBeforeHold: 2 });
	await settle();
	assert.deepEqual([run.starts(), run.waits.length], [3, 3], "held in its third wait");
	assert.deepEqual(run.ended, []);
	await run.keeper.close();
	assert.deepEqual(run.ended, [20_000], "the pending wait was ended by the shutdown itself");
	await settle();
	assert.deepEqual([run.starts(), run.waits.length], [3, 3]);
	assert.deepEqual(run.lines, [["history_reader_unavailable", {}]], "no recovery line");
});

test("an attempt still pending at shutdown has what it gets closed when it settles, once, and nothing recovers", async () => {
	const closes = [];
	let settleAttempt;
	const run = drive({ attempt: (n) => { if (n === 1) throw new Error("no"); return new Promise((resolve) => { settleAttempt = resolve; }); } });
	await settle();
	assert.equal(run.starts(), 2);
	await run.keeper.close();
	settleAttempt(service(closes));
	await settle();
	assert.deepEqual(closes, ["close"]);
	assert.deepEqual(run.lines, [["history_reader_unavailable", {}]]);
	await run.keeper.close();
	assert.deepEqual(closes, ["close"]);
});

test("a start that throws before it returns a promise is one more failure, and a failing close at shutdown is not thrown", async () => {
	let starts = 0;
	const lines = [];
	const keeper = keepServing({
		start: () => {
			starts += 1;
			if (starts === 1) throw new TypeError("thrown, not rejected");
			return { close: async () => { throw new Error("already gone"); } };
		},
		log: (event, fields) => lines.push([event, fields]),
		unavailable: "u",
		recovered: "r",
		sleep: async () => true,
		now: () => 0,
	});
	await settle();
	assert.deepEqual(lines, [["u", {}], ["r", { failedAttempts: 1, waitedSeconds: 0 }]]);
	await keeper.close();
});

test("the real sleep answers true when it ends and false as soon as it is aborted, its timer holding nothing open", async () => {
	// Its own timer is unref'd, so the test holds the process open itself while it waits: without this the process could
	// end before the 1 ms passed, which is what "holds nothing open" means.
	const open = setTimeout(() => {}, 10_000);
	try { assert.equal(await abortableSleep(1, new AbortController().signal), true); } finally { clearTimeout(open); }
	const stop = new AbortController();
	const realSetTimeout = globalThis.setTimeout;
	let timer = null;
	globalThis.setTimeout = (...args) => (timer = realSetTimeout(...args));
	let pending;
	try { pending = abortableSleep(3_600_000, stop.signal); } finally { globalThis.setTimeout = realSetTimeout; }
	assert.equal(timer.hasRef(), false, "the wait's own timer keeps no process alive");
	stop.abort();
	assert.equal(await pending, false);
	const aborted = new AbortController();
	aborted.abort();
	assert.equal(await abortableSleep(3_600_000, aborted.signal), false);
});

test("a log or a sleep that throws ends the retry quietly, never as an unhandled rejection that would end the worker", async () => {
	const unhandled = [];
	const note = (reason) => unhandled.push(reason);
	process.on("unhandledRejection", note);
	try {
		for (const broken of ["log", "sleep"]) {
			const keeper = keepServing({
				start: async () => { throw new Error("subscribe timed out"); },
				log: () => { if (broken === "log") throw new Error("log failed"); },
				unavailable: "history_reader_unavailable",
				recovered: "history_reader_recovered",
				sleep: async () => { if (broken === "sleep") throw new Error("sleep failed"); return false; },
				now: () => 0,
			});
			await settle();
			await keeper.close();
		}
		await settle();
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("unhandledRejection", note);
	}
});
