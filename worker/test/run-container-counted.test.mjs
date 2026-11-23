import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { makeContainerActivity } from "../src/container-activity.mjs";

// Issue #1023: every run reports through the worker's count of its job containers (container-activity.mjs), which the
// sandbox retention sweep reads. run-container imports env-allowlist -> @earendil-works/pi-ai, so this skips below the
// node floor and runs in CI, as run-container.test.mjs does.
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
const PREPARED = { workspace: "/host/folder", jobDir: "/host/jobs/j1" };
const ABORTED = { code: 137, aborted: true, turns: null, tokens: null, session: null, usage: null, context: null, exitReason: null };
const fs = { readFileSync: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }, rmSync() {}, statSync: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } };

/**
 * The REAL count, with every report recorded in order beside what the test's own fakes note (`spawn:<what>`, `data`,
 * `close`), and the two counts read at each of those points: `[starting, running]`.
 */
function counted() {
	const real = makeContainerActivity({ now: () => 0 });
	const events = [];
	const at = (what) => events.push([what, real.starting(), real.running()]);
	const containerActivity = {
		enter() {
			const run = real.enter();
			at("enter");
			return {
				started() {
					run.started();
					at("started");
				},
				ended() {
					run.ended();
					at("ended");
				},
			};
		},
		starting: () => real.starting(),
		running: () => real.running(),
	};
	// One `started` per run in what a test reads: the report is made on every chunk and again at the child's end.
	const story = () => events.filter(([what], i) => what !== "started" || events.findIndex(([w]) => w === "started") === i);
	return { containerActivity, at, story, counts: () => [real.starting(), real.running()] };
}

/** A CLI child per spawn. `run` answers the job's own child; every other spawn (a network step) exits `step`. */
function cli(c, { run = { chunks: ["out\n"], exit: 0 }, step = 0, onRun = () => {} } = {}) {
	return (cmd, args) => {
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		const isRun = args[0] === "run" || args.includes("exec");
		c.at(`spawn:${isRun ? "run" : args.slice(0, 2).join(" ")}`);
		queueMicrotask(() => {
			if (!isRun) return child.emit("close", step);
			onRun();
			if (run.error) return child.emit("error", run.error);
			for (const chunk of run.chunks ?? []) {
				child.stdout.emit("data", chunk);
				c.at("data");
			}
			child.emit("close", run.exit ?? 0);
			c.at("close");
		});
		return child;
	};
}

const bag = (signal = new AbortController().signal) => ({ job: JOB, prepared: PREPARED, name: "pi-job-j1", signal });

test("a run is starting from its first step, running from its container's first output, and counted no more once it has ended (issue #1023)", { skip }, async () => {
	const c = counted();
	const run = mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, fs, spawnFn: cli(c, { run: { chunks: ["one\n", "two\n"], exit: 0 } }), containerActivity: c.containerActivity });
	const result = await run(bag());
	assert.equal(result.code, 0);
	assert.deepEqual(c.story(), [
		["enter", 1, 0],
		["spawn:run", 1, 0],
		["started", 0, 1],
		["data", 0, 1],
		["data", 0, 1],
		["close", 0, 1],
		["ended", 0, 0],
	]);
});

test("a container that writes nothing is running from its CLI child's end (issue #1023)", { skip }, async () => {
	const c = counted();
	const run = mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, fs, spawnFn: cli(c, { run: { chunks: [], exit: 2 } }), containerActivity: c.containerActivity });
	assert.equal((await run(bag())).code, 2);
	assert.deepEqual(c.story(), [["enter", 1, 0], ["spawn:run", 1, 0], ["started", 0, 1], ["close", 0, 1], ["ended", 0, 0]]);
});

test("every way a run ends before or without a container ends the count, and none says started (issue #1023)", { skip }, async () => {
	// Stopped before it began: the early return, before any step.
	const before = counted();
	const ac = new AbortController();
	ac.abort();
	assert.deepEqual(await mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, fs, spawnFn: cli(before), containerActivity: before.containerActivity })(bag(ac.signal)), ABORTED);
	assert.deepEqual(before.story(), [["enter", 1, 0], ["ended", 0, 0]]);

	// A throw before any runtime call: an unconfigured provider.
	const unconfigured = counted();
	await assert.rejects(mod.makeRunContainer({ image: "pi-job:x", hostEnv: {}, fs, spawnFn: cli(unconfigured), containerActivity: unconfigured.containerActivity })(bag()));
	assert.deepEqual(unconfigured.story(), [["enter", 1, 0], ["ended", 0, 0]]);

	// The attempt's first runtime call fails: the job's network would not build. It was counted as starting when asked.
	const network = counted();
	await assert.rejects(mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, fs, egress: true, spawnFn: cli(network, { step: 1 }), containerActivity: network.containerActivity })(bag()), (err) => err.reason === "container-never-started");
	assert.deepEqual(network.story(), [["enter", 1, 0], ["spawn:network create", 1, 0], ["ended", 0, 0]]);

	// A venue's stage throws (a sandbox that would not be created), and one a stop cut short.
	const stage = counted();
	await assert.rejects(mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, fs, spawnFn: cli(stage), stageRun: async () => { stage.at("stage"); throw new Error("create failed"); }, teardownRun: async () => stage.at("teardown"), containerActivity: stage.containerActivity })(bag()), (err) => err.reason === "container-never-started");
	assert.deepEqual(stage.story(), [["enter", 1, 0], ["stage", 1, 0], ["teardown", 1, 0], ["ended", 0, 0]]);
	const cut = counted();
	const stop = new AbortController();
	assert.deepEqual(await mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, fs, spawnFn: cli(cut), stageRun: async () => stop.abort(), teardownRun: async () => {}, containerActivity: cut.containerActivity })(bag(stop.signal)), ABORTED);
	assert.deepEqual(cut.story(), [["enter", 1, 0], ["ended", 0, 0]]);
});

test("a CLI that cannot be started, a worker's stop and a job's timeout each end the count (issue #1023)", { skip }, async () => {
	// The runtime's CLI is not there: the child errors and never closes. It is no start any more, then gone.
	const missing = counted();
	await assert.rejects(mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, fs, spawnFn: cli(missing, { run: { error: new Error("spawn docker ENOENT") } }), containerActivity: missing.containerActivity })(bag()), (err) => err.reason === "container-never-started");
	assert.deepEqual(missing.story(), [["enter", 1, 0], ["spawn:run", 1, 0], ["started", 0, 1], ["ended", 0, 0]]);

	// The worker stops the container (a shutdown, or the job's timeout: both abort the signal and the CLI exits 137).
	for (const chunks of [["working\n"], []]) {
		const stopped = counted();
		const ac = new AbortController();
		const result = await mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, fs, spawnFn: cli(stopped, { run: { chunks, exit: 137 }, onRun: () => ac.abort() }), containerActivity: stopped.containerActivity })(bag(ac.signal));
		assert.deepEqual([result.code, result.aborted], [137, true]);
		assert.deepEqual(stopped.story().at(-1), ["ended", 0, 0]);
		assert.deepEqual(stopped.story().filter(([what]) => what === "started"), [["started", 0, 1]]);
	}
});

test("a run is counted to the end of its teardown: a copying venue's download and the network's removal are still beside the sweep (issue #1023)", { skip }, async () => {
	const c = counted();
	const run = mod.makeRunContainer({
		image: "pi-job:x",
		hostEnv: HOST,
		fs,
		egress: true,
		spawnFn: cli(c),
		stageRun: async () => c.at("stage"),
		collectRun: async (result) => (c.at("collect"), result),
		teardownRun: async () => c.at("teardown"),
		containerActivity: c.containerActivity,
	});
	assert.equal((await run(bag())).code, 0);
	const story = c.story().map(([what]) => what);
	assert.deepEqual(story.slice(0, 2), ["enter", "spawn:network create"], "counted before the attempt's first runtime call");
	assert.ok(story.indexOf("stage") < story.indexOf("spawn:run") && story.indexOf("spawn:run") < story.indexOf("started"));
	assert.deepEqual(c.story().find(([what]) => what === "stage"), ["stage", 1, 0], "the venue's stage is part of the start");
	assert.deepEqual(c.story().find(([what]) => what === "collect"), ["collect", 0, 1]);
	assert.deepEqual(c.story().find(([what]) => what === "teardown"), ["teardown", 0, 1]);
	// The network's teardown asks the runtime again after the child has closed, and the run is still counted then.
	const afterClose = c.story().slice(story.indexOf("close") + 1);
	const teardownSteps = afterClose.filter(([what]) => what.startsWith("spawn:"));
	assert.ok(teardownSteps.length > 0, "the teardown made runtime calls");
	assert.ok(teardownSteps.every(([, starting, running]) => starting === 0 && running === 1), "each beside a run the sweep still sees");
	assert.deepEqual(afterClose.at(-1), ["ended", 0, 0], "and the count ends after the last of them");
});

test("two runs at once are two counts, each ended by its own run (issue #1023)", { skip }, async () => {
	const c = counted();
	const held = [];
	const spawnFn = (cmd, args) => {
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		held.push(child);
		return child;
	};
	const run = mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, fs, spawnFn, containerActivity: c.containerActivity });
	const first = run(bag());
	const second = run({ ...bag(), name: "pi-job-j2", prepared: { workspace: "/host/other", jobDir: "/host/jobs/j2" } });
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(c.counts(), [2, 0]);
	held[0].stdout.emit("data", "up\n");
	assert.deepEqual(c.counts(), [1, 1], "the first is up, the second still starting");
	held[0].emit("close", 0);
	await first;
	assert.deepEqual(c.counts(), [1, 0], "the first is over: only the second is counted");
	held[1].emit("close", 0);
	await second;
	assert.deepEqual(c.counts(), [0, 0]);
});

test("the count is never the job's business: one that throws stops no run and changes no answer, and without one the answer is the same (issue #1023)", { skip }, async () => {
	const plain = await mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, fs, spawnFn: cli(counted(), { run: { chunks: ["x\n"], exit: 2 } }) })(bag());
	const c = counted();
	const withCount = await mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, fs, spawnFn: cli(c, { run: { chunks: ["x\n"], exit: 2 } }), containerActivity: c.containerActivity })(bag());
	assert.deepEqual(withCount, plain, "the same result, key for key");
	const broken = [
		{ enter() { throw new Error("broken"); } },
		{ enter: () => ({ started() { throw new Error("broken"); }, ended() { throw new Error("broken"); } }) },
	];
	for (const containerActivity of broken) {
		const result = await mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, fs, spawnFn: cli(counted(), { run: { chunks: ["x\n"], exit: 2 } }), containerActivity })(bag());
		assert.deepEqual(result, plain);
		// And a failing run still fails as itself, not as the count's fault.
		await assert.rejects(mod.makeRunContainer({ image: "pi-job:x", hostEnv: {}, fs, spawnFn: cli(counted()), containerActivity })(bag()), (err) => !/broken/.test(String(err?.message)));
	}
});

test("without a count the run function is the attempt itself, not a wrapper around it (issue #1023)", { skip }, async () => {
	// Every caller but the worker builds its run function without a count (the canary replay, a bare wiring, most
	// tests), and gets exactly the function it had: an answer the attempt has at once is the caller's at once. A wrapper
	// would settle it a turn later, which is a change for every one of those callers. Told by the order of two answers
	// that are both there without waiting: a job stopped before it began, and a promise that was already resolved.
	const stopped = () => {
		const ac = new AbortController();
		ac.abort();
		return bag(ac.signal);
	};
	const orderOf = async (runContainer) => {
		const order = [];
		const run = runContainer(stopped()).then(() => order.push("run"));
		const turn = Promise.resolve().then(() => order.push("turn"));
		await Promise.all([run, turn]);
		return order;
	};
	const options = { image: "pi-job:x", hostEnv: HOST, fs, spawnFn: cli(counted()) };
	assert.deepEqual(await orderOf(mod.makeRunContainer(options)), ["run", "turn"], "no count: the attempt's own promise");
	assert.deepEqual(await orderOf(mod.makeRunContainer({ ...options, containerActivity: null })), ["run", "turn"], "a count of null is no count");
	// With a count the run is wrapped, so that every exit ends the count: its answer comes after the wrapper's turn.
	const c = counted();
	assert.deepEqual(await orderOf(mod.makeRunContainer({ ...options, containerActivity: c.containerActivity })), ["turn", "run"]);
	assert.deepEqual(c.story().map(([what]) => what), ["enter", "ended"]);
	assert.deepEqual(await mod.makeRunContainer(options)(stopped()), ABORTED);
});
