import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
// processor.mjs pulls in no bullmq, so this import is safe below the node floor where index.mjs skips.
import { InfraRetry } from "../src/processor.mjs";
// run-history.mjs pulls in only node:fs/node:path -- safe below the node floor alongside processor.mjs.
import { buildRecord, makeRecordWriter } from "../src/run-history.mjs";

// index.mjs imports bullmq, so this skips below the node floor / without deps and runs in CI,
// where PI_DISPATCH_REQUIRE_WORKER_TESTS=1 turns a skip into a hard failure.
let mod;
let importError;
try {
	mod = await import("../src/index.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`worker wiring tests are REQUIRED here but bullmq could not import.\n${importError}`);
}
const skip = mod ? false : `bullmq not installed (node ${process.version} < 22.19.0); CI runs these`;

test("createWorker registers a win32-guarded SIGBREAK shutdown alongside SIGTERM/SIGINT", () => {
	// The signal registration lives inside createWorker, AFTER `new Worker(...)`. Constructing a real
	// Worker to observe process.once at runtime leaves a dangling ioredis reconnect handle that keeps
	// `node --test` from exiting (verified), so this asserts the contract against the source instead:
	// SIGTERM/SIGINT register unconditionally, SIGBREAK only on win32, and all three route to the same
	// `shutdown` closure (Windows never delivers an external SIGTERM; SIGBREAK covers console-close).
	// No bullmq import here, so this runs even below the node floor where the other tests skip.
	const src = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
	assert.match(src, /process\.once\("SIGTERM", shutdown\)/, "SIGTERM must route to shutdown");
	assert.match(src, /process\.once\("SIGINT", shutdown\)/, "SIGINT must route to shutdown");
	assert.match(
		src,
		/process\.platform === "win32"\)\s*\{?\s*process\.once\("SIGBREAK", shutdown\)/,
		"SIGBREAK must be win32-guarded and route to the same shutdown closure",
	);
});

test("the processor declares arity 3 -- the silent trap that would disable the timeout", { skip }, () => {
	// BullMQ only allocates an AbortController when processor.length >= 3. If a refactor drops the
	// unused `token` param, the 30-minute timeout and shutdown abort silently stop working. This is
	// the single most important assertion in the worker's wiring, because nothing at runtime reports
	// its failure -- the container just runs unbounded.
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis: {},
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, concurrency: 3 }),
		deps: {},
		recordRun: () => {},
	});
	assert.equal(processor.length, 3, "processor must declare (job, token, signal) or the abort dies");
});

test("the timeout fires cancelJob after timeoutMs", { skip }, async () => {
	let cancelled = null;
	const processor = mod.makeProcessor({
		cancelJob: (id, reason) => (cancelled = { id, reason }),
		stopContainer: () => {},
		redis: { async incr() { return 1; }, async expire() {} },
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, concurrency: 3 }),
		timeoutMs: 20,
		deps: {
			mintToken: async () => "t",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({}),
			// a real container exits when docker stop runs; mirror that -- reject on abort.
			runContainer: ({ signal }) =>
				new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true })),
			cleanup: async () => {},
			comment: async () => {},
		},
	});

	const ac = new AbortController();
	const job = { id: "j1", data: { kind: "github", repo: "o/r" } };
	const running = processor(job, "tok", ac.signal).catch(() => {});
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(cancelled?.id, "j1");
	assert.equal(cancelled?.reason, "job-timeout-30m");
	ac.abort(); // let the hung runContainer's abort path settle
	await running;
});

test("an abort stops the container", { skip }, async () => {
	let stopped = null;
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: (name) => (stopped = name),
		redis: { async incr() { return 1; }, async expire() {} },
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, concurrency: 3 }),
		timeoutMs: 100000,
		deps: {
			mintToken: async () => "t",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({}),
			runContainer: ({ signal }) =>
				new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true })),
			cleanup: async () => {},
			comment: async () => {},
		},
	});
	const ac = new AbortController();
	const running = processor({ id: "j2", data: { kind: "github", repo: "o/r" } }, "tok", ac.signal).catch(() => {});
	// Let the job reach the running container before aborting -- in reality the container has been
	// up for minutes when the 30-min timeout fires.
	await new Promise((r) => setTimeout(r, 10));
	ac.abort();
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(stopped, "pi-job-j2");
	await running;
});

test("shutdown closes each extraCloser after the worker drains", { skip }, async () => {
	// A cron scheduler (or any auxiliary resource) is handed to createWorker as an extraCloser so it
	// is torn down on SIGTERM/SIGINT alongside the worker. This proves close() runs during shutdown.
	const origExit = process.exit;
	const beforeTerm = new Set(process.listeners("SIGTERM"));
	const beforeInt = new Set(process.listeners("SIGINT"));
	let closed = false;
	let worker;
	try {
		process.exit = () => {}; // shutdown ends in process.exit(0); neutralise it for the test
		worker = mod.createWorker({
			connection: { host: "127.0.0.1", port: 1 },
			concurrency: 1,
			getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, concurrency: 3 }),
			redis: {},
			deps: {},
			extraClosers: [{ close: async () => { closed = true; } }],
		});
		worker.on("error", () => {}); // swallow the connection-refused error against the dead port
		const shutdown = process.listeners("SIGTERM").find((l) => !beforeTerm.has(l));
		assert.ok(shutdown, "createWorker must register a SIGTERM shutdown handler");
		await shutdown();
		assert.equal(closed, true, "extraCloser.close() must run during shutdown");
	} finally {
		process.exit = origExit;
		for (const l of process.listeners("SIGTERM")) if (!beforeTerm.has(l)) process.removeListener("SIGTERM", l);
		for (const l of process.listeners("SIGINT")) if (!beforeInt.has(l)) process.removeListener("SIGINT", l);
		await Promise.resolve(worker?.close()).catch(() => {});
	}
});

test("createWorker NAMES the BullMQ Worker when given one, and omits the option when not", { skip }, async () => {
	// Naming is what makes `getWorkers()` rows tell hosts apart -- bullmq appends `:w:<name>` to the client
	// name and `moveToActive` stamps `processedBy` onto each active job's hash. Conditional, so a bare
	// createWorker still builds a byte-identical options object.
	const base = {
		connection: { host: "127.0.0.1", port: 1 },
		concurrency: 1,
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, concurrency: 3 }),
		redis: {},
		deps: {},
	};
	const beforeTerm = new Set(process.listeners("SIGTERM"));
	const beforeInt = new Set(process.listeners("SIGINT"));
	let named;
	let unnamed;
	try {
		named = mod.createWorker({ ...base, name: "mac-mini-1" });
		named.on("error", () => {});
		assert.equal(named.opts.name, "mac-mini-1");

		unnamed = mod.createWorker(base);
		unnamed.on("error", () => {});
		assert.ok(!("name" in unnamed.opts), "no name given, no name key -- a single-host deployment's options are unchanged");
	} finally {
		for (const l of process.listeners("SIGTERM")) if (!beforeTerm.has(l)) process.removeListener("SIGTERM", l);
		for (const l of process.listeners("SIGINT")) if (!beforeInt.has(l)) process.removeListener("SIGINT", l);
		await Promise.resolve(named?.close()).catch(() => {});
		await Promise.resolve(unnamed?.close()).catch(() => {});
	}
});

// The full BullMQ job object the processor hands to recordRun -- id/attemptsMade/name/data are the
// fields buildRecord (start.mjs) reads, so recordRun must receive `job`, not `job.data`.
const fakeJob = () => ({ id: "j1", attemptsMade: 0, name: "github", data: { kind: "github", repo: "o/r", flow: "fix", target: { type: "issue", number: 1 } } });
const isoRoundtrips = (s) => typeof s === "string" && new Date(s).toISOString() === s;

test("recordRun fires once on the SUCCESS (return) path with { job, result, startedAt, endedAt }", { skip }, async () => {
	const calls = [];
	const job = fakeJob();
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis: { async incr() { return 1; }, async expire() {} },
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, concurrency: 3 }),
		timeoutMs: 100000,
		recordRun: (rec) => calls.push(rec),
		deps: {
			mintToken: async () => "t",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({}),
			runContainer: async () => ({ code: 0, aborted: false, turns: 3 }),
			cleanup: async () => {},
			comment: async () => {},
		},
	});

	const result = await processor(job, "tok", new AbortController().signal);

	assert.equal(calls.length, 1, "recordRun must fire exactly once");
	const rec = calls[0];
	assert.equal(rec.job, job, "recordRun receives the FULL job object, not job.data");
	assert.equal(rec.result, result, "recordRun.result is the runJob return value");
	assert.equal(rec.result.outcome, "completed");
	assert.equal(rec.error, undefined, "no error on the success path");
	assert.ok(isoRoundtrips(rec.startedAt), "startedAt is an ISO string");
	assert.ok(isoRoundtrips(rec.endedAt), "endedAt is an ISO string");
});

test("recordRun fires with { job, error } BEFORE an UnrecoverableError propagates (non-infra throw)", { skip }, async () => {
	const calls = [];
	const job = fakeJob();
	const boom = new Error("container boom");
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis: { async incr() { return 1; }, async expire() {} },
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, concurrency: 3 }),
		timeoutMs: 100000,
		recordRun: (rec) => calls.push(rec),
		deps: {
			mintToken: async () => "t",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({}),
			runContainer: async () => { throw boom; },
			cleanup: async () => {},
			comment: async () => {},
		},
	});

	await assert.rejects(
		() => processor(job, "tok", new AbortController().signal),
		(e) => e.name === "UnrecoverableError",
		"a non-infra throw must surface as UnrecoverableError (no retry)",
	);
	assert.equal(calls.length, 1, "recordRun must fire before the throw propagates");
	const rec = calls[0];
	assert.equal(rec.job, job);
	assert.equal(rec.error, boom, "recordRun.error is the original thrown error, pre-wrap");
	assert.equal(rec.result, undefined, "no result on the throw path");
	assert.ok(isoRoundtrips(rec.startedAt) && isoRoundtrips(rec.endedAt), "both timestamps are ISO strings");
});

test("recordRun fires and the InfraRetry still propagates (retryable, not UnrecoverableError)", { skip }, async () => {
	const calls = [];
	const job = fakeJob();
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis: { async incr() { return 1; }, async expire() {}, async decr() {} },
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, concurrency: 3 }),
		timeoutMs: 100000,
		recordRun: (rec) => calls.push(rec),
		deps: {
			mintToken: async () => "t",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({}),
			// exit 1 => runJob throws InfraRetry; the processor must rethrow it unwrapped so BullMQ retries.
			runContainer: async () => ({ code: 1, aborted: false, turns: 2 }),
			cleanup: async () => {},
			comment: async () => {},
		},
	});

	await assert.rejects(
		() => processor(job, "tok", new AbortController().signal),
		(e) => e instanceof InfraRetry,
		"an InfraRetry must propagate unwrapped (retryable), never become UnrecoverableError",
	);
	assert.equal(calls.length, 1, "recordRun must fire on the infra-retry path too");
	assert.equal(calls[0].job, job);
	assert.ok(calls[0].error instanceof InfraRetry, "recordRun.error is the InfraRetry");
});

test("collectChain receives the REAL BullMQ job (id + data), not runJob's effectiveJob", { skip }, async () => {
	// runJob's own `job` is the effectiveJob (a spread of job.data, no `.id`/`.data`). collectChain
	// (outbox.mjs) needs the parent's real `.id` and `.data.kind`/`.data.chainDepth`, so makeProcessor must
	// inject the real wrapper -- mirroring the name/signal injection into runContainer. This locks that.
	let received;
	const job = { id: "local-parent-1", attemptsMade: 0, name: "local", data: { kind: "local", folder: "/p", chainDepth: 1 } };
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis: { async incr() { return 1; }, async expire() {} },
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, concurrency: 3 }),
		timeoutMs: 100000,
		deps: {
			mintToken: async () => "t",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ jobDir: "/j", workspace: "/p", outboxDir: "/j/outbox", sha: "s" }),
			runContainer: async () => ({ code: 0, aborted: false, turns: 1 }),
			collectChain: async (ctx) => {
				received = ctx;
				return { enqueued: 1, refused: 0 };
			},
			cleanup: async () => {},
			comment: async () => {},
		},
	});

	const result = await processor(job, "tok", new AbortController().signal);

	assert.equal(result.outcome, "completed");
	assert.equal(result.chainEnqueued, 1, "the completed result carries collectChain's enqueued count");
	assert.equal(received.job, job, "collectChain must receive the FULL BullMQ job (with .id/.data), not the effectiveJob");
	assert.equal(received.job.id, "local-parent-1");
	assert.equal(received.job.data.kind, "local");
	assert.equal(received.prepared.outboxDir, "/j/outbox", "prepared threads through to collectChain");
});

test("prepareWorkspace receives (effectiveJob, token, { queueJobId: <real BullMQ job id> })", { skip }, async () => {
	// runJob's own `job` is the effectiveJob (a spread of job.data, no `.id`). prepare needs the real
	// wrapper's id to derive a cron job's scheduled-for instant from the deterministic
	// repeat:<id>:<millis> jobId (DES-CRON-VIA-BULLMQ-SCHEDULER), so makeProcessor must inject it as
	// `queueJobId` -- mirroring the collectChain injection above. This locks that.
	let received;
	const job = {
		id: "repeat:t:1758868620000",
		attemptsMade: 0,
		name: "local",
		data: { kind: "local", folder: "/p", trigger: { id: "t", pattern: "0 3 * * *" } },
	};
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis: { async incr() { return 1; }, async expire() {} },
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, concurrency: 3 }),
		timeoutMs: 100000,
		deps: {
			mintToken: async () => "t",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async (j, t, opts) => {
				received = { job: j, token: t, opts };
				return { jobDir: "/j", workspace: "/p", sha: "s" };
			},
			runContainer: async () => ({ code: 0, aborted: false, turns: 1 }),
			cleanup: async () => {},
			comment: async () => {},
		},
	});

	const result = await processor(job, "tok", new AbortController().signal);

	assert.equal(result.outcome, "completed");
	assert.deepEqual(received.opts, { queueJobId: "repeat:t:1758868620000" }, "the real wrapper's id reaches prepare as queueJobId");
	assert.notEqual(received.job, job, "prepare receives the effectiveJob (a spread of job.data), not the raw wrapper");
	assert.equal(received.job.kind, "local");
	assert.deepEqual(received.job.trigger, { id: "t", pattern: "0 3 * * *" }, "the cron-only trigger data field rides the effectiveJob");
	assert.equal(received.token, null, "an unflagged local job stays tokenless");
});

test("checkOnceSpent receives (effectiveJob, { queueJobId: <real BullMQ job id> })", { skip }, async () => {
	// runJob's own `job` is the effectiveJob (a spread of job.data, no `.id`), and the one-shot check
	// needs the REAL wrapper's id to excuse this delivery's own earlier attempt -- without it, attempt
	// two of the delivery that spent the trigger reads its own mark as foreign and attempts:2 silently
	// becomes attempts:1. makeProcessor must inject it, mirroring prepareWorkspace's queueJobId
	// injection above. This locks that.
	let received;
	const job = {
		id: "gh-42-1699999",
		attemptsMade: 1,
		name: "github",
		data: { kind: "github", repo: "o/r", flow: "deploy", target: { type: "issue", number: 40 }, trigger: { matched: { index: 1, type: "issue", action: "closed", number: 40, once: true } } },
	};
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis: { async incr() { return 1; }, async expire() {} },
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, concurrency: 3 }),
		timeoutMs: 100000,
		deps: {
			checkOnceSpent: async (j, opts) => {
				received = { job: j, opts };
				return { ok: true };
			},
			mintToken: async () => "t",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({}),
			runContainer: async () => ({ code: 0, aborted: false, turns: 1 }),
			cleanup: async () => {},
			comment: async () => {},
		},
	});

	const result = await processor(job, "tok", new AbortController().signal);

	assert.equal(result.outcome, "completed");
	assert.deepEqual(received.opts, { queueJobId: "gh-42-1699999" }, "the real wrapper's id reaches the check as queueJobId");
	assert.notEqual(received.job, job, "the check receives the effectiveJob (a spread of job.data), not the raw wrapper");
	assert.equal(received.job.kind, "github");
	assert.equal(received.job.trigger.matched.once, true, "the matched one-shot facts ride the effectiveJob");
	assert.equal(received.job.id, undefined, "the effectiveJob has no id of its own -- that is why the injection exists");
});

// End-to-end money-path acceptance: compose the REAL recordRun = writeRecord(buildRecord(...)) over a
// fake fs and drive makeProcessor per outcome, asserting the SERIALIZED bytes. This is the only place
// the whole record path (processor wrapper -> buildRecord -> writeRecord) is exercised end-to-end, so
// it is where "the record path never breaks the retry contract" is actually proven, not asserted piece
// by piece. writeThrows models a real ENOSPC/EACCES from writeFileSync so (c)/(c2) exercise the
// never-throw writer THROUGH makeProcessor, not a stub of it.
function makeRealRecordRun({ writeThrows = false } = {}) {
	const writes = [];
	const fakeFs = {
		mkdirSync: () => {},
		writeFileSync: (path, data) => {
			if (writeThrows) throw new Error("ENOSPC");
			writes.push({ path, data });
		},
	};
	const writeRecord = makeRecordWriter({ logsDir: "/logs", fs: fakeFs, log: () => {} });
	const recordRun = (a) => writeRecord(buildRecord(a));
	return { recordRun, writes };
}

// The full BullMQ job wrapper carrying user-authored PII (title/body) the record must never serialise.
// trigger.matched rides along so (a) can prove the attribution SPLIT end-to-end: index/type persist,
// the collaborator-applied label never does (INT-RUN-HISTORY-FILE-CONTRACT, issue #54).
const secretJob = (id = "j1") => ({
	id,
	attemptsMade: 0,
	name: "github",
	data: {
		kind: "github",
		repo: "o/r",
		flow: "fix",
		target: { type: "issue", number: 1, title: "SECRET_T", body: "SECRET_B" },
		trigger: { kind: "issues", matched: { index: 0, type: "label", label: "SECRET_LABEL" } },
	},
});

// A processor wired to the real recordRun. `runContainer`/`redis` are overridable so the infra-exit
// paths (b)/(c2) reuse the same construction with a different container exit.
function realRecordProcessor(recordRun, { runContainer, redis } = {}) {
	return mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis: redis ?? { async incr() { return 1; }, async expire() {}, async decr() {} },
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, concurrency: 3 }),
		timeoutMs: 100000,
		recordRun,
		deps: {
			mintToken: async () => "t",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({}),
			runContainer: runContainer ?? (async () => ({ code: 0, aborted: false, turns: 3 })),
			cleanup: async () => {},
			comment: async () => {},
			log: () => {},
		},
	});
}

test("(a) completed run: real writer serialises a PII-free record to <jobId>.json", { skip }, async () => {
	const { recordRun, writes } = makeRealRecordRun();
	const job = secretJob("j1");
	const processor = realRecordProcessor(recordRun);

	await processor(job, "tok", new AbortController().signal);

	assert.equal(writes.length, 1, "exactly one record is written on the success path");
	assert.equal(writes[0].path, join("/logs", "j1.json"), "path is the sanitized <jobId>.json under logsDir");
	const rec = JSON.parse(writes[0].data);
	assert.equal(rec.outcome, "completed");
	assert.equal(rec.target, "o/r#1", "GitHub target is repo#issue, never the payload text");
	assert.equal(rec.exitCode, 0);
	assert.equal(rec.turns, 3);
	assert.equal(rec.budgetReserved, true);
	// The usage-ledger trio (INT-RUN-HISTORY-FILE-CONTRACT) rides the serialized bytes end-to-end:
	// provider/model are the HOST-effective values the overlay fill resolved (here the settings, since
	// the job data names none), and usage is null-defaulted -- this container reported no ledger, and
	// null-with-the-key-present is the contract's normal case, not an error.
	assert.equal("usage" in rec && "provider" in rec && "model" in rec, true, "the record carries all three additive keys");
	assert.equal(rec.provider, "anthropic", "provider is the overlay-resolved host fact, never a container string");
	assert.equal(rec.model, "m");
	assert.equal(rec.usage, null);
	// Trigger attribution rides the serialized bytes end-to-end, split exactly as the contract says:
	// the integer and the enum persist, the collaborator-applied label does not.
	assert.equal(rec.triggerIndex, 0, "matched.index persists, and index 0 is 0, never null");
	assert.equal(rec.triggerType, "label");
	// buildRecord reads only stable non-PII fields, so the serialized bytes carry neither title nor body.
	assert.equal(writes[0].data.includes("SECRET_T"), false, "issue title must not leak into the record bytes");
	assert.equal(writes[0].data.includes("SECRET_B"), false, "issue body must not leak into the record bytes");
	assert.equal(writes[0].data.includes("SECRET_LABEL"), false, "the matched label must not leak into the record bytes");
});

test("(b) infra exit 1: a failed record is written on the catch path BEFORE InfraRetry rethrows", { skip }, async () => {
	const { recordRun, writes } = makeRealRecordRun();
	const job = secretJob("j1");
	const processor = realRecordProcessor(recordRun, { runContainer: async () => ({ code: 1, aborted: false, turns: 2 }) });

	await assert.rejects(
		() => processor(job, "tok", new AbortController().signal),
		(e) => e.name === "InfraRetry",
		"exit 1 must surface as the retryable InfraRetry",
	);
	assert.equal(writes.length, 1, "the record is written before the rethrow");
	const rec = JSON.parse(writes[0].data);
	assert.equal(rec.outcome, "failed", "the error path records outcome=failed");
	assert.equal(rec.exitCode, 1);
});

test("(c) try-path writer failure NEVER converts a completed run into a failure/retry", { skip }, async () => {
	const { recordRun, writes } = makeRealRecordRun({ writeThrows: true });
	const job = secretJob("j1");
	const processor = realRecordProcessor(recordRun);

	// A throwing writer on the success path must be swallowed by writeRecord: no throw, no
	// UnrecoverableError, and the processor resolves to the same completed result a healthy run yields.
	const result = await processor(job, "tok", new AbortController().signal);

	assert.equal(result.outcome, "completed");
	assert.equal(result.exitCode, 0);
	assert.equal(result.turns, 3);
	assert.equal(result.budgetReserved, true);
	assert.equal(writes.length, 0, "the throwing writer recorded nothing");
});

test("(c2) catch-path writer failure still propagates the retryable InfraRetry unswallowed", { skip }, async () => {
	const { recordRun, writes } = makeRealRecordRun({ writeThrows: true });
	const job = secretJob("j1");
	const processor = realRecordProcessor(recordRun, { runContainer: async () => ({ code: 1, aborted: false, turns: 2 }) });

	await assert.rejects(
		() => processor(job, "tok", new AbortController().signal),
		(e) => e.name === "InfraRetry",
		"a writer failure on the catch path must not swallow the retryable error",
	);
	assert.equal(writes.length, 0, "the throwing writer recorded nothing");
});

test("(d) a colon-bearing scheduled id sanitizes in the filename but stays raw in the body", { skip }, async () => {
	const { recordRun, writes } = makeRealRecordRun();
	const job = secretJob("repeat:sched:123");
	const processor = realRecordProcessor(recordRun);

	await processor(job, "tok", new AbortController().signal);

	assert.equal(writes[0].path, join("/logs", "repeat_sched_123.json"), "colon (illegal on NTFS) collapses to _ in the filename");
	assert.equal(JSON.parse(writes[0].data).jobId, "repeat:sched:123", "the record body keeps the raw id");
});

test("(e) a burst of distinct ids writes one distinct file each through the same writer", { skip }, async () => {
	const { recordRun, writes } = makeRealRecordRun();
	const processor = realRecordProcessor(recordRun);

	for (const id of ["j1", "j2", "j3"]) {
		await processor(secretJob(id), "tok", new AbortController().signal);
	}

	assert.equal(writes.length, 3, "one record per job, none dropped or collided");
	const paths = writes.map((w) => w.path);
	assert.equal(new Set(paths).size, 3, "the three paths are distinct");
	assert.ok(paths.includes(join("/logs", "j1.json")));
	assert.ok(paths.includes(join("/logs", "j2.json")));
	assert.ok(paths.includes(join("/logs", "j3.json")));
});
