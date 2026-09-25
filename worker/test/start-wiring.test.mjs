import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeBackendRegistry as realRegistry } from "../src/backend-registry.mjs";
import { makePodmanBackend as realPodmanBackend } from "../src/backend-podman.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

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
// These tests need a REAL queue: `startWorker` connects for real (the fakes here stop at docker, not at
// the queue), and BullMQ's connections carry `maxRetriesPerRequest: null`, so a URL pointing at nothing does
// not fail, it HANGS forever. That makes "no Valkey" a state this file must DECLINE rather than attempt --
// a hang has no error, no output and no end, and it wedged both the required contract job and the release
// workflow, the latter of which has no Valkey service at all and would never have published.
const skip = !mod
	? `worker deps not installed (node ${process.version} < 22.19.0); CI runs these`
	: process.env.VALKEY_TEST_URL
		? false
		: "needs VALKEY_TEST_URL (startWorker connects for real; a dead URL hangs rather than fails)";

// The Valkey these tests actually reach. `startWorker` connects for real here -- the fakes stop at docker,
// not at the queue -- so a URL pointing at nothing does not fail, it HANGS: BullMQ's connections carry
// `maxRetriesPerRequest: null`, which makes a command against an unreachable server queue forever rather
// than reject. A hardcoded local port therefore passes on a laptop that happens to run one there and wedges
// CI, where the service is published on a different port, with no error and no output. `VALKEY_TEST_URL` is
// what the rest of the suite reads and what CI sets; the literal is only the local fallback.
const VALKEY_URL = process.env.VALKEY_TEST_URL ?? "redis://127.0.0.1:6399";

// EVERY byte `startWorker`'s `write` seam emits, in order, for the life of the file.
//
// Nothing here reassigns `process.stdout.write`, and that is the whole point (issue #266). `node --test`
// runs each file in a child process that serialises its own results over that same stdout, so a helper
// holding a replacement across an `await` swallows the runner's result frames: three tests in this file
// were reported as never existing at all -- no name, no count, exit code 0. Reading the product's own
// injected writer cannot lose anything, because it never touches the channel the runner needs.
const bootLines = [];

/** Parse the raw chunks a slice of `bootLines` holds; a non-JSON chunk survives as `{ raw }`. */
function parseLines(chunks) {
	return chunks.flatMap((l) =>
		String(l)
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
}

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
/** A host filesystem with none of the files the runtime-mounts observation reads. */
const enoent = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
const NO_HOST_FILES = { statSync: (p) => { throw enoent(p); }, readFileSync: (p) => { throw enoent(p); }, readdirSync: (p) => { throw enoent(p); } };

/**
 * `podman info` as `makePodmanInfoReader` answers it (issue #354): a healthy rootless Podman on cgroup v2 with the three
 * controllers delegated, unless a test overrides a fact. `answer` replaces the whole answer (an unanswered read).
 */
function PODMAN_INFO(over = {}, { answer, calls } = {}) {
	return async () => {
		calls?.push("podman info");
		return answer ?? { answered: true, info: { rootless: true, serviceIsRemote: false, selinux: false, cgroupVersion: "v2", controllers: ["cpuset", "cpu", "io", "memory", "pids"], version: "5.8.1", ...over } };
	};
}

/**
 * A venue other than `local` with the five required functions and NEITHER optional preflight (issue #354), so a job on it
 * gets the registry's absent answers. `spawned` records every call, which is how a test proves nothing here ran.
 */
function OTHER_VENUE(name, { spawned = [], reap = async () => ({ reaped: true }), ...extra } = {}) {
	return {
		name,
		neverStartedExits: [],
		containerName: (id) => `${name}-${id}`,
		runContainer: async () => (spawned.push(`${name}:runContainer`), { code: 0 }),
		imagePreflight: async () => (spawned.push(`${name}:imagePreflight`), { ok: true, imageDigest: `sha256:${name}`, piVersion: "0.0.0-test" }),
		egressPreflight: async () => (spawned.push(`${name}:egressPreflight`), { ok: true }),
		stopContainer: async () => spawned.push(`${name}:stopContainer`),
		reap,
		...extra,
	};
}

async function runStart({ env = {}, makeAuth, makeHost, makeGitLabAuth, makeGitLabHost, makeReaper, makeLogSink, makeRecordWriter, makeLogReaper, makeSandboxReaper, makeSandboxNetworkSweeper, makeRetentionSweep, makeRunContainer, makeHostRegistry, makeScopeClaimSweeper, makeBackendRegistry, extraBackends, order, stops, now, authResolveTimeoutMs, resolveDockerEndpoint, readDaemonFacts, jobUserIdentity, bootImage, observationFs, loadConfig, readPodmanInfo, makePodmanReaper, makePodmanBackend } = {}) {
	const secretsResolverCalls = [];
	const calls = [];
	const registered = {};
	const stopCalls = [];
	const createWorkerFn = (arg) => {
		if (order) order.push("createWorker");
		calls.push(arg);
		// Record every worker.on(...) registration so tests can drive the completed/failed handlers
		// (inspecting the emitted log line) and assert the scheduler stall guard's "stalled" listener.
		// `stop` records too (issue #299): a boot that refuses after this handoff must stop what it was
		// handed, and the recording is how a test tells the PRODUCT did it rather than this harness's own
		// teardown, which drains closers and disconnects but never calls stop. ASYNC deliberately -- the
		// wrap spells `Promise.resolve(worker?.stop?.())` precisely so a synchronous double cannot
		// TypeError over the boot's real error, and this double must not hide that spelling's job.
		return {
			on(evt, fn) {
				registered[evt] = fn;
			},
			stop: async () => {
				stopCalls.push("stop");
				// Into the CALLER'S array too, like `order`: a refusing boot rejects, so its caller never
				// sees runStart's return value and this is the only wire out.
				stops?.push("stop");
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

	// Its network sweeper is faked for exactly the same reason, and one more: the real one's default runner
	// is the docker CLI, so CALLING it in a wiring test would shell out. Tests assert what boot hands the
	// reaper, never a docker call.
	const sandboxSweeperCalls = [];
	const sandboxSweeper =
		makeSandboxNetworkSweeper ??
		(() => {
			const sweep = async (args) => {
				sandboxSweeperCalls.push(args);
				return { swept: [], notes: [] };
			};
			return sweep;
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

	// The boot log is collected through `startWorker`'s OWN `write` seam, never by reassigning
	// `process.stdout.write`. Under `node --test` the child process serialises its results over that same
	// stdout, so holding a replacement across this `await` swallowed the runner's result frames: three tests
	// in this file were reported as never existing -- no name, no count, exit 0 (issue #266).
	// Issue #354: the podman venue's bundle is the REAL one, so what the wiring hands it is what a job gets, with its two
	// spawning edges replaced: the image preflight answers like local's fake above, and every other podman spawn throws, so
	// a wiring test can never start one. `podmanBackendCalls` records the options boot handed it.
	const podmanBackendCalls = [];
	const podmanBackend =
		makePodmanBackend ??
		((opts) => {
			podmanBackendCalls.push(opts);
			return realPodmanBackend({
				...opts,
				makeImagePreflight: (args) => (imagePreflightCalls.push({ ...args, podman: true }), async () => bootImage ?? { ok: true }),
				spawnFn: () => {
					throw new Error("a wiring test must never spawn podman");
				},
			});
		});

	const from = bootLines.length;
	let captured;
	let booted = false;
	try {
		await mod.startWorker(env, {
			write: (chunk) => {
				bootLines.push(String(chunk));
				return true;
			},
			makeAuth,
			makeHost,
			createWorkerFn,
			makeReaper: reaper,
			makeLogSink: logSink,
			makeRecordWriter: recordWriter,
			makeLogReaper: logReaper,
			makeSandboxReaper: sandboxReaper,
			makeSandboxNetworkSweeper: sandboxSweeper,
			makeRunContainer: runContainerFactory,
			makeSecretsResolver: (args) => (secretsResolverCalls.push(args), async () => ({ ok: true, secrets: {} })),
			makeImagePreflight: (args) => (imagePreflightCalls.push(args), async () => bootImage ?? { ok: true }),
			// Issue #278: never the real CLI under test. A local socket unless a test says otherwise.
			resolveDockerEndpoint: resolveDockerEndpoint ?? (async () => ({ local: true, context: "test", endpoint: "unix:///test.sock", reason: null, transient: false })),
			// Issue #341: never the real daemon or this process's ids under test. A rootful Docker body and uid 1001, so the
			// job-user decision is `worker` with no --user (the shipped image's own uid) unless a test says otherwise.
			readDaemonFacts: readDaemonFacts ?? (async () => ({ answered: true, facts: { shape: "docker", podman: false, os: "Test Linux", rootless: false, userns: false, bounds: { pids: true, memory: true }, serviceIsRemote: null, remoteSocketPath: null } })),
			jobUserIdentity: jobUserIdentity ?? { platform: "linux", release: "6.8.0-test", euid: 1001, egid: 1001 },
			// Issue #345: never this machine's /etc. A host with none of Podman's files unless a test says otherwise.
			observationFs: observationFs ?? NO_HOST_FILES,
			// Issue #354: never the real `podman info` under test. A healthy rootless Podman unless a test says otherwise; only
			// a boot that blesses `podman` ever asks.
			readPodmanInfo: readPodmanInfo ?? PODMAN_INFO(),
			makePodmanReaper: makePodmanReaper ?? (() => async () => ({ reaped: true })),
			makePodmanBackend: podmanBackend,
			...(makeBackendRegistry ? { makeBackendRegistry } : {}),
			...(extraBackends ? { extraBackends } : {}),
			...(loadConfig ? { loadConfig } : {}),
			...(makeRetentionSweep ? { makeRetentionSweep } : {}),
			...(makeHostRegistry ? { makeHostRegistry } : {}),
			...(makeScopeClaimSweeper ? { makeScopeClaimSweeper } : {}),
			...(makeGitLabAuth ? { makeGitLabAuth } : {}),
			...(makeGitLabHost ? { makeGitLabHost } : {}),
			...(now ? { now } : {}),
			...(authResolveTimeoutMs ? { authResolveTimeoutMs } : {}),
		});
		booted = true;
	} finally {
		// TEARDOWN RUNS ON A REJECTING BOOT TOO (issue #295). A boot can refuse AFTER `createWorkerFn` has
		// already been handed the queue, the registry and the redis client -- `reconcileGated` awaits
		// `livePeers()` outside its own try, and the backend registry refuses on nine conditions -- and
		// without this `finally` every one of those paths skipped the disconnect, the closer drain and the
		// host-queue sweep. One unclosed ioredis connection holds the event loop open forever, which shows
		// up as the whole test FILE hanging rather than as a failure anyone can read.
		captured = calls[0];
		try {
			// The BACKSTOP for a faked createWorker, no longer the only closer anywhere (issue #300): the
			// real shutdown releases this client itself, sequenced after the closer drain, but that shutdown
			// lives inside the real createWorker and this file fakes createWorkerFn -- so the product's
			// release is unreachable here by construction and `wiring.test.mjs` is where it is pinned.
			captured?.redis?.disconnect?.();
			// EVERY extraCloser, not just the first: since issue #57 a deployment that declares a worker name
			// also opens a host-queue handle, and since issue #295 the three live-edit file watchers ride the
			// same list -- so this loop is what proves, on every test in this file, that a watch does not
			// outlive the boot that armed it.
			for (const closer of captured?.extraClosers ?? []) await Promise.resolve(closer?.close?.()).catch(() => {});

		// DELETE THE HOST QUEUE THIS RUN CREATED (issue #262). A declared `PI_WORKER_NAME` makes `startWorker`
		// open `pi-jobs@<name>`, and BullMQ's meta key for it outlives the process: they accumulate across runs
		// and are exactly what `discoverHostQueues` reads to find host queues. Nothing in the suite reads the
		// live keyspace for them today, but the read they would pollute was added by the same slice that created
		// the residue, and it has already produced one false result: a live check of "a deployment that never had
		// a named worker opens exactly one queue" reported the claim FALSE against leftover keys. The claim was
		// true; the fixture was dirty.
		//
		// AFTER the closers and on its OWN client, both deliberately. Deleting before `queue.close()` does not
		// work -- BullMQ writes `:meta` back on the way out, so the keys reappear -- and the worker's own client
		// is disconnected by then. The MATCH is narrowed to this run's declared name, so it can only ever remove
		// what this file made.
		if (env.PI_WORKER_NAME) {
			const { makeRedisClient } = await import("../src/connection.mjs");
			const sweeper = makeRedisClient(env.VALKEY_URL ?? VALKEY_URL);
			sweeper.on("error", () => {});
			try {
				let cursor = "0";
				const keys = [];
				do {
					const [next, batch] = await sweeper.scan(cursor, "MATCH", `bull:pi-jobs@${env.PI_WORKER_NAME}:*`, "COUNT", 200);
					cursor = next;
					keys.push(...batch);
				} while (cursor !== "0");
				if (keys.length > 0) await sweeper.del(...keys);
			} catch {
				// Best effort: a surviving key costs a FUTURE test a confusing fixture, never this one a failure.
			} finally {
				sweeper.disconnect();
			}
		}
		} catch (teardownError) {
			// SWALLOWED ONLY ON A REFUSED BOOT, where a throw here would surface instead of the configError the
			// caller's `assert.rejects` is matching on and the real failure would vanish. On a boot that
			// SUCCEEDED there is nothing to protect and everything to lose: a teardown that started failing used
			// to turn forty tests in this file red, and a blanket swallow would buy the refused-boot case by
			// making a leaked handle silent -- which is the trade this file exists downstream of.
			if (booted) throw teardownError;
		}
	}

	const logs = parseLines(bootLines.slice(from));
	// Expose the registration map under both names: `handlers` for the completed/failed handler tests,
	// `registered` for the scheduler stall-guard test. Same object, one capture path.
	return { captured, stopCalls, deps: captured?.deps, logs, handlers: registered, registered, logSinkCalls, recordWriterCalls, logReaperCalls, sandboxReaperCalls, runContainerCalls, imagePreflightCalls, secretsResolverCalls, podmanBackendCalls };
}

// Capture the JSON log lines a synchronous fn emits through the injected writer.
function captureLogs(fn) {
	// Reads the slice of `bootLines` that `fn` produced, rather than stealing `process.stdout.write`.
	const from = bootLines.length;
	fn();
	return parseLines(bootLines.slice(from));
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
	// TAGGED, because that is what a determinate failure now has to be for this path to hold. The fixture
	// used to throw a bare Error and rely on every throw being treated alike; issue #316 made the tag the
	// discriminator, and a genuinely logged-out `gh` is exactly the determinate case.
	const makeAuth = async () => {
		throw Object.assign(new Error("gh CLI is logged out"), { piDispatchConfig: true });
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

test("a TRANSIENT boot auth failure is re-resolved on the next job, not carried for the process lifetime", { skip }, async () => {
	// Issue #316, and the most expensive shape in it. Boot auth is best-effort inside a try/catch, and any
	// throw used to leave `auth` null forever. So a forge that was merely unreachable for the seconds this
	// loop ran stayed credential-less until somebody restarted the worker, and every job of that kind then
	// hit the configError fallback -- which, since #310, refunds the reserve and posts a public comment
	// telling the issue author the operator's deployment is misconfigured. A deployment `doctor` calls
	// healthy.
	let attempt = 0;
	const makeAuth = async () => {
		attempt += 1;
		if (attempt === 1) throw new Error("connect ETIMEDOUT api.github.com:443"); // untagged: transient
		return { mintToken: async () => "tok", selfId: 777, source: "gh" };
	};
	const { deps, logs } = await runStart({ makeAuth, makeHost: () => fakeHost() });

	assert.ok(
		logs.some((l) => l.event === "github_auth_unavailable" && l.transient === true),
		"the boot line must say the failure was transient, so the two cases are distinguishable in a log",
	);
	// `logs` is a SNAPSHOT taken when runStart returned, so the recovery line cannot be in it. Read the
	// slice the mint itself produces instead, which is also the only way to prove the line is emitted by
	// the re-resolve rather than by boot.
	const from = bootLines.length;
	assert.equal(await deps.mintToken({ kind: "github", repo: "o/r" }), "tok", "the next job re-resolves and mints");
	assert.equal(attempt, 2, "exactly one re-resolve, on demand");
	const afterMint = parseLines(bootLines.slice(from));
	assert.ok(
		afterMint.some((l) => l.event === "self_identity" && l.id === 777 && l.kind === "github"),
		"the recovered identity is logged like any other, so an operator can see the forge came back",
	);
});

test("a DETERMINATE boot auth failure is not retried -- the refusal stays immediate", { skip }, async () => {
	// The bound. Re-resolving a wrong credential is how a deployment pays to be told the same thing twice,
	// and the local-only case (no `gh` on PATH) is precisely this: it must boot and drain cron jobs with
	// one attempt and no further calls.
	let attempt = 0;
	const makeAuth = async () => {
		attempt += 1;
		throw Object.assign(new Error("`gh auth token` failed (ENOENT)"), { piDispatchConfig: true });
	};
	const { deps, logs } = await runStart({ makeAuth, makeHost: () => fakeHost() });

	assert.ok(logs.some((l) => l.event === "github_auth_unavailable" && l.transient === false));
	await assert.rejects(() => deps.mintToken({ kind: "github", repo: "o/r" }), (e) => e.piDispatchConfig === true);
	await assert.rejects(() => deps.mintToken({ kind: "github", repo: "o/r" }), (e) => e.piDispatchConfig === true);
	assert.equal(attempt, 1, "the determinate failure must not be retried, on this job or the next");
});

test("a re-resolve that fails transiently is retryable, never a public misconfiguration verdict", { skip }, async () => {
	// The forge is still down when the job arrives. That is an infrastructure failure and it must reach the
	// processor as one: the config classifier would refund the reserve, complete the job, and comment on
	// the issue that the operator's deployment is misconfigured.
	const makeAuth = async () => {
		throw new Error("connect ECONNREFUSED");
	};
	const { deps } = await runStart({ makeAuth, makeHost: () => fakeHost() });
	await assert.rejects(
		() => deps.mintToken({ kind: "github", repo: "o/r" }),
		(e) => e.piDispatchRetry === true && e.piDispatchConfig === undefined,
	);
});

test("a re-resolve that fails DETERMINATELY stops re-resolving -- the second job refuses immediately", { skip }, async () => {
	// Boot failed transiently, so a re-resolver was kept; by the time a job arrives the credential has
	// genuinely gone (revoked token, deleted app). That answer will not change, and asking again on every
	// delivery is one identity call per job against a credential that can never work. So the determinate
	// answer RETIRES the re-resolver, which is the same rule the boot arm applies one step earlier.
	let attempt = 0;
	const makeAuth = async () => {
		attempt += 1;
		if (attempt === 1) throw new Error("connect ETIMEDOUT");
		throw Object.assign(new Error("bad app credentials (401)"), { piDispatchConfig: true });
	};
	const { deps } = await runStart({ makeAuth, makeHost: () => fakeHost() });
	await assert.rejects(
		() => deps.mintToken({ kind: "github", repo: "o/r" }),
		// The REAL reason, not the generic "configure GITHUB_AUTH_SOURCE". `ensureAuth` used to turn a
		// determinate failure into null, which sent every such job to the fallback message while the
		// specific one was already in hand and went only to the log.
		(e) => e.piDispatchConfig === true && /bad app credentials/.test(e.message),
	);
	assert.equal(attempt, 2, "boot, then one re-resolve");
	await assert.rejects(() => deps.mintToken({ kind: "github", repo: "o/r" }), (e) => e.piDispatchConfig === true);
	assert.equal(attempt, 2, "the second job must not ask again -- the determinate answer retired the retry");
});

test("comment re-resolves a transiently-failed forge, and still falls back to stdout when it cannot", { skip }, async () => {
	// A comment is how a refusal reaches the person who asked for the job. A forge whose auth was merely
	// unreachable during boot used to degrade every later comment to a stdout line for the lifetime of the
	// process, which on a github deployment means the issue author is told nothing at all.
	let attempt = 0;
	const posted = [];
	const host = fakeHost({ postStatusComment: async (_job, _target, text) => void posted.push(text) });
	const makeAuth = async () => {
		attempt += 1;
		if (attempt === 1) throw new Error("connect ETIMEDOUT");
		return { mintToken: async () => "tok", selfId: 1, source: "gh" };
	};
	const { deps } = await runStart({ makeAuth, makeHost: () => host });
	await deps.comment({ kind: "github", repo: "o/r", id: "j1" }, "Refused: ...");
	assert.deepEqual(posted, ["Refused: ..."], "the re-resolved credential posts the comment for real");

	// And when the forge is still unreachable, the adapter must not throw AND must not swallow the text:
	// the stdout line is the only remaining signal, so it has to stay reachable.
	const downHost = fakeHost();
	const { deps: d2 } = await runStart({ makeAuth: async () => { throw new Error("connect ECONNREFUSED"); }, makeHost: () => downHost });
	const from = bootLines.length;
	await assert.doesNotReject(() => d2.comment({ kind: "github", repo: "o/r", id: "j2" }, "still needs saying"));
	const after = parseLines(bootLines.slice(from));
	assert.ok(
		after.some((l) => l.event === "comment" && l.text === "still needs saying"),
		"the text falls through to stdout rather than being replaced by a comment_failed line that omits it",
	);
});

test("a factory that throws SYNCHRONOUSLY does not leave the forge dead for the process lifetime", { skip }, async () => {
	// An async function runs synchronously up to its first await, so a factory that throws before any await
	// runs the whole re-resolve body -- cleanup included -- BEFORE the in-flight entry is stored. The
	// cleanup then finds an empty map, the rejected promise is installed, and every later job awaits that
	// same rejection: the forge is dead until someone restarts the worker, which is the exact defect #316
	// exists to remove, reintroduced by its own fix. Found by a mutation check, not by reading.
	let attempt = 0;
	const makeAuth = (cfg) => {
		attempt += 1;
		if (attempt === 1) return Promise.reject(new Error("connect ETIMEDOUT")); // boot: transient
		if (attempt === 2) throw new Error("sync boom"); // NOT a rejection: a synchronous throw
		return Promise.resolve({ mintToken: async () => "tok", selfId: 3, source: "gh" });
	};
	let clock = 1_000_000;
	const { deps } = await runStart({ makeAuth, makeHost: () => fakeHost(), now: () => clock });

	await assert.rejects(() => deps.mintToken({ kind: "github", repo: "o/r" }), (e) => e.piDispatchRetry === true);
	assert.equal(attempt, 2, "the sync throw was the re-resolve");

	clock += 30_000; // past the cooldown
	assert.equal(await deps.mintToken({ kind: "github", repo: "o/r" }), "tok", "the next job must be able to ask again");
	assert.equal(attempt, 3);
});

test("a forge that accepts the connection and never answers does not wedge the queue", { skip }, async () => {
	// The re-resolve put a live network call on the per-job path, and none of the four resolvers passes an
	// AbortSignal while undici's default header timeout is five minutes. A load balancer draining, or a
	// firewall that drops rather than rejects, would hold every job for that long with BullMQ renewing the
	// lock the whole time, so nothing ever stalls out: at PI_CONCURRENCY=1 that is the queue stopped, with
	// no error line anywhere.
	let released;
	const blackHole = new Promise((r) => {
		released = r;
	});
	let attempt = 0;
	const makeAuth = async () => {
		attempt += 1;
		if (attempt === 1) throw new Error("connect ETIMEDOUT");
		await blackHole; // accepts, and answers nothing
		return { mintToken: async () => "tok", selfId: 4, source: "gh" };
	};
	// The production bound is ten seconds. Injected down to 50ms here because the property is that a bound
	// EXISTS, and proving it by waiting ten real seconds would be paid for on every run for the life of
	// this file.
	const { deps } = await runStart({ makeAuth, makeHost: () => fakeHost(), authResolveTimeoutMs: 50 });

	// The assertion is that the mint SETTLES, not that it succeeds.
	const raced = await Promise.race([
		deps.mintToken({ kind: "github", repo: "o/r" }).then(() => "resolved", (e) => (e?.piDispatchRetry === true ? "refused" : "other")),
		new Promise((r) => setTimeout(() => r("still-pending"), 250)),
	]);
	released();
	assert.notEqual(raced, "still-pending", "a job must not sit on an unanswered identity call");

	// The comment adapter shares the bound, and it matters more there: it is how a refusal reaches the
	// person who asked, and it promises never to throw.
	const commented = await Promise.race([
		assert.doesNotReject(() => deps.comment({ kind: "github", repo: "o/r", id: "j1" }, "text")).then(() => "done"),
		new Promise((r) => setTimeout(() => r("still-pending"), 250)),
	]);
	assert.notEqual(commented, "still-pending", "the comment adapter must not hang either");
});

test("a SEQUENTIAL backlog against a forge that is still down is bounded by a cooldown", { skip }, async () => {
	// The in-flight promise dedupes CONCURRENT callers. It does nothing for sequential ones, which is the
	// shape a PI_CONCURRENCY=1 worker draining a backlog actually has: without a cooldown that is one live
	// identity round-trip per job, forever, each able to sit on undici's 300-second header timeout with the
	// queue waiting behind it.
	let attempt = 0;
	const makeAuth = async () => {
		attempt += 1;
		throw new Error("connect ETIMEDOUT");
	};
	let clock = 1_000_000;
	const { deps } = await runStart({ makeAuth, makeHost: () => fakeHost(), now: () => clock });
	assert.equal(attempt, 1, "boot tried once");

	for (let i = 0; i < 5; i++) {
		await assert.rejects(() => deps.mintToken({ kind: "github", repo: "o/r" }), (e) => e.piDispatchRetry === true);
	}
	assert.equal(attempt, 2, "five sequential jobs, one re-resolve: the rest were answered from the cooldown");

	// And the cooldown expires rather than latching: a forge that comes back is picked up within one job.
	clock += 30_000;
	await assert.rejects(() => deps.mintToken({ kind: "github", repo: "o/r" }), (e) => e.piDispatchRetry === true);
	assert.equal(attempt, 3, "past the window, exactly one more attempt");
});

test("the cooldown answers with the SAME verdict, not a vaguer one", { skip }, async () => {
	// A cooldown that reported something generic would trade one defect for another: the operator would see
	// a different message depending on which job in the backlog they looked at.
	const makeAuth = async () => { throw new Error("connect ETIMEDOUT api.github.com:443"); };
	const { deps } = await runStart({ makeAuth, makeHost: () => fakeHost(), now: () => 1_000_000 });
	const first = await deps.mintToken({ kind: "github", repo: "o/r" }).catch((e) => e);
	const second = await deps.mintToken({ kind: "github", repo: "o/r" }).catch((e) => e);
	assert.equal(second.piDispatchRetry, true);
	assert.equal(second.message, first.message, "the cached refusal reads exactly like the one that produced it");
});

test("concurrent jobs share ONE re-resolve, not one per job", { skip }, async () => {
	// A worker at PI_CONCURRENCY>1 draining a backlog after a forge outage would otherwise open an identity
	// call per job, against the forge that just came back.
	let attempt = 0;
	let release;
	const gate = new Promise((r) => { release = r; });
	const makeAuth = async () => {
		attempt += 1;
		if (attempt === 1) throw new Error("connect ETIMEDOUT");
		await gate;
		return { mintToken: async () => "tok", selfId: 5, source: "gh" };
	};
	const { deps } = await runStart({ makeAuth, makeHost: () => fakeHost() });
	const jobs = [deps.mintToken({ kind: "github", repo: "o/r" }), deps.mintToken({ kind: "github", repo: "o/r" }), deps.mintToken({ kind: "github", repo: "o/r" })];
	release();
	assert.deepEqual(await Promise.all(jobs), ["tok", "tok", "tok"]);
	assert.equal(attempt, 2, "one boot attempt and one shared re-resolve, for three concurrent jobs");
});

test("a local job still reaches github auth, because run.github borrows it", { skip }, async () => {
	// `mintToken` maps kind "local" onto github before asking, and the re-resolve must not have moved that
	// mapping: a cron trigger with run.github is the case.
	let attempt = 0;
	const makeAuth = async () => {
		attempt += 1;
		if (attempt === 1) throw new Error("connect ETIMEDOUT");
		return { mintToken: async () => "tok", selfId: 9, source: "gh" };
	};
	const { deps } = await runStart({ makeAuth, makeHost: () => fakeHost() });
	assert.equal(await deps.mintToken({ kind: "local", repo: "o/r" }), "tok");
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

	// (a) the money backstop is keyed on "stalled", and it is INVOKED here rather than merely counted.
	//
	// `typeof registered.stalled === "function"` was the whole assertion for the life of this feature, and it
	// could not fail: the registered arrow is a function whatever its body does. The body called
	// `guard.onStalled(jobId)` while `makeStallGuard` returns the listener ITSELF, so every stall threw
	// `TypeError: guard.onStalled is not a function` and the guard never counted one (issue #267). BullMQ
	// exempts scheduler jobs from `maxStalledCount`, so this listener is the only thing standing between a
	// wedged cron run and being re-paid forever -- CONST-RETRY-INFRA-ONLY's "BullMQ will never do this for
	// us". A backstop that is never called is worth nothing, and only calling it can tell you.
	assert.equal(typeof registered.stalled, "function", "a stalled listener (the scheduler stall guard) must be registered");
	await assert.doesNotReject(async () => {
		const out = registered.stalled("repeat:not-a-real-scheduler:1");
		await Promise.resolve(out);
	}, "the registered listener must actually RUN -- a listener that throws is a backstop that does not exist");

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
	const dir = tempDir("pi-settings-");
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
	const madeSweeper = async () => ({ swept: [], notes: [] });
	const { deps } = await runStart({
		env: { PI_SANDBOX_DIR: "/tmp/pi-sbx", PI_SANDBOX_RETENTION_HOURS: "6", PI_JOB_IMAGE: "pi-job:pinned" },
		makeAuth,
		makeHost: () => fakeHost(),
		makeSandboxReaper,
		makeSandboxNetworkSweeper: () => madeSweeper,
		order,
	});
	assert.deepEqual(order, ["reapSandboxes", "createWorker"], "retained directories are swept before the worker takes a job");
	assert.equal(reaperArgs.sandboxDir, "/tmp/pi-sbx");
	assert.equal(reaperArgs.retentionHours, 6);
	// The one thing this reaper needs that its siblings do not: without it the sweep is blind and can
	// delete a bind mount out from under a shell an operator is sitting in.
	assert.equal(typeof reaperArgs.listRunning, "function", "the sweep must be able to ask which sandboxes are live");
	// And the session networks beside them (issue #337). Assert the reaper got the factory's RESULT, not
	// merely something callable: `typeof` cannot tell the sweeper from the factory that makes it, and passing
	// the factory uncalled is a one-character slip that leaves the whole feature dead while the suite stays
	// green. At runtime it would surface only as a `sandbox_reaper_skipped` line reading "swept is not
	// iterable", which is the line a dozen ordinary faults also produce. The reaper defaults this dep to a
	// no-op as well, so an unwired one sweeps directories and is SILENT rather than broken.
	assert.equal(reaperArgs.sweepNetworks, madeSweeper, "the reaper is handed the sweeper, not the factory that makes it");
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
	const overlay = tempDir("pi-global-");
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
	// Same as `captureLogs`, but hands back the wrapped call's return value alongside its log lines.
	const from = bootLines.length;
	const value = fn();
	return { value, logs: parseLines(bootLines.slice(from)) };
}

// The reason the boot-time read became a per-job one (issue #102): `pi install` then `import-pi` is now a
// routine act, so a re-stage that only lands after a restart is a stale set nobody asked for.
test("staged packages: a re-stage after boot reaches the NEXT job, with no worker restart", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const overlay = tempDir("pi-global-");
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
	const overlay = tempDir("pi-global-");
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

test("the free credential gate resolves against the SAME inputs buildContainerEnv will use", { skip }, async () => {
	// Issue #310. The gate is a probe of the same resolution the container builder performs, so a job it
	// admits is a job the builder can build. If the two read different env or a different authFromPi, the
	// gate would pass a job the container then refuses (with the budget reserved, which is the whole defect)
	// or refuse one that would have run. Driven rather than read: the gate is invoked and its verdict flips
	// with the env, against the SAME `hostEnv` object the container factory was handed.
	// PI_AUTH_FROM_PI=0 on BOTH runs. Without it the verdicts are decided by whether the developer's own
	// ~/.pi/agent/auth.json holds an anthropic login, which is exactly the "decided by the shell" failure
	// this repo has already been bitten by once.
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const withKey = await runStart({ env: { PI_AUTH_FROM_PI: "0", ANTHROPIC_API_KEY: "sk-ant-x", PI_FORWARD_ENV: "MY_CUSTOM_KEY" }, makeAuth, makeHost: () => fakeHost() });
	const gate = withKey.deps.checkProviderCredential;
	assert.equal(typeof gate, "function", "the processor is wired with the gate at all");
	assert.deepEqual(gate({ provider: "anthropic" }), { ok: true }, "a configured provider is admitted");
	assert.equal(withKey.runContainerCalls[0].hostEnv.ANTHROPIC_API_KEY, "sk-ant-x", "and the builder reads the same env");
	// authFromPi and forwardEnv reach the builder too, and the gate must be built from the same two or it
	// answers a different question: forwardEnv is what decides the cred.env companion refusal on the
	// auth.json path, and authFromPi decides whether that path is taken at all.
	assert.equal(withKey.runContainerCalls[0].authFromPi, false, "PI_AUTH_FROM_PI=0 reaches the builder");
	assert.deepEqual(withKey.runContainerCalls[0].forwardEnv, ["MY_CUSTOM_KEY"]);

	// No env key and no fallback: refused, and the message is carried for the caller, never for the comment.
	const fallbackOff = await runStart({ env: { PI_AUTH_FROM_PI: "0" }, makeAuth, makeHost: () => fakeHost() });
	const verdict = fallbackOff.deps.checkProviderCredential({ provider: "anthropic" });
	assert.equal(verdict.ok, false);
	assert.match(verdict.message, /no configured credential/);
	// A different provider on the SAME wired gate: the verdict follows the job, not the boot.
	assert.equal(gate({ provider: "openai" }).ok, false, "the gate reads job.provider, not a captured one");
});

test("the secrets resolver and the container builder are handed the SAME host env and forward list", { skip }, async () => {
	// Issue #309. `hostEnv` is what the resolver SUBPROCESS runs in; the same `env` is what buildContainerEnv
	// reads to assemble the container. They were not the same object: makeSecretsResolver was constructed
	// without `hostEnv` and fell back to `process.env`, while makeRunContainer got startWorker's own `env`.
	// Identical on the shipped path, where both are process.env, and divergent under an injected one, which
	// is the hazard start.mjs already names for sessionsDir. One deployment value, one place.
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const { runContainerCalls, secretsResolverCalls } = await runStart({
		env: { PI_FORWARD_ENV: "MY_CUSTOM_KEY", PI_SECRET_PROFILES: "default:/opt/pi/resolve.sh" },
		makeAuth,
		makeHost: () => fakeHost(),
	});
	assert.equal(secretsResolverCalls.length, 1, "constructed exactly once, at boot");
	assert.equal(secretsResolverCalls[0].hostEnv, runContainerCalls[0].hostEnv, "the SAME object, not two reads of process.env");
	assert.deepEqual(secretsResolverCalls[0].forwardEnv, runContainerCalls[0].forwardEnv, "one PI_FORWARD_ENV list, two consumers");
	assert.deepEqual(secretsResolverCalls[0].forwardEnv, ["MY_CUSTOM_KEY"]);
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
		// #277: the venue a transcript is stamped with and gated on, from the registry's own default.
		["defaultBackend", "config.defaultBackend"],
	]) {
		// Anchored to a whole line, so a commented-out wire or a longer name (`config.defaultBackends`) fails.
		assert.match(call[0], new RegExp(`^\\s*${option}:\\s*${setting.replace(".", "\\.")},\\s*$`, "m"), `${option} must be wired from ${setting}`);
	}
});

test("the sandbox stamp resolves its venue with the same default (#277)", () => {
	// A window of the source between the preparer's construction and its preparers argument, rather than a
	// regex over the whole object literal: that literal nests other calls' braces.
	const src = readFileSync(new URL("../src/start.mjs", import.meta.url), "utf8");
	const from = src.indexOf("prepareWorkspace: makePrepareWorkspace({");
	const to = src.indexOf("preparers: makeForgePreparers(", from);
	assert.ok(from >= 0 && to > from, "the preparer is constructed where this pin expects");
	// A whole line: a `//` comment or `config.defaultBackends` must not satisfy it.
	assert.match(src.slice(from, to), /^\s*defaultBackend:\s*config\.defaultBackend,\s*$/m, "the retained manifest records the venue the registry dispatches to");
});

test("the record's default venue and the registry's come from the one config value (#277)", () => {
	// Asserted against the SOURCE so it runs without Valkey. Two defaults read from two places would let the
	// record name a venue the registry never dispatched to, and nothing else would notice.
	const src = readFileSync(new URL("../src/start.mjs", import.meta.url), "utf8");
	assert.match(src, /buildRecord\(\{[^}]*defaultBackend:\s*config\.defaultBackend\s*\}\)/, "recordRun passes the default venue to buildRecord");
	assert.match(src, /defaultName:\s*config\.defaultBackend/, "and the registry is built with the same value");
});

test("the boot refusal's endpoint evidence goes through the one renderer, not the raw field (#360)", () => {
	// `dockerEndpointEvidence` is the FOURTH site that interpolates an endpoint into "resolves ..., which is
	// not shown to be on this host", and it was the one nothing covered: a review pass reverted it to
	// `endpoint.endpoint` and the whole 4045-test suite stayed green. It is private to `start.mjs` and its
	// output only reaches a refusal's `evidence`, which every existing test hands in by hand, so a source pin
	// is the honest instrument here rather than a behavioural test built to reach one string.
	//
	// What it buys: a context stored with a blank host renders "an empty endpoint" instead of a gap, and a
	// control byte in one cannot rewrite the operator's line (`endpointShown`, backend-local.mjs).
	const src = readFileSync(new URL("../src/start.mjs", import.meta.url), "utf8");
	assert.match(src, /function dockerEndpointEvidence\(endpoint\) \{[\s\S]*?endpointShown\(endpoint\)/, "the evidence line renders through endpointShown");
	assert.doesNotMatch(src, /to \$\{endpoint\.endpoint\}/, "and never the raw field");
});

// --- one-shot wiring (issue #231, DES-ONE-SHOT-DISARM-IN-THE-FILE): the file path, the deps entry,
// --- and the record-before-disarm order. startWorker exposes no factory seam for makeDisarmOnce /
// --- makeCheckOnceSpent, so these pins drive the REAL closures against a real temp triggers file.

const onceEntry = (number, disarmed) => ({ on: { type: "issue", action: ["closed"], number, once: true, ...(disarmed ? { disarmed } : {}) }, run: { kind: "github", flow: "deploy" } });
const onceEffectiveJob = (number) => ({ kind: "github", repo: "o/r", flow: "deploy", target: { type: "issue", number }, trigger: { matched: { index: 0, type: "issue", action: "closed", number, once: true } } });

test("once wiring: deps.checkOnceSpent reads PI_TRIGGERS_FILE when set, and excuses only this delivery's own id", { skip }, async () => {
	const dir = tempDir("pi-once-path-");
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
	const dir = tempDir("pi-once-cwd-");
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
	const dir = tempDir("pi-once-order-");
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
	const dir = tempDir("pi-sl-");
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
	const dir = tempDir("pi-sl-");
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
	const dir = tempDir("pi-sl-");
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

// ── live-edit watcher lifecycle (issue #295) ────────────────────────────────────────────────────────

test("the live-edit watchers are CLOSED with the worker that armed them", { skip }, async () => {
	// THE DEFECT THIS PINS. `watch(dir, cb).unref?.()` retained nothing, so no code path could close the
	// FSWatcher and `extraClosers` never carried one: the watch outlived its boot, and the debounce it later
	// fired logged through THAT boot's `log` -- that boot's injected `write`, stamped with that boot's host.
	// Every boot in this file writes into one never-reset `bootLines`, so a dead worker's line landed inside
	// a LATER test's window under a host that had shut down two tests earlier, and CI reported
	// `scoped_limits_reload_invalid` carrying `runnervmejwal` inside the test that asserts `mac-mini-1`.
	//
	// The negative half below is only worth what its arming half is worth, so both are asserted. A plain
	// write is also the right provocation: it passes the basename filter on both platforms this runs on,
	// where removing the DIRECTORY does not -- Linux names the file in that event and macOS names the
	// directory, which is why every leak here was reachable in CI and unreachable on a laptop.
	const dir = tempDir("pi-watch-close-");
	try {
		const triggersPath = join(dir, "triggers.json");
		const pausePath = join(dir, "pause-windows.json");
		const limitsPath = join(dir, "scoped-limits.json");
		writeFileSync(triggersPath, JSON.stringify({ triggers: [] }));
		writeFileSync(pausePath, JSON.stringify({ windows: [] }));
		writeFileSync(limitsPath, JSON.stringify({ version: 1, limits: [] }));

		const { captured, logs } = await runStart({
			env: { VALKEY_URL, PI_TRIGGERS_FILE: triggersPath, PI_PAUSE_WINDOWS_FILE: pausePath, PI_SCOPED_LIMITS_FILE: limitsPath },
			makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
			makeHost: () => fakeHost(),
		});

		// Armed, or the silence below proves nothing. `PI_PAUSE_WINDOWS_FILE` reaches `startWorker` from no
		// other test in this repo, so this is also the only place its watcher is exercised at all.
		for (const event of ["triggers_watching", "pause_windows_watching", "scoped_limits_watching"]) {
			assert.ok(logs.some((l) => l.event === event), `${event}: the canary must ARM the watch it claims to close`);
		}
		// The runtime queue, the registry, one closer per armed watch, and the retention sweep. Not `>=`:
		// the count IS the claim. Before issue #295 this was 2 -- the watches were never registered at all,
		// so an eye passing over `extraClosers` looking for a broken `close()` would have found nothing
		// wrong. It became 6 with issue #292's periodic sweep, registered on #295's own finding that
		// UNREF'D IS NOT CLEANED UP: that handle holds an `rmSync`, and the shut-down canary below waits
		// 600ms, so a leaked DAILY timer would be invisible here and real in production.
		assert.equal(captured.extraClosers.length, 6, "runtimeQueue + registry + one closer per armed watch + the retention sweep");

		// `runStart` has already drained every closer. An operator edit now reaches a worker that is gone.
		const before = bootLines.length;
		writeFileSync(triggersPath, `${JSON.stringify({ triggers: [] })}\n`);
		writeFileSync(pausePath, `${JSON.stringify({ windows: [{ scope: "acme/web", from: "01:00", to: "02:00" }] })}\n`);
		writeFileSync(limitsPath, `${JSON.stringify({ version: 1, limits: [{ scope: "acme/web", day: 3 }] })}\n`);
		await new Promise((resolve) => setTimeout(resolve, 600));

		assert.deepEqual(
			parseLines(bootLines.slice(before)),
			[],
			"a shut-down worker must write NOTHING once its closers have run: whatever lands here would land in a later test's window carrying THIS worker's host. The watches are the expected culprit, not the only possible one -- read the event name before assuming which closer leaked",
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a watch closer closes once, cancels the debounce it armed, silences a reload already in flight, and never throws", { skip }, async () => {
	// The properties the shutdown rests on, none of which a real `fs.watch` can pin without racing the
	// filesystem -- which is why the closer is exported apart from its watchers, `reloadScopedLimits`'s own
	// reasoning applied to the other half of the same three functions.
	let closes = 0;
	let fired = 0;
	const handles = {
		watcher: {
			close() {
				closes += 1;
				throw new Error("a platform whose close fails");
			},
		},
		timer: setTimeout(() => (fired += 1), 20),
		closed: false,
	};
	const emitted = [];
	const closer = mod.makeWatchCloser(handles, (event, fields) => emitted.push({ event, fields }));

	// A reload that has ALREADY started cannot be recalled: `reloadSchedules` is async and awaits Valkey, so
	// the close can land mid-flight. What is gated is what it can still SAY, because a line written then
	// carries the host of a worker that has stopped.
	closer.reloadLog("schedules_reloaded", { installed: 1 });
	assert.deepEqual(emitted, [{ event: "schedules_reloaded", fields: { installed: 1 } }], "before close a reload logs normally");

	// MUST NOT THROW: `index.mjs` wraps each closer in `Promise.resolve(c?.close?.()).catch(...)`, which does
	// not catch a SYNCHRONOUS throw -- one escapes the `.map()` callback, rejects the whole shutdown and
	// skips the `process.exit(0)` after it, stranding every closer that had not run yet.
	assert.doesNotThrow(() => closer.close());
	assert.doesNotThrow(() => closer.close(), "a second close is a no-op, not a second throw");
	// Idempotence is the NULLING, not an early return: the second close finds no watcher to close. That is
	// the assertion below, and it is what a guard with nothing behind it would have hidden.
	assert.equal(closes, 1, "the watcher is closed exactly once -- an unclosed one outlives the worker that armed it");

	closer.reloadLog("schedules_reload_failed", { reason: "Connection is closed." });
	assert.equal(emitted.length, 1, "after close the in-flight reload is SILENT -- this is the line that used to reach a later test");

	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal(fired, 0, "the ARMED debounce is cancelled: closing a watcher does not cancel a timer its callback already set");

	// The `fs.watch`-threw arm's HANDLES, not its registration: a bag that never received a watcher still
	// closes clean. That the three watch functions RETURN a closer on that arm regardless is structural --
	// they return from outside their try/catch -- and is not what this line proves.
	assert.doesNotThrow(() => mod.makeWatchCloser({ watcher: null, timer: null, closed: false }, () => {}).close());
});

test("a boot that refuses AFTER the handoff still drains what it opened", { skip }, async () => {
	// `reconcileGated` awaits `livePeers()` outside its own try, so a registry read that fails refuses the
	// boot with the queue, the registry and the redis client ALREADY handed to `createWorker`. Before the
	// teardown moved into a `finally`, every such path skipped the drain -- and one unclosed ioredis
	// connection does not fail this file, it HANGS it, which is the trap this whole file sits downstream of.
	//
	// This guards the issue #57 and #262 handles, NOT the live-edit watches: their closers are registered in
	// the last statements before `startWorker` returns, so no refused boot can leave one armed. Found while
	// closing #295 and fixed here because the drain it protects is the same drain.
	const { makeHostRegistry } = await import("../src/host-registry.mjs");
	const dir = tempDir("pi-boot-refuse-");
	const folder = tempDir("pi-boot-refuse-f-");
	try {
		const triggersPath = join(dir, "triggers.json");
		// A cron trigger, because the boot reconcile is what reads the peer list -- a triggers file with no
		// schedule in it never reaches `reconcileGated` and the boot would simply succeed.
		writeFileSync(
			triggersPath,
			JSON.stringify({ triggers: [{ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder, flow: "tidy", task: "t" } }] }),
		);
		let registryClosed = false;
		const stops = [];
		await assert.rejects(
			() =>
				runStart({
					env: { VALKEY_URL, PI_TRIGGERS_FILE: triggersPath },
					stops,
					makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
					makeHost: () => fakeHost(),
					makeHostRegistry: (args) => {
						const real = makeHostRegistry(args);
						return {
							...real,
							livePeers: async () => {
								throw new Error("registry read blew up");
							},
							close: async () => {
								registryClosed = true;
								await real.close();
							},
						};
					},
				}),
			/registry read blew up/,
			"the boot refusal must still reach the caller -- the teardown may not replace it",
		);
		assert.equal(registryClosed, true, "what the refused boot had already opened is drained anyway");
		// The PRODUCT half (issue #299). The drain above is this harness's own finally; this is
		// `startWorker`'s catch calling stop() on the worker it built, which is what a real deployment
		// gets -- the harness never calls stop, so a recording here can only have come from the product.
		assert.deepEqual(stops, ["stop"], "the refusing boot must STOP the worker it built before the rejection surfaces: a live Worker keeps taking paid jobs behind a printed error");
	} finally {
		rmSync(dir, { recursive: true, force: true });
		rmSync(folder, { recursive: true, force: true });
	}
});

test("a refusal from a DIFFERENT post-handoff point stops the worker too -- the catch covers the region", { skip }, async () => {
	// The reconcile refusal above is the reachable one issue #299 reproduced; this one throws from the
	// retention sweep's arming at the far end of the region, so the pair pins the WRAP rather than one
	// call site. A guard that only covered the reconcile would go green above and red here.
	//
	// A pause-windows file rides along so a live-edit WATCHER is armed inside the region before the
	// refusal: armed-then-refused is the interaction neither test exercised, and this file's own
	// silence canaries watch what a leaked watch would write. The harness drains the closers either way.
	const dir = tempDir("pi-sweep-refuse-");
	const pausePath = join(dir, "pause-windows.json");
	writeFileSync(pausePath, `${JSON.stringify({ windows: [] })}\n`);
	const stops = [];
	try {
		await assert.rejects(
			() =>
				runStart({
					env: { VALKEY_URL, PI_PAUSE_WINDOWS_FILE: pausePath },
					stops,
					makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
					makeHost: () => fakeHost(),
					makeRetentionSweep: () => ({
						start: () => {
							throw new Error("sweep arm blew up");
						},
						close: () => {},
					}),
				}),
			/sweep arm blew up/,
			"the region's own error must surface -- entryExitCode reads it, and a swallow would exit 0 on a refusal",
		);
		assert.deepEqual(stops, ["stop"], "stopped from this refusal point too");
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
	const dir = tempDir("pi-boot-hang-");
	const folder = tempDir("pi-boot-folder-");
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

test("a named run leaves NO host-queue keys behind in the test Valkey", { skip }, async () => {
	// The harness cleans up after itself (issue #262). This pins that, because the residue is invisible
	// until something reads the live keyspace for host queues -- and `discoverHostQueues`, which the kill
	// switch depends on, does exactly that. A future integration test for it would otherwise see queues no
	// test created and pass, or fail, for reasons unrelated to what it was checking.
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const { makeRedisClient } = await import("../src/connection.mjs");
	const probe = makeRedisClient(VALKEY_URL);
	probe.on("error", () => {});
	const leftover = async () => {
		let cursor = "0";
		const keys = [];
		do {
			const [next, batch] = await probe.scan(cursor, "MATCH", "bull:pi-jobs@mac-mini-1:*", "COUNT", 200);
			cursor = next;
			keys.push(...batch);
		} while (cursor !== "0");
		return keys;
	};

	// try/finally, because a FAILING assertion here would otherwise leak this client -- and an open ioredis
	// handle does not fail the file, it HANGS it, which is the trap this whole file exists downstream of.
	try {
		await probe.del(...(await leftover()).concat("__never__")); // start from a known-clean slate
		await runStart({ env: { PI_WORKER_NAME: "mac-mini-1", VALKEY_URL }, makeAuth, makeHost: () => fakeHost() });
		assert.deepEqual(await leftover(), [], "the run's own host queue is gone when it ends");
	} finally {
		probe.disconnect();
	}
});

test("startWorker CONNECTS the registry to the processor, and to the abort (#227)", { skip }, async () => {
	// Six mutations reverting exactly this connection survived the whole suite: `wiring.test.mjs` pins that
	// the processor uses an INJECTED stop, `backend-registry.test.mjs` pins that the registry dispatches --
	// and nothing pinned that `startWorker` joins the two. Reverting one line put the abort path back on
	// hard-wired local docker, which is the condition the venue-resolution fix exists to prevent, and every
	// one of them is behaviourally neutral while a single venue is registered. That is the same shape as the
	// bug that shipped: invisible on a single-venue deployment, wrong the moment there are two.
	//
	// The proof is a SECOND registered venue. Each dep is then asked for a job naming it, and must answer
	// from that venue rather than from `local`.
	const seen = [];
	const far = {
		name: "far",
		declares: (await import("../src/backends.mjs")).BACKENDS.local.declares,
		neverStartedExits: [7],
		containerName: (id) => `far-${id}`,
		runContainer: async () => (seen.push("far:runContainer"), { code: 0 }),
		imagePreflight: async () => (seen.push("far:imagePreflight"), {}),
		egressPreflight: async () => (seen.push("far:egressPreflight"), { ok: true }),
		stopContainer: async () => seen.push("far:stopContainer"),
		reap: async () => ({ reaped: true }),
	};
	let registryArgs = null;
	const { captured } = await runStart({
		makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
		makeHost: () => fakeHost(),
		extraBackends: [far],
		makeBackendRegistry: (args) => {
			registryArgs = args;
			return realRegistry(args);
		},
	});

	// The registry is built from the deployment's own facts, not from literals: reverting either of these
	// disarms a boot cross-check silently.
	assert.deepEqual(registryArgs.blessed, ["local"], "PI_BACKENDS is what the registry cross-checks against");
	assert.ok(typeof registryArgs.reaps?.local === "function", "and the boot reaper map, or an unswept venue reads as proven");
	assert.deepEqual(registryArgs.bundles.map((b) => b.name), ["local", "far"], "the seam an adapter registers through");

	// Every per-job dep must route through the registry, or a job naming `far` would run on `local`.
	const job = { id: "j", backend: "far" };
	await captured.deps.imagePreflight(job);
	await captured.deps.egressPreflight(job);
	await captured.deps.runContainer({ job });
	await captured.stopContainer("far-j", job);
	assert.deepEqual(seen.sort(), ["far:egressPreflight", "far:imagePreflight", "far:runContainer", "far:stopContainer"].sort());
	assert.deepEqual(captured.deps.neverStartedExits(job), [7], "the exit set is the venue's too");
	assert.equal(captured.containerName(job), "far-j", "and the NAME the abort stops is built by that venue");
});

test("the run record resolves a venue with the SAME default the registry dispatches with (#277)", { skip }, async () => {
	let registryArgs = null;
	const records = [];
	const { captured } = await runStart({
		makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
		makeHost: () => fakeHost(),
		makeBackendRegistry: (args) => {
			registryArgs = args;
			return realRegistry(args);
		},
		makeRecordWriter: () => (record) => records.push(record),
	});
	const at = "2026-09-14T09:00:00.000Z";
	const job = (id, extra = {}) => ({ id, attemptsMade: 0, name: "github", data: { kind: "github", repo: "o/r", flow: "fix", target: { type: "issue", number: 1 }, ...extra } });
	captured.recordRun({ job: job("gh-plain"), result: { outcome: "completed", exitCode: 0 }, startedAt: at, endedAt: at });
	captured.recordRun({ job: job("gh-far", { backend: "far" }), result: { outcome: "policy", reason: "backend-unblessed" }, startedAt: at, endedAt: at });

	assert.equal(records.length, 2);
	// Equal today partly by construction: this build's table holds only `local` and PI_BACKENDS must include
	// it, so both defaults are the same word however they are wired. The source-pin test on start.mjs is what catches the
	// two being wired from different places; this proves the live closure reaches a real record.
	assert.equal(records[0].backend, registryArgs.defaultName, "a job naming no venue records the registry's own default");
	assert.equal(records[0].backend, "local");
	assert.equal(records[1].backend, "far", "and a named venue is recorded as named");
});

// ── issue #292: the periodic retention sweep ────────────────────────────────────────────────────────

test("PI_SWEEP_INTERVAL_HOURS=0 does not CONSTRUCT the sweep, so nothing it could do is reachable", { skip }, async () => {
	// "0 is byte-identical to before" is proven by proving the OBJECT DOES NOT EXIST, not by counting
	// effects. With no construction there is no timer, no closer, and no reachable second call to any
	// reaper -- a stronger and much cheaper claim than asserting that a sweep did not happen.
	const constructions = [];
	const { captured, logs } = await runStart({
		env: { PI_SWEEP_INTERVAL_HOURS: "0" },
		makeRetentionSweep: (args) => {
			constructions.push(args);
			return { start() {}, sweepOnce: async () => {}, close: async () => {} };
		},
	});
	assert.equal(constructions.length, 0, "the factory is never called at all");
	// No watch files in this env, so the list is just the runtime queue and the registry. The point is
	// the DELTA against the twin test below: the sweep contributes exactly one closer, or none at 0.
	assert.equal(captured.extraClosers.length, 2, "runtimeQueue + registry, and nothing from the sweep");
	assert.equal(logs.filter((l) => l.event === "retention_sweep").length, 0);
	const started = logs.find((l) => l.event === "worker_started");
	assert.equal(started.sweepIntervalHours, 0, "the boot line still SAYS the sweep is off, which is the one visible difference");
});

test("the default arms one daily sweep and registers it as a closer", { skip }, async () => {
	// The positive twin of the test above. Without it the count of 2 there could drift to mean anything.
	const constructions = [];
	const starts = [];
	const { captured, logs } = await runStart({
		makeRetentionSweep: (args) => {
			constructions.push(args);
			const handle = { start: () => starts.push(args), sweepOnce: async () => {}, close: async () => {} };
			return handle;
		},
	});
	assert.equal(constructions.length, 1);
	assert.equal(starts.length, 1, "constructed AND started");
	assert.equal(constructions[0].intervalMs, 24 * 3600000, "24h by default, in ms");
	assert.deepEqual(constructions[0].reapers.map((r) => r.name), ["log", "sandbox", "session"], "boot's own order");
	assert.equal(captured.extraClosers.length, 3, "runtimeQueue + registry + the sweep (no watch files in this env)");
	assert.equal(logs.find((l) => l.event === "worker_started").sweepIntervalHours, 24);
});

test("the sweep re-runs the SAME closures boot already built, so one config read serves both", { skip }, async () => {
	// The claim that makes this safe: nothing is rebuilt on a tick, so a tick cannot read a different
	// logsDir or a different retention window than boot did.
	const logReaperCalls = [];
	const sandboxReaperCalls = [];
	let handed;
	await runStart({
		env: { PI_LOGS_DIR: "/x/logs", PI_LOG_RETENTION_DAYS: "9" },
		makeLogReaper: (args) => {
			logReaperCalls.push(args);
			return () => {};
		},
		makeSandboxReaper: (args) => {
			sandboxReaperCalls.push(args);
			return async () => {};
		},
		makeRetentionSweep: (args) => {
			handed = args;
			return { start() {}, sweepOnce: async () => {}, close: async () => {} };
		},
	});
	assert.equal(logReaperCalls.length, 1, "built once at boot, not once per tick");
	assert.equal(sandboxReaperCalls.length, 1);
	assert.equal(logReaperCalls[0].logsDir, "/x/logs");
	assert.equal(logReaperCalls[0].retentionDays, 9);

	// Driving the handed reapers must reach those same closures, which is what "no drift" means.
	const before = logReaperCalls.length + sandboxReaperCalls.length;
	for (const r of handed.reapers) await r.reap();
	assert.equal(logReaperCalls.length + sandboxReaperCalls.length, before, "a sweep constructs nothing");
});

test("settleWithin clears its fuse when the read wins, and still answers when it does not", async () => {
	// ISSUE #300, the timer half. The boot-image read races a five-second unref'd fuse, and when the read
	// won, the inline race left that fuse armed for its full term -- invisible to every census, because
	// `process.getActiveResourcesInfo()` does not report unref'd timers at all (measured), which is why
	// this pin counts through async_hooks, where `destroy` fires for a cleared timer and not for a merely
	// unref'd one. Ungated: no Valkey, no boot, one helper.
	const { createHook } = await import("node:async_hooks");
	// SELF-CONTAINED, deliberately: the second settleWithin call below awaits an unref'd fuse, and a
	// process running ONLY this test (a --test-name-pattern debug run) has nothing else holding the
	// loop -- node then abandons the pending await ("Promise resolution is still pending but the event
	// loop has already resolved"), which is the helper's own documented bare-context boundary biting the
	// test that pins it. This ref'd interval is the ambient loop the real boot provides.
	const keepAlive = setInterval(() => {}, 1000);
	const live = new Set();
	const hook = createHook({
		init(asyncId, type) {
			if (type === "Timeout") live.add(asyncId);
		},
		destroy(asyncId) {
			live.delete(asyncId);
		},
	});
	hook.enable();
	try {
		const before = new Set(live);
		const won = await mod.settleWithin(Promise.resolve({ imageDigest: "sha" }), 5000, {});
		assert.deepEqual(won, { imageDigest: "sha" }, "the read's own answer wins");
		// A cleared timer's destroy hook fires on a later tick; give it two.
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
		const leaked = [...live].filter((id) => !before.has(id));
		assert.deepEqual(leaked, [], "the losing fuse is CLEARED, not left armed: unref'd is not cleaned up");

		const fell = await mod.settleWithin(new Promise(() => {}), 5, { fellBack: true });
		assert.deepEqual(fell, { fellBack: true }, "a read that never answers still yields the fallback");
	} finally {
		clearInterval(keepAlive);
		hook.disable();
	}
});

test("the boot-image read goes THROUGH settleWithin (source pin)", () => {
	// The helper's guarantee only reaches production if the call site uses it. The property is not
	// observable through a full boot without racing every other timer the boot arms, so the call site is
	// pinned against the source, the `wiring.test.mjs` SIGBREAK precedent. NEGATIVE half included: the
	// inline race must not come back beside the helper.
	const src = readFileSync(new URL("../src/start.mjs", import.meta.url), "utf8");
	assert.match(src, /const bootImage = await settleWithin\(imagePreflight/, "the boot-image read must ride the fuse-clearing helper");
	assert.ok(!/setTimeout\(\(\) => resolve\({}\), BOOT_IMAGE_TIMEOUT_MS\)/.test(src), "the inline race that leaked its timer must stay gone");
});

// --- the paid terminals announce themselves (issue #288) ------------------------------------------------

/** Settle the void-fired comment/hook chains a listener starts (auth re-resolve + mint + post). */
async function settleListeners() {
	for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

test("a TERMINAL failed attempt comments ONCE through the real adapter; a retried one comments nothing and job_failed stays byte-identical", { skip }, async () => {
	const posted = [];
	const host = fakeHost({ postStatusComment: async (_job, _target, text) => void posted.push(text) });
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const { handlers } = await runStart({ makeAuth, makeHost: () => host });

	// finishedOn is BullMQ's own terminal decision: set on the non-retry branch alone, visible here
	// because the emit follows moveToFailed. The guard reads it rather than re-deriving attempts math.
	const from = bootLines.length;
	handlers.failed({ id: "j1", data: { kind: "github", repo: "o/r", target: { type: "issue", number: 7 } }, attemptsMade: 2, finishedOn: 123 }, new Error("boom"));
	await settleListeners();
	assert.deepEqual(posted, ["Failed: an error stopped this job and it will not be retried further. Ask the operator to check the worker log."], "one fixed sentence, never err.message");
	const terminal = parseLines(bootLines.slice(from));
	assert.deepEqual(Object.keys(terminal.find((l) => l.event === "job_failed")), ["event", "jobId", "attempt", "reason", "host"], "the existing line's key set is untouched");

	// A RETRIED attempt (no finishedOn): the log line exactly as before, and no comment of any kind --
	// a flaky daemon must not post three comments for one recovery.
	posted.length = 0;
	const from2 = bootLines.length;
	handlers.failed({ id: "j2", data: { kind: "github", repo: "o/r" }, attemptsMade: 1 }, new Error("flake"));
	await settleListeners();
	assert.deepEqual(posted, [], "a retried attempt must not comment");
	const retried = parseLines(bootLines.slice(from2));
	assert.deepEqual(Object.keys(retried.find((l) => l.event === "job_failed")), ["event", "jobId", "attempt", "reason", "host"]);
	assert.ok(!retried.some((l) => l.event === "comment" || l.event === "comment_failed"), "no adapter activity at all on a retried attempt");
});

test("PI_ON_FAILURE fires for the paid terminals only: terminal-failed and policy worker-abort/runner-policy, nothing else", { skip }, async () => {
	// An unresolvable command still proves the THREADING (the on_failure line is the hook's own), while
	// spawning nothing on a test machine.
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const { handlers } = await runStart({ env: { PI_ON_FAILURE: "/nope/pi-notify-does-not-exist" }, makeAuth, makeHost: () => fakeHost() });

	const fired = async (drive) => {
		const from = bootLines.length;
		drive();
		await settleListeners();
		return parseLines(bootLines.slice(from)).filter((l) => l.event === "on_failure");
	};

	const terminal = await fired(() => handlers.failed({ id: "j1", data: { kind: "github", repo: "o/r" }, attemptsMade: 2, finishedOn: 9 }, new Error("x")));
	assert.equal(terminal.length, 1, "the final infra failure pages");
	assert.deepEqual(Object.keys(terminal[0]), ["event", "jobId", "code", "detail", "host"], "the pinned key set, host stamped by the closure");
	assert.equal(terminal[0].detail, "unresolvable");

	assert.equal((await fired(() => handlers.completed({ id: "j2" }, { outcome: "policy", reason: "worker-abort" }))).length, 1, "the 30-minute kill pages");
	assert.equal((await fired(() => handlers.completed({ id: "j3" }, { outcome: "policy", reason: "runner-policy" }))).length, 1, "an in-container stop pages");
	assert.equal((await fired(() => handlers.completed({ id: "j4" }, { outcome: "completed" }))).length, 0, "a completion pages nobody");
	assert.equal((await fired(() => handlers.completed({ id: "j5" }, { outcome: "policy", reason: "over-budget" }))).length, 0, "a free pre-spend refusal already comments; a delivery storm must not page");
	assert.equal((await fired(() => handlers.completed({ id: "j6" }, { outcome: "policy", reason: "operator-cancel" }))).length, 0, "the operator initiated it; a push saying what they just did is noise");
	assert.equal((await fired(() => handlers.failed({ id: "j7", data: { kind: "github", repo: "o/r" }, attemptsMade: 1 }, new Error("x")))).length, 0, "a retried attempt pages nobody");
});

test("with PI_ON_FAILURE unset, a terminal failure produces no on_failure line and the existing lines are unchanged", { skip }, async () => {
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const { handlers } = await runStart({ makeAuth, makeHost: () => fakeHost() });
	const from = bootLines.length;
	handlers.failed({ id: "j1", data: { kind: "github", repo: "o/r" }, attemptsMade: 2, finishedOn: 9 }, new Error("x"));
	handlers.completed({ id: "j2" }, { outcome: "policy", reason: "worker-abort" });
	await settleListeners();
	const lines = parseLines(bootLines.slice(from));
	assert.ok(!lines.some((l) => l.event === "on_failure"), "unset means not constructed: no spawn, no line, byte-identical");
	assert.deepEqual(Object.keys(lines.find((l) => l.event === "job_failed")), ["event", "jobId", "attempt", "reason", "host"]);
	assert.deepEqual(Object.keys(lines.find((l) => l.event === "job_completed")), ["event", "jobId", "outcome", "reason", "host"]);
});

test("a terminal LOCAL failure comments into the log fallthrough with the fixed sentence, and posts nothing to any forge (review finding)", { skip }, async () => {
	const forgeCalls = [];
	const host = fakeHost({ postStatusComment: async () => void forgeCalls.push(1) });
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const { handlers } = await runStart({ makeAuth, makeHost: () => host });
	const from = bootLines.length;
	handlers.failed({ id: "L-1", data: { kind: "local", folder: "/Users/op/private-project" }, attemptsMade: 2, finishedOn: 9 }, new Error("x"));
	await settleListeners();
	const lines = parseLines(bootLines.slice(from));
	const line = lines.find((l) => l.event === "comment");
	assert.ok(line, "the local terminal comment is the stdout line -- the only signal a cron deployment has");
	assert.equal(line.text, "Failed: an error stopped this job and it will not be retried further. Ask the operator to check the worker log.");
	assert.ok(!line.text.includes("/Users"), "fixed and path-free: this text sits verbatim in a persistent service log");
	assert.deepEqual(forgeCalls, [], "a local job has no forge to post to");
});

test("a real err.reason token rides the hook's argv end to end, through a REAL script (review finding)", { skip }, async () => {
	// The unit suite pins the shape guard; this drives the whole seam -- listener -> fire -> spawn -- with
	// a real executable, so the token's verbatim passage is proven where it actually travels.
	const { writeFileSync, chmodSync, readFileSync, existsSync } = await import("node:fs");
	const { join } = await import("node:path");
	const dir = tempDir("on-failure-");
	const script = join(dir, "notify.sh");
	const out = join(dir, "args.txt");
	// The script also echoes an env marker: the hook must inherit the WORKER'S injected env, not the
	// ambient process.env (the #309 rule every spawner in start.mjs follows -- review finding).
	writeFileSync(script, `#!/bin/sh\necho "$@ marker=$INJECTED_ENV_MARKER" >> "${out}"\n`);
	chmodSync(script, 0o755);
	const makeAuth = async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" });
	const { handlers } = await runStart({ env: { PI_ON_FAILURE: script, INJECTED_ENV_MARKER: "threaded" }, makeAuth, makeHost: () => fakeHost() });
	handlers.failed({ id: "gh-9", data: { kind: "github", repo: "o/r" }, attemptsMade: 2, finishedOn: 9 }, Object.assign(new Error("the runtime could not start the container, exit 125"), { reason: "container-never-started" }));
	// A real child: poll for its write rather than guessing its scheduling, on a WALL CLOCK. The bound is a
	// ceiling on a hang, never a wait in the healthy case: the poll measures 146-292ms idle and 1642ms at its
	// worst under deliberate fork pressure (19 node processes on 14 cores), so the ceiling sits about 6x above
	// anything observed and the loop leaves on its first look once the file is there.
	//
	// NOT `i < n` (issue #369, and issue #221 is the same defect one file over -- see service.test.mjs's
	// waitForMarker, which this shape is copied from). A nominal count undercharges every iteration by the
	// existsSync plus the event-loop hop, so the bound it enforces is neither the number in the source nor
	// knowable, and the term it undercharges is exactly the one that grows under the full parallel suite --
	// which `contract-tests` runs three times per job. The old `i < 100` at 20ms read as 2s, was less, and
	// missed: the assertion below then failed wearing "the hook really spawned", which reads as a defect in
	// the failure hook and is not one.
	//
	// NOT lifted into test/helpers/ beside temp-dir.mjs, deliberately. This is the suite's only real-child
	// iteration-count poll, and service.test.mjs's sibling declines a shared ceiling for a reason of its own:
	// its bound is DERIVED from the signal stub's lifetime, so a shared constant would be a second place for
	// that relationship to be wrong. One caller and one standing opt-out is not a helper, it is a third thing
	// to keep in step.
	const deadline = Date.now() + 10_000;
	while (!existsSync(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
	assert.ok(existsSync(out), "the hook really spawned -- nothing was written within the 10s ceiling, which is a failure to spawn rather than a slow one");
	// The host cell is this machine's derived worker name, which varies -- pin the id-only trio exactly
	// and only the SHAPE of the fourth.
	const argv = readFileSync(out, "utf8").trim().split(" ");
	assert.deepEqual(argv.slice(0, 3), ["gh-9", "failed", "container-never-started"], "a VALID token passes the guard verbatim; the message never rides");
	assert.equal(argv.length, 5, "host rides fourth, whatever this machine calls itself, then the marker cell");
	assert.equal(argv[4], "marker=threaded", "the hook runs with the worker's injected env, never the ambient one");
});

// ── issue #278: which daemon the job credentials travel to ─────────────────────────────────────────────────

const REMOTE_ENDPOINT = async () => ({ local: false, context: "remote", endpoint: "tcp://10.1.2.3:2375", reason: null, transient: false });
// These refuse BEFORE any Valkey contact, so they need the module, not a queue.
const skipNoModule = !mod ? `worker deps not installed (node ${process.version} < 22.19.0); CI runs these` : false;

test("a floor asking credentialTransit=enforced refuses to BOOT on a docker CLI that points off this host, tagged, before anything is built", { skip: skipNoModule }, async () => {
	const order = [];
	await assert.rejects(
		() => runStart({ env: { PI_BACKEND_FLOOR: "credentialTransit=enforced" }, resolveDockerEndpoint: REMOTE_ENDPOINT, order, makeReaper: () => (order.push("makeReaper"), async () => ({ reaped: true })) }),
		(err) => err.piDispatchConfig === true && /credentialTransit=enforced holds only while/.test(err.message) && /tcp:\/\/10\.1\.2\.3:2375, which is not shown to be on this host/.test(err.message),
	);
	assert.deepEqual(order, [], "no reaper and no worker: the refusal comes first");
});

test("an endpoint read that timed out refuses a floor UNTAGGED, so the supervisor retries; a determinate one is tagged", { skip: skipNoModule }, async () => {
	const env = { PI_BACKEND_FLOOR: "credentialTransit=enforced" };
	await assert.rejects(
		() => runStart({ env, resolveDockerEndpoint: async () => ({ local: null, context: null, endpoint: null, reason: "timeout", transient: true }) }),
		(err) => err.piDispatchConfig !== true && /did not say which endpoint it resolves \(timeout\)/.test(err.message),
	);
	await assert.rejects(
		() => runStart({ env, resolveDockerEndpoint: async () => ({ local: null, context: null, endpoint: null, reason: "docker-not-found", transient: false }) }),
		(err) => err.piDispatchConfig === true,
	);
});

test("without a floor a redirected docker CLI boots, logs it once without credentials, and gates each job only by the floor", { skip }, async () => {
	let answer = { local: false, context: "remote", endpoint: "ssh://remote", reason: null, transient: false };
	const { captured, logs } = await runStart({
		makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
		makeHost: () => fakeHost(),
		resolveDockerEndpoint: async () => answer,
	});
	const notLocal = logs.filter((l) => l.event === "docker_endpoint_not_local");
	assert.equal(notLocal.length, 1);
	assert.equal(notLocal[0].endpoint, "ssh://remote");
	const started = logs.find((l) => l.event === "worker_started");
	assert.equal(started.dockerEndpointLocal, false);
	assert.equal(started.dockerContext, "remote");

	// Each job re-reads it; with no floor the answer never refuses, and an unchanged answer logs nothing more.
	// `logs` is a snapshot taken when boot returned, so later lines are read off the shared capture.
	const job = { kind: "github", repo: "o/r", target: { type: "issue", number: 1 } };
	const mark = bootLines.length;
	// The endpoint rides the ok answer (issue #341), so this job's user is decided against the same read.
	const okOf = async () => {
		const { ok, endpoint, jobUser } = await captured.deps.observationPreflight(job);
		assert.equal(typeof jobUser?.decision?.mode, "string", "the job user decided from the same read rides along (issue #345), so it is not read twice");
		return { ok, endpoint };
	};
	assert.deepEqual(await okOf(), { ok: true, endpoint: answer });
	assert.deepEqual(await okOf(), { ok: true, endpoint: answer });
	assert.equal(parseLines(bootLines.slice(mark)).filter((l) => l.event === "docker_endpoint_not_local").length, 0, "a standing redirect is one line at boot, not one per job");
	answer = { local: true, context: "desktop-linux", endpoint: "unix:///x.sock", reason: null, transient: false };
	await captured.deps.observationPreflight(job);
	assert.equal(parseLines(bootLines.slice(mark)).filter((l) => l.event === "docker_endpoint_local").length, 1, "a return to this host is logged once, as a change");
});

test("a floor asking only credentialTransit=asserted BOOTS on a redirected CLI and admits every job (#278)", { skip }, async () => {
	// The decision that keeps every existing floor working: `asserted` is exactly what a redirect degrades to, so
	// it is met, and only the operator's pointing the CLI elsewhere is being asserted.
	const { captured, logs } = await runStart({
		env: { PI_BACKEND_FLOOR: "credentialTransit=asserted" },
		makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
		makeHost: () => fakeHost(),
		resolveDockerEndpoint: REMOTE_ENDPOINT,
	});
	assert.ok(logs.some((l) => l.event === "docker_endpoint_not_local"), "the redirect is still said");
	assert.equal(logs.find((l) => l.event === "worker_started").dockerEndpointLocal, false);
	const job = { kind: "github", repo: "o/r", target: { type: "issue", number: 1 } };
	const { ok, endpoint } = await captured.deps.observationPreflight(job);
	assert.deepEqual({ ok, endpoint }, { ok: true, endpoint: await REMOTE_ENDPOINT() });
});

test("with a floor, a context switched AFTER boot refuses the next job before it spends (#278)", { skip }, async () => {
	let answer = { local: true, context: "desktop-linux", endpoint: "unix:///x.sock", reason: null, transient: false };
	const { captured, logs } = await runStart({
		env: { PI_BACKEND_FLOOR: "credentialTransit=enforced" },
		makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
		makeHost: () => fakeHost(),
		resolveDockerEndpoint: async () => answer,
	});
	const job = { kind: "github", repo: "o/r", target: { type: "issue", number: 1 } };
	const first = await captured.deps.observationPreflight(job);
	assert.deepEqual({ ok: first.ok, endpoint: first.endpoint }, { ok: true, endpoint: answer }, "booted on a local endpoint, so the first job runs");
	const mark = bootLines.length;
	answer = { local: false, context: "pd-remote", endpoint: "tcp://10.1.2.3:2375", reason: null, transient: false };
	const refused = await captured.deps.observationPreflight(job);
	assert.equal(refused.refused, true);
	assert.match(refused.message, /tcp:\/\/10\.1\.2\.3:2375/);
	assert.match(refused.message, /\blocal: credentialTransit=enforced holds only while/, "the refusal names the venue the job RESOLVED to, not its absent run.backend");
	assert.ok(parseLines(bootLines.slice(mark)).some((l) => l.event === "docker_endpoint_not_local" && l.context === "pd-remote"), "the change is logged when it happens");
	assert.ok(!logs.some((l) => l.event === "docker_endpoint_not_local"), "and not at boot, where it was local");
	answer = { local: null, context: null, endpoint: null, reason: "timeout", transient: true };
	assert.deepEqual(await captured.deps.observationPreflight(job), { unavailable: true, reason: "timeout" }, "a transient read retries rather than refusing");
	assert.deepEqual(refused.observations, ["dockerEndpointLocal"], "the refusal says which observation it missed, for the forge comment's fixed words");
});

// --- issue #341: which uid job containers run as ---------------------------------------------------------------

const DOCKER_FACTS = (over = {}) => async () => ({ answered: true, facts: { shape: "docker", podman: false, os: "Test Linux", rootless: false, userns: false, bounds: { pids: true, memory: true }, serviceIsRemote: null, remoteSocketPath: null, ...over } });
const LINUX_ID = (euid, egid = euid) => ({ platform: "linux", release: "6.8.0-test", euid, egid });

test("a rootless daemon or a root worker refuses to BOOT when local is the default venue, tagged, before anything is built", { skip: skipNoModule }, async () => {
	for (const [label, readDaemonFacts, jobUserIdentity, pattern] of [
		["rootless", DOCKER_FACTS({ rootless: true }), LINUX_ID(1234), /runs rootless/],
		["userns-remap", DOCKER_FACTS({ userns: true }), LINUX_ID(1234), /userns-remap/],
		["worker-is-root", DOCKER_FACTS(), LINUX_ID(0), /the worker runs as root/],
		["desktop-linux", DOCKER_FACTS({ os: "Docker Desktop" }), LINUX_ID(1234), /Docker Desktop on Linux/],
	]) {
		const order = [];
		const makeAuth = async () => (order.push("makeAuth"), { mintToken: async () => "tok", selfId: 1, source: "gh" });
		await assert.rejects(
			() => runStart({ readDaemonFacts, jobUserIdentity, order, makeAuth, makeHost: () => fakeHost(), makeReaper: () => (order.push("makeReaper"), async () => ({ reaped: true })) }),
			(err) => err.piDispatchConfig === true && pattern.test(err.message),
			label,
		);
		assert.deepEqual(order, [], `${label}: the refusal comes before forge auth, the reaper and the worker`);
	}
	// Non-vacuous: the same recorders on a decidable daemon do see forge auth, so an empty array above means "before".
	const order = [];
	await runStart({ readDaemonFacts: DOCKER_FACTS(), jobUserIdentity: LINUX_ID(1234), order, makeAuth: async () => (order.push("makeAuth"), { mintToken: async () => "tok", selfId: 1, source: "gh" }), makeHost: () => fakeHost(), makeReaper: () => (order.push("makeReaper"), async () => ({ reaped: true })) });
	assert.ok(order.includes("makeAuth") && order.includes("makeReaper"), JSON.stringify(order));
});

test("only an identity verdict refuses at boot, and only while local is the default venue", { skip: skipNoModule }, async () => {
	// Pinned on the predicate, and end to end since issue #354 part 2 (a podman default beside a rootless docker boots:
	// see the podman boot-refusal test below).
	for (const cause of ["rootless", "userns-remap", "worker-is-root", "desktop-linux-userns"]) {
		assert.match(mod.jobUserBootRefusal({ mode: "unmappable", cause }, "local"), /^Refused: /, cause);
		assert.equal(mod.jobUserBootRefusal({ mode: "unmappable", cause }, "far"), null, `${cause}: local blessed but not default boots`);
	}
	for (const decision of [{ mode: "unmappable", cause: "runtime-unreadable" }, { mode: "unmappable", cause: "docker-group" }, { mode: "unknown", reason: "timeout" }, { mode: "worker", user: "1234:1234" }, { mode: "image", cause: "desktop-platform" }]) {
		assert.equal(mod.jobUserBootRefusal(decision, "local"), null, JSON.stringify(decision));
	}
});

test("an unanswered or unreadable daemon BOOTS, and says what it could not decide", { skip }, async () => {
	for (const [label, readDaemonFacts, mode] of [
		["transient", async () => ({ answered: false, reason: "timeout", transient: true }), "unknown"],
		["unparseable", async () => ({ answered: false, reason: "unparseable", transient: false }), "unmappable"],
	]) {
		const { logs } = await runStart({ makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }), makeHost: () => fakeHost(), readDaemonFacts, jobUserIdentity: LINUX_ID(1234) });
		assert.equal(logs.find((l) => l.event === "job_user")?.mode, mode, label);
		assert.equal(logs.find((l) => l.event === "worker_started")?.jobUser?.mode, mode, `${label}: the boot line names it`);
	}
});

test("on macOS the job user is the image's whatever the daemon says, and its one facts read feeds the runtime observations (#345)", { skip }, async () => {
	let reads = 0;
	const { logs } = await runStart({ makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }), makeHost: () => fakeHost(), readDaemonFacts: async () => (reads++, { answered: false, reason: "daemon-unreachable", transient: true }), jobUserIdentity: { platform: "darwin", release: "24.6.0", euid: 501, egid: 20 } });
	assert.equal(reads, 1, "read once, for the observations; the decision needs no fact");
	const started = logs.find((l) => l.event === "worker_started");
	assert.deepEqual(started.jobUser, { mode: "image", user: null, cause: "desktop-platform" });
	assert.deepEqual([started.daemonAppliesBounds, started.runtimeAddsNoMounts], [null, null], "a daemon still starting is not read, never false");
});

test("the per-job gate: --user with HOME for another uid on an anyUid image, refused without it, nothing for uid 1001", { skip }, async () => {
	const endpointReads = [];
	const endpoint = { local: true, context: "default", endpoint: "unix:///run/pd-test/docker.sock", reason: null, transient: false };
	const job = { kind: "github", repo: "o/r", target: { type: "issue", number: 1 } };
	// Never this machine's socket: the owner and group are the test's.
	const stat = () => ({ uid: 0, gid: 2375 });

	const other = await runStart({ makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }), makeHost: () => fakeHost(), readDaemonFacts: DOCKER_FACTS(), jobUserIdentity: { ...LINUX_ID(1234), stat }, resolveDockerEndpoint: async () => (endpointReads.push(1), endpoint) });
	assert.ok(other.logs.some((l) => l.event === "job_image_any_uid_unsupported"), "the default image cannot run as this uid: said once at boot");
	const reads = endpointReads.length;
	assert.deepEqual(await other.captured.deps.jobUserPreflight(job, { capabilities: ["anyUid"], observed: { ok: true, endpoint } }), { user: "1234:1234", home: "/home/pi" });
	assert.equal(endpointReads.length, reads, "the endpoint the observation just read is reused, never read twice for one job");
	assert.deepEqual(await other.captured.deps.jobUserPreflight(job, { capabilities: [], observed: { ok: true, endpoint } }), { refused: "job-image-any-uid-unsupported", cause: "any-uid-unsupported" });

	const shipped = await runStart({ makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }), makeHost: () => fakeHost(), readDaemonFacts: DOCKER_FACTS(), jobUserIdentity: { ...LINUX_ID(1001), stat } });
	assert.ok(!shipped.logs.some((l) => l.event === "job_image_any_uid_unsupported"), "uid 1001 needs no anyUid");
	assert.deepEqual(await shipped.captured.deps.jobUserPreflight(job, { capabilities: [], observed: { ok: true, endpoint } }), { user: null, home: null });
});

test("the per-job gate refuses a docker-group primary gid through the socket it statted, the endpoint the job observed", { skip }, async () => {
	const job = { kind: "github", repo: "o/r", target: { type: "issue", number: 1 } };
	const statted = [];
	const stat = (path) => (statted.push(path), { uid: 0, gid: 2375 });
	const bootEndpoint = { local: true, context: "default", endpoint: "unix:///run/pd-boot/docker.sock", reason: null, transient: false };
	const { captured, logs } = await runStart({
		makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
		makeHost: () => fakeHost(),
		readDaemonFacts: DOCKER_FACTS(),
		jobUserIdentity: { ...LINUX_ID(1235, 2375), stat },
		resolveDockerEndpoint: async () => bootEndpoint,
		bootImage: { ok: true, capabilities: ["anyUid"] },
	});
	assert.equal(logs.find((l) => l.event === "job_user_group_refused")?.cause, "docker-group", "said once at boot for the default image");
	const observed = { local: true, context: "other", endpoint: "unix:///run/pd-job/docker.sock", reason: null, transient: false };
	statted.length = 0;
	assert.deepEqual(await captured.deps.jobUserPreflight(job, { capabilities: ["anyUid"], observed: { ok: true, endpoint: observed } }), { refused: "job-user-unmappable", cause: "docker-group" });
	assert.deepEqual(statted, ["/run/pd-job/docker.sock"], "the socket of the endpoint THIS job observed, never the boot one");
});

test("a job on another venue never reaches the job-user decision, and a changed decision is logged when a job meets it", { skip }, async () => {
	let answer = { answered: false, reason: "timeout", transient: true };
	let reads = 0;
	const endpoint = { local: true, context: "default", endpoint: "unix:///run/pd-test/docker.sock", reason: null, transient: false };
	const { captured, logs } = await runStart({
		makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
		makeHost: () => fakeHost(),
		readDaemonFacts: async () => (reads++, answer),
		jobUserIdentity: { ...LINUX_ID(1234), stat: () => ({ uid: 0, gid: 2375 }) },
		resolveDockerEndpoint: async () => endpoint,
		// Issue #354: the other venue is REGISTERED, as every venue a job can reach past the blessed gate is. The job-user
		// decision is now the venue's own optional member, dispatched by the registry, and this one carries none.
		extraBackends: [OTHER_VENUE("far")],
	});
	assert.equal(logs.filter((l) => l.event === "job_user").length, 1);
	const mark = bootLines.length;
	const readsAtBoot = reads;
	assert.deepEqual(await captured.deps.jobUserPreflight({ kind: "github", repo: "o/r", backend: "far" }, { capabilities: [], observed: { ok: true, endpoint } }), { user: null, home: null });
	assert.equal(reads, readsAtBoot, "another venue's job asks this daemon nothing");

	const job = { kind: "github", repo: "o/r", target: { type: "issue", number: 1 } };
	assert.equal((await captured.deps.jobUserPreflight(job, { capabilities: ["anyUid"], observed: { ok: true, endpoint } })).unavailable, true);
	assert.ok(!parseLines(bootLines.slice(mark)).some((l) => l.event === "job_user"), "an unchanged unknown is not said again");
	answer = { answered: true, facts: (await DOCKER_FACTS({ rootless: true })()).facts };
	assert.deepEqual(await captured.deps.jobUserPreflight(job, { capabilities: ["anyUid"], observed: { ok: true, endpoint } }), { refused: "job-user-unmappable", cause: "rootless" });
	assert.deepEqual(await captured.deps.jobUserPreflight(job, { capabilities: ["anyUid"], observed: { ok: true, endpoint } }), { refused: "job-user-unmappable", cause: "rootless" });
	const said = parseLines(bootLines.slice(mark)).filter((l) => l.event === "job_user");
	assert.deepEqual(said.map((l) => [l.mode, l.cause]), [["unmappable", "rootless"]], "a boot that read unknown is not left as the last word, and the same answer twice is said once");
});

test("the per-job gate carries relabel: true from a local Podman daemon with SELinux, and nothing otherwise (issue #355)", { skip }, async () => {
	const endpoint = { local: true, context: "podman", endpoint: "unix:///run/pd-test/podman.sock", reason: null, transient: false };
	const job = { kind: "github", repo: "o/r", target: { type: "issue", number: 1 } };
	const stat = () => ({ uid: 0, gid: 2375 });
	const start = (over, identity = LINUX_ID(1234)) =>
		runStart({ makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }), makeHost: () => fakeHost(), readDaemonFacts: DOCKER_FACTS(over), jobUserIdentity: { ...identity, stat }, resolveDockerEndpoint: async () => endpoint });
	const podman = await start({ podman: true, selinux: true, bounds: null });
	assert.deepEqual(await podman.captured.deps.jobUserPreflight(job, { capabilities: ["anyUid"], observed: { ok: true, endpoint } }), { user: "1234:1234", home: "/home/pi", relabel: true });
	// The image-mode path relabels too: uid 1001 needs no --user, and its mounts are denied just the same.
	const shipped = await start({ podman: true, selinux: true, bounds: null }, LINUX_ID(1001));
	assert.deepEqual(await shipped.captured.deps.jobUserPreflight(job, { capabilities: [], observed: { ok: true, endpoint } }), { user: null, home: null, relabel: true });
	// A refusal runs nothing, so it carries no relabel.
	assert.deepEqual(await podman.captured.deps.jobUserPreflight(job, { capabilities: [], observed: { ok: true, endpoint } }), { refused: "job-image-any-uid-unsupported", cause: "any-uid-unsupported" });
	// The endpoint THIS job observed decides: the same daemon behind an endpoint not on this host relabels nothing.
	const far = { ...endpoint, local: false, endpoint: "tcp://10.0.0.5:2376" };
	assert.deepEqual(await podman.captured.deps.jobUserPreflight(job, { capabilities: ["anyUid"], observed: { ok: true, endpoint: far } }), { user: null, home: null });
	for (const [label, over] of [
		["docker with selinux, out of scope", { selinux: true }],
		["podman without selinux", { podman: true, selinux: false, bounds: null }],
	]) {
		const other = await start(over);
		assert.deepEqual(await other.captured.deps.jobUserPreflight(job, { capabilities: ["anyUid"], observed: { ok: true, endpoint } }), { user: "1234:1234", home: "/home/pi" }, label);
	}
});

test("PI_FORWARD_ENV=HOME on a worker that runs jobs under --user is said at boot", { skip }, async () => {
	const { logs } = await runStart({
		env: { PI_FORWARD_ENV: "HOME" },
		makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
		makeHost: () => fakeHost(),
		readDaemonFacts: DOCKER_FACTS(),
		jobUserIdentity: { ...LINUX_ID(1234), stat: () => ({ uid: 0, gid: 2375 }) },
		bootImage: { ok: true, capabilities: ["anyUid"] },
	});
	assert.ok(logs.some((l) => l.event === "forward_env_home_overridden"));
	assert.ok(!logs.some((l) => l.event === "job_user_group_refused" || l.event === "job_image_any_uid_unsupported"));
	// A uid-1001 worker runs jobs with no --user, so its forwarded HOME is really forwarded: nothing to say.
	const shipped = await runStart({
		env: { PI_FORWARD_ENV: "HOME" },
		makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
		makeHost: () => fakeHost(),
		readDaemonFacts: DOCKER_FACTS(),
		jobUserIdentity: { ...LINUX_ID(1001), stat: () => ({ uid: 0, gid: 2375 }) },
		bootImage: { ok: true, capabilities: ["anyUid"] },
	});
	assert.ok(!shipped.logs.some((l) => l.event === "forward_env_home_overridden"));
});

// --- issue #345: the runtime observations ------------------------------------------------------------------------

const PODMAN_FACTS = (over = {}) => DOCKER_FACTS({ podman: true, bounds: null, ...over });
const hostFiles = (files) => ({
	statSync: (p) => {
		if (files[p] === undefined) throw enoent(p);
		return { size: Buffer.byteLength(files[p]) };
	},
	readFileSync: (p) => {
		if (files[p] === undefined) throw enoent(p);
		return files[p];
	},
	readdirSync: (p) => {
		throw enoent(p);
	},
});

test("a floor asking isolation=enforced refuses to BOOT on a daemon not observed applying the bounds, tagged, with its own remedy, before anything is built (#345)", { skip: skipNoModule }, async () => {
	const order = [];
	await assert.rejects(
		() => runStart({ env: { PI_BACKEND_FLOOR: "isolation=enforced" }, readDaemonFacts: PODMAN_FACTS(), order, makeReaper: () => (order.push("makeReaper"), async () => ({ reaped: true })) }),
		(err) => err.piDispatchConfig === true && /local: isolation=enforced holds only while the daemon reports that it applies/.test(err.message) && /the daemon is Podman/.test(err.message) && /doctor --live` reads pids\.max/.test(err.message) && !/Point the docker CLI back/.test(err.message),
	);
	assert.deepEqual(order, [], "no reaper and no worker");
	await assert.rejects(
		() => runStart({ env: { PI_BACKEND_FLOOR: "isolation=enforced" }, readDaemonFacts: async () => ({ answered: false, reason: "daemon-unreachable", transient: true }) }),
		(err) => err.piDispatchConfig !== true && /the daemon's info was not read \(daemon-unreachable\)/.test(err.message),
		"a daemon still starting is retried by the supervisor (exit 1), never a config error that strands the unit",
	);
	await assert.rejects(
		() => runStart({ env: { PI_BACKEND_FLOOR: "isolation=enforced" }, readDaemonFacts: async () => ({ answered: false, reason: "unparseable", transient: false }) }),
		(err) => err.piDispatchConfig === true && /answered in a shape nothing here reads \(unparseable\)/.test(err.message),
		"an answer nothing reads is determinate: exit 2, not a restart loop",
	);
});

test("a floor asking mountSet=enforced boots on Podman only with the empty mounts.conf override, and the observations reach worker_started (#345)", { skip }, async () => {
	await assert.rejects(
		() => runStart({ env: { PI_BACKEND_FLOOR: "mountSet=enforced" }, readDaemonFacts: PODMAN_FACTS(), makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }), makeHost: () => fakeHost() }),
		(err) => err.piDispatchConfig === true && /mountSet=enforced/.test(err.message) && /mounts\.conf does not exist/.test(err.message) && /create an empty \/etc\/containers\/mounts\.conf/.test(err.message),
	);
	const { logs } = await runStart({ env: { PI_BACKEND_FLOOR: "mountSet=enforced" }, readDaemonFacts: PODMAN_FACTS(), observationFs: hostFiles({ "/etc/containers/mounts.conf": "" }), makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }), makeHost: () => fakeHost() });
	const started = logs.find((l) => l.event === "worker_started");
	assert.deepEqual([started.daemonAppliesBounds, started.runtimeAddsNoMounts], [false, true], "Podman: bounds not credited, mounts credited with the override");
	const docker = await runStart({ makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }), makeHost: () => fakeHost() });
	const dockerStarted = docker.logs.find((l) => l.event === "worker_started");
	assert.deepEqual([dockerStarted.daemonAppliesBounds, dockerStarted.runtimeAddsNoMounts], [true, true]);
});

test("per job: the runtime observations are read from the job user's cached facts, logged on change, and refuse under a floor with which observation missed (#345)", { skip }, async () => {
	let facts = DOCKER_FACTS();
	let reads = 0;
	const endpoint = { local: true, context: "default", endpoint: "unix:///run/pd-test/docker.sock", reason: null, transient: false };
	let current = endpoint;
	const { captured } = await runStart({
		env: { PI_BACKEND_FLOOR: "isolation=enforced" },
		makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
		makeHost: () => fakeHost(),
		readDaemonFacts: async () => (reads++, facts()),
		resolveDockerEndpoint: async () => current,
	});
	const job = { kind: "github", repo: "o/r", target: { type: "issue", number: 1 } };
	const readsAtBoot = reads;
	const held = await captured.deps.observationPreflight(job);
	assert.equal(held.ok, true);
	assert.equal(reads, readsAtBoot, "the boot read is cached for the same endpoint: no second docker info");
	assert.deepEqual(await captured.deps.jobUserPreflight(job, { capabilities: [], observed: held }), { user: null, home: null });
	assert.equal(reads, readsAtBoot, "and the job-user gate reuses the observation's read");

	facts = PODMAN_FACTS();
	current = { ...endpoint, endpoint: "unix:///run/podman/podman.sock", context: "podman" };
	const mark = bootLines.length;
	const refused = await captured.deps.observationPreflight(job);
	assert.equal(refused.refused, true);
	assert.deepEqual(refused.observations, ["daemonAppliesBounds"]);
	assert.match(refused.message, /the daemon is Podman/);
	const changed = parseLines(bootLines.slice(mark)).filter((l) => l.event === "runtime_observed");
	assert.deepEqual(changed.map((l) => [l.daemonAppliesBounds, l.runtimeAddsNoMounts]), [[false, false]], "logged once, when it changed");
	await captured.deps.observationPreflight(job);
	assert.equal(parseLines(bootLines.slice(mark)).filter((l) => l.event === "runtime_observed").length, 1, "an unchanged answer logs nothing more");

	facts = async () => ({ answered: false, reason: "timeout", transient: true });
	current = { ...endpoint, context: "third" };
	assert.deepEqual(await captured.deps.observationPreflight(job), { unavailable: true, reason: "timeout" }, "an unanswered read retries");
});

test("per job without a floor: an unanswered facts read is not cached, and the job-user gate reuses the observation's read instead of asking again (#345)", { skip }, async () => {
	let reads = 0;
	const { captured } = await runStart({
		makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
		makeHost: () => fakeHost(),
		readDaemonFacts: async () => (reads++, { answered: false, reason: "timeout", transient: true }),
		jobUserIdentity: LINUX_ID(1234),
	});
	const job = { kind: "github", repo: "o/r", target: { type: "issue", number: 1 } };
	const before = reads;
	const observed = await captured.deps.observationPreflight(job);
	assert.equal(observed.ok, true, "no floor: an unanswered read refuses nothing");
	assert.equal(reads, before + 1, "not cached, so the job asks once");
	assert.deepEqual(await captured.deps.jobUserPreflight(job, { capabilities: [], observed }), { unavailable: true, reason: "timeout" });
	assert.equal(reads, before + 1, "and the job-user gate decides from that same read, not a second docker info");
});

test("a floor that needs a daemon observation waits the facts read's own bound at boot, so a slow but healthy docker info still boots (#345)", { skip, timeout: 30_000 }, async () => {
	const slow = async () => {
		await new Promise((resolve) => setTimeout(resolve, 5_600));
		return DOCKER_FACTS()();
	};
	const { logs } = await runStart({ env: { PI_BACKEND_FLOOR: "isolation=enforced" }, readDaemonFacts: slow, makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }), makeHost: () => fakeHost() });
	assert.equal(logs.find((l) => l.event === "worker_started")?.daemonAppliesBounds, true, "past the 5 s image bound, and still credited");
});

test("per job, a floor on the endpoint refuses a redirected CLI BEFORE any daemon read (#345)", { skip }, async () => {
	let reads = 0;
	let current = { local: true, context: "default", endpoint: "unix:///x.sock", reason: null, transient: false };
	const { captured } = await runStart({
		env: { PI_BACKEND_FLOOR: "credentialTransit=enforced,isolation=enforced" },
		makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
		makeHost: () => fakeHost(),
		readDaemonFacts: async () => (reads++, DOCKER_FACTS()()),
		resolveDockerEndpoint: async () => current,
	});
	const job = { kind: "github", repo: "o/r", target: { type: "issue", number: 1 } };
	current = { local: false, context: "remote", endpoint: "tcp://10.1.2.3:2375", reason: null, transient: false };
	const before = reads;
	const refused = await captured.deps.observationPreflight(job);
	assert.deepEqual([refused.refused, refused.observations], [true, ["dockerEndpointLocal"]]);
	assert.equal(reads, before, "the distrusted daemon is never asked");
});

test("the boot facts bound: the facts read's own 15 s plus 2 only for a floor that a daemon observation decides (#345)", { skip: skipNoModule }, () => {
	const bound = (floor) => mod.bootFactsBoundMs({ backends: ["local"], backendFloor: floor });
	assert.equal(bound({}), 5_000);
	for (const floor of [{ credentialTransit: "enforced" }, { nonRoot: "asserted" }, { egress: "enforced" }, { isolation: "asserted" }, { mountSet: "absent" }]) {
		assert.equal(bound(floor), 5_000, JSON.stringify(floor));
	}
	for (const floor of [{ isolation: "enforced" }, { mountSet: "enforced" }, { credentialTransit: "enforced", mountSet: "enforced" }]) {
		assert.equal(bound(floor), 17_000, JSON.stringify(floor));
	}
});

// --- issue #386: the boot race, as a rule the four watches share

test("the boot-race rule fires only on a change, only with a live watch, and never on an unreadable read", async () => {
	// The three watches in the worker and the one in the receiver all read their file at boot and arm
	// afterwards, so an edit in that gap waits for the NEXT edit or a restart. The repair is one read after
	// arming compared against one before it, and each of these arms is a way it would otherwise misfire.
	const mod = await import("../src/watch-closer.mjs");
	const armed = () => ({ watcher: {}, timer: null, closed: false });

	const changed = armed();
	mod.readBeforeArming(changed, () => "a");
	assert.equal(mod.changedWhileArming(changed, () => "b"), true, "a file that moved between the two reads is the race being LOST");

	const quiet = armed();
	mod.readBeforeArming(quiet, () => "a");
	assert.equal(mod.changedWhileArming(quiet, () => "a"), false, "an unchanged file costs a read and nothing else -- no reload, no line");

	// NO WATCHER means the arming THREW and the service already logged that it runs without live reload.
	// Re-reading there would paper over that with one lucky read and no watch behind it.
	const unarmed = { watcher: null, timer: null, closed: false };
	mod.readBeforeArming(unarmed, () => "a");
	assert.equal(mod.changedWhileArming(unarmed, () => "b"), false, "a watch that never armed gets no consolation read");

	// An unreadable file on EITHER side is not a change. Every reload path keeps last-good on a bad read, so
	// firing one here would spend a reload to arrive at the value already in memory.
	const boom = () => {
		throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
	};
	const goneAfter = armed();
	mod.readBeforeArming(goneAfter, () => "a");
	assert.equal(mod.changedWhileArming(goneAfter, boom), false, "unreadable after");
	const goneBefore = armed();
	mod.readBeforeArming(goneBefore, boom);
	assert.equal(mod.changedWhileArming(goneBefore, () => "a"), false, "unreadable before");
});

test("one debounce, shared: the 150ms literal is written once (issue #386)", async () => {
	// It was written four times, which is the shape CLAUDE.md warns about: four copies agree until one of
	// them does not. The value itself is pinned because it is a contract with the panel's atomic writer --
	// a tmp+rename delivers more than one event for one edit, and the window only has to outlast that burst.
	const mod = await import("../src/watch-closer.mjs");
	assert.equal(mod.WATCH_DEBOUNCE_MS, 150);
	for (const file of ["../src/start.mjs", "../../receiver/src/start.mjs"]) {
		const src = readFileSync(new URL(file, import.meta.url), "utf8");
		assert.doesNotMatch(src, /setTimeout\([^)]*,\s*150\)/, `${file} still spells the debounce inline`);
		assert.match(src, /WATCH_DEBOUNCE_MS/, `${file} uses the shared one`);
	}
});

test("all FOUR live-edit watches apply the boot-race rule, not just the one with an end-to-end test (#386)", () => {
	// BY SHAPE, and the limit is the point rather than an apology. The rule itself is pinned behaviourally
	// above, and the receiver's watch is driven end to end through its read seam. The worker's three are
	// private functions armed from deep inside `startWorker`, so driving each would mean three full worker
	// boots with a Valkey behind them to prove one `if`. What is cheap and exact instead is that every watch
	// in this project reads before arming and compares after it -- which is the thing a fifth watch added
	// tomorrow would forget.
	//
	// It sees a CALL, not an effect: a site that calls both and ignores the answer passes. That is the same
	// trade `temp-dir-check` makes, and the same reason its oracle exists beside it.
	const sources = {
		"worker/src/start.mjs": readFileSync(new URL("../src/start.mjs", import.meta.url), "utf8"),
		"receiver/src/start.mjs": readFileSync(new URL("../../receiver/src/start.mjs", import.meta.url), "utf8"),
	};
	// One watch per `watch(dir, ...)` arming, which is how all four are written.
	const armings = Object.entries(sources).map(([name, src]) => [name, (src.match(/handles\.watcher = watch\(/g) ?? []).length]);
	assert.deepEqual(armings, [["worker/src/start.mjs", 3], ["receiver/src/start.mjs", 1]], "four watches, and if that count moves this test must be read again rather than updated");
	for (const [name, src] of Object.entries(sources)) {
		const arms = (src.match(/handles\.watcher = watch\(/g) ?? []).length;
		assert.equal((src.match(/readBeforeArming\(/g) ?? []).length, arms, `${name}: every watch reads before it arms`);
		assert.equal((src.match(/changedWhileArming\(/g) ?? []).length, arms, `${name}: and compares after`);
		// THE THIRD ARGUMENT IS THE WHOLE POINT, and its absence is the design error a review pass caught in
		// the first version of this change: with no boot baseline the helper reads the file where the watch
		// ARMS, which measures a fraction of a millisecond around the arming while the window the race lives
		// in -- boot load to arming, holding identity resolution and its retries -- stays open.
		assert.equal(
			(src.match(/readBeforeArming\([^)]*,[^)]*,[^)]*\)/g) ?? []).length,
			arms,
			`${name}: every watch's baseline is handed in, not taken at the arming`,
		);
	}

	// AND AT THE CALLER, which is where it can actually go missing. The check above reads the line INSIDE
	// the watch function, where the third argument is a parameter name that never changes -- so dropping
	// `atBoot.triggers` at the `startWorker` call site left it green while reinstating the whole defect,
	// measured end to end by a review pass. Three of the four sites were unguarded against the very error
	// under repair. The receiver's caller is covered behaviourally, by an edit made during identity
	// resolution; the worker's three are armed a thousand lines into `startWorker`, behind a live Valkey,
	// so they are covered here.
	const worker = sources["worker/src/start.mjs"];
	for (const [fn, key] of [["watchTriggersFile", "triggers"], ["watchPauseWindowsFile", "pauseWindows"], ["watchScopedLimitsFile", "scopedLimits"]]) {
		const call = worker.match(new RegExp(`extraClosers\\.push\\(${fn}\\(([^;]*)\\)\\);`));
		assert.ok(call, `${fn} is armed from startWorker`);
		assert.match(call[1], new RegExp(`atBoot\\.${key}\\b`), `${fn} is handed the boot baseline of ITS OWN file, not another's`);
		// The capture that fills it must name the same file, or the baseline is another file's bytes and
		// every boot reloads: measured, a mismatched pair logs a reload and a Valkey reconcile on EVERY start.
		assert.match(worker, new RegExp(`recording\\("${key}", config\\.${key === "triggers" ? "triggersFile" : key + "File"}\\)`), `${key}'s baseline is captured from its own file`);
	}
});

// ── issue #354: `local` is no longer mandatory ─────────────────────────────────────────────────────────

/** The real loader with its backend facts replaced: `local` is the table's one entry, so no env can omit it yet. */
async function configWith(overrides) {
	const { loadConfig } = await import("../src/config.mjs");
	return (env) => ({ ...loadConfig(env), ...overrides });
}

/** A seam that FAILS the test if called: the proof that a boot without `local` asks this host's docker CLI nothing. */
const forbidden = (what, seen) => (...args) => {
	seen.push(what);
	throw new Error(`${what} must not be called with local unblessed (${JSON.stringify(args).slice(0, 80)})`);
};

test("a registry that refuses at boot releases every handle boot opened, so the refusing worker can exit (#354)", { skip }, async () => {
	// The refusal arrives after boot opened the Redis client, the runtime queue, the host's own cron queue (a declared name)
	// and the host registry. Any one left open keeps the event loop alive, and the CLI waits for it to empty, so a worker
	// that refused to boot never exited (measured against a real Valkey).
	const { makeHostRegistry } = await import("../src/host-registry.mjs");
	const sockets = () => process.getActiveResourcesInfo().filter((r) => r === "TCPSocketWrap").length;
	const before = sockets();
	let closed = 0;
	await assert.rejects(
		() =>
			runStart({
				env: { PI_WORKER_NAME: "refuses-at-registry", VALKEY_URL },
				makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
				makeHost: () => fakeHost(),
				makeHostRegistry: (args) => {
					const real = makeHostRegistry(args);
					return {
						...real,
						close: async (...rest) => {
							closed++;
							return real.close(...rest);
						},
					};
				},
				makeBackendRegistry: () => {
					throw new Error("refused by the registry (test)");
				},
			}),
		/refused by the registry \(test\)/,
	);
	assert.equal(closed, 1, "the host registry is closed");
	// Sockets close asynchronously after quit/disconnect; give them a moment, then nothing boot opened may remain.
	for (let i = 0; i < 40 && sockets() > before; i++) await new Promise((r) => setTimeout(r, 50));
	assert.ok(sockets() <= before, `no socket boot opened is left: ${sockets()} now, ${before} before`);
});

test("a deployment WITHOUT local boots on its own venue, and asks this host's docker CLI nothing (#354)", { skip }, async () => {
	const seen = [];
	const spawned = [];
	let registryArgs = null;
	const swept = [];
	const { captured, logs, imagePreflightCalls, runContainerCalls, sandboxReaperCalls } = await runStart({
		env: { PI_WORKER_NAME: "no-docker-1", VALKEY_URL },
		makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
		makeHost: () => fakeHost(),
		// A floor naming an observation only `local` makes. With `local` blessed and unobserved this is the unanswered,
		// transient arm, exit 1 forever; without it there is nothing of local's to observe.
		loadConfig: await configWith({ backends: ["far"], defaultBackend: "far", backendFloor: { isolation: "enforced", mountSet: "enforced", credentialTransit: "enforced" } }),
		extraBackends: [OTHER_VENUE("far", { spawned })],
		resolveDockerEndpoint: forbidden("resolveDockerEndpoint", seen),
		readDaemonFacts: forbidden("readDaemonFacts", seen),
		makeReaper: forbidden("makeReaper", seen),
		makeScopeClaimSweeper: () => async (opts) => (swept.push(opts), { swept: 0, skipped: !opts.reaped }),
		makeBackendRegistry: (args) => {
			registryArgs = args;
			return realRegistry(args);
		},
	});
	assert.deepEqual(seen, [], "no endpoint read, no daemon facts, no local reaper");
	assert.equal(imagePreflightCalls.length, 0, "local's image preflight is not even constructed");
	assert.equal(runContainerCalls.length, 0, "nor its runContainer");
	assert.deepEqual(registryArgs.bundles.map((b) => b.name), ["far"], "no local bundle is registered");
	assert.deepEqual(Object.keys(registryArgs.reaps), ["far"], "and no local boot reaper, which the registry would refuse");
	assert.equal(registryArgs.defaultName, "far");

	// The boot image read asks the DEFAULT venue's own preflight, the one its jobs are gated on.
	assert.deepEqual(spawned, ["far:imagePreflight"]);
	const started = logs.find((l) => l.event === "worker_started");
	assert.equal(started.imageDigest, "sha256:far");
	for (const key of ["dockerContext", "dockerEndpointLocal", "jobUser", "daemonAppliesBounds", "runtimeAddsNoMounts"]) {
		assert.equal(started[key], null, `${key} is null: this host's docker CLI was not asked`);
	}
	assert.ok(!logs.some((l) => l.event === "job_user"), "no job-user decision is said about a daemon nobody asked");

	// The sandbox reaper is built, but its liveness listing refuses rather than answering "none open", and its
	// docker-backed network sweeper is not built at all.
	assert.equal(sandboxReaperCalls.length, 1);
	await assert.rejects(() => sandboxReaperCalls[0].listRunning(), /local is not blessed/);
	assert.equal(sandboxReaperCalls[0].sweepNetworks, undefined);

	// Every reaper answered, and the host is still not proven: Docker containers from before may remain.
	assert.deepEqual(swept, [{ reaped: false }]);
	assert.equal(logs.find((l) => l.event === "host_reap_unproven")?.reason, "local is not blessed, so no reaper lists this host's docker containers");

	// Per job: the venue carries neither optional preflight, so it gets the processor's own defaults, dispatched.
	const job = { kind: "github", repo: "o/r", target: { type: "issue", number: 1 } };
	assert.deepEqual(await captured.deps.observationPreflight(job), { ok: true });
	assert.deepEqual(await captured.deps.jobUserPreflight(job, { capabilities: [], observed: { ok: true } }), { user: null, home: null });
	assert.deepEqual(seen, [], "and still nothing of local's is asked");
});

test("with local blessed, a blessed venue with NO boot reaper never lets the scope sweep run (#354)", { skip }, async () => {
	// The registry refuses a blessed-but-unbuilt venue, but only AFTER the scope sweep has acted on the reap: `reapAll`
	// is conservative over the reapers it is HANDED, and a venue that handed none was proven by nobody. The registry's
	// own cross-check is switched off here so the boot completes and the sweep's input can be read.
	const swept = [];
	const { logs } = await runStart({
		env: { PI_WORKER_NAME: "mac-mini-1", VALKEY_URL },
		makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
		makeHost: () => fakeHost(),
		loadConfig: await configWith({ backends: ["local", "ghost"], defaultBackend: "local" }),
		makeReaper: () => async () => ({ reaped: true }),
		makeScopeClaimSweeper: () => async (opts) => (swept.push(opts), { swept: 0, skipped: !opts.reaped }),
		makeBackendRegistry: (args) => realRegistry({ ...args, blessed: null }),
	});
	assert.deepEqual(swept, [{ reaped: false }], "every reaper handed over enumerated, and the host is still unproven");
	assert.equal(logs.find((l) => l.event === "host_reap_unproven")?.reason, "a blessed backend has no boot reaper");
});

test("a venue whose words are observation-gated must carry an observationPreflight, or boot refuses (#354)", { skip }, async () => {
	// `local`'s table entry names `observedBy`. A bundle claiming that name with no preflight would have those words hold
	// with nothing observing them; the absent answer admits every job.
	const base = {
		makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
		makeHost: () => fakeHost(),
		loadConfig: await configWith({ backends: ["far"], defaultBackend: "far" }),
	};
	await assert.rejects(
		() => runStart({ ...base, extraBackends: [OTHER_VENUE("far"), OTHER_VENUE("local")] }),
		/backend "local" declares isolation, mountSet, credentialTransit as held only while observed, and carries no observationPreflight/,
	);
	// Carrying one, it boots, and a job on it is dispatched to that member.
	const asked = [];
	const { captured } = await runStart({
		...base,
		extraBackends: [OTHER_VENUE("far"), OTHER_VENUE("local", { observationPreflight: async (job) => (asked.push(job.backend), { ok: true, mine: true }) })],
	});
	assert.deepEqual(await captured.deps.observationPreflight({ backend: "local" }), { ok: true, mine: true });
	assert.deepEqual(asked, ["local"]);
});

test("with local blessed, the preflights are local's own members and a job naming another venue gets that venue's answer (#354)", { skip }, async () => {
	let reads = 0;
	const { captured } = await runStart({
		makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
		makeHost: () => fakeHost(),
		readDaemonFacts: async () => (reads++, { answered: true, facts: { shape: "docker", podman: false, os: "Test Linux", rootless: false, userns: false, bounds: { pids: true, memory: true }, serviceIsRemote: null, remoteSocketPath: null } }),
		extraBackends: [OTHER_VENUE("far", { jobUserPreflight: async () => ({ user: "4242:4242", home: "/far" }) })],
		makeBackendRegistry: (args) => {
			const bundle = args.bundles.find((b) => b.name === "local");
			assert.equal(typeof bundle.observationPreflight, "function", "local carries its observation preflight");
			assert.equal(typeof bundle.jobUserPreflight, "function", "and its job-user preflight");
			return realRegistry(args);
		},
	});
	const atBoot = reads;
	assert.deepEqual(await captured.deps.jobUserPreflight({ backend: "far" }, { capabilities: [] }), { user: "4242:4242", home: "/far" }, "a venue's own member answers for its jobs");
	assert.deepEqual(await captured.deps.observationPreflight({ backend: "far" }), { ok: true }, "and one it does not carry is the absent answer");
	assert.equal(reads, atBoot, "neither asked this host's daemon anything");
});

// ── issue #354 part 2: the native podman venue at boot ─────────────────────────────────────────────────────

const PODMAN_ID = { platform: "linux", release: "6.8.0-test", euid: 1234, egid: 1234, home: "/home/pdjob" };
/** The one file that earns `podmanAddsNoMounts`: this account's own mounts.conf override, empty. */
const PODMAN_FILES = hostFiles({ "/home/pdjob/.config/containers/mounts.conf": "" });
const PODMAN_KEYS = ["podmanVersion", "podmanRootless", "podmanJobUser", "podmanBoundsDelegated", "podmanAddsNoMounts", "podmanServiceLocal"];

test("podman unblessed: no podman info, no podman reaper, no podman bundle, and the boot line's podman keys are null (#354)", { skip }, async () => {
	const seen = [];
	let registryArgs = null;
	const { logs, podmanBackendCalls } = await runStart({
		makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
		makeHost: () => fakeHost(),
		readPodmanInfo: forbidden("readPodmanInfo", seen),
		makePodmanReaper: forbidden("makePodmanReaper", seen),
		makeBackendRegistry: (args) => ((registryArgs = args), realRegistry(args)),
	});
	assert.deepEqual(seen, []);
	assert.equal(podmanBackendCalls.length, 0);
	assert.deepEqual(registryArgs.bundles.map((b) => b.name), ["local"]);
	const started = logs.find((l) => l.event === "worker_started");
	for (const key of PODMAN_KEYS) assert.equal(started[key], null, key);
});

test("podman as the only venue: one podman info at boot shared with the first job, its reaper and bundle registered, its facts on the boot line (#354)", { skip }, async () => {
	const calls = [];
	const seen = [];
	let registryArgs = null;
	const podmanReap = async () => ({ reaped: true });
	const { captured, logs, podmanBackendCalls, imagePreflightCalls } = await runStart({
		env: { PI_BACKENDS: "podman", PI_BACKEND_FLOOR: "isolation=enforced,mountSet=enforced,credentialTransit=enforced", PI_JOB_IMAGE: "pi-job:ci" },
		makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
		makeHost: () => fakeHost(),
		jobUserIdentity: PODMAN_ID,
		observationFs: PODMAN_FILES,
		readPodmanInfo: PODMAN_INFO({}, { calls }),
		makePodmanReaper: () => podmanReap,
		bootImage: { ok: true, image: "pi-job:ci", imageDigest: "sha256:pod", piVersion: "0.80.7", capabilities: ["anyUid"] },
		resolveDockerEndpoint: forbidden("resolveDockerEndpoint", seen),
		readDaemonFacts: forbidden("readDaemonFacts", seen),
		makeReaper: forbidden("makeReaper", seen),
		makeBackendRegistry: (args) => ((registryArgs = args), realRegistry(args)),
	});
	assert.deepEqual(seen, [], "nothing of local's is asked");
	assert.deepEqual(registryArgs.bundles.map((b) => b.name), ["podman"]);
	assert.equal(registryArgs.defaultName, "podman");
	assert.deepEqual(Object.keys(registryArgs.reaps), ["podman"]);
	assert.equal(registryArgs.reaps.podman, podmanReap, "the boot-built podman reaper is the one the registry holds");
	assert.equal(registryArgs.bundles[0].reap, podmanReap, "and the one the bundle carries");

	// What boot handed the bundle: the deployment's own inputs, the floor, and the podman identity and files.
	assert.equal(podmanBackendCalls.length, 1);
	const opts = podmanBackendCalls[0];
	assert.equal(opts.image, "pi-job:ci");
	assert.deepEqual(opts.backendFloor, { isolation: "enforced", mountSet: "enforced", credentialTransit: "enforced" });
	assert.deepEqual([opts.platform, opts.euid, opts.egid, opts.home], ["linux", 1234, 1234, "/home/pdjob"]);
	assert.equal(opts.fs, PODMAN_FILES);
	assert.equal(typeof opts.packagePaths, "function", "a resolver, as local's runContainer gets");

	// The boot image read asked podman's own preflight, the one podman jobs are gated on.
	assert.deepEqual(imagePreflightCalls.map((c) => [c.image, c.bin, c.podman]), [["pi-job:ci", "podman", true]]);
	const started = logs.find((l) => l.event === "worker_started");
	assert.equal(started.imageDigest, "sha256:pod");
	assert.equal(started.podmanVersion, "5.8.1");
	assert.equal(started.podmanRootless, true);
	assert.deepEqual(started.podmanJobUser, { mode: "worker", user: "1234:1234", cause: null, reason: null });
	assert.deepEqual([started.podmanBoundsDelegated, started.podmanAddsNoMounts, started.podmanServiceLocal], [true, true, true]);
	for (const key of ["dockerContext", "dockerEndpointLocal", "jobUser", "daemonAppliesBounds", "runtimeAddsNoMounts"]) assert.equal(started[key], null, key);
	assert.ok(!logs.some((l) => l.event === "job_image_any_uid_unsupported"), "the image declares anyUid");

	// Per job, through the registry: the floor holds on the SAME cached read, and the job runs as the worker's uid.
	const job = { kind: "github", repo: "o/r", target: { type: "issue", number: 1 } };
	const observed = await captured.deps.observationPreflight(job);
	assert.equal(observed.ok, true, JSON.stringify(observed));
	assert.deepEqual(await captured.deps.jobUserPreflight(job, { capabilities: ["anyUid"], observed }), { user: "1234:1234", home: "/home/pi", relabel: false });
	assert.deepEqual(calls, ["podman info"], "one podman info for the boot and the job together");
});

test("a podman default whose image lacks anyUid is said at boot, with the venue named (#354)", { skip }, async () => {
	const { logs } = await runStart({
		env: { PI_BACKENDS: "podman", PI_FORWARD_ENV: "HOME" },
		makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
		makeHost: () => fakeHost(),
		jobUserIdentity: PODMAN_ID,
		bootImage: { ok: true, image: "pi-job:latest", capabilities: [] },
	});
	assert.deepEqual(logs.find((l) => l.event === "job_image_any_uid_unsupported"), { event: "job_image_any_uid_unsupported", image: "pi-job:latest", backend: "podman", host: logs[0].host });
	// uid 1001 is the image's own: no anyUid needed, so nothing is said, and HOME beside --user is.
	const own = await runStart({ env: { PI_BACKENDS: "podman", PI_FORWARD_ENV: "HOME" }, makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }), makeHost: () => fakeHost(), jobUserIdentity: { ...PODMAN_ID, euid: 1001, egid: 1001 }, bootImage: { ok: true, capabilities: [] } });
	assert.ok(!own.logs.some((l) => l.event === "job_image_any_uid_unsupported"));
	assert.equal(own.logs.find((l) => l.event === "forward_env_home_overridden")?.backend, "podman");
	// With local the default, docker's copy of the tag says nothing about the podman store: not said.
	const localDefault = await runStart({ env: { PI_BACKENDS: "local,podman" }, makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }), makeHost: () => fakeHost(), jobUserIdentity: PODMAN_ID, bootImage: { ok: true, capabilities: [] } });
	assert.ok(!localDefault.logs.some((l) => l.event === "job_image_any_uid_unsupported" && l.backend === "podman"));
});

test("a podman default refuses to BOOT on every identity cause, tagged, before anything is built; merely blessed it boots (#354)", { skip: skipNoModule }, async () => {
	for (const [label, readPodmanInfo, jobUserIdentity, pattern] of [
		["rootful", PODMAN_INFO({ rootless: false }), PODMAN_ID, /podman is not rootless for this account/],
		["remote", PODMAN_INFO({ serviceIsRemote: true }), PODMAN_ID, /through a remote service/],
		["not-found", PODMAN_INFO({}, { answer: { answered: false, reason: "podman-not-found", transient: false } }), PODMAN_ID, /no podman CLI was found/],
		["root", PODMAN_INFO(), { ...PODMAN_ID, euid: 0, egid: 0 }, /the worker runs as root/],
		["platform", PODMAN_INFO(), { ...PODMAN_ID, platform: "darwin" }, /runs only on Linux/],
	]) {
		const order = [];
		const makeAuth = async () => (order.push("makeAuth"), { mintToken: async () => "tok", selfId: 1, source: "gh" });
		await assert.rejects(
			() => runStart({ env: { PI_BACKENDS: "podman" }, readPodmanInfo, jobUserIdentity, order, makeAuth, makeHost: () => fakeHost(), makePodmanReaper: () => (order.push("makePodmanReaper"), async () => ({ reaped: true })) }),
			(err) => err.piDispatchConfig === true && pattern.test(err.message) && /\(issue #354\)/.test(err.message),
			label,
		);
		assert.deepEqual(order, [], `${label}: before forge auth, the reaper and the worker`);
	}
	// The identity verdict comes BEFORE the observations: a rootful Podman fails the mounts observation too, and a floor
	// refusal naming mounts.conf would send the operator after the wrong fix.
	await assert.rejects(
		() => runStart({ env: { PI_BACKENDS: "podman", PI_BACKEND_FLOOR: "mountSet=enforced" }, readPodmanInfo: PODMAN_INFO({ rootless: false }), jobUserIdentity: PODMAN_ID, observationFs: PODMAN_FILES }),
		(err) => err.piDispatchConfig === true && /podman is not rootless for this account/.test(err.message) && !/mountSet/.test(err.message),
	);
	// Blessed beside a default `local`, a rootful Podman boots: its jobs are refused one by one, local's still run.
	const { logs } = await runStart({ env: { PI_BACKENDS: "local,podman" }, readPodmanInfo: PODMAN_INFO({ rootless: false }), jobUserIdentity: PODMAN_ID, makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }), makeHost: () => fakeHost() });
	assert.deepEqual(logs.find((l) => l.event === "worker_started").podmanJobUser, { mode: "unmappable", user: null, cause: "podman-rootful", reason: null });
	// Even under a floor the rootful Podman's observations cannot meet: its identity refusal is what its jobs get, and the
	// worker is not stopped with a mounts.conf fix that is not the one.
	const floored = await runStart({ env: { PI_BACKENDS: "local,podman", PI_BACKEND_FLOOR: "mountSet=enforced" }, readPodmanInfo: PODMAN_INFO({ rootless: false }), jobUserIdentity: PODMAN_ID, observationFs: PODMAN_FILES, makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }), makeHost: () => fakeHost() });
	assert.equal(floored.logs.find((l) => l.event === "worker_started").podmanJobUser.cause, "podman-rootful");
	// And the reverse: with podman the default, local's identity causes do not refuse the boot (local's rule, end to end).
	const localRootless = await runStart({ env: { PI_BACKENDS: "podman,local" }, readDaemonFacts: DOCKER_FACTS({ rootless: true }), jobUserIdentity: PODMAN_ID, makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }), makeHost: () => fakeHost() });
	assert.equal(localRootless.logs.find((l) => l.event === "worker_started").jobUser.cause, "rootless");
	// A transient unanswered read is `unknown`, never a boot exit, even as the default.
	const slow = await runStart({ env: { PI_BACKENDS: "podman" }, readPodmanInfo: PODMAN_INFO({}, { answer: { answered: false, reason: "timeout", transient: true } }), jobUserIdentity: PODMAN_ID, makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }), makeHost: () => fakeHost() });
	const slowStarted = slow.logs.find((l) => l.event === "worker_started");
	assert.deepEqual(slowStarted.podmanJobUser, { mode: "unknown", user: null, cause: null, reason: "timeout" });
	assert.deepEqual([slowStarted.podmanVersion, slowStarted.podmanRootless, slowStarted.podmanBoundsDelegated], [null, null, null]);
});

test("podmanBootRefusal: only a boot-refusing cause, and only while podman is the default venue (#354)", { skip: skipNoModule }, () => {
	for (const cause of ["podman-platform", "podman-not-found", "podman-remote", "podman-rootful", "worker-is-root"]) {
		assert.match(mod.podmanBootRefusal({ mode: "unmappable", cause }, "podman"), /^Refused: .*\(issue #354\)\.$/, cause);
		assert.equal(mod.podmanBootRefusal({ mode: "unmappable", cause }, "local"), null, `${cause}: podman blessed but not default boots`);
	}
	for (const decision of [{ mode: "unmappable", cause: "podman-unreadable" }, { mode: "unmappable", cause: "root-group" }, { mode: "unknown", reason: "timeout" }, { mode: "worker", user: "1234:1234" }, null]) {
		assert.equal(mod.podmanBootRefusal(decision, "podman"), null, JSON.stringify(decision));
	}
	// Local's rule does not answer for podman's causes, and podman's does not for local's.
	assert.equal(mod.jobUserBootRefusal({ mode: "unmappable", cause: "podman-rootful" }, "podman"), null);
	assert.equal(mod.podmanBootRefusal({ mode: "unmappable", cause: "rootless" }, "podman"), null);
});

test("a floor naming a podman observation refuses to BOOT on a missed one, tagged when answered, untagged when the read did not answer (#354)", { skip: skipNoModule }, async () => {
	const base = { jobUserIdentity: PODMAN_ID, observationFs: PODMAN_FILES, makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }), makeHost: () => fakeHost() };
	const order = [];
	await assert.rejects(
		() => runStart({ ...base, env: { PI_BACKENDS: "podman", PI_BACKEND_FLOOR: "isolation=enforced" }, readPodmanInfo: PODMAN_INFO({ controllers: ["memory", "pids"] }), order, makePodmanReaper: () => (order.push("makePodmanReaper"), async () => ({ reaped: true })) }),
		(err) => err.piDispatchConfig === true && /podman: isolation=enforced/.test(err.message) && /cpu cgroup controller is not delegated/.test(err.message),
	);
	assert.deepEqual(order, [], "before the reaper and the worker");
	// Blessed but NOT the default, it is still judged: the floor is over every blessed venue.
	await assert.rejects(
		() => runStart({ ...base, env: { PI_BACKENDS: "local,podman", PI_BACKEND_FLOOR: "mountSet=enforced" }, observationFs: NO_HOST_FILES, readPodmanInfo: PODMAN_INFO() }),
		(err) => err.piDispatchConfig === true && /podman: mountSet=enforced/.test(err.message),
	);
	// A read that did not answer is the supervisor's retry, never a config error that strands the unit. (Blessed beside
	// local, so the identity verdict cannot refuse first: `unknown` is never a boot exit anyway.)
	await assert.rejects(
		() => runStart({ ...base, env: { PI_BACKENDS: "local,podman", PI_BACKEND_FLOOR: "credentialTransit=enforced" }, readPodmanInfo: PODMAN_INFO({}, { answer: { answered: false, reason: "timeout", transient: true } }) }),
		(err) => err.piDispatchConfig !== true && /podman info was not read \(timeout\)/.test(err.message),
	);
});

test("each venue's boot observations are judged for that venue alone, so local and podman blessed together boot under a full floor (#354, M14)", { skip }, async () => {
	// PR #425's surviving mutant: judging local's observations over EVERY blessed venue reads podman's observedBy names
	// as unanswered in local's map, the transient arm, exit 1 on every restart. And the reverse for podman's.
	const floor = "isolation=enforced,mountSet=enforced,credentialTransit=enforced";
	const { logs } = await runStart({
		env: { PI_BACKENDS: "local,podman", PI_BACKEND_FLOOR: floor },
		jobUserIdentity: PODMAN_ID,
		observationFs: PODMAN_FILES,
		makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
		makeHost: () => fakeHost(),
	});
	const started = logs.find((l) => l.event === "worker_started");
	assert.deepEqual([started.daemonAppliesBounds, started.runtimeAddsNoMounts, started.dockerEndpointLocal], [true, true, true], "local's own observations hold");
	assert.deepEqual([started.podmanBoundsDelegated, started.podmanAddsNoMounts, started.podmanServiceLocal], [true, true, true], "and podman's");
});

test("the boot line carries each podman observation under its own key (#354)", { skip }, async () => {
	// Three different answers, so a key reading another observation's value cannot pass: bounds withheld (no cpu
	// controller), mounts credited (the empty override), service local. No floor, so nothing refuses.
	const { logs } = await runStart({
		env: { PI_BACKENDS: "local,podman" },
		jobUserIdentity: PODMAN_ID,
		observationFs: PODMAN_FILES,
		readPodmanInfo: PODMAN_INFO({ controllers: ["memory", "pids"] }),
		makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
		makeHost: () => fakeHost(),
	});
	const started = logs.find((l) => l.event === "worker_started");
	assert.deepEqual([started.podmanBoundsDelegated, started.podmanAddsNoMounts, started.podmanServiceLocal], [false, true, true]);
	const noOverride = await runStart({ env: { PI_BACKENDS: "local,podman" }, jobUserIdentity: PODMAN_ID, makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }), makeHost: () => fakeHost() });
	const s2 = noOverride.logs.find((l) => l.event === "worker_started");
	assert.deepEqual([s2.podmanBoundsDelegated, s2.podmanAddsNoMounts, s2.podmanServiceLocal], [true, false, true]);
});

test("a backend registry refusal releases every handle boot opened before it, not only the raw client (#354)", { skip }, async () => {
	// The registry refuses AFTER the job queue, the host queue and the host registry's heartbeat exist, and createWorker
	// has not been handed them, so neither the product's shutdown nor this harness's teardown can reach them. Before this
	// fix only `redis` was released: the refusal surfaced and the FILE hung (a mutant dropping podman's boot reaper
	// found it). The registry's close is pinned here; the queues' is this file ending at all.
	const { makeHostRegistry } = await import("../src/host-registry.mjs");
	let registryClosed = false;
	await assert.rejects(
		() =>
			runStart({
				env: { PI_BACKENDS: "podman", PI_WORKER_NAME: "refused-1", VALKEY_URL },
				jobUserIdentity: PODMAN_ID,
				makeAuth: async () => ({ mintToken: async () => "tok", selfId: 1, source: "gh" }),
				makeHost: () => fakeHost(),
				makeBackendRegistry: () => {
					throw new Error("registry refused this boot");
				},
				makeHostRegistry: (args) => {
					const real = makeHostRegistry(args);
					return {
						...real,
						close: async () => {
							registryClosed = true;
							await real.close();
						},
					};
				},
			}),
		/registry refused this boot/,
		"the refusal travels, not a teardown error",
	);
	assert.equal(registryClosed, true);
});
