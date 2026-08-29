import assert from "node:assert/strict";
import { test } from "node:test";
import { makeInFlight, parseScopedLimits } from "../src/scoped-limits.mjs";

// index.mjs imports bullmq; skip below the node floor / without deps, hard-fail in CI (mirrors pause-gate).
let mod;
let importError;
try {
	mod = await import("../src/index.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`scope-mutex tests are REQUIRED here but bullmq could not import.\n${importError}`);
}
const skip = mod ? false : `bullmq not installed (node ${process.version} < 22.19.0); CI runs these`;

const NOW = Date.UTC(2026, 7, 29, 12, 0);
const limitsOf = (rows) => parseScopedLimits(JSON.stringify({ version: 1, limits: rows }), "sl.json");

// A redis whose incr spies reserveBudget: incrCalls MUST stay 0 on every defer path.
function fakeRedis() {
	const redis = { incrCalls: 0 };
	redis.incr = async () => (redis.incrCalls++, 1);
	redis.decr = async () => 0;
	redis.expire = async () => {};
	return redis;
}

// A BullMQ-shaped job whose moveToDelayed records the (timestamp, token) it was deferred with.
function spyJob(id, data) {
	const moves = [];
	return {
		job: { id, attemptsMade: 0, name: data.kind, data, moveToDelayed: async (ts, tok) => moves.push({ ts, tok }) },
		moves,
	};
}

/**
 * The pause-gate harness plus a HOLD-OPEN container: each run parks on a promise until the test
 * releases it, so a test can pin what happens while a scope is genuinely held -- the committed form
 * of the demonstration that measured 301ms of live same-folder container overlap on main before this
 * gate existed.
 */
function harness({ limits = [], inFlight = makeInFlight(), pauseUntil = () => null, redis = fakeRedis() } = {}) {
	const seen = { started: 0, records: [], logs: [] };
	const releases = [];
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis,
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
		applyConcurrency: () => {},
		pauseUntil,
		scopedLimits: () => limits,
		inFlight,
		now: () => NOW,
		recordRun: (r) => seen.records.push(r),
		timeoutMs: 100000,
		deps: {
			mintToken: async () => "tok",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			runContainer: async () => {
				seen.started++;
				await new Promise((resolve) => releases.push(resolve));
				return { code: 0, aborted: false, turns: 3 };
			},
			cleanup: async () => {},
			comment: async () => {},
			log: (event, fields) => seen.logs.push({ event, fields }),
		},
	});
	const releaseNext = () => releases.shift()?.();
	const untilStarted = async (n) => {
		while (seen.started < n) await new Promise((r) => setImmediate(r));
	};
	return { processor, seen, redis, inFlight, releaseNext, untilStarted };
}

const localJob = (id, folder) => spyJob(id, { kind: "local", folder, flow: "tidy", task: "t" });
const ghJob = (id, repo) => spyJob(id, { kind: "github", repo, target: { number: 1 }, flow: "fix", trigger: { deliveryId: id, sender: { id: 1 } } });

test("the folder mutex: a second same-folder local job defers while the first holds -- the 301ms overlap, inverted into an assertion", { skip }, async () => {
	const h = harness();
	const a = localJob("j-1", "/srv/site");
	const b = localJob("j-2", "/srv/site");

	const first = h.processor(a.job, "tok-a", new AbortController().signal);
	await h.untilStarted(1); // the first container is genuinely RUNNING (held open), not merely enqueued

	await assert.rejects(() => h.processor(b.job, "tok-b", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal(b.moves.length, 1, "moveToDelayed exactly once");
	assert.equal(b.moves[0].ts, NOW + mod.SCOPE_BUSY_RECHECK_MS, "deferred to the fixed re-check instant");
	assert.equal(b.moves[0].tok, "tok-b", "with the worker's token");
	assert.equal(h.seen.started, 1, "the second container NEVER started while the first held the folder");
	assert.equal(h.redis.incrCalls, 1, "only the first job reserved budget -- the defer path spends nothing");
	assert.equal(h.seen.records.length, 0, "a deferral writes NO record (and the held job has not completed yet)");
	const deferred = h.seen.logs.find((l) => l.event === "scope_busy_deferred");
	assert.deepEqual(deferred.fields, { jobId: "j-2", kind: "local", delayMs: mod.SCOPE_BUSY_RECHECK_MS });
	assert.ok(!JSON.stringify(deferred.fields).includes("/srv/site"), "the raw folder path stays out of the log");

	h.releaseNext();
	const result = await first;
	assert.equal(result.outcome, "completed");
	assert.equal(h.seen.records.length, 1, "exactly the completed job recorded; the deferral never did");
	assert.equal(h.inFlight.count("/srv/site"), 0, "the finally released the folder");

	// A third same-folder job (the shape a chained child arrives in: enqueued before the parent's
	// finally released) now acquires cleanly -- one re-check is the whole penalty.
	const c = localJob("j-3", "/srv/site");
	const third = h.processor(c.job, "tok-c", new AbortController().signal);
	await h.untilStarted(2);
	h.releaseNext();
	assert.equal((await third).outcome, "completed");
});

test("the mutex holds across folder spellings: /srv/site held, /srv/site/ defers (canonicalScope collapses them)", { skip }, async () => {
	const h = harness();
	const a = localJob("j-1", "/srv/site");
	const b = localJob("j-2", "/srv/site/");
	const first = h.processor(a.job, "tok", new AbortController().signal);
	await h.untilStarted(1);
	await assert.rejects(() => h.processor(b.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal(h.seen.started, 1);
	h.releaseNext();
	await first;
});

test("the mutex is unconditional: no limits wired at all (makeProcessor defaults) still serializes a folder", { skip }, async () => {
	// No scopedLimits, no inFlight passed -- the defaults ARE the mutex; config cannot be required for it.
	const seen = { started: 0 };
	const releases = [];
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis: fakeRedis(),
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
		recordRun: () => {},
		timeoutMs: 100000,
		now: () => NOW,
		deps: {
			mintToken: async () => "tok",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			runContainer: async () => {
				seen.started++;
				await new Promise((resolve) => releases.push(resolve));
				return { code: 0, aborted: false, turns: 3 };
			},
			cleanup: async () => {},
			comment: async () => {},
			log: () => {},
		},
	});
	const a = localJob("j-1", "/srv/site");
	const b = localJob("j-2", "/srv/site");
	const first = processor(a.job, "tok", new AbortController().signal);
	while (seen.started < 1) await new Promise((r) => setImmediate(r));
	await assert.rejects(() => processor(b.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal(seen.started, 1);
	releases.shift()();
	await first;
});

test("a configured concurrent: 5 on a folder scope still serializes local jobs (min clamps, no off-switch)", { skip }, async () => {
	const h = harness({ limits: limitsOf([{ scope: "/srv/site", concurrent: 5 }]) });
	const a = localJob("j-1", "/srv/site");
	const b = localJob("j-2", "/srv/site");
	const first = h.processor(a.job, "tok", new AbortController().signal);
	await h.untilStarted(1);
	await assert.rejects(() => h.processor(b.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	h.releaseNext();
	await first;
});

test("different folders run concurrently -- the mutex is per scope, not global", { skip }, async () => {
	const h = harness();
	const a = localJob("j-1", "/srv/site");
	const b = localJob("j-2", "/srv/other");
	const first = h.processor(a.job, "tok", new AbortController().signal);
	await h.untilStarted(1);
	const second = h.processor(b.job, "tok", new AbortController().signal);
	await h.untilStarted(2); // both containers live at once
	h.releaseNext();
	h.releaseNext();
	assert.equal((await first).outcome, "completed");
	assert.equal((await second).outcome, "completed");
});

test("forge scope concurrent: 2 admits two and defers the third; an unlisted forge scope admits freely", { skip }, async () => {
	const h = harness({ limits: limitsOf([{ scope: "acme/web", concurrent: 2 }]) });
	const first = h.processor(ghJob("g-1", "acme/web").job, "tok", new AbortController().signal);
	const second = h.processor(ghJob("g-2", "acme/web").job, "tok", new AbortController().signal);
	await h.untilStarted(2);
	const c = ghJob("g-3", "acme/web");
	await assert.rejects(() => h.processor(c.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal(h.seen.started, 2);
	// A different repo with no row is unlimited: it starts while both slots above are held.
	const other = h.processor(ghJob("g-4", "acme/other").job, "tok", new AbortController().signal);
	await h.untilStarted(3);
	h.releaseNext();
	h.releaseNext();
	h.releaseNext();
	await Promise.all([first, second, other]);
});

test("release-exactly-once: completion, infra throw, overlay-invalid return and worker-abort each free the scope for the next acquire", { skip }, async () => {
	// completion
	{
		const h = harness();
		const p = h.processor(localJob("j-1", "/f").job, "tok", new AbortController().signal);
		await h.untilStarted(1);
		h.releaseNext();
		await p;
		assert.equal(h.inFlight.count("/f"), 0);
	}
	// infra throw (docker exit 125 => container-never-started InfraRetry)
	{
		const inFlight = makeInFlight();
		const processor = mod.makeProcessor({
			cancelJob: () => {}, stopContainer: () => {}, redis: fakeRedis(),
			getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
			inFlight, now: () => NOW, recordRun: () => {}, timeoutMs: 100000,
			deps: { mintToken: async () => "tok", isDefaultBranchProtected: async () => true, prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }), runContainer: async () => ({ code: 125, aborted: false }), cleanup: async () => {}, comment: async () => {}, log: () => {} },
		});
		await assert.rejects(() => processor(localJob("j-1", "/f").job, "tok", new AbortController().signal), (e) => e.name !== "DelayedError");
		assert.equal(inFlight.count("/f"), 0, "the finally released on the throw path");
		assert.equal(inFlight.tryAcquire("/f", 1), true, "the folder is acquirable again");
	}
	// overlay-invalid policy return (refused before runJob, still released)
	{
		const inFlight = makeInFlight();
		const processor = mod.makeProcessor({
			cancelJob: () => {}, stopContainer: () => {}, redis: fakeRedis(),
			getSettings: () => ({ invalid: "boom" }),
			inFlight, now: () => NOW, recordRun: () => {}, timeoutMs: 100000,
			deps: { log: () => {} },
		});
		const result = await processor(localJob("j-1", "/f").job, "tok", new AbortController().signal);
		assert.equal(result.reason, "settings-overlay-invalid");
		assert.equal(inFlight.count("/f"), 0);
	}
	// worker-abort (container reports aborted)
	{
		const inFlight = makeInFlight();
		const processor = mod.makeProcessor({
			cancelJob: () => {}, stopContainer: () => {}, redis: fakeRedis(),
			getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
			inFlight, now: () => NOW, recordRun: () => {}, timeoutMs: 100000,
			deps: { mintToken: async () => "tok", isDefaultBranchProtected: async () => true, prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }), runContainer: async () => ({ code: 0, aborted: true }), cleanup: async () => {}, comment: async () => {}, log: () => {} },
		});
		const result = await processor(localJob("j-1", "/f").job, "tok", new AbortController().signal);
		assert.equal(result.reason, "worker-abort");
		assert.equal(inFlight.count("/f"), 0);
	}
});

test("a log-less wiring (deps: {}) defers without a TypeError -- the log call is optional-chained", { skip }, async () => {
	const inFlight = makeInFlight();
	inFlight.tryAcquire("/f", 1); // pre-hold the folder so the gate defers immediately
	const processor = mod.makeProcessor({
		cancelJob: () => {}, stopContainer: () => {}, redis: fakeRedis(),
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
		inFlight, now: () => NOW, recordRun: () => {}, timeoutMs: 100000,
		deps: {},
	});
	await assert.rejects(() => processor(localJob("j-1", "/f").job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
});

test("a scopeless job acquires nothing and releases nothing -- no phantom key, no release(undefined)", { skip }, async () => {
	const calls = { tryAcquire: 0, release: 0 };
	const inFlight = {
		tryAcquire: () => (calls.tryAcquire++, true),
		release: () => calls.release++,
		count: () => 0,
	};
	const processor = mod.makeProcessor({
		cancelJob: () => {}, stopContainer: () => {}, redis: fakeRedis(),
		getSettings: () => ({ invalid: "short-circuit" }), // shortest terminal path; the gate runs before it
		inFlight, now: () => NOW, recordRun: () => {}, timeoutMs: 100000,
		deps: { log: () => {} },
	});
	await processor(spyJob("j-1", { kind: "github" }).job, "tok", new AbortController().signal); // no repo => no scope
	assert.deepEqual(calls, { tryAcquire: 0, release: 0 });
});

test("a throw between the acquire and the main try releases the hold (the setup guard is structural)", { skip }, async () => {
	const inFlight = makeInFlight();
	const processor = mod.makeProcessor({
		cancelJob: () => {}, stopContainer: () => {}, redis: fakeRedis(),
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
		inFlight, now: () => NOW, recordRun: () => {}, timeoutMs: 100000,
		deps: { log: () => {} },
	});
	// Nothing in that window can throw today; force the one injectable seam (the abort listener) to
	// prove the guard, not the weather.
	const boomSignal = { addEventListener: () => { throw new Error("boom-in-setup"); }, removeEventListener: () => {} };
	await assert.rejects(() => processor(localJob("j-1", "/f").job, "tok", boomSignal), /boom-in-setup/);
	assert.equal(inFlight.count("/f"), 0, "the setup guard released the hold");
	assert.equal(inFlight.tryAcquire("/f", 1), true, "the folder is acquirable, not wedged until restart");
});

test("pause outranks busy: a paused job defers to the WINDOW END and never touches the in-flight map", { skip }, async () => {
	const inFlight = makeInFlight();
	inFlight.tryAcquire("/srv/site", 1); // the folder is ALSO busy; pause must still win
	const windowEnd = NOW + 3_600_000;
	const h = harness({ inFlight, pauseUntil: () => windowEnd });
	const a = localJob("j-1", "/srv/site");
	await assert.rejects(() => h.processor(a.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal(a.moves[0].ts, windowEnd, "deferred to the window end, not the 5s re-check");
	assert.equal(inFlight.count("/srv/site"), 1, "the pause path acquired nothing (count is the pre-hold only)");
});

test("a completed default-wired run's record keeps the pre-#242 shape -- no new fields ride the record", { skip }, async () => {
	const h = harness();
	const p = h.processor(localJob("j-1", "/f").job, "tok", new AbortController().signal);
	await h.untilStarted(1);
	h.releaseNext();
	await p;
	const { result } = h.seen.records[0];
	assert.deepEqual(
		Object.keys(result).sort(),
		["budgetReserved", "chainEnqueued", "chainRefused", "exitCode", "model", "outcome", "provider", "session", "tokens", "turns", "usage"],
		"the completed result's field set is byte-identical to before the gate existed",
	);
});

test("the limits snapshot is read ONCE per pickup, shared by gate and ledger -- a mid-job reload cannot split them", { skip }, async () => {
	// A reload landing between two reads would let the gate charge a scope the ledger never bills (or
	// vice versa). The stub returns the rows exactly once, then []: if the wiring re-read, budgetCapsFor
	// would see [] and the scoped budget key would silently never land.
	const limits = limitsOf([{ scope: "acme/web", day: 5 }]);
	let reads = 0;
	const keys = new Set();
	const redis = {
		incr: async (k) => (keys.add(k), 1),
		decr: async () => 0,
		expire: async () => {},
		get: async () => null,
	};
	const processor = mod.makeProcessor({
		cancelJob: () => {}, stopContainer: () => {}, redis,
		getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null }),
		scopedLimits: () => (reads++ === 0 ? limits : []),
		now: () => NOW, recordRun: () => {}, timeoutMs: 100000,
		deps: { mintToken: async () => "tok", isDefaultBranchProtected: async () => true, prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }), runContainer: async () => ({ code: 0, aborted: false, turns: 1 }), cleanup: async () => {}, comment: async () => {}, log: () => {} },
	});
	const r = await processor(ghJob("g-1", "acme/web").job, "tok", new AbortController().signal);
	assert.equal(r.outcome, "completed");
	assert.equal(reads, 1, "one snapshot per pickup");
	assert.ok([...keys].some((k) => k.startsWith("budget:s:")), "the scoped budget key landed from the SAME snapshot the gate used");
});
