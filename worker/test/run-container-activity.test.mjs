import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";

// run-container imports env-allowlist -> @earendil-works/pi-ai, so this skips below the node floor and runs in CI
// (PI_DISPATCH_REQUIRE_WORKER_TESTS=1 makes a skip a hard failure), run-container.test.mjs's rule.
let mod;
let importError;
try {
	mod = await import("../src/run-container.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error(`run-container tests are REQUIRED here but pi-ai could not import.\n${importError}`);
const skip = mod ? false : `pi-ai not installed (node ${process.version} < 22.19.0); CI runs these`;

const HOST = { ANTHROPIC_API_KEY: "sk-real" };
const JOB = { kind: "local", provider: "anthropic", model: "m", maxTurns: 5 };
const MIN = 60_000;

/** A `docker` child the test ends by hand (`close(code)`), recording the argv. */
function heldSpawn(recorder) {
	return (cmd, args) => {
		recorder.args = args;
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		recorder.close = (code) => child.emit("close", code);
		return child;
	};
}

const envOf = (args) => Object.fromEntries(args.flatMap((arg, i, all) => (arg === "-e" ? [all[i + 1].split(/=(.*)/s).slice(0, 2)] : [])));

/** A run with the watch asked for, on a binding venue, with a fake clock and a timer the test ticks. */
function watchedRun({ activityWatch = { idleMs: 15 * MIN, stallMs: 240 * MIN, keepWallClock: false }, stageLive } = {}) {
	const recorder = {};
	const h = { t: 1_000_000, ticks: [], armed: 0, stops: [], noted: [], logs: [] };
	const jobDir = tempDir("activity-run-");
	const prepared = { workspace: jobDir, jobDir };
	const run = mod.makeRunContainer({
		image: "pi-job:x",
		hostEnv: HOST,
		spawnFn: heldSpawn(recorder),
		log: (event, fields) => h.logs.push({ event, ...fields }),
		activityClock: () => h.t,
		activityTimers: { setInterval: (fn) => (h.ticks.push(fn), { unref() {} }), clearInterval: () => (h.ticks = []) },
		...(stageLive ? { stageLive } : {}),
	});
	const done = run({
		job: JOB,
		prepared,
		name: "pi-job-act-1",
		activityWatch,
		onActivityArmed: () => (h.armed += 1),
		requestStop: (reason) => h.stops.push(reason),
		noteActivity: (fields) => h.noted.push(fields),
	});
	h.tick = (ms) => {
		h.t += ms;
		for (const fn of h.ticks) fn();
	};
	return { h, recorder, done, jobDir };
}

test("a watched run on a binding venue stages the transcript, hands the runner its limits and the wall clock over to the watch", { skip }, async () => {
	const { h, recorder, done } = watchedRun();
	await new Promise((resolve) => setImmediate(resolve));
	const env = envOf(recorder.args);
	assert.equal(env.PI_JOB_IDLE_MS, String(15 * MIN));
	assert.equal(env.PI_JOB_STALL_MS, String(240 * MIN));
	assert.equal(env.PI_SESSION_FILE, "/session/current.jsonl", "the counters' directory is mounted");
	assert.equal(h.armed, 1, "the wall clock is handed over at the spawn");
	recorder.close(0);
	await done;
	assert.equal(h.noted.length, 1);
	assert.equal(h.noted[0].channel, "file");
});

test("the backstop reads the counters beside the session file and stops a run whose counters stopped changing", { skip }, async () => {
	const { h, recorder, done, jobDir } = watchedRun();
	await new Promise((resolve) => setImmediate(resolve));
	const counters = join(jobDir, "session", "activity.json");
	writeFileSync(counters, '{"v":1,"steps":1,"active":1}\n');
	h.tick(15_000);
	// Activity every minute keeps it going well past the idle limit.
	for (let m = 1; m <= 30; m++) {
		writeFileSync(counters, `{"v":1,"steps":1,"active":${1 + m}}\n`);
		h.tick(MIN);
	}
	assert.deepEqual(h.stops, []);
	// Then nothing: stopped at the idle limit plus the grace, once.
	for (let m = 0; m < 18; m++) h.tick(MIN);
	assert.deepEqual(h.stops, ["idle"]);
	assert.ok(h.logs.some((l) => l.event === "activity_backstop_stop" && l.reason === "idle"));
	recorder.close(143);
	await done;
	assert.equal(h.noted[0].channel, "file");
	assert.match(h.noted[0].lastActivityAt, /^\d{4}-\d\d-\d\dT/);
});

test("a run that must keep its wall clock is watched but never hands it over", { skip }, async () => {
	const { h, recorder, done } = watchedRun({ activityWatch: { idleMs: 15 * MIN, stallMs: null, keepWallClock: true } });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(envOf(recorder.args).PI_JOB_IDLE_MS, String(15 * MIN), "the runner still stops it when idle");
	assert.equal(envOf(recorder.args).PI_JOB_STALL_MS, undefined);
	assert.equal(h.armed, 0);
	recorder.close(0);
	await done;
});

test("with no channel for the counters the runner is asked for nothing and the reason is said", { skip }, async () => {
	const { h, recorder, done } = watchedRun({ stageLive: () => {
		throw new Error("no room");
	} });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(envOf(recorder.args).PI_JOB_IDLE_MS, undefined);
	assert.equal(h.armed, 0, "the job keeps the wall clock");
	assert.ok(h.logs.some((l) => l.event === "idle_watch_unavailable" && l.reason === "no-transcript"));
	recorder.close(0);
	await done;
	assert.deepEqual(h.noted, [{ channel: null, unavailable: "no-transcript" }]);
});

test("without the watch asked for, the run is exactly as before: no variable, no hand-over, nothing noted", { skip }, async () => {
	const recorder = {};
	const noted = [];
	let armed = 0;
	const run = mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, spawnFn: heldSpawn(recorder) });
	const done = run({ job: JOB, prepared: { workspace: "/host/w", jobDir: "/host/jobs/j9" }, name: "pi-job-act-9", onActivityArmed: () => (armed += 1), noteActivity: (f) => noted.push(f) });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(envOf(recorder.args).PI_JOB_IDLE_MS, undefined);
	recorder.close(0);
	await done;
	assert.equal(armed, 0);
	assert.deepEqual(noted, []);
});
