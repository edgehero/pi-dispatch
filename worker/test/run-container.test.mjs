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

test("the trigger's excludeTools reach the container env, and an unflagged job emits no PI_EXCLUDE_TOOLS", { skip }, async () => {
	// Issue #291: run.excludeTools rides env like PI_COMMAND (a permission boundary is not a fact about
	// the delivery), so the runner can withhold the tools structurally at createAgentSession.
	const withXt = await argvFor({ ...JOB, excludeTools: ["bash", "edit"] });
	assert.ok(withXt.includes("PI_EXCLUDE_TOOLS=bash,edit"), "run.excludeTools must reach the runner structurally, comma-joined");
	const without = await argvFor(JOB);
	assert.ok(!without.some((a) => String(a).startsWith("PI_EXCLUDE_TOOLS")), "an unflagged job emits no PI_EXCLUDE_TOOLS at all");
	// Junk shapes are treated as absent, the same defensive guard the flow/command lines keep: the
	// loader guarantees a non-empty array, so anything else is a hand-built job, and an empty variable
	// is worse than none.
	const junk = await argvFor({ ...JOB, excludeTools: [] });
	assert.ok(!junk.some((a) => String(a).startsWith("PI_EXCLUDE_TOOLS")));
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

test("the job's docker run passes NO env, so it talks to the daemon the endpoint read observed (#278)", { skip }, async () => {
	// credentialTransit's observation asks the docker CLI with this process's own environment. If the job's
	// spawn passed an env of its own, the read would describe a different CLI than the one carrying the
	// provider key and forge token, and the enforced word would be about the wrong connection.
	let opts = null;
	const spawnFn = (cmd, args, o) => {
		opts = o;
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		queueMicrotask(() => child.emit("close", 0));
		return child;
	};
	const runContainer = mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, spawnFn });
	await runContainer({ job: JOB, prepared: PREPARED, name: "j1", signal: new AbortController().signal });
	assert.ok(opts, "docker was spawned");
	assert.equal(Object.hasOwn(opts, "env"), false);
});

test("a job user runs as --user with HOME=/home/pi beside it, and no user means neither (issue #341)", { skip }, async () => {
	const rec = {};
	const runContainer = mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, spawnFn: fakeSpawn(rec) });
	await runContainer({ job: JOB, prepared: PREPARED, name: "j1", signal: new AbortController().signal, user: "1234:1234", home: "/home/pi" });
	assert.ok(rec.args.includes("--user=1234:1234"));
	assert.ok(rec.args.includes("HOME=/home/pi"));
	const plain = {};
	await mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, spawnFn: fakeSpawn(plain) })({ job: JOB, prepared: PREPARED, name: "j1", signal: new AbortController().signal });
	assert.ok(!plain.args.some((a) => a.startsWith("--user")), "no user, no flag: the argv is the one before issue #341");
	assert.ok(!plain.args.includes("HOME=/home/pi"));
});

test("a job user without HOME=/home/pi is refused before docker is ever spawned (issue #341)", { skip }, async () => {
	for (const home of [null, undefined, "/", "/workspace"]) {
		const rec = {};
		const runContainer = mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, spawnFn: fakeSpawn(rec) });
		await assert.rejects(() => runContainer({ job: JOB, prepared: PREPARED, name: "j1", signal: new AbortController().signal, user: "1234:1234", home }), /must be paired with HOME=\/home\/pi/, String(home));
		assert.equal(rec.cmd, undefined, String(home));
	}
});

// --- issue #345: a container that outlived its docker run -------------------------------------------------------

const CID = "d".repeat(64);
/** An in-memory host fs for the cidfile: `files` maps a path to its content; every rmSync is recorded. */
function cidFs(files = {}) {
	const removed = [];
	return {
		files,
		removed,
		readFileSync: (p) => {
			if (files[p] === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
			return files[p];
		},
		rmSync: (p) => {
			removed.push(p);
			delete files[p];
		},
	};
}
/**
 * A docker whose `run` exits `runCode` (writing `cid` to the cidfile first, as the CLI does after a create) and whose
 * later steps answer from `steps`: `{ ps, stop, rm }`, each `{ code, stdout }` or "hang" (never closes).
 */
function detachedDocker({ runCode, cid = CID, steps = {}, fs, onRun = () => {} }) {
	const calls = [];
	const spawnFn = (cmd, args) => {
		calls.push(args);
		if (args[0] === "run") onRun();
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		if (args[0] === "run") {
			const cidFile = args.find((a) => a.startsWith("--cidfile="))?.slice("--cidfile=".length);
			queueMicrotask(() => {
				if (cid !== null && cidFile) fs.files[cidFile] = `${cid}`;
				child.emit("close", runCode);
			});
			return child;
		}
		const answer = steps[args[0]] ?? { code: 0, stdout: "" };
		if (answer !== "hang") {
			queueMicrotask(() => {
				if (answer.stdout) child.stdout.emit("data", answer.stdout);
				child.emit("close", answer.code);
			});
		}
		return child;
	};
	return { spawnFn, calls };
}
const runWith = async ({ runCode, cid, steps, files = {}, abortOnRun = false, neverStartedExits, detachedCheck = instantCheck() } = {}) => {
	const fs = cidFs(files);
	const controller = new AbortController();
	const signal = controller.signal;
	const atSpawn = {};
	const docker = detachedDocker({
		runCode,
		cid,
		steps,
		fs,
		onRun: () => {
			atSpawn.files = { ...fs.files };
			if (abortOnRun) controller.abort();
		},
	});
	const runContainer = mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, spawnFn: docker.spawnFn, fs, detachedCheck, ...(neverStartedExits ? { neverStartedExits } : {}) });
	const result = await runContainer({ job: JOB, prepared: PREPARED, name: "pi-job-j1", signal });
	return { result, calls: docker.calls, fs, atSpawn };
};
const psOf = (state) => ({ code: 0, stdout: `${CID} ${state}\n` });
/** A clock the detached check's retries advance without waiting. */
const instantCheck = () => {
	let t = 0;
	return { now: () => t, delay: async (ms) => (t += ms) };
};

test("the job argv writes this attempt's container ID beside the job dir, removing a stale one first and the file afterwards (#345)", { skip }, async () => {
	const { result, calls, fs, atSpawn } = await runWith({ runCode: 0, files: { "/host/jobs/j1.cid": "stale" } });
	assert.equal(atSpawn.files["/host/jobs/j1.cid"], undefined, "gone BEFORE docker is spawned, not only after the run");
	assert.equal(result.code, 0);
	assert.equal("detached" in result, false, "the result shape is unchanged unless a container was found detached");
	const run = calls.find((a) => a[0] === "run");
	assert.ok(run.includes("--cidfile=/host/jobs/j1.cid"), "beside the job dir, never inside the /job:ro mount");
	assert.ok(!run.includes("/host/jobs/j1.cid:/job:ro"));
	assert.equal(fs.removed[0], "/host/jobs/j1.cid", "a stale cidfile is removed before docker is spawned, which refuses an existing one");
	assert.equal(fs.files["/host/jobs/j1.cid"], undefined, "and the file is gone when the run ends");
	assert.equal(calls.filter((a) => a[0] !== "run").length, 0, "an exit that is not never-started checks nothing");
});

test("a never-started exit is checked against the cidfile: nothing created or nothing listed stays never-started, and a created-only container is removed (#345)", { skip }, async () => {
	for (const [label, opts] of [
		["no cidfile written (a name conflict, an absent image)", { runCode: 125, cid: null }],
		["an empty cidfile", { runCode: 125, cid: "" }],
		["not an ID", { runCode: 125, cid: "abc" }],
		["the ID no longer listed", { runCode: 125, steps: { ps: { code: 0, stdout: "" } } }],
	]) {
		const { result, calls } = await runWith(opts);
		assert.deepEqual([result.code, "detached" in result], [125, false], label);
		assert.ok(!calls.some((a) => a[0] === "stop"), `${label}: nothing is stopped`);
	}
	const created = await runWith({ runCode: 127, steps: { ps: psOf("created") } });
	assert.equal("detached" in created.result, false, "created and never started is still never started");
	assert.deepEqual(created.calls.filter((a) => a[0] !== "run"), [["ps", "-a", "--no-trunc", "--filter", `id=${CID}`, "--format", "{{.ID}} {{.State}}"], ["rm", "-f", CID]], "removed by ID, not stopped");
});

test("a never-started exit whose container is still there is stopped and removed BY ID and reported detached, and an unanswered ps counts too (#345)", { skip }, async () => {
	for (const [label, steps] of [
		["listed running", { ps: psOf("running") }],
		["listed exited", { ps: psOf("exited") }],
		["a line that is not this full ID", { ps: { code: 0, stdout: `${CID.slice(0, 12)}\n` } }],
		["ps failed", { ps: { code: 1, stdout: "" } }],
	]) {
		const { result, calls } = await runWith({ runCode: 125, steps });
		assert.deepEqual([result.code, result.detached], [125, true], label);
		assert.deepEqual(calls.filter((a) => a[0] === "stop" || a[0] === "rm"), [["stop", CID], ["rm", "-f", CID]], label);
	}
	const aborted = await runWith({ runCode: 125, steps: { ps: psOf("running") }, abortOnRun: true });
	assert.equal(aborted.result.aborted, true, "a run the worker aborted (its own docker stop) is not checked");
	assert.ok(!aborted.calls.some((a) => a[0] === "ps"));
	const other = await runWith({ runCode: 1, steps: { ps: psOf("running") } });
	assert.ok(!other.calls.some((a) => a[0] === "ps"), "exit 1 is the runner's own code: never checked");
	const declared = await runWith({ runCode: 125, steps: { ps: psOf("running") }, neverStartedExits: [] });
	assert.equal("detached" in declared.result, false, "an adapter that declares no never-started exits is never checked");
});

test("the detached check is bounded: a ps that never answers is given up on and still stops the container (#345)", { skip, timeout: 10_000 }, async () => {
	const fs = cidFs();
	const calls = [];
	const spawnFn = (cmd, args) => {
		calls.push(args);
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		if (args[0] !== "ps") queueMicrotask(() => child.emit("close", 0));
		return child;
	};
	fs.files["/host/jobs/j1.cid"] = CID;
	assert.equal(await mod.stopDetached({ spawnFn, cidFile: "/host/jobs/j1.cid", fs, timeoutMs: 20 }), true);
	assert.deepEqual(calls.map((a) => a[0]), ["ps", "stop", "rm"]);
	assert.equal(mod.DETACHED_CHECK_TIMEOUT_MS, 10_000);
});

test("only a full 64-hex ID in the cidfile is ever acted on: a prefix could name other containers (#345)", { skip }, async () => {
	for (const cid of [CID.slice(0, 12), `${CID}0`, "D".repeat(64), `${CID.slice(0, 63)}g`]) {
		const { result, calls } = await runWith({ runCode: 125, cid, steps: { ps: psOf("running") } });
		assert.equal("detached" in result, false, cid);
		assert.equal(calls.filter((a) => a[0] !== "run").length, 0, `${cid}: no docker step at all`);
	}
});

test("a check that meets a refused connection asks again until the service answers, then stops the container, within its bound (#345)", { skip }, async () => {
	const fs = cidFs({ "/host/jobs/j1.cid": CID });
	let t = 0;
	const calls = [];
	let psTries = 0;
	const spawnFn = (cmd, args) => {
		calls.push(args);
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		queueMicrotask(() => {
			if (args[0] === "ps") {
				psTries++;
				if (psTries < 3) return child.emit("close", 1);
				child.stdout.emit("data", `${CID} running\n`);
			}
			child.emit("close", 0);
		});
		return child;
	};
	const clock = { now: () => t, delay: async (ms) => (t += ms) };
	assert.equal(await mod.stopDetached({ spawnFn, cidFile: "/host/jobs/j1.cid", fs, ...clock }), true);
	assert.deepEqual(calls.map((a) => a[0]), ["ps", "ps", "ps", "stop", "rm"], "two refused tries, then the answer, then stop and remove");
	assert.equal(t, 1000, "paced, not a spin");

	let never = 0;
	const down = (cmd, args) => {
		never++;
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		queueMicrotask(() => child.emit("close", 1));
		return child;
	};
	t = 0;
	assert.equal(await mod.stopDetached({ spawnFn: down, cidFile: "/host/jobs/j1.cid", fs: cidFs({ "/host/jobs/j1.cid": CID }), ...clock, timeoutMs: 10_000 }), true, "a service that never comes back is still detached");
	assert.ok(t <= 10_000 && never <= 3 * 20 + 3, `bounded by the deadline (${never} tries over ${t} ms)`);
});

test("each step of the detached check is retried while it fails, and every try gets at least its own minimum bound (#345)", { skip }, async () => {
	const fake = (answers) => {
		const calls = [];
		let t = 0;
		const run = async (_spawn, args, bound) => {
			calls.push([args[0], bound]);
			t += 100;
			const queue = answers[args[0]];
			return queue.length > 1 ? queue.shift() : queue[0];
		};
		return { calls, run, now: () => t, delay: async (ms) => (t += ms) };
	};
	const fs = () => cidFs({ "/host/jobs/j1.cid": CID });
	// stop and rm each refused twice, then answered: three tries of each, not one.
	const flaky = fake({ ps: [psOf("running")], stop: [{ code: 1, stdout: "" }, { code: 1, stdout: "" }, { code: 0, stdout: "" }], rm: [{ code: 1, stdout: "" }, { code: 1, stdout: "" }, { code: 0, stdout: "" }] });
	assert.equal(await mod.stopDetached({ spawnFn: null, cidFile: "/host/jobs/j1.cid", fs: fs(), ...flaky }), true);
	assert.deepEqual(flaky.calls.map(([step]) => step), ["ps", "stop", "stop", "stop", "rm", "rm", "rm"]);
	const created = fake({ ps: [psOf("created")], rm: [{ code: 1, stdout: "" }, { code: 0, stdout: "" }] });
	assert.equal(await mod.stopDetached({ spawnFn: null, cidFile: "/host/jobs/j1.cid", fs: fs(), ...created }), false);
	assert.deepEqual(created.calls.map(([step]) => step), ["ps", "rm", "rm"], "a created container's removal is retried too");
	// A service that never answers: every try is bounded by what is left, but never below the minimum, and nothing runs
	// past the deadline except one last stop and one last rm.
	const down = fake({ ps: [{ code: null, stdout: "" }], stop: [{ code: null, stdout: "" }], rm: [{ code: null, stdout: "" }] });
	assert.equal(await mod.stopDetached({ spawnFn: null, cidFile: "/host/jobs/j1.cid", fs: fs(), ...down, timeoutMs: 2_000, minStepMs: 1_000, retryMs: 500 }), true);
	assert.ok(down.calls.every(([, bound]) => bound >= 1_000 && bound <= 2_000), JSON.stringify(down.calls));
	assert.equal(down.calls[0][1], 2_000, "the first try gets the whole window, not the minimum");
	assert.equal(down.calls[1][1], 1_400, "a later try gets only what is left of the window (2000 - 100 run - 500 pause)");
	assert.deepEqual(down.calls.slice(-2).map(([step]) => step), ["stop", "rm"], "once past the deadline, one stop and one rm");
	assert.deepEqual([mod.DETACHED_CHECK_TIMEOUT_MS, mod.DETACHED_MIN_STEP_MS], [10_000, 5_000]);
});
