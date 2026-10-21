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
