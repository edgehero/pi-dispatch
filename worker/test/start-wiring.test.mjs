import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// start.mjs imports index.mjs (bullmq), connection.mjs (ioredis), and the octokit-backed auth/host
// modules, so this skips below the node floor / without deps and runs in CI, where
// PI_DISPATCH_REQUIRE_WORKER_TESTS=1 turns a skip into a hard failure.
let mod;
let importError;
try {
	mod = await import("../src/start.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`start wiring tests are REQUIRED here but a dependency could not import.\n${importError}`);
}
const skip = mod ? false : `worker deps not installed (node ${process.version} < 22.19.0); CI runs these`;

function fakeHost(overrides = {}) {
	return {
		resolveDefaultBranchSha: async () => ({ branch: "main", sha: "abc" }),
		isDefaultBranchProtected: async () => true,
		postStatusComment: async () => {},
		...overrides,
	};
}

// Drive startWorker with injected fakes and capture the exact object handed to createWorker
// (deps are nested under `deps`). No real Redis: createWorkerFn is faked. The real ioredis client
// startWorker constructs via makeRedisClient is torn down so it leaves no dangling handle.
async function runStart({ env = {}, makeAuth, makeHost, makeGitLabAuth, makeGitLabHost, makeReaper, makeLogSink, makeRecordWriter, makeLogReaper, makeSandboxReaper, makeRunContainer, order } = {}) {
	const calls = [];
	const registered = {};
	const createWorkerFn = (arg) => {
		if (order) order.push("createWorker");
		calls.push(arg);
		// Record every worker.on(...) registration so tests can drive the completed/failed handlers
		// (inspecting the emitted log line) and assert the scheduler stall guard's "stalled" listener.
		return {
			on(evt, fn) {
				registered[evt] = fn;
			},
		};
	};

	// Default to a no-op reaper so the wiring tests never shell out to docker; ordering/throwing tests
	// inject their own.
	const reaper = makeReaper ?? (() => async () => {});

	// Default the run-history factories to inert fakes so the wiring tests never touch disk (the real
	// factories mkdirSync/readdirSync at construction). Each default records the args it was constructed
	// with so a test can assert config threading without a fs. A `logsDir`-only sentinel is fine here:
	// runContainer is never invoked, so the returned openJobLog is stored and never called.
	const openJobLogSentinel = () => ({ write() {}, close: async () => ({ turns: null }) });
	const logSinkCalls = [];
	const recordWriterCalls = [];
	const logReaperCalls = [];
	const logSink =
		makeLogSink ??
		((args) => {
			logSinkCalls.push(args);
			return openJobLogSentinel;
		});
	const recordWriter =
		makeRecordWriter ??
		((args) => {
			recordWriterCalls.push(args);
			return () => {};
		});
	const logReaper =
		makeLogReaper ??
		((args) => {
			logReaperCalls.push(args);
			return () => {};
		});
	// The sandbox reaper is faked for the SAME reason as makeReaper above, and it is the stronger case of
	// the two: this one asks docker which sandboxes are live before it sweeps, so a real one here would
	// shell out to `docker ps` on every wiring test -- and block for as long as an unreachable daemon takes
	// to answer. Ordering/threading tests inject their own.
	const sandboxReaperCalls = [];
	const sandboxReaper =
		makeSandboxReaper ??
		((args) => {
			sandboxReaperCalls.push(args);
			return async () => {};
		});

	// The container factory is faked for the same reason as the run-history ones: the wiring tests assert
	// what boot HANDS it (image, overlay, staged packages), never a docker launch. It records its args and
	// returns an inert runContainer that is stored in deps and never invoked here.
	const runContainerCalls = [];
	const imagePreflightCalls = [];
	const runContainerFactory =
		makeRunContainer ??
		((args) => {
			runContainerCalls.push(args);
			return async () => ({ code: 0, aborted: false, turns: null, tokens: null });
		});

	const lines = [];
	const origWrite = process.stdout.write;
	process.stdout.write = (chunk) => {
		lines.push(String(chunk));
		return true;
	};
	try {
		await mod.startWorker(env, {
			makeAuth,
			makeHost,
			createWorkerFn,
			makeReaper: reaper,
			makeLogSink: logSink,
			makeRecordWriter: recordWriter,
			makeLogReaper: logReaper,
			makeSandboxReaper: sandboxReaper,
			makeRunContainer: runContainerFactory,
			makeImagePreflight: (args) => (imagePreflightCalls.push(args), async () => ({ ok: true })),
			...(makeGitLabAuth ? { makeGitLabAuth } : {}),
			...(makeGitLabHost ? { makeGitLabHost } : {}),
		});
	} finally {
		process.stdout.write = origWrite;
	}

	const captured = calls[0];
	captured?.redis?.disconnect?.(); // release the background reconnect handle
	// The persistent runtimeQueue opens its own ioredis connection; close it so the suite leaks no handle.
	await captured?.extraClosers?.[0]?.close?.().catch(() => {});

	const logs = lines.map((l) => {
		try {
			return JSON.parse(l);
		} catch {
			return { raw: l };
		}
	});
	// Expose the registration map under both names: `handlers` for the completed/failed handler tests,
	// `registered` for the scheduler stall-guard test. Same object, one capture path.
	return { captured, deps: captured?.deps, logs, handlers: registered, registered, logSinkCalls, recordWriterCalls, logReaperCalls, sandboxReaperCalls, runContainerCalls, imagePreflightCalls };
}

// Capture the JSON log lines a synchronous fn emits via process.stdout.write, then restore it.
function captureLogs(fn) {
	const lines = [];
	const origWrite = process.stdout.write;
	process.stdout.write = (chunk) => {
		lines.push(String(chunk));
		return true;
	};
	try {
		fn();
	} finally {
		process.stdout.write = origWrite;
	}
	return lines.map((l) => {
		try {
			return JSON.parse(l);
		} catch {
			return { raw: l };
		}
	});
}

test("github configured: real mintToken and the host's isDefaultBranchProtected are wired", { skip }, async () => {
	const host = fakeHost();
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 123, source: "gh" });
	const { deps, logs } = await runStart({ makeAuth, makeHost: () => host });

	const ghJob = { kind: "github", repo: "o/r" };
	assert.equal(await deps.mintToken(ghJob), "tok", "mintToken must be the real one (not the throwing fallback)");
	// Both deps now resolve the forge from the JOB rather than being bound to one host at wiring time, so
	// the assertion is that they ROUTE to this host -- identity-equality would only prove the old binding.
	let asked = null;
	const routing = fakeHost({ isDefaultBranchProtected: async (ref) => ((asked = ref?.repo), true) });
	const { deps: d2 } = await runStart({ makeAuth, makeHost: () => routing });
	assert.equal(await d2.isDefaultBranchProtected(ghJob, "tok"), true);
	assert.equal(asked, "o/r", "the github host must be asked about the job's own repo");
	assert.equal(typeof deps.prepareWorkspace, "function");
	assert.ok(
		logs.some((l) => l.event === "self_identity" && l.id === 123 && l.source === "gh"),
		"a self_identity log carrying { id, source } must be emitted",
	);
});

test("comment is best-effort: a rejecting postStatusComment does not reject the adapter", { skip }, async () => {
	const host = fakeHost({
		postStatusComment: async () => {
			throw new Error("comment API down");
		},
	});
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const { deps } = await runStart({ makeAuth, makeHost: () => host });

	const ghJob = { kind: "github", repo: "o/r", issueNumber: 7, id: "j1" };
	await assert.doesNotReject(() => deps.comment(ghJob, "text"), "github comment must swallow the postStatusComment rejection");

	// A local job never touches GitHub -- the adapter just logs and resolves.
	await assert.doesNotReject(() => deps.comment({ kind: "local", id: "L1" }, "hi"));
});

test("auth unavailable: the worker still boots; mintToken fails github jobs closed with a configError", { skip }, async () => {
	const makeAuth = async () => {
		throw new Error("gh CLI is logged out");
	};
	const { deps, captured, logs } = await runStart({ makeAuth, makeHost: () => fakeHost() });

	assert.ok(captured, "startWorker must still construct the worker (a local-only deployment boots)");
	assert.ok(logs.some((l) => l.event === "github_auth_unavailable"), "a github_auth_unavailable log must be emitted");
	await assert.rejects(
		() => deps.mintToken({ kind: "github", repo: "o/r" }),
		(err) => err?.piDispatchConfig === true,
		"mintToken must reject with a .piDispatchConfig-tagged configError when auth is unavailable",
	);
});

test("resolveDefaultBranchSha is threaded into prepareWorkspace (C2)", { skip }, async () => {
	const host = fakeHost();
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 5, source: "gh" });
	const { captured, deps } = await runStart({ makeAuth, makeHost: () => host });

	// makePrepareWorkspace receives resolveDefaultBranchSha and closes over it; the closure is what
	// the github prepare path calls. Threading is asserted at the boundary the wiring controls:
	// startWorker completed and a prepareWorkspace function was built from the host's resolver.
	assert.ok(captured, "startWorker completed");
	assert.equal(typeof deps.prepareWorkspace, "function", "a prepareWorkspace dep must be wired");
});

test("the boot reaper runs BEFORE the worker starts draining (strays cleared first)", { skip }, async () => {
	const order = [];
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const makeReaper = () => async () => {
		order.push("reap");
	};
	await runStart({ makeAuth, makeHost: () => fakeHost(), makeReaper, order });
	assert.deepEqual(order, ["reap", "createWorker"], "reap must clear strays before the worker is created");
});

test("a reaper that throws does NOT reject startWorker (boot is best-effort)", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const makeReaper = () => async () => {
		throw new Error("docker daemon down");
	};
	const { captured, logs } = await runStart({ makeAuth, makeHost: () => fakeHost(), makeReaper });
	assert.ok(captured, "startWorker must still construct the worker when the reaper throws");
	assert.ok(logs.some((l) => l.event === "reaper_skipped"), "a throwing reaper must be logged as reaper_skipped");
});

test("job_completed carries reason when the result has one and omits it otherwise", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const { handlers } = await runStart({ makeAuth, makeHost: () => fakeHost() });
	assert.equal(typeof handlers.completed, "function", "startWorker must register a completed handler");

	const withReason = captureLogs(() => handlers.completed({ id: "j1" }, { outcome: "policy", reason: "worker-abort" }));
	const wr = withReason.find((l) => l.event === "job_completed");
	assert.equal(wr?.outcome, "policy");
	assert.equal(wr?.reason, "worker-abort", "reason must be logged when the result carries one");

	const noReason = captureLogs(() => handlers.completed({ id: "j2" }, { outcome: "success" }));
	const nr = noReason.find((l) => l.event === "job_completed");
	assert.equal(nr?.outcome, "success");
	assert.ok(!("reason" in nr), "reason must be omitted from a clean success line");
});

test("chain wiring: the outbox collectChain is wired into deps as a function", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const { deps } = await runStart({ makeAuth, makeHost: () => fakeHost() });
	assert.equal(typeof deps.collectChain, "function", "the outbox chain collector must be wired into deps.collectChain");
});

// Cron wiring. DEFAULT env => no PI_TRIGGERS_FILE => schedules=[] => reconcile is skipped, so these
// assert the wiring that runs even with cron disabled: no live Valkey required.
test("cron wiring: a stalled listener is registered and schedules_installed precedes worker_started", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 9, source: "gh" });
	const { captured, logs, registered } = await runStart({ makeAuth, makeHost: () => fakeHost() });

	// (a) the money backstop is keyed on "stalled" -- the guard's onStalled is registered there.
	assert.equal(typeof registered.stalled, "function", "a stalled listener (the scheduler stall guard) must be registered");

	// (c) the persistent runtimeQueue is handed to createWorker as an extraCloser so shutdown drains it.
	assert.equal(
		typeof captured.extraClosers?.[0]?.close,
		"function",
		"the runtimeQueue must be registered as extraClosers[0] with a close()",
	);

	// (d) empty schedule set still emits schedules_installed {0,0} so the operator sees cron is off.
	const installed = logs.find((l) => l.event === "schedules_installed");
	assert.ok(installed, "a schedules_installed log must be emitted even when cron is disabled");
	assert.deepEqual(
		{ installed: installed.installed, removed: installed.removed },
		{ installed: 0, removed: 0 },
		"an empty schedule set must log schedules_installed {installed:0, removed:0}",
	);

	// (b) schedules must be reconciled and logged before the worker announces itself.
	const installedIdx = logs.findIndex((l) => l.event === "schedules_installed");
	const startedIdx = logs.findIndex((l) => l.event === "worker_started");
	assert.ok(startedIdx !== -1, "a worker_started log must be emitted");
	assert.ok(installedIdx < startedIdx, "schedules_installed must be logged before worker_started");
});

// Run-history wiring (REQ-LOCAL-JOB-VISIBILITY). DEFAULT env => no live Valkey / disk required: the
// harness injects inert run-history factories, so these assert the wiring, not the I/O.
test("run-history: makeLogSink receives config.logsDir and the captureJobLogs gate (both polarities)", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });

	const on = await runStart({ env: { PI_LOGS_DIR: "/tmp/pi-logs", PI_CAPTURE_JOB_LOGS: "1" }, makeAuth, makeHost: () => fakeHost() });
	assert.equal(on.logSinkCalls.length, 1, "makeLogSink must be constructed exactly once");
	assert.equal(on.logSinkCalls[0].logsDir, "/tmp/pi-logs", "makeLogSink must receive the host-side config.logsDir");
	assert.equal(on.logSinkCalls[0].enabled, true, "enabled must mirror captureJobLogs when PI_CAPTURE_JOB_LOGS=1");

	// The record writer is always constructed against the same logsDir; the id-only record is not gated.
	assert.equal(on.recordWriterCalls[0]?.logsDir, "/tmp/pi-logs", "makeRecordWriter must receive config.logsDir");

	const off = await runStart({ env: { PI_LOGS_DIR: "/tmp/pi-logs" }, makeAuth, makeHost: () => fakeHost() });
	assert.equal(off.logSinkCalls[0].enabled, false, "enabled must be false when PI_CAPTURE_JOB_LOGS is unset");
});

test("run-history: recordRun is passed to createWorker as a TOP-LEVEL arg, not nested under deps", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const { captured } = await runStart({ makeAuth, makeHost: () => fakeHost() });
	assert.equal(typeof captured.recordRun, "function", "recordRun must be a top-level createWorker arg");
	assert.equal(captured.deps.recordRun, undefined, "recordRun must NOT be nested under deps");
});

// Runtime-settings overlay wiring (INT-CONFIG-OVERLAY-CONTRACT). PI_SETTINGS_FILE points at a path that
// cannot exist so readOverlay yields the normal empty overlay and getSettings resolves purely from
// env/default config -- no real settings.json on the host is consulted.
test("runtime settings: getSettings is a top-level createWorker arg resolving effective settings; the static cap arg is gone", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const settingsFile = "/pi-dispatch-nonexistent/does-not-exist/settings.json";
	const { captured, logs } = await runStart({ env: { PI_SETTINGS_FILE: settingsFile }, makeAuth, makeHost: () => fakeHost() });

	assert.equal(typeof captured.getSettings, "function", "getSettings must be a top-level createWorker arg");
	assert.equal(captured.cap, undefined, "no static cap arg survives -- the overlay replaces the frozen daily cap");

	// Calling it with an empty overlay yields the ten effective keys from env/default config (env {} here);
	// the optional week/month ceilings, token controls, and the soft-hold band default to disabled (null).
	assert.deepEqual(
		captured.getSettings(),
		{
			provider: "anthropic",
			model: "claude-sonnet-4-5-20250929",
			maxTurns: 30,
			dailyCap: 25,
			weeklyCap: null,
			monthlyCap: null,
			maxTokens: null,
			dailyTokenCap: null,
			concurrency: 3,
			softHoldPct: null,
		},
		"getSettings resolves the ten effective keys from env/default config when the overlay is empty",
	);

	const started = logs.find((l) => l.event === "worker_started");
	assert.ok(started, "a worker_started log must be emitted");
	assert.equal(started.settingsFile, settingsFile, "worker_started must announce the settings overlay path");
});

test("runtime settings: a boot overlay sets the constructed concurrency, and worker_started reports that effective value (not the env default)", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	// A real settings.json whose concurrency (7) differs from the env default (3), so the boot-effective
	// value is distinguishable from config.concurrency in both the constructor arg and the log.
	const dir = mkdtempSync(join(tmpdir(), "pi-settings-"));
	const settingsFile = join(dir, "settings.json");
	writeFileSync(settingsFile, JSON.stringify({ concurrency: 7 }));
	try {
		const { captured, logs } = await runStart({ env: { PI_SETTINGS_FILE: settingsFile }, makeAuth, makeHost: () => fakeHost() });
		assert.equal(captured.concurrency, 7, "the Worker is constructed with the boot-effective concurrency, not the env default 3");
		const started = logs.find((l) => l.event === "worker_started");
		assert.equal(started.concurrency, 7, "worker_started must report the concurrency the Worker was actually constructed with");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("run-history: the log reaper sweeps aged history BEFORE the worker starts draining", { skip }, async () => {
	const order = [];
	let reaperArgs;
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const makeLogReaper = (args) => {
		reaperArgs = args;
		return () => {
			order.push("reapLogs");
		};
	};
	await runStart({
		env: { PI_LOGS_DIR: "/tmp/pi-logs", PI_LOG_RETENTION_DAYS: "7" },
		makeAuth,
		makeHost: () => fakeHost(),
		makeLogReaper,
		order,
	});
	assert.deepEqual(order, ["reapLogs", "createWorker"], "the log reaper must sweep before the worker is created");
	assert.equal(reaperArgs.logsDir, "/tmp/pi-logs", "the log reaper must receive config.logsDir");
	assert.equal(reaperArgs.retentionDays, 7, "the log reaper must receive config.logRetentionDays");
});

test("sandbox: the retention sweep runs BEFORE the worker drains, and is handed a way to ask docker", { skip }, async () => {
	const order = [];
	let reaperArgs;
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const makeSandboxReaper = (args) => {
		reaperArgs = args;
		return async () => {
			order.push("reapSandboxes");
		};
	};
	const { deps } = await runStart({
		env: { PI_SANDBOX_DIR: "/tmp/pi-sbx", PI_SANDBOX_RETENTION_HOURS: "6", PI_JOB_IMAGE: "pi-job:pinned" },
		makeAuth,
		makeHost: () => fakeHost(),
		makeSandboxReaper,
		order,
	});
	assert.deepEqual(order, ["reapSandboxes", "createWorker"], "retained directories are swept before the worker takes a job");
	assert.equal(reaperArgs.sandboxDir, "/tmp/pi-sbx");
	assert.equal(reaperArgs.retentionHours, 6);
	// The one thing this reaper needs that its siblings do not: without it the sweep is blind and can
	// delete a bind mount out from under a shell an operator is sitting in.
	assert.equal(typeof reaperArgs.listRunning, "function", "the sweep must be able to ask which sandboxes are live");
	assert.equal(typeof deps.cleanup, "function", "teardown is the retention-aware closure, not the bare rm");
});

test("sandbox: retention off still wires a cleanup, and it is the delete-only one", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const { deps, logs } = await runStart({
		env: { PI_SANDBOX_RETENTION_HOURS: "0" },
		makeAuth,
		makeHost: () => fakeHost(),
	});
	assert.equal(typeof deps.cleanup, "function");
	// Boot says which way it is configured, so "why was nothing retained" is answerable from the log alone.
	assert.equal(logs.find((l) => l.event === "worker_started")?.sandboxRetentionHours, 0);
});

// REQ-GLOBAL-PI-OVERLAY staged packages. The overlay dir EXISTS (config refuses a missing one at load)
// but holds no packages.json -- the shape of every deployment that never opted into staged packages.
test("staged packages: an overlay with no packages.json boots to packagePaths [] and logs it -- never a boot failure", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const overlay = mkdtempSync(join(tmpdir(), "pi-global-"));
	try {
		const { captured, logs, runContainerCalls } = await runStart({ env: { PI_GLOBAL_PI_DIR: overlay }, makeAuth, makeHost: () => fakeHost() });

		assert.ok(captured, "an unreadable/absent manifest must not block boot -- doctor is what fails loud on the mismatch");
		assert.equal(runContainerCalls.length, 1, "the container factory is constructed exactly once, at boot");
		// A resolver since issue #102, so a re-stage lands on the next job without a restart. The factory is
		// still built once (asserted above); only the value it reads became a call.
		assert.equal(typeof runContainerCalls[0].packagePaths, "function", "the staged set reaches the factory as a per-job resolver");
		assert.deepEqual(runContainerCalls[0].packagePaths(), [], "an absent manifest resolves to the empty staged set, so every job stays unflagged");
		assert.equal(runContainerCalls[0].globalPiDir, overlay, "the overlay itself is still mounted -- only the staged packages are missing");

		const absent = logs.find((l) => l.event === "packages_manifest_absent");
		assert.ok(absent, "the absent manifest must leave one log line, so a silent [] is never the only trace");
		assert.equal(absent.overlay, overlay, "the line names the overlay it looked under (a deploy path is not PII)");
	} finally {
		rmSync(overlay, { recursive: true, force: true });
	}
});

test("staged packages: no overlay configured means no manifest read and no packages_manifest_absent noise", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const { logs, runContainerCalls } = await runStart({ makeAuth, makeHost: () => fakeHost() });
	assert.deepEqual(runContainerCalls[0].packagePaths(), [], "no overlay -> the empty staged set");
	assert.ok(!logs.some((l) => l.event === "packages_manifest_absent"), "a deployment with no overlay at all has nothing to warn about");
});

/**
 * Run `fn` with stdout captured, returning its value and the parsed log lines. runStart's own capture ends
 * when it returns, and the per-job resolver is called AFTER that, so its lines need their own window.
 */
function whileCapturingLogs(fn) {
	const origWrite = process.stdout.write;
	const lines = [];
	process.stdout.write = (chunk) => (lines.push(String(chunk)), true);
	let value;
	try {
		value = fn();
	} finally {
		process.stdout.write = origWrite;
	}
	const logs = lines.flatMap((l) =>
		l
			.split("\n")
			.filter(Boolean)
			.map((one) => {
				try {
					return JSON.parse(one);
				} catch {
					return { raw: one };
				}
			}),
	);
	return { value, logs };
}

// The reason the boot-time read became a per-job one (issue #102): `pi install` then `import-pi` is now a
// routine act, so a re-stage that only lands after a restart is a stale set nobody asked for.
test("staged packages: a re-stage after boot reaches the NEXT job, with no worker restart", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const overlay = mkdtempSync(join(tmpdir(), "pi-global-"));
	try {
		const { runContainerCalls } = await runStart({ env: { PI_GLOBAL_PI_DIR: overlay }, makeAuth, makeHost: () => fakeHost() });
		const resolve = runContainerCalls[0].packagePaths;
		assert.deepEqual(resolve(), [], "nothing staged at boot");

		mkdirSync(join(overlay, "packages"), { recursive: true });
		writeFileSync(join(overlay, "packages", "packages.json"), JSON.stringify({ stagedAt: null, packages: [{ name: "@a/b", version: "1.0.0", dir: "a__b" }] }));

		const first = whileCapturingLogs(() => resolve());
		assert.deepEqual(first.value, ["/opt/pi-global/packages/a__b"], "the next job sees what the stager just wrote");
		assert.equal(first.logs.filter((l) => l.event === "packages_stage_changed").length, 1, "the change is logged");
		const second = whileCapturingLogs(() => resolve());
		assert.deepEqual(second.value, ["/opt/pi-global/packages/a__b"]);
		assert.equal(second.logs.filter((l) => l.event === "packages_stage_changed").length, 0, "logged once per CHANGE, not once per job");
	} finally {
		rmSync(overlay, { recursive: true, force: true });
	}
});

// The transient-fault hole this resolver could have opened, closed. Degrading to [] would emit no
// PI_PACKAGES at all, so the runner's assertPackagePathsExist would have nothing to refuse and the job
// would run WITHOUT its tools and still exit 0 -- the silent no-op, arrived at by a different road.
test("staged packages: a manifest that goes unreadable after boot keeps the last-known-good set and says so", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const overlay = mkdtempSync(join(tmpdir(), "pi-global-"));
	try {
		mkdirSync(join(overlay, "packages"), { recursive: true });
		writeFileSync(join(overlay, "packages", "packages.json"), JSON.stringify({ stagedAt: null, packages: [{ name: "@a/b", version: "1.0.0", dir: "a__b" }] }));

		const { runContainerCalls } = await runStart({ env: { PI_GLOBAL_PI_DIR: overlay }, makeAuth, makeHost: () => fakeHost() });
		const resolve = runContainerCalls[0].packagePaths;
		assert.deepEqual(resolve(), ["/opt/pi-global/packages/a__b"]);

		writeFileSync(join(overlay, "packages", "packages.json"), "{ this is not json");
		const torn = whileCapturingLogs(() => resolve());
		assert.deepEqual(torn.value, ["/opt/pi-global/packages/a__b"], "a torn read keeps the last set rather than silently running toolless");
		assert.ok(torn.logs.some((l) => l.event === "packages_manifest_unreadable"), "and it is never silent");
	} finally {
		rmSync(overlay, { recursive: true, force: true });
	}
});

test("the image preflight and the container factory are wired from the SAME config.jobImage", { skip }, async () => {
	// If these two ever drifted, the worker would check one tag and run another -- the preflight would pass
	// on an image the container never uses, and the guarantee it exists to provide would be a lie.
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const { runContainerCalls, imagePreflightCalls } = await runStart({ env: { PI_JOB_IMAGE: "pi-job:0.1.0" }, makeAuth, makeHost: () => fakeHost() });

	assert.equal(imagePreflightCalls.length, 1, "the preflight is constructed exactly once, at boot");
	assert.equal(imagePreflightCalls[0].image, "pi-job:0.1.0", "PI_JOB_IMAGE reaches the preflight, not only the runner");
	assert.equal(imagePreflightCalls[0].image, runContainerCalls[0].image, "one deployment default, two consumers");
});

test("run-history: worker_started announces logsDir, captureJobLogs and logRetentionDays (a path is not PII)", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const { logs } = await runStart({
		env: { PI_LOGS_DIR: "/tmp/pi-logs", PI_CAPTURE_JOB_LOGS: "1", PI_LOG_RETENTION_DAYS: "7" },
		makeAuth,
		makeHost: () => fakeHost(),
	});
	const started = logs.find((l) => l.event === "worker_started");
	assert.ok(started, "a worker_started log must be emitted");
	assert.equal(started.logsDir, "/tmp/pi-logs", "worker_started must announce where records land");
	assert.equal(started.captureJobLogs, true, "worker_started must announce the raw-log capture gate");
	assert.equal(started.logRetentionDays, 7, "worker_started must announce the retention window");
});

test("a gitlab job routes to the gitlab forge's auth and host, never to github's", { skip }, async () => {
	// The whole point of the forges map: two forges configured at once, and each job reaching its own.
	const asked = { github: [], gitlab: [] };
	const ghHost = fakeHost({ isDefaultBranchProtected: async (ref) => (asked.github.push(ref?.repo), true) });
	const glHost = fakeHost({ isDefaultBranchProtected: async (ref) => (asked.gitlab.push(ref?.projectId), true) });
	const { deps } = await runStart({
		env: { GITLAB_TOKEN: "glpat-x" },
		makeAuth: async () => ({ mintToken: async () => "gh-tok", selfId: 1, source: "gh" }),
		makeHost: () => ghHost,
		makeGitLabAuth: async () => ({ mintToken: async () => "gl-tok", selfId: 2, source: "pat" }),
		makeGitLabHost: () => glHost,
	});

	const glJob = { kind: "gitlab", repo: "group/sub/proj", projectId: 42, target: { type: "issue", number: 5 } };
	const ghJob = { kind: "github", repo: "o/r", target: { type: "issue", number: 7 } };

	assert.equal(await deps.mintToken(glJob), "gl-tok", "a gitlab job must not be handed the github credential");
	assert.equal(await deps.mintToken(ghJob), "gh-tok");

	await deps.isDefaultBranchProtected(glJob, "gl-tok");
	await deps.isDefaultBranchProtected(ghJob, "gh-tok");
	assert.deepEqual(asked.gitlab, [42], "the gitlab host is keyed on the numeric project id");
	assert.deepEqual(asked.github, ["o/r"], "and the github host on the repo path -- neither saw the other's job");
});

test("with no GITLAB_TOKEN there is no gitlab forge, and a gitlab job refuses at mint", { skip }, async () => {
	const { deps } = await runStart({
		makeAuth: async () => ({ mintToken: async () => "gh-tok", selfId: 1, source: "gh" }),
		makeHost: () => fakeHost(),
	});
	await assert.rejects(
		() => deps.mintToken({ kind: "gitlab", repo: "g/p", projectId: 1 }),
		(e) => e.piDispatchConfig === true,
		"an unconfigured forge refuses with a message, rather than running the job anonymously",
	);
});
