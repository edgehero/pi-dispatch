import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

// run-container imports env-allowlist -> @earendil-works/pi-ai, so this skips below the node floor
// and runs in CI (PI_DISPATCH_REQUIRE_WORKER_TESTS=1 makes a skip a hard failure).
let mod;
let importError;
try {
	mod = await import("../src/run-container.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`run-container tests are REQUIRED here but pi-ai could not import.\n${importError}`);
}
const skip = mod ? false : `pi-ai not installed (node ${process.version} < 22.19.0); CI runs these`;

const HOST = { ANTHROPIC_API_KEY: "sk-real" };
const JOB = { kind: "local", provider: "anthropic", model: "m", maxTurns: 5 };
const PREPARED = { workspace: "/host/folder", jobDir: "/host/jobs/j1" };

/** A fake `docker` child: records argv, lets the test drive its exit. */
function fakeSpawn(recorder, exitCode = 0) {
	return (cmd, args) => {
		recorder.cmd = cmd;
		recorder.args = args;
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		queueMicrotask(() => child.emit("close", exitCode));
		return child;
	};
}

/** A fake `docker` child modelling a WORKER-initiated stop: the container has already started (so the
 *  entry guard passed), then the worker's onAbort fires `docker stop`, aborting the signal, and the
 *  container exits with `exitCode`. The close handler must see `signal.aborted === true`. */
function fakeSpawnAbortedThenClose(ac, exitCode) {
	return () => {
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		ac.abort();
		queueMicrotask(() => child.emit("close", exitCode));
		return child;
	};
}

/** A `docker` child that streams stdout `data` chunks BEFORE the `close`, so a test can exercise the
 *  tee (onOutput + sink.write) and then observe the resolved result. Chunks arrive in array order. */
function fakeSpawnWithData(recorder, { chunks = [], exitCode = 0 } = {}) {
	return (cmd, args) => {
		recorder.cmd = cmd;
		recorder.args = args;
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		queueMicrotask(() => {
			for (const chunk of chunks) child.stdout.emit("data", chunk);
			child.emit("close", exitCode);
		});
		return child;
	};
}

/** A `docker` child that fails to launch: it emits `error` and NEVER `close`, modelling docker-not-found
 *  / daemon-down. Drives the `container-never-started` InfraRetry path and its best-effort sink teardown. */
function fakeSpawnError(recorder, err = new Error("spawn docker ENOENT")) {
	return (cmd, args) => {
		recorder.cmd = cmd;
		recorder.args = args;
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		queueMicrotask(() => child.emit("error", err));
		return child;
	};
}

/** A recording fake for `openJobLog`: captures every `write` chunk and counts `close` calls, and its
 *  `close` resolves `{ turns }`. `closeDelay` defers the resolve past a `setImmediate`, so a test can
 *  prove `resolve` awaits `close` -- a non-awaited close would leave `turns` at its null default. */
function makeRecordingSink({ turns = null, closeDelay = false } = {}) {
	const writes = [];
	let closeCalls = 0;
	return {
		writes,
		get closeCalls() {
			return closeCalls;
		},
		write(chunk) {
			writes.push(chunk);
		},
		close: async () => {
			closeCalls += 1;
			if (closeDelay) await new Promise((resolve) => setImmediate(resolve));
			return { turns };
		},
	};
}

test("an already-aborted signal returns {code:137, aborted:true} and NEVER spawns docker", { skip }, async () => {
	const rec = {};
	const runContainer = mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, spawnFn: fakeSpawn(rec) });
	const ac = new AbortController();
	ac.abort();
	const result = await runContainer({ job: JOB, prepared: PREPARED, name: "j1", signal: ac.signal });
	assert.deepEqual(result, { code: 137, aborted: true, turns: null, tokens: null, session: null, usage: null, context: null });
	assert.equal(rec.cmd, undefined, "no container may start once the timeout has fired");
});

test("launches docker with the isolation argv and returns the container's exit code", { skip }, async () => {
	const rec = {};
	const runContainer = mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, spawnFn: fakeSpawn(rec, 2) });
	const result = await runContainer({ job: JOB, prepared: PREPARED, name: "j1", signal: new AbortController().signal });
	assert.equal(result.code, 2, "exit 2 (policy) is a normal outcome, not an error to reject on");
	assert.equal(result.aborted, false, "no worker abort -> the code stands on its own");
	assert.equal(rec.cmd, "docker");
	assert.ok(rec.args.includes("--cap-drop=ALL"), "isolation flags present");
	assert.ok(rec.args.includes("/host/jobs/j1:/job:ro"), "whole /job mounted read-only");
	assert.ok(rec.args.includes("/host/folder:/workspace"), "the folder is the workspace");
	assert.ok(rec.args.includes("ANTHROPIC_API_KEY=sk-real"), "the provider key is forwarded");
});

test("exit 1 (infra) is returned, not thrown -- it is retryable, not a spawn error", { skip }, async () => {
	const runContainer = mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, spawnFn: fakeSpawn({}, 1) });
	const result = await runContainer({ job: JOB, prepared: PREPARED, name: "j1", signal: new AbortController().signal });
	assert.deepEqual(result, { code: 1, aborted: false, turns: null, tokens: null, session: null, usage: null, context: null });
});

test("close 137 while the worker aborted => {code:137, aborted:true} (our docker stop is POLICY)", { skip }, async () => {
	const ac = new AbortController();
	const runContainer = mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, spawnFn: fakeSpawnAbortedThenClose(ac, 137) });
	const result = await runContainer({ job: JOB, prepared: PREPARED, name: "j1", signal: ac.signal });
	assert.deepEqual(result, { code: 137, aborted: true, turns: null, tokens: null, session: null, usage: null, context: null });
});

test("close 137 with a signal that never aborted => {code:137, aborted:false} (kernel OOM stays infra)", { skip }, async () => {
	const runContainer = mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, spawnFn: fakeSpawn({}, 137) });
	const result = await runContainer({ job: JOB, prepared: PREPARED, name: "j1", signal: new AbortController().signal });
	assert.deepEqual(result, { code: 137, aborted: false, turns: null, tokens: null, session: null, usage: null, context: null });
});

test("refuses before spawning if the provider is unconfigured (pre-spend guard)", { skip }, async () => {
	const rec = {};
	const runContainer = mod.makeRunContainer({ image: "pi-job:x", hostEnv: {}, spawnFn: fakeSpawn(rec) });
	await assert.rejects(
		() => runContainer({ job: JOB, prepared: PREPARED, name: "j1", signal: new AbortController().signal }),
		(e) => e.piDispatchConfig === true,
	);
	assert.equal(rec.cmd, undefined, "no container for an unconfigured provider");
});

// REQ-GLOBAL-PI-OVERLAY staged packages. The staged set lives on the factory (boot-time, like
// allowGlobalExtensions); the per-job opt-OUT lives on the job (per-job, like maxTurns). Asserted through
// the argv, which is the contract the container actually sees.
const STAGED = ["/opt/pi-global/packages/pi-playwright", "/opt/pi-global/packages/pi-lint"];
const PI_PACKAGES_ARG = "PI_PACKAGES=/opt/pi-global/packages/pi-playwright:/opt/pi-global/packages/pi-lint";

/** Run one job through the factory with the staged set wired, and hand back the recorded argv. */
async function argvFor(job, packagePaths = STAGED, factory = {}) {
	const rec = {};
	const runContainer = mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, packagePaths, spawnFn: fakeSpawn(rec), ...factory });
	await runContainer({ job, prepared: PREPARED, name: "j1", signal: new AbortController().signal });
	return rec.args;
}

test("packages: true passes the boot-staged set through to the container env", { skip }, async () => {
	const args = await argvFor({ ...JOB, packages: true });
	assert.ok(args.includes(PI_PACKAGES_ARG), "an explicitly opted-in job must carry the \":\"-joined staged container paths");
});

test("packages ABSENT loads the staged set -- staging is the opt-in, the trigger flag is only an opt-out", { skip }, async () => {
	const args = await argvFor(JOB);
	assert.ok(args.includes(PI_PACKAGES_ARG), "an unflagged job gets what the operator staged");
});

test("packages: false is the ONLY thing that withholds the staged set", { skip }, async () => {
	const args = await argvFor({ ...JOB, packages: false });
	assert.ok(!args.some((a) => String(a).startsWith("PI_PACKAGES")), "an explicit opt-out yields no PI_PACKAGES at all");
});

test("the STRING \"false\" does not opt out -- parseTriggers refuses it before it can become job data", { skip }, async () => {
	// The strictness moved rather than vanished: `!== false` here is only safe because the trigger validator
	// rejects every non-boolean run.packages fail-loud at load. This pins the halves together.
	const args = await argvFor({ ...JOB, packages: "false" });
	assert.ok(args.includes(PI_PACKAGES_ARG), "only the boolean false withholds; a string is not it");
});

test("packages: true with NOTHING staged still yields no PI_PACKAGES (the opt-in is not a promise)", { skip }, async () => {
	const args = await argvFor({ ...JOB, packages: true }, []);
	assert.ok(!args.some((a) => String(a).startsWith("PI_PACKAGES")), "an empty staged set omits the variable, never PI_PACKAGES=");
});

test("the trigger's flow reaches the container env, and a flowless job emits no PI_FLOW", { skip }, async () => {
	// Issue #189: run.flow rides env, not event.json (an execution knob is not a fact about the
	// delivery), so the runner can compare it against the skill set that actually loaded.
	const withFlow = await argvFor({ ...JOB, flow: "review" });
	assert.ok(withFlow.includes("PI_FLOW=review"), "run.flow must reach the runner structurally");
	const without = await argvFor(JOB);
	assert.ok(!without.some((a) => String(a).startsWith("PI_FLOW")), "a bare run.task job emits no PI_FLOW at all");
});

test("the trigger's command reaches the container env, and a commandless job emits no PI_COMMAND", { skip }, async () => {
	// Issue #189: run.command rides env like PI_FLOW (an execution knob is not a fact about the
	// delivery), so the runner can refuse an unregistered command before any spend.
	const withCmd = await argvFor({ ...JOB, command: "wf run nightly" });
	assert.ok(withCmd.includes("PI_COMMAND=wf run nightly"), "run.command must reach the runner structurally, args and all");
	const without = await argvFor(JOB);
	assert.ok(!without.some((a) => String(a).startsWith("PI_COMMAND")), "a commandless job emits no PI_COMMAND at all");
	// A blank string is treated as absent, the same guard the flow line keeps -- never PI_COMMAND=.
	const blank = await argvFor({ ...JOB, command: "   " });
	assert.ok(!blank.some((a) => String(a).startsWith("PI_COMMAND")));
});

test("overlay extensions: the factory default emits nothing, and only an explicit false emits the opt-out", { skip }, async () => {
	const on = await argvFor(JOB);
	assert.ok(!on.some((a) => String(a).startsWith("PI_GLOBAL_ALLOW_EXTENSIONS")), "loading is the absence of the variable, on both sides");
	const off = await argvFor(JOB, STAGED, { allowGlobalExtensions: false });
	assert.ok(off.includes("PI_GLOBAL_ALLOW_EXTENSIONS=0"), "the operator's opt-out reaches the container verbatim");
});

test("tee: every chunk reaches BOTH onOutput and the sink, in order", { skip }, async () => {
	const outputs = [];
	const sink = makeRecordingSink();
	const runContainer = mod.makeRunContainer({
		image: "pi-job:x",
		hostEnv: HOST,
		onOutput: (c) => outputs.push(c),
		openJobLog: () => sink,
		spawnFn: fakeSpawnWithData({}, { chunks: ["one", "two"], exitCode: 0 }),
	});
	const result = await runContainer({ job: JOB, prepared: PREPARED, name: "j1", signal: new AbortController().signal });
	assert.deepEqual(outputs, ["one", "two"], "onOutput sees both chunks in order");
	assert.deepEqual(sink.writes, ["one", "two"], "the sink tee sees both chunks in order");
	assert.equal(result.code, 0);
});

test("flush-before-resolve: resolve awaits a delayed sink.close and carries its turns", { skip }, async () => {
	const sink = makeRecordingSink({ turns: 7, closeDelay: true });
	const runContainer = mod.makeRunContainer({
		image: "pi-job:x",
		hostEnv: HOST,
		onOutput: () => {},
		openJobLog: () => sink,
		spawnFn: fakeSpawn({}, 0),
	});
	const result = await runContainer({ job: JOB, prepared: PREPARED, name: "j1", signal: new AbortController().signal });
	assert.equal(result.turns, 7, "turns from a close that resolves only after setImmediate proves resolve awaited it");
	assert.equal(result.code, 0);
	assert.equal(sink.closeCalls, 1, "close is invoked exactly once");
});

test("hostile sink: a throwing write and a rejecting close neither hang nor crash the run", { skip, timeout: 5000 }, async () => {
	const runContainer = mod.makeRunContainer({
		image: "pi-job:x",
		hostEnv: HOST,
		onOutput: () => {},
		openJobLog: () => ({
			write: () => {
				throw new Error("boom");
			},
			close: async () => {
				throw new Error("boom2");
			},
		}),
		spawnFn: fakeSpawnWithData({}, { chunks: ["x"], exitCode: 0 }),
	});
	const result = await runContainer({ job: JOB, prepared: PREPARED, name: "j1", signal: new AbortController().signal });
	assert.deepEqual(result, { code: 0, aborted: false, turns: null, tokens: null, session: null, usage: null, context: null }, "the swallowed sink faults leave code/aborted intact and turns/tokens/session/usage/context null");
});

test("never-started: the sink is still closed (best-effort teardown) and the reject reason is unchanged", { skip }, async () => {
	const sink = makeRecordingSink();
	const runContainer = mod.makeRunContainer({
		image: "pi-job:x",
		hostEnv: HOST,
		onOutput: () => {},
		openJobLog: () => sink,
		spawnFn: fakeSpawnError({}),
	});
	await assert.rejects(
		() => runContainer({ job: JOB, prepared: PREPARED, name: "j1", signal: new AbortController().signal }),
		(e) => e.reason === "container-never-started",
	);
	assert.equal(sink.closeCalls, 1, "the never-started path still closes the sink");
});

test("a job's own image overrides the deployment default in the argv, and an imageless job runs the default", { skip }, async () => {
	// The image is the FINAL argv positional, so at(-1) is the whole assertion.
	const override = await argvFor({ ...JOB, image: "my-python:1.2.0" });
	assert.equal(override.at(-1), "my-python:1.2.0", "a trigger's run.image reaches docker");

	const fallback = await argvFor(JOB);
	assert.equal(fallback.at(-1), "pi-job:x", "an unflagged trigger runs the deployment default");
});

test("the argv can never fetch an image -- --pull=never rides every run, whichever image", { skip }, async () => {
	for (const job of [JOB, { ...JOB, image: "my-python:1.2.0" }]) {
		const args = await argvFor(job);
		assert.ok(args.includes("--pull=never"), "a per-trigger image name must not become a registry pull");
	}
});
