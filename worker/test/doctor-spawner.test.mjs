import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { DOCTOR_BOOT_DELAY_MS, DOCTOR_PUBLISH_SKIPPED_PREFIX, DOCTOR_RUN_TIMEOUT_MS, makeDoctorSpawner } from "../src/doctor-spawner.mjs";

/**
 * The worker's own doctor runs (issue #712, `DES-DOCTOR-RESULTS-PUBLISHED`): the boot run, the interval, no overlap, the
 * kill on timeout and on close, and the log lines' content. Every timer and the spawn are injected, so nothing here
 * starts a process or waits on the wall clock.
 */

/** Timers that fire only when the test says so. */
function fakeTimers() {
	const timeouts = [];
	const intervals = [];
	return {
		timeouts,
		intervals,
		setTimeoutFn(fn, ms) {
			const t = { fn, ms, cleared: false, unref() { t.unrefd = true; return t; } };
			timeouts.push(t);
			return t;
		},
		clearTimeoutFn(t) {
			if (t) t.cleared = true;
		},
		setIntervalFn(fn, ms) {
			const t = { fn, ms, cleared: false, unref() { t.unrefd = true; return t; } };
			intervals.push(t);
			return t;
		},
		clearIntervalFn(t) {
			if (t) t.cleared = true;
		},
	};
}

/** A spawn that hands back children the test ends by hand. */
function fakeSpawn() {
	const children = [];
	const spawnFn = (cmd, args, opts) => {
		const child = new EventEmitter();
		child.cmd = cmd;
		child.args = args;
		child.opts = opts;
		child.stderr = new EventEmitter();
		child.kills = [];
		child.pid = 4000 + children.length;
		child.kill = (sig) => {
			child.kills.push(sig);
			queueMicrotask(() => child.emit("close", null, sig));
		};
		child.unref = () => {
			child.unrefd = true;
		};
		children.push(child);
		return child;
	};
	return { spawnFn, children };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function build(extra = {}) {
	const timers = fakeTimers();
	const { spawnFn, children } = fakeSpawn();
	const logs = [];
	let clock = 1_000;
	const groupKills = [];
	const killGroup = (pid, sig) => {
		groupKills.push([pid, sig]);
		const child = children.find((c) => c.pid === pid);
		queueMicrotask(() => child?.emit("close", null, sig));
	};
	const spawner = makeDoctorSpawner({
		cliPath: "/opt/pd/worker/src/cli.mjs",
		execPath: "/usr/bin/node",
		cwd: "/srv/deploy",
		env: { PI_WORKER_NAME: "mini1" },
		intervalMs: 24 * 3600_000,
		log: (event, data) => logs.push([event, data]),
		spawnFn,
		now: () => clock,
		platform: "linux",
		killGroup,
		...timers,
		...extra,
	});
	return { spawner, timers, children, logs, groupKills, tick: (ms) => (clock += ms) };
}

test("start: the first run waits a minute after boot, then one run per interval, both timers unref'd", async () => {
	const { spawner, timers, children } = build();
	spawner.start();
	assert.equal(children.length, 0, "nothing runs at the moment of boot");
	assert.deepEqual(timers.timeouts.map((t) => [t.ms, t.unrefd]), [[DOCTOR_BOOT_DELAY_MS, true]]);
	assert.deepEqual(timers.intervals.map((t) => [t.ms, t.unrefd]), [[24 * 3600_000, true]]);
	spawner.start();
	assert.equal(timers.intervals.length, 1, "a second start arms nothing");
	timers.timeouts[0].fn();
	assert.equal(children.length, 1);
	const [child] = children;
	assert.equal(child.cmd, "/usr/bin/node");
	assert.deepEqual(child.args, ["/opt/pd/worker/src/cli.mjs", "doctor", "--publish", "--by-worker=24"], "never --live, --secrets or --fix; the record names the worker and its real interval");
	assert.deepEqual(child.opts, { cwd: "/srv/deploy", env: { PI_WORKER_NAME: "mini1" }, stdio: ["ignore", "ignore", "pipe"], detached: true }, "its own process group on POSIX");
	assert.equal(child.unrefd, true, "the child never holds the worker open");
	child.emit("close", 0, null);
	await flush();
	timers.intervals[0].fn();
	assert.equal(children.length, 2, "the interval runs it again");
	await spawner.close();
});

test("the log line: doctor's exit code, the time, and whether it published, read from its one stderr prefix only", async () => {
	const { spawner, children, logs, tick } = build();
	const first = spawner.runOnce();
	tick(4200);
	children[0].stderr.emit("data", "some other text /home/rob/secret-path\n");
	children[0].emit("close", 1, null);
	await first;
	const second = spawner.runOnce();
	children[1].stderr.emit("data", `${DOCTOR_PUBLISH_SKIPPED_PREFIX} (Valkey did not take them); ...\n`);
	children[1].emit("close", 0, null);
	await second;
	assert.deepEqual(logs, [
		["doctor_published", { code: 1, signal: null, ms: 4200, published: true }],
		["doctor_published", { code: 0, signal: null, ms: 0, published: false }],
	]);
	assert.doesNotMatch(JSON.stringify(logs), /home|secret|Valkey/, "nothing doctor wrote reaches the log");
	await spawner.close();
});

test("no overlap: a tick while a run is in flight starts nothing and says so", async () => {
	const { spawner, children, logs } = build();
	const run = spawner.runOnce();
	await spawner.runOnce();
	assert.equal(children.length, 1);
	assert.deepEqual(logs[0], ["doctor_overlapped", {}]);
	children[0].emit("close", 0, null);
	await run;
	await spawner.close();
});

test("a wedged run is killed at its bound and logged as a failure, and the next tick may run again", async () => {
	const { spawner, timers, children, logs, groupKills } = build();
	const run = spawner.runOnce();
	const kill = timers.timeouts.find((t) => t.ms === DOCTOR_RUN_TIMEOUT_MS);
	assert.ok(kill, "the run carries its own bound");
	assert.equal(kill.unrefd, undefined, "and the bound is NOT unref'd: it must fire when the hung child is all that is left");
	kill.fn();
	await run;
	assert.deepEqual(groupKills, [[children[0].pid, "SIGKILL"]], "the whole group, so what doctor started dies with it");
	assert.deepEqual(children[0].kills, []);
	assert.deepEqual(logs.map((l) => l[0]), ["doctor_spawn_failed"]);
	assert.equal(logs[0][1].reason, "timeout");
	spawner.runOnce();
	assert.equal(children.length, 2, "a killed run does not block the next");
	children[1].emit("close", 0, null);
	await spawner.close();
});

test("a spawn that fails is one log line naming its code, never a throw out of the timer", async () => {
	const throwing = build({
		spawnFn: () => {
			throw Object.assign(new Error("nope"), { code: "EACCES" });
		},
	});
	await throwing.spawner.runOnce();
	assert.deepEqual(throwing.logs, [["doctor_spawn_failed", { reason: "EACCES" }]]);
	const erroring = build();
	const run = erroring.spawner.runOnce();
	erroring.children[0].emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
	await run;
	assert.deepEqual(erroring.logs, [["doctor_spawn_failed", { reason: "ENOENT" }]]);
});

test("close: clears both timers, kills a run in flight, says nothing after, and starts nothing after", async () => {
	const { spawner, timers, children, logs, groupKills } = build();
	spawner.start();
	timers.timeouts[0].fn();
	assert.equal(children.length, 1);
	await spawner.close();
	assert.deepEqual(groupKills, [[children[0].pid, "SIGKILL"]]);
	assert.equal(timers.intervals[0].cleared, true);
	assert.deepEqual(logs, [], "a run ended by the shutdown is not reported through the boot's log");
	await spawner.runOnce();
	timers.intervals[0].fn();
	assert.equal(children.length, 1, "nothing spawns after close");
	await spawner.close();
	const early = build();
	early.spawner.start();
	await early.spawner.close();
	assert.equal(early.timers.timeouts[0].cleared, true, "a close before the first run clears the boot delay");
});

test("a non-positive interval arms nothing", () => {
	for (const intervalMs of [0, -1, Number.NaN, undefined]) {
		const { spawner, timers } = build({ intervalMs });
		spawner.start();
		assert.equal(timers.timeouts.length + timers.intervals.length, 0, String(intervalMs));
	}
});

test("Windows: no process group, so the plain kill, and no detached spawn; a group kill that throws falls back to it", async () => {
	const win = build({ platform: "win32" });
	const run = win.spawner.runOnce();
	assert.equal(win.children[0].opts.detached, undefined);
	await win.spawner.close();
	await run;
	assert.deepEqual(win.children[0].kills, ["SIGKILL"]);
	assert.deepEqual(win.groupKills, []);
	const gone = build({
		killGroup: () => {
			throw Object.assign(new Error("no such process"), { code: "ESRCH" });
		},
	});
	gone.spawner.runOnce();
	await gone.spawner.close();
	assert.deepEqual(gone.children[0].kills, ["SIGKILL"]);
});

test("a free question first: no answer of yes starts no child, and a question that fails starts none either (issue #796)", async () => {
	const answers = [false, new Error("valkey down"), true];
	const made = build({ args: ["updates", "reconcile"], shouldRun: async () => { const next = answers.shift(); if (next instanceof Error) throw next; return next; } });
	await made.spawner.runOnce();
	assert.equal(made.children.length, 0, "nothing to do");
	await made.spawner.runOnce();
	assert.equal(made.children.length, 0, "could not ask: the next tick");
	const running = made.spawner.runOnce();
	await flush();
	assert.equal(made.children.length, 1, "asked for, and started");
	assert.deepEqual(made.children[0].args.slice(1), ["updates", "reconcile"]);
	made.children[0].emit("close", 0, null);
	await running;
});

test("the not-published line is found at the END of a long stderr, which a kept head would have cut off", async () => {
	const { spawner, children, logs } = build();
	const run = spawner.runOnce();
	children[0].stderr.emit("data", "x".repeat(10_000));
	children[0].stderr.emit("data", `\n${DOCTOR_PUBLISH_SKIPPED_PREFIX} (Valkey did not take them)\n`);
	children[0].emit("close", 0, null);
	await run;
	assert.equal(logs[0][1].published, false);
	await spawner.close();
});

// Issue #1021: a run killed at its bound leaves what its cleanups would have removed, and the host publishes no result
// until the next run, so one extra run follows it: doubling per killed run in a row, capped at the interval, reset by a
// run that finishes.
const RETRY = 15 * 60_000;
const fire = (t) => {
	t.fired = true;
	t.fn();
};
const killTimerOf = (timers) => timers.timeouts.filter((t) => t.ms === DOCTOR_RUN_TIMEOUT_MS && !t.cleared && !t.fired).at(-1);
const retriesOf = (timers) => timers.timeouts.filter((t) => t.ms !== DOCTOR_RUN_TIMEOUT_MS && t.ms !== DOCTOR_BOOT_DELAY_MS);

test("a run killed at its bound is retried after retryAfterKillMs, doubling per killed run up to the interval, reset by a run that finishes (issue #1021)", async () => {
	const { spawner, timers, children, logs } = build({ retryAfterKillMs: RETRY, intervalMs: 100 * 60_000 });
	void spawner.runOnce();
	const delays = [];
	for (let i = 0; i < 4; i++) {
		fire(killTimerOf(timers));
		await flush();
		const retry = retriesOf(timers).at(-1);
		assert.equal(retry.unrefd, true, "the retry never holds the worker open");
		delays.push(retry.ms);
		assert.deepEqual(logs.at(-1), ["doctor_spawn_failed", { reason: "timeout", ms: 0, retryMs: retry.ms }], "the line says when the retry is due");
		fire(retry);
		assert.equal(children.length, i + 2, "the retry starts a run");
	}
	assert.deepEqual(delays, [RETRY, 2 * RETRY, 4 * RETRY, 100 * 60_000], "15, 30, 60 minutes, then the interval caps it");
	// The run the last retry started finishes; the next killed run starts again from the first delay.
	children.at(-1).emit("close", 0, null);
	await flush();
	assert.deepEqual(logs.at(-1)[0], "doctor_published");
	void spawner.runOnce();
	fire(killTimerOf(timers));
	await flush();
	assert.equal(logs.at(-1)[1].retryMs, RETRY, "a finished run resets the doubling");
	await spawner.close();
});

test("a pending retry is cleared by the run that starts before it and by close, never overlaps a run, and only a kill at the bound arms one (issue #1021)", async () => {
	const { spawner, timers, children, logs } = build({ retryAfterKillMs: RETRY });
	spawner.start();
	void spawner.runOnce();
	fire(killTimerOf(timers));
	await flush();
	const [retry] = retriesOf(timers);
	assert.equal(retry.ms, RETRY);
	// The interval's own tick comes first: its run supersedes the retry, which then cannot start a second one beside it.
	timers.intervals[0].fn();
	assert.equal(children.length, 2);
	assert.equal(retry.cleared, true, "the run that started is the retry");
	children[1].emit("close", 0, null);
	await flush();
	// A run that finishes, even with doctor's own exit 1, arms nothing.
	void spawner.runOnce();
	children[2].emit("close", 1, null);
	await flush();
	assert.equal(retriesOf(timers).length, 1, "only the first kill armed a retry");
	assert.equal(logs.filter((l) => l[0] === "doctor_overlapped").length, 0, "and nothing ever overlapped");
	// Killed again, then the worker stops: close clears the pending retry, and one that fires anyway starts nothing.
	void spawner.runOnce();
	fire(killTimerOf(timers));
	await flush();
	const pending = retriesOf(timers).at(-1);
	assert.notEqual(pending, retry);
	assert.equal(pending.cleared, false);
	await spawner.close();
	assert.equal(pending.cleared, true, "close clears it");
	pending.fn();
	assert.equal(children.length, 4, "nothing starts after close");
});

test("no retry without the option, at a non-positive interval, or for a run the shutdown killed (issue #1021)", async () => {
	const armed = build({ retryAfterKillMs: RETRY });
	void armed.spawner.runOnce();
	fire(killTimerOf(armed.timers));
	await flush();
	assert.deepEqual(armed.timers.timeouts.map((t) => t.ms), [DOCTOR_RUN_TIMEOUT_MS, RETRY], "with the option and an interval, a kill arms one");
	await armed.spawner.close();
	for (const extra of [{}, { retryAfterKillMs: RETRY, intervalMs: 0 }, { args: ["updates", "look"], events: { overlapped: "updates_look_overlapped", spawnFailed: "updates_look_failed", finished: "updates_look_finished" } }]) {
		const { spawner, timers, logs } = build(extra);
		void spawner.runOnce();
		fire(killTimerOf(timers));
		await flush();
		assert.deepEqual(timers.timeouts.map((t) => t.ms), [DOCTOR_RUN_TIMEOUT_MS], JSON.stringify(extra));
		assert.deepEqual(logs, [[extra.events?.spawnFailed ?? "doctor_spawn_failed", { reason: "timeout", ms: 0 }]], "and the line names no retry");
		await spawner.close();
	}
	const { spawner, timers } = build({ retryAfterKillMs: RETRY });
	void spawner.runOnce();
	await spawner.close();
	assert.deepEqual(timers.timeouts.map((t) => t.ms), [DOCTOR_RUN_TIMEOUT_MS], "a run the shutdown killed is not retried");
});

test("a run killed at its bound whose end lands after close arms no retry (issue #1021)", async () => {
	// The child's own close event arrives after the worker said it stopped: nothing may be armed past the closer.
	const { spawner, timers, children, logs } = build({ retryAfterKillMs: RETRY, killGroup: () => {} });
	void spawner.runOnce();
	fire(killTimerOf(timers));
	const closing = spawner.close();
	children[0].emit("close", null, "SIGKILL");
	await closing;
	assert.deepEqual(timers.timeouts.map((t) => t.ms), [DOCTOR_RUN_TIMEOUT_MS], "no retry armed after close");
	assert.deepEqual(logs, []);
});

test("issue #1040: after a run killed at its bound has ended, afterKill gets that child's pid and a log that is silent after close; never for a run that finished, one close() killed, or without the option", async () => {
	const calls = [];
	const afterKill = (pid, say) => {
		calls.push(pid);
		say("doctor_helper_not_removed", { pid, reason: "timeout" });
	};
	const { spawner, timers, children, logs, groupKills } = build({ afterKill });
	const run = spawner.runOnce();
	fire(killTimerOf(timers));
	await run;
	await flush();
	assert.deepEqual(groupKills, [[children[0].pid, "SIGKILL"]]);
	assert.deepEqual(calls, [children[0].pid], "the killed child's own pid, the one its doctor named its helper after");
	assert.deepEqual(logs.map((l) => l[0]), ["doctor_spawn_failed", "doctor_helper_not_removed"], "what the hook says goes through the spawner's log");
	// A run that finishes calls nothing.
	const finished = spawner.runOnce();
	children[1].emit("close", 0, null);
	await finished;
	await flush();
	assert.deepEqual(calls, [children[0].pid]);
	// A run close() killed calls nothing: the worker is stopping.
	void spawner.runOnce();
	await spawner.close();
	await flush();
	assert.deepEqual(calls, [children[0].pid], "not after a shutdown kill");
	// A run killed at its bound whose end lands after close: nothing either.
	const late = build({ afterKill: (pid) => calls.push(pid), killGroup: () => {} });
	void late.spawner.runOnce();
	fire(killTimerOf(late.timers));
	const closing = late.spawner.close();
	late.children[0].emit("close", null, "SIGKILL");
	await closing;
	await flush();
	assert.deepEqual(calls, [children[0].pid]);
	// A hook that answers after close says nothing, and one that throws is not thrown out of the spawner.
	let release;
	const slow = build({ afterKill: (pid, say) => new Promise((resolve) => (release = () => resolve(say("doctor_helper_not_removed", { pid, reason: "timeout" })))) });
	const slowRun = slow.spawner.runOnce();
	fire(killTimerOf(slow.timers));
	await slowRun;
	await flush();
	await slow.spawner.close();
	release();
	await flush();
	assert.deepEqual(slow.logs.map((l) => l[0]), ["doctor_spawn_failed"], "silent after close");
	const throwing = build({ afterKill: () => {
		throw new Error("x");
	} });
	const thrown = throwing.spawner.runOnce();
	fire(killTimerOf(throwing.timers));
	await thrown;
	await flush();
	assert.deepEqual(throwing.logs.map((l) => l[0]), ["doctor_spawn_failed"]);
	// Without the option a kill at the bound is what it was.
	const plain = build();
	const plainRun = plain.spawner.runOnce();
	fire(killTimerOf(plain.timers));
	await plainRun;
	assert.deepEqual(plain.logs, [["doctor_spawn_failed", { reason: "timeout", ms: 0 }]]);
});
