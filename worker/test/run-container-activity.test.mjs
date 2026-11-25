import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
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
function watchedRun({ activityWatch = { idleMs: 15 * MIN, stallMs: 240 * MIN, keepWallClock: false }, stageLive, credentialRefresh = null, subscriptionAuth = [], makeCredentialDirectory, stageRun, openLiveTranscript = null, job = JOB, checkpoint = null, recover = false } = {}) {
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
		...(makeCredentialDirectory ? { makeCredentialDirectory } : {}),
		...(stageRun ? { stageRun: (args) => stageRun(args, h) } : {}),
		openLiveTranscript,
	});
	const done = run({
		job,
		prepared,
		name: "pi-job-act-1",
		jobId: "act-1",
		subscriptionAuth,
		checkpoint,
		recover,
		activityWatch,
		onActivityArmed: () => (h.armed += 1),
		requestStop: (reason) => h.stops.push(reason),
		noteActivity: (fields) => h.noted.push(fields),
		...(credentialRefresh ? { credentialRefresh } : {}),
	});
	h.tick = (ms) => {
		h.t += ms;
		for (const fn of h.ticks) fn();
	};
	return { h, recorder, done, jobDir, prepared };
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

test("issue #888, part 3: an expiring credential with a renewal armed is mounted read-only, and the wall clock is handed over after all", { skip }, async () => {
	const credentialRefresh = { forge: { expiresAt: Date.now() + 3_600_000, mint: async () => ({ token: "ghs_x", expiresAt: Date.now() + 7_200_000 }) }, subscriptions: [], extend: async () => null };
	const { h, recorder, done, jobDir } = watchedRun({ activityWatch: { idleMs: 15 * MIN, stallMs: null, keepWallClock: true, why: "forge-token" }, credentialRefresh });
	await new Promise((resolve) => setImmediate(resolve));
	const folder = `${jobDir}.credentials`;
	assert.ok(recorder.args.includes(`${folder}:/run/pi-dispatch/credentials:ro`), recorder.args.join(" "));
	assert.equal(envOf(recorder.args).PI_CREDENTIAL_REFRESH, "1");
	assert.equal(h.armed, 1, "renewed credentials no longer need the 30-minute bound");
	recorder.close(0);
	await done;
	const { existsSync } = await import("node:fs");
	assert.equal(existsSync(folder), false, "the folder goes with the run");
});

test("issue #888, part 3: an expiring credential with no renewal keeps the wall clock, and the record says why", { skip }, async () => {
	const { h, recorder, done } = watchedRun({ activityWatch: { idleMs: 15 * MIN, stallMs: null, keepWallClock: true, why: "subscription" } });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(envOf(recorder.args).PI_CREDENTIAL_REFRESH, undefined);
	assert.equal(h.armed, 0);
	assert.ok(h.noted.some((n) => n.basis === "wall-clock" && n.why === "subscription"), JSON.stringify(h.noted));
	recorder.close(0);
	await done;
});

const leaseSnapshot = () => ({ provider: "openai", connectionId: "chatgpt", adapter: "openai-chatgpt", generation: 1, renewable: true, expiresAt: 1_000_000 + 60 * MIN, deadlineAt: 1_000_000 + 30 * MIN, env: { OPENAI_API_KEY: "opaque.original.access.value" } });
const leaseJob = { kind: "local", provider: "openai", model: "gpt-4.1", maxTurns: 5 };

test("a short subscription lease never starts when its renewal folder or activity channel cannot be armed", { skip }, async () => {
	for (const options of [{ makeCredentialDirectory: () => null }, { stageLive: () => null }, { credentialRefresh: null }]) {
		const snapshot = leaseSnapshot();
		const h = watchedRun({ job: leaseJob, subscriptionAuth: [snapshot], credentialRefresh: { subscriptions: [snapshot], extend: async () => null }, ...options });
		await assert.rejects(h.done, (error) => error.reason === "container-never-started");
		assert.equal(h.recorder.args, undefined, "no paid container starts on the legacy wall-clock fallback");
		assert.equal(existsSync(`${h.jobDir}.credentials`), false);
	}
});

test("a lease consumed during venue preparation refuses before spawn and removes its drop folder", { skip }, async () => {
	for (const elapsed of [0, 1]) {
		const snapshot = leaseSnapshot();
		const h = watchedRun({ job: leaseJob, subscriptionAuth: [snapshot], credentialRefresh: { subscriptions: [snapshot], extend: async () => null }, stageRun: (_args, state) => { state.t = snapshot.deadlineAt - 4 * MIN + elapsed; } });
		await assert.rejects(h.done, (error) => error.reason === "container-never-started");
		assert.equal(h.recorder.args, undefined);
		assert.equal(existsSync(`${h.jobDir}.credentials`), false);
	}
});

test("rotated opaque access is registered before publication in live, question and checkpoint consumers, retaining prior values", { skip }, async () => {
	const snapshot = leaseSnapshot();
	const replacement = "opaque.rotated.access.value";
	const checkpoint = { runId: "act-1", baseSha: "a".repeat(40), secretValues: ["existing.workspace.secret"] };
	let opened;
	const h = watchedRun({
		job: leaseJob,
		subscriptionAuth: [snapshot],
		checkpoint,
		recover: true,
		activityWatch: { idleMs: 120 * MIN, stallMs: 240 * MIN, keepWallClock: true, why: "subscription" },
		openLiveTranscript: (options) => { opened = options; return { start() {}, async finish() {} }; },
		credentialRefresh: { subscriptions: [snapshot], extend: async (current, { deadlineAt }) => ({ ...current, generation: 2, deadlineAt, expiresAt: deadlineAt + 20 * MIN, env: { OPENAI_API_KEY: replacement } }) },
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(opened.checkpoint.secretValues, checkpoint.secretValues, "the scanner keeps this collection by reference");
	h.h.tick(20 * MIN);
	await new Promise((resolve) => setImmediate(resolve));
	const content = `${snapshot.env.OPENAI_API_KEY} ${replacement} existing.workspace.secret`;
	assert.equal(opened.redact(content), "[redacted] [redacted] [redacted]");
	assert.equal(h.prepared.questionRedact(content), "[redacted] [redacted] [redacted]");
	assert.ok(opened.checkpoint.secretValues.includes(replacement), "a checkpoint after rotation scans the new bearer");
	assert.ok(opened.checkpoint.secretValues.includes(snapshot.env.OPENAI_API_KEY), "old output and files remain protected");
	assert.equal(Object.keys(h.prepared).includes("questionRedact"), false);
	assert.equal(h.prepared.credentialSecretValues, checkpoint.secretValues, "the final fork snapshot shares the same retained values");
	assert.equal(Object.keys(h.prepared).includes("credentialSecretValues"), false, "private values cannot become preparation telemetry");
	const drop = JSON.parse((await import("node:fs")).readFileSync(`${h.jobDir}.credentials/current.json`, "utf8"));
	assert.equal(drop.subscriptions[0].token, replacement, "the same replacement is published only after registration");
	assert.equal(JSON.stringify(h.h.logs).includes(replacement), false);
	h.recorder.close(0);
	await h.done;
	assert.equal(h.prepared.questionRedact(replacement), "[redacted]", "the final transcript consumer sees all credentials after the run ends");
});

test("watch output uses the updated credential redactor after rotation", { skip }, async () => {
	const snapshot = leaseSnapshot();
	const replacement = "opaque.watch.replacement.access";
	const h = watchedRun({ job: { ...leaseJob, watch: { mode: "investigate" } }, subscriptionAuth: [snapshot], activityWatch: { idleMs: 120 * MIN, stallMs: null, keepWallClock: true }, credentialRefresh: { subscriptions: [snapshot], extend: async (current, { deadlineAt }) => ({ ...current, generation: 2, deadlineAt, expiresAt: deadlineAt + 20 * MIN, env: { OPENAI_API_KEY: replacement } }) } });
	await new Promise((resolve) => setImmediate(resolve));
	h.h.tick(20 * MIN);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(h.prepared.watchRedact(`${snapshot.env.OPENAI_API_KEY} ${replacement}`), "[redacted] [redacted]");
	assert.ok(h.prepared.credentialSecretValues.includes(replacement), "values remain available even without a live checkpoint");
	h.recorder.close(0);
	await h.done;
});

/** A plain run (no watch) with an optional `timeLimit`, recording the argv. */
function timedRun(timeLimit) {
	const recorder = {};
	const jobDir = tempDir("time-limit-run-");
	const run = mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, spawnFn: heldSpawn(recorder), log: () => {} });
	const done = run({ job: JOB, prepared: { workspace: jobDir, jobDir }, name: "pi-job-time-1", jobId: "time-1", ...(timeLimit !== undefined ? { timeLimit } : {}) });
	return { recorder, done };
}

test("issue #1055: the job's ceiling and what is left of it are read when the environment is built, as two durations, and a reader that fails hands nothing", { skip }, async () => {
	let reads = 0;
	const { recorder, done } = timedRun({ limitMs: 60 * MIN, left: () => ((reads += 1), 42 * MIN + 0.75) });
	await new Promise((resolve) => setImmediate(resolve));
	const env = envOf(recorder.args);
	assert.deepEqual([env.PI_JOB_MAX_MS, env.PI_JOB_LEFT_MS, reads], [String(60 * MIN), String(42 * MIN), 1], "floored, read once");
	recorder.close(0);
	await done;
	for (const [timeLimit, why] of [[undefined, "no ceiling"], [null, "none handed"], [{ limitMs: 60 * MIN, left: () => { throw new Error("clock"); } }, "a reader that throws"], [{ limitMs: 60 * MIN, left: () => Number.NaN }, "not a number"], [{ limitMs: 60 * MIN, left: () => 0 }, "nothing left"]]) {
		const quiet = timedRun(timeLimit);
		await new Promise((resolve) => setImmediate(resolve));
		const quietEnv = envOf(quiet.recorder.args);
		assert.deepEqual([quietEnv.PI_JOB_MAX_MS, quietEnv.PI_JOB_LEFT_MS], [undefined, undefined], why);
		quiet.recorder.close(0);
		await quiet.done;
	}
});
