import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// The Valkey these tests actually reach. `startWorker` connects for real here -- the fakes stop at docker,
// not at the queue -- so a URL pointing at nothing does not fail, it HANGS: BullMQ's connections carry
// `maxRetriesPerRequest: null`, which makes a command against an unreachable server queue forever rather
// than reject. A hardcoded local port therefore passes on a laptop that happens to run one there and wedges
// CI, where the service is published on a different port, with no error and no output. `VALKEY_TEST_URL` is
// what the rest of the suite reads and what CI sets; the literal is only the local fallback.
const VALKEY_URL = process.env.VALKEY_TEST_URL ?? "redis://127.0.0.1:6399";

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
async function runStart({ env = {}, makeAuth, makeHost, makeGitLabAuth, makeGitLabHost, makeReaper, makeLogSink, makeRecordWriter, makeLogReaper, makeSandboxReaper, makeRunContainer, makeHostRegistry, makeScopeClaimSweeper, order } = {}) {
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
			...(makeHostRegistry ? { makeHostRegistry } : {}),
			...(makeScopeClaimSweeper ? { makeScopeClaimSweeper } : {}),
			...(makeGitLabAuth ? { makeGitLabAuth } : {}),
			...(makeGitLabHost ? { makeGitLabHost } : {}),
		});
	} finally {
		process.stdout.write = origWrite;
	}

	const captured = calls[0];
	captured?.redis?.disconnect?.(); // release the background reconnect handle
	// EVERY extraCloser, not just the first: since issue #57 a deployment that declares a worker name also
	// opens a host-queue handle, and one unclosed ioredis connection holds the event loop open forever --
	// which shows up as the whole test FILE hanging rather than as a failure anyone can read.
	for (const closer of captured?.extraClosers ?? []) await Promise.resolve(closer?.close?.()).catch(() => {});

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
	// `secretProfiles` (issue #225) rides ALONGSIDE those ten rather than inside effectiveSettings, which is
	// why it appears here and not in that function's own pins: it carries no `overlay > env` precedence, so
	// putting it there would have claimed one it deliberately does not have.
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
			secretProfiles: {},
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

test("every session bound config reads is actually handed to the store", () => {
	// A bound that config parses and start.mjs forgets to pass is a knob an operator sets, doctor prints,
	// and nothing enforces -- silent in exactly the way this project keeps refusing to be. Asserted
	// against the SOURCE, the same tactic the checks above use: constructing the real wiring needs a
	// Valkey connection, and the makeSessionStore call is a literal either way.
	const src = readFileSync(new URL("../src/start.mjs", import.meta.url), "utf8");
	const call = src.match(/makeSessionStore\(\{[^}]*\}\)/s);
	assert.ok(call, "makeSessionStore must be called with an object literal");
	for (const [option, setting] of [
		["sessionsDir", "config.sessionsDir"],
		["ttlDays", "config.sessionsTtlDays"],
		["maxBytes", "config.sessionMaxBytes"],
		["maxAgeDays", "config.sessionMaxAgeDays"],
		["maxResumeChain", "config.sessionMaxResumeChain"],
		["maxContextPct", "config.sessionMaxContextPct"],
	]) {
		assert.match(call[0], new RegExp(`${option}:\\s*${setting.replace(".", "\\.")}`), `${option} must be wired from ${setting}`);
	}
});

// --- one-shot wiring (issue #231, DES-ONE-SHOT-DISARM-IN-THE-FILE): the file path, the deps entry,
// --- and the record-before-disarm order. startWorker exposes no factory seam for makeDisarmOnce /
// --- makeCheckOnceSpent, so these pins drive the REAL closures against a real temp triggers file.

const onceEntry = (number, disarmed) => ({ on: { type: "issue", action: ["closed"], number, once: true, ...(disarmed ? { disarmed } : {}) }, run: { kind: "github", flow: "deploy" } });
const onceEffectiveJob = (number) => ({ kind: "github", repo: "o/r", flow: "deploy", target: { type: "issue", number }, trigger: { matched: { index: 0, type: "issue", action: "closed", number, once: true } } });

test("once wiring: deps.checkOnceSpent reads PI_TRIGGERS_FILE when set, and excuses only this delivery's own id", { skip }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-once-path-"));
	try {
		const triggersPath = join(dir, "triggers.json");
		writeFileSync(triggersPath, JSON.stringify({ triggers: [onceEntry(40, { at: "2026-08-28T09:00:00.000Z", jobId: "gh-first" })] }));
		const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
		const { deps } = await runStart({ env: { PI_TRIGGERS_FILE: triggersPath }, makeAuth, makeHost: () => fakeHost() });

		assert.equal(typeof deps.checkOnceSpent, "function", "the one-shot pre-spend check must be wired into deps");
		assert.deepEqual(
			await deps.checkOnceSpent(onceEffectiveJob(40), { queueJobId: "gh-other" }),
			{ refused: true, at: "2026-08-28T09:00:00.000Z", jobId: "gh-first" },
			"a FOREIGN mark refuses with its provenance -- and it can only have read the file PI_TRIGGERS_FILE names",
		);
		assert.deepEqual(
			await deps.checkOnceSpent(onceEffectiveJob(40), { queueJobId: "gh-first" }),
			{ ok: true },
			"the delivery that spent the trigger keeps its second attempt (attempts:2 stays attempts:2)",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("once wiring: with PI_TRIGGERS_FILE unset the fallback is <cwd>/triggers.json -- doctor's own default", { skip }, async () => {
	// Deliberately NOT config.triggersFile, whose null means "cron disabled" and must keep meaning that:
	// under that knob the DEFAULT single-host deployment would have a firing receiver and a worker that
	// can neither disarm nor pre-spend-check. No factory seam exists, so the pin is behavioural: chdir
	// into a temp dir whose ./triggers.json holds a foreign mark, boot with an env that never names the
	// file, and the wired check must still find the mark.
	const dir = mkdtempSync(join(tmpdir(), "pi-once-cwd-"));
	const prevCwd = process.cwd();
	try {
		writeFileSync(join(dir, "triggers.json"), JSON.stringify({ triggers: [onceEntry(40, { at: "2026-08-28T09:00:00.000Z", jobId: "gh-first" })] }));
		process.chdir(dir);
		const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
		const { deps } = await runStart({ makeAuth, makeHost: () => fakeHost() }); // PI_TRIGGERS_FILE absent from env
		assert.deepEqual(
			await deps.checkOnceSpent(onceEffectiveJob(40), { queueJobId: "gh-other" }),
			{ refused: true, at: "2026-08-28T09:00:00.000Z", jobId: "gh-first" },
			"the check found the mark, so ./triggers.json resolved against the worker's own cwd",
		);
	} finally {
		process.chdir(prevCwd);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("once wiring: writeRecord lands strictly BEFORE the disarm, for all three record shapes", { skip }, async () => {
	// The crash direction is the chosen one: an armed one-shot WITH a record, never a disarm without
	// one. The injected writeRecord reads the triggers file at the instant it runs -- its OWN job's mark
	// must not exist yet (record strictly before disarm), while every EARLIER job's must (the real
	// disarm completes inside the prior recordRun call, uncontended). Three shapes because makeProcessor
	// has three recordRun call sites -- success, catch, and the settings-overlay-invalid refusal -- and
	// all of them funnel through this one start.mjs closure; driving the closure with each shape proves
	// the ordering holds wherever it is invoked from.
	const dir = mkdtempSync(join(tmpdir(), "pi-once-order-"));
	try {
		const triggersPath = join(dir, "triggers.json");
		writeFileSync(triggersPath, JSON.stringify({ triggers: [onceEntry(40), onceEntry(41), onceEntry(42)] }));
		const observed = [];
		const makeRecordWriter = () => (record) => {
			const marks = JSON.parse(readFileSync(triggersPath, "utf8")).triggers.map((t) => t.on.disarmed?.jobId ?? null);
			observed.push({ jobId: record.jobId, outcome: record.outcome, marks });
		};
		const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
		const { captured } = await runStart({ env: { PI_TRIGGERS_FILE: triggersPath }, makeAuth, makeHost: () => fakeHost(), makeRecordWriter });

		const at = "2026-08-28T09:00:00.000Z";
		const jobFor = (index, number, id) => ({
			id,
			attemptsMade: 0,
			name: "github",
			data: { kind: "github", repo: "o/r", flow: "deploy", target: { type: "issue", number }, trigger: { matched: { index, type: "issue", action: "closed", number, once: true } } },
		});
		// The three shapes the processor's call sites hand this closure (index.mjs).
		captured.recordRun({ job: jobFor(0, 40, "gh-success"), result: { outcome: "completed", exitCode: 0, turns: 1, tokens: null, budgetReserved: true }, startedAt: at, endedAt: at });
		captured.recordRun({ job: jobFor(1, 41, "gh-catch"), error: new Error("infra boom"), startedAt: at, endedAt: at });
		captured.recordRun({ job: jobFor(2, 42, "gh-overlay"), result: { outcome: "policy", reason: "settings-overlay-invalid", exitCode: null, turns: null, tokens: null, budgetReserved: false }, startedAt: at, endedAt: at });
		await new Promise((resolve) => setImmediate(resolve)); // let the fire-and-forget hooks' microtasks settle

		// The contract, exactly: each record was written while its OWN entry was still armed. (Earlier
		// jobs' marks may or may not be visible yet -- WHEN the fire-and-forget disarm settles is not
		// pinned, only that it never precedes its record.)
		assert.equal(observed.length, 3, "all three shapes reached the durable record");
		for (const [i, o] of observed.entries()) {
			assert.equal(o.marks[i], null, `record ${o.jobId}: its own entry must still be armed when writeRecord runs -- the disarm comes strictly after`);
		}
		assert.deepEqual(observed.map((o) => o.outcome), ["completed", "failed", "policy"], "the three call-site shapes all reached the durable record");
		const final = JSON.parse(readFileSync(triggersPath, "utf8")).triggers;
		assert.deepEqual(
			final.map((t) => t.on.disarmed),
			[
				{ at, jobId: "gh-success" },
				{ at, jobId: "gh-catch" },
				{ at, jobId: "gh-overlay" },
			],
			"every record shape disarms with the record's own endedAt -- 'fired' means 'produced a run record', per-attempt failures included",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ── scoped limits wiring (issue #242) ───────────────────────────────────────────────────────────────

test("scoped limits: a valid file boot-loads into a top-level closure, arms the watcher, and rides worker_started", { skip }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-sl-"));
	try {
		const file = join(dir, "scoped-limits.json");
		writeFileSync(file, `${JSON.stringify({ version: 1, limits: [{ scope: "acme/web", day: 3, concurrent: 1 }] })}\n`);
		const { captured, logs } = await runStart({ env: { PI_SCOPED_LIMITS_FILE: file } });
		assert.equal(typeof captured.scopedLimits, "function", "a closure, beside pauseUntil, at the TOP level (not in deps)");
		const rows = captured.scopedLimits();
		assert.equal(rows.length, 1);
		assert.equal(rows[0].day, 3);
		assert.ok(logs.some((l) => l.event === "scoped_limits_watching" && l.path === file), "the live-edit watcher armed");
		const started = logs.find((l) => l.event === "worker_started");
		assert.equal(started.scopedLimitsFile, file);
		assert.equal(started.scopedLimits, 1, "the row count -- money config gets boot visibility");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("scoped limits: unset means [] from the closure, no watcher, and null in worker_started", { skip }, async () => {
	const { captured, logs } = await runStart({});
	assert.deepEqual(captured.scopedLimits(), []);
	assert.ok(!logs.some((l) => l.event === "scoped_limits_watching"), "no file, no watcher");
	const started = logs.find((l) => l.event === "worker_started");
	assert.equal(started.scopedLimitsFile, null);
	assert.equal(started.scopedLimits, 0);
});

test("scoped limits: an invalid file refuses BOOT fail-loud (configError), with the operator present", { skip }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-sl-"));
	try {
		const file = join(dir, "scoped-limits.json");
		writeFileSync(file, JSON.stringify({ version: 1, limits: [{ scope: "acme/web", day: 0 }] }));
		await assert.rejects(
			() => runStart({ env: { PI_SCOPED_LIMITS_FILE: file } }),
			(e) => e.piDispatchConfig === true && /day must be an integer >= 1/.test(e.message),
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reloadScopedLimits keeps LAST-GOOD on a bad edit and hot-swaps on a good one", { skip }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-sl-"));
	try {
		const file = join(dir, "scoped-limits.json");
		const config = { scopedLimitsFile: file };
		const good = [{ scope: "acme/web", day: 3, week: null, month: null, concurrent: null }];
		const ref = { current: good };
		const logs = [];
		const log = (event, fields) => logs.push({ event, fields });

		writeFileSync(file, "{ not json");
		mod.reloadScopedLimits(config, ref, log);
		assert.equal(ref.current, good, "the SAME array object -- last-good untouched, not merely equal");
		assert.equal(logs[0].event, "scoped_limits_reload_invalid");

		writeFileSync(file, JSON.stringify({ version: 1, limits: [{ scope: "acme/web", day: 9 }] }));
		mod.reloadScopedLimits(config, ref, log);
		assert.equal(ref.current[0].day, 9, "a good edit swaps the ref");
		assert.deepEqual(logs[1], { event: "scoped_limits_reloaded", fields: { count: 1 } });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// --- host identity (issue #57) --------------------------------------------------------------------------

test("every log line carries the host", { skip }, async () => {
	const { logs } = await runStart({
		env: { PI_WORKER_NAME: "mac-mini-1", VALKEY_URL },
		makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
	});
	const emitted = logs.filter((l) => l.event);
	assert.ok(emitted.length > 0);
	for (const line of emitted) assert.equal(line.host, "mac-mini-1", `every line, including ${line.event}`);
});

test("a call site that passes its own host is OVERRIDDEN, never trusted", { skip }, async () => {
	const { deps } = await runStart({
		env: { PI_WORKER_NAME: "mac-mini-1", VALKEY_URL },
		makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
	});
	// The stamp sits AFTER the spread, so the closure's value wins: no call site knows better than this
	// one which process wrote a line, and one that passed `host` would be lying by construction.
	const { logs } = whileCapturingLogs(() => deps.log("forged", { host: "somewhere-else", jobId: "j1" }));
	const forged = logs.find((l) => l.event === "forged");
	assert.equal(forged.host, "mac-mini-1");
	assert.equal(forged.jobId, "j1", "and every other field the caller passed survives");
});

test("the worker is NAMED, the registry is closed on shutdown, and the boot line announces both host and digest", { skip }, async () => {
	const { captured, logs } = await runStart({
		env: { PI_WORKER_NAME: "mac-mini-1", VALKEY_URL },
		makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
	});

	// Naming the BullMQ Worker is what makes getWorkers() rows tell hosts apart, and it stamps
	// `processedBy` on every active job's hash for free.
	assert.equal(captured.name, "mac-mini-1");

	// The registry joins the runtime queue as an extraCloser, so a clean shutdown DELETES the row rather
	// than leaving a ghost peer for the TTL.
	// The runtime queue, the registry, and -- because this deployment DECLARES a name -- the host queue the
	// cron watcher reloads through. The registry is the one that must leave rather than expire.
	assert.ok(captured.extraClosers.length >= 2);
	const registryCloser = captured.extraClosers[1];
	assert.equal(typeof registryCloser.close, "function");
	await registryCloser.close();

	const started = logs.find((l) => l.event === "worker_started");
	assert.equal(started.host, "mac-mini-1");
	assert.ok("imageDigest" in started, "two hosts on two builds of one tag must not emit identical boot lines");
});

test("an unreachable Valkey cannot hang boot, and a HANG is what unreachable means here", { skip }, async () => {
	// `makeRedisClient` sets `maxRetriesPerRequest: null`, which BullMQ's blocking connections require and
	// which means a command against an unreachable server QUEUES rather than rejects. So the failure mode is
	// a hang, a try/catch around it catches nothing, and every registry await has to be BOUNDED instead.
	//
	// This drives the REAL registry over a redis whose every command never settles, rather than a fake whose
	// methods resolve instantly -- a fake would pass against the unbounded code this test exists to keep out.
	const { makeHostRegistry } = await import("../src/host-registry.mjs");
	const hanging = new Proxy({}, { get: () => () => new Promise(() => {}) });

	// A triggers file with a cron entry, so the boot RECONCILE runs too: `reconcileGated` awaits publish and
	// livePeers two hops below the deliberately un-awaited `start()`, and those were the second hang.
	const dir = mkdtempSync(join(tmpdir(), "pi-boot-hang-"));
	const folder = mkdtempSync(join(tmpdir(), "pi-boot-folder-"));
	const triggersFile = join(dir, "triggers.json");
	writeFileSync(triggersFile, JSON.stringify({ triggers: [{ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder, flow: "tidy", task: "tidy up" } }] }));

	try {
		const { captured, logs } = await Promise.race([
			runStart({
				env: { PI_WORKER_NAME: "mac-mini-1", VALKEY_URL, PI_TRIGGERS_FILE: triggersFile },
				makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
				makeHostRegistry: (args) => makeHostRegistry({ ...args, redis: hanging, timeoutMs: 50 }),
			}),
			// NOT unref'd: an unref'd rejection timer does not fire when the hang is the only thing left, so
			// the test would hang rather than fail -- which is the failure it is meant to report.
			new Promise((_r, reject) => setTimeout(() => reject(new Error("boot waited on the registry")), 15000)),
		]);

		assert.ok(captured, "the worker is constructed regardless");
		assert.ok(logs.some((l) => l.event === "worker_started"), "a worker whose row never appears still comes up");
		assert.ok(logs.some((l) => l.event === "host_registry_unreachable"), "and the outage is REPORTED -- a bound is what turns a hang into something the catch can see");
		// The gate proceeded rather than refusing: not knowing whether anyone disagrees is not knowing that
		// someone does, so absence never refuses.
		assert.ok(logs.some((l) => l.event === "schedules_installed"), "and cron still reconciled");
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(folder, { recursive: true, force: true });
	}
});

test("the boot scope-claim sweep actually RUNS, and is told whether the reaper enumerated", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });

	// The headline defect this pins: `makeReaper` returned nothing at all, so `?.reaped === true` was
	// always false and the whole sweep was dead code that nobody noticed. Every reaper fake in this file
	// also returns undefined, so no wiring test exercised the sweep running -- which is exactly how a
	// silent no-op survives. This one drives it end to end.
	const swept = [];
	await runStart({
		env: { PI_WORKER_NAME: "mac-mini-1", VALKEY_URL },
		makeAuth,
		makeHost: () => fakeHost(),
		makeReaper: () => async () => ({ reaped: true }),
		makeScopeClaimSweeper: (args) => async (opts) => (swept.push({ workerName: args.workerName, ...opts }), { swept: 0, skipped: false }),
	});
	assert.deepEqual(swept, [{ workerName: "mac-mini-1", reaped: true }]);
});

test("a reaper that could not enumerate passes reaped:false, and the sweep declines", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });

	// The money finding: freeing a slot for a container that may still be running lets ANOTHER host start
	// one alongside it. The reaper's `docker ps` is inside its own try, so a daemon blip means this host
	// never established that it holds nothing -- and the sweep must be told that, not guess.
	const swept = [];
	await runStart({
		env: { PI_WORKER_NAME: "mac-mini-1", VALKEY_URL },
		makeAuth,
		makeHost: () => fakeHost(),
		makeReaper: () => async () => ({ reaped: false }),
		makeScopeClaimSweeper: () => async (opts) => (swept.push(opts), { swept: 0, skipped: true }),
	});
	assert.deepEqual(swept, [{ reaped: false }]);
});

test("an UNDECLARED worker name never sweeps a shared keyspace it does not participate in", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });

	const swept = [];
	await runStart({
		env: { VALKEY_URL },
		makeAuth,
		makeHost: () => fakeHost(),
		makeReaper: () => async () => ({ reaped: true }),
		makeScopeClaimSweeper: () => async (opts) => (swept.push(opts), { swept: 0, skipped: false }),
	});
	assert.deepEqual(swept, [], "no name declared means no fleet claims to own");
});
