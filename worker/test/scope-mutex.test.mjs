import assert from "node:assert/strict";
import { test } from "node:test";
import { RELEASE_IF_MINE, endpointSlotKey, hash16, makeFleetLease, scopeSlotKey } from "../src/fleet-lease.mjs";
import { makeInFlight, parseScopedLimits, scopeClaimRows } from "../src/scoped-limits.mjs";
import { deferRecordOf, withDeferRecords } from "./helpers/defer-redis.mjs";

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
const SETTINGS = () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null });
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
function harness({ limits = [], inFlight = makeInFlight(), pauseUntil = () => null, redis = fakeRedis(), hostBound = null, getSettings = SETTINGS, extra = {}, extraDeps = {}, onContainer = () => {} } = {}) {
	const seen = { started: 0, records: [], logs: [] };
	const releases = [];
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis,
		getSettings,
		applyConcurrency: () => {},
		pauseUntil,
		scopedLimits: () => limits,
		inFlight,
		hostBound,
		now: () => NOW,
		recordRun: (r) => seen.records.push(r),
		timeoutMs: 100000,
		deps: {
			mintToken: async () => "tok",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			runContainer: async (ctx) => {
				seen.started++;
				onContainer(ctx);
				await new Promise((resolve) => releases.push(resolve));
				return { code: 0, aborted: false, turns: 3 };
			},
			cleanup: async () => {},
			comment: async () => {},
			log: (event, fields) => seen.logs.push({ event, fields }),
			...extraDeps,
		},
		...extra,
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
	assert.equal(b.moves[0].ts, NOW + mod.SCOPE_BUSY_RECHECK_MS, "deferred to the first re-check instant");
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
	// Nothing in that window throws past its own guards today; force one injectable seam (the abort listener) to
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

// --- the host-wide bound (issue #57) -------------------------------------------------------------------

test("PI_CONCURRENCY bounds the HOST, not each queue: a second job defers and the slot comes back", { skip }, async () => {
	// A worker that drains a host-affine queue as well as the shared one runs two BullMQ Workers, and
	// BullMQ's concurrency is per Worker -- so two at 3 would run six containers and break the RAM and
	// provider-throttle reasoning DES-CONCURRENCY-3 rests on. This semaphore restores the bound as a
	// property of the MACHINE.
	const hostSlots = makeInFlight();
	const h = harness({ hostBound: { slots: hostSlots, limit: () => 1 } });

	const a = ghJob("gh-1", "o/a");
	const first = h.processor(a.job, "tok-a", new AbortController().signal);
	await h.untilStarted(1);
	assert.equal(hostSlots.count(mod.HOST_SLOT_KEY), 1);

	// A DIFFERENT repo, so neither the folder mutex nor any scoped ceiling can be what stops it. Only the
	// machine-wide bound can, which is what makes this a test of that bound rather than of them.
	const b = ghJob("gh-2", "o/b");
	const reservedBefore = h.redis.incrCalls; // the FIRST job already reserved; only the delta is this job's
	await assert.rejects(() => h.processor(b.job, "tok-b", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal(b.moves[0].ts, NOW + mod.SCOPE_BUSY_RECHECK_MS, "deferred, never refused: a full host is transient state");
	assert.ok(h.seen.logs.some((l) => l.event === "host_busy_deferred"));
	assert.equal(h.redis.incrCalls, reservedBefore, "and the deferred job reserved nothing");
	assert.equal(hostSlots.count(mod.HOST_SLOT_KEY), 1, "the deferral gave its OWN slot back -- release is not idempotent");

	h.releaseNext();
	await first;
	assert.equal(hostSlots.count(mod.HOST_SLOT_KEY), 0, "and the finished job releases too");
});

test("with no host queue there is no host bound, and the gate is the one it always was", { skip }, async () => {
	const h = harness(); // hostBound: null
	const a = ghJob("gh-1", "o/a");
	const p = h.processor(a.job, "tok-a", new AbortController().signal);
	await h.untilStarted(1);
	assert.ok(!h.seen.logs.some((l) => l.event === "host_busy_deferred"), "a single-host deployment never reaches the acquire");
	h.releaseNext();
	await p;
});

// --- model endpoint slots (issue #503) ------------------------------------------------------------------

// A Valkey with real SET NX semantics for the leases, and a log of every command: "no endpoints declared"
// is a claim about commands NOT sent, so the spy is the evidence.
function leaseRedis({ fail = false } = {}) {
	const store = new Map();
	const calls = [];
	const guard = (op, key) => {
		calls.push([op, key]);
		if (fail) throw new Error("ECONNREFUSED");
	};
	return {
		store,
		calls,
		async set(key, value, _px, _ms, nx) {
			guard("set", key);
			if (nx === "NX" && store.has(key)) return null;
			store.set(key, value);
			return "OK";
		},
		async get(key) {
			guard("get", key);
			return store.get(key) ?? null;
		},
		async del(key) {
			guard("del", key);
			store.delete(key);
		},
		async eval(script, _n, key, arg) {
			guard("eval", key);
			const v = store.get(key);
			if (!(script === RELEASE_IF_MINE ? v === arg : typeof v === "string" && v.startsWith(arg))) return 0;
			store.delete(key);
			return 1;
		},
	};
}

const OLLAMA = { id: "lan-ollama", host: "gpu.lan", port: 11434, slots: 1, keyless: true };
const OVERLAY = { providers: { "local-ollama": { api: "openai-completions", baseUrl: "http://gpu.lan:11434/v1", models: [{ id: "qwen" }] } } };
const LOCAL_MODEL = () => ({ ...SETTINGS(), provider: "local-ollama", model: "qwen" });
const keyOf = (id, i = 0) => endpointSlotKey(hash16(id), i);
const flush = () => new Promise((r) => setImmediate(r));

// The endpoint seams makeProcessor takes, over one lease store a test can read. `holder` stands for the host name.
function endpointWiring({ endpoints = [OLLAMA], models = OVERLAY, redis = leaseRedis(), holder = "mini1", endpointSlots = makeInFlight(), lease = true, ...rest } = {}) {
	const leaseLogs = [];
	const extra = {
		endpointSlots,
		endpointLease: lease ? makeFleetLease({ redis, holderPrefix: holder, keyFor: endpointSlotKey, ttlMs: 60_000, timeoutMs: 50, log: (event) => leaseLogs.push(event) }) : null,
		modelEndpoints: () => endpoints,
		overlayModels: () => models,
		...rest,
	};
	return { redis, endpointSlots, leaseLogs, extra };
}

test("the endpoint re-check has a wake instant of its own, distinct from every other deferral", { skip }, async () => {
	// The defer record says why a job sits in the delayed set (issue #737); for a reader older than it, and a record
	// that could not be written, the instant is the only evidence. 11s is the wait throttle floor, which index.mjs
	// does not export.
	// Issue #596, phase 2: the host budget's re-check and the never-fits deferral are two more.
	const { BUDGET_RECHECK_MS, NEVER_FITS_RECHECK_MS } = await import("../src/host-budget.mjs");
	const instants = [mod.SCOPE_BUSY_RECHECK_MS, mod.SUPERSEDE_RECHECK_MS, 11_000, mod.ENDPOINT_BUSY_RECHECK_MS, BUDGET_RECHECK_MS, NEVER_FITS_RECHECK_MS];
	assert.equal(typeof mod.ENDPOINT_BUSY_RECHECK_MS, "number");
	assert.equal(new Set(instants).size, instants.length, `six distinct instants: ${instants.join(", ")}`);
});

test("effectiveJobOf is the one precedence, and the endpoint set follows the model it names", { skip }, async () => {
	const settings = LOCAL_MODEL();
	assert.deepEqual(mod.effectiveJobOf({ kind: "local", folder: "/f" }, settings), { kind: "local", folder: "/f", provider: "local-ollama", model: "qwen", maxTurns: 30, maxTokens: undefined, maxCostMicros: null });
	assert.equal(mod.effectiveJobOf({ provider: "anthropic", model: "m2" }, settings).model, "m2", "an explicit per-job field wins");
	assert.deepEqual(mod.mainModelEndpoints({ models: OVERLAY, job: { provider: "local-ollama", model: "qwen" }, endpoints: [OLLAMA] }), [OLLAMA]);
	assert.deepEqual(mod.mainModelEndpoints({ models: OVERLAY, job: { provider: "anthropic", model: "m" }, endpoints: [OLLAMA] }), [], "a hosted model uses no endpoint");
});

test("effectiveJobOf: maxCostMicros is the SMALLER of the trigger's run.maxCostUsd and the deployment's maxCostUsd (#501)", { skip }, () => {
	const cap = (data, maxCostUsd) => mod.effectiveJobOf(data, { ...LOCAL_MODEL(), maxCostUsd }).maxCostMicros;
	assert.equal(cap({}, null), null, "neither sets one: no cap, so no PI_MAX_COST_MICROS and no costCap needed");
	assert.equal(cap({}, "5"), 5_000_000, "the deployment's alone");
	assert.equal(cap({ maxCostUsd: "1.25" }, null), 1_250_000, "the trigger's alone applies");
	assert.equal(cap({ maxCostUsd: "1.25" }, "5"), 1_250_000, "a lower trigger narrows");
	assert.equal(cap({ maxCostUsd: 9 }, 5), 5_000_000, "a higher trigger can NOT raise it: never the max");
	assert.equal(cap({ maxCostUsd: "nope" }, "5"), 0, "a malformed queued value fails closed to the tightest cap");
	assert.equal(cap({ maxCostMicros: 99_000_000 }, "5"), 5_000_000, "job data cannot carry its own micro-dollar cap past this");
	// The fail-closed read is LOGGED, by key only; a well-formed or absent value logs nothing.
	const logs = [];
	const log = (event, fields) => logs.push([event, fields]);
	assert.equal(mod.effectiveJobOf({ maxCostUsd: "sk-ant-oops" }, { ...LOCAL_MODEL(), maxCostUsd: "5" }, null, log).maxCostMicros, 0);
	assert.deepEqual(logs, [["job_cost_cap_malformed", { key: "maxCostUsd" }]]);
	assert.equal(JSON.stringify(logs).includes("sk-ant"), false, "never the value");
	mod.effectiveJobOf({ maxCostUsd: "2" }, LOCAL_MODEL(), null, log);
	mod.effectiveJobOf({}, LOCAL_MODEL(), null, log);
	assert.equal(logs.length, 1);
});

test("the processor logs a malformed queued cap as job_cost_cap_malformed with the job id and the key, and runs it at a cap of 0 (#501)", { skip }, async () => {
	let ran;
	const h = harness({ onContainer: (ctx) => (ran = ctx.job) });
	const j = spyJob("bad-cap", { kind: "local", folder: "/srv/cap", flow: "tidy", task: "t", maxCostUsd: "sk-ant-not-money" });
	const done = h.processor(j.job, "tok", new AbortController().signal);
	await h.untilStarted(1);
	h.releaseNext();
	await done;
	assert.equal(ran.maxCostMicros, 0, "fail closed: the tightest cap, never the deployment's or none");
	const hits = h.seen.logs.filter((l) => l.event === "job_cost_cap_malformed");
	assert.deepEqual(hits, [{ event: "job_cost_cap_malformed", fields: { jobId: "bad-cap", key: "maxCostUsd" } }], "once per pickup, with the job id");
	assert.equal(JSON.stringify(h.seen.logs).includes("sk-ant"), false, "never the value");
});

test("local AND forge jobs take an endpoint slot (both halves), a full endpoint defers the next one, and the finally gives both back", { skip }, async () => {
	const w = endpointWiring();
	const h = harness({ getSettings: LOCAL_MODEL, extra: w.extra });

	// A LOCAL job takes it, where the scope lease would skip it: an endpoint is one server whoever calls it.
	const a = localJob("l-1", "/srv/a");
	const first = h.processor(a.job, "tok-a", new AbortController().signal);
	await h.untilStarted(1);
	assert.equal(w.endpointSlots.count("lan-ollama"), 1, "the in-process half");
	assert.equal(w.redis.store.get(keyOf("lan-ollama")), "mini1#l-1", "and the fleet half, keyed slot:m:<hash16(id)>:<i>");

	// A forge job on ANOTHER scope: neither the folder mutex nor a scoped ceiling can be what stops it.
	const b = ghJob("g-1", "acme/web");
	await assert.rejects(() => h.processor(b.job, "tok-b", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal(b.moves.length, 1);
	assert.equal(b.moves[0].ts, NOW + mod.ENDPOINT_BUSY_RECHECK_MS, "deferred to the endpoint re-check, never refused");
	assert.equal(h.seen.started, 1, "the second container never started");
	assert.equal(h.seen.records.length, 0, "a deferral writes no record");
	const deferred = h.seen.logs.find((l) => l.event === "endpoint_busy_deferred");
	assert.deepEqual(deferred.fields, { jobId: "g-1", endpoint: "lan-ollama", where: "host", delayMs: mod.ENDPOINT_BUSY_RECHECK_MS });

	h.releaseNext();
	assert.equal((await first).outcome, "completed");
	assert.equal(w.endpointSlots.count("lan-ollama"), 0, "the finally released the in-process half");
	assert.equal(w.redis.store.size, 0, "and the fleet half");

	// The forge job now takes it, and a local job on ANOTHER HOST (its own map, the same Valkey) is held off by the
	// fleet half alone.
	const c = ghJob("g-2", "acme/web");
	const second = h.processor(c.job, "tok-c", new AbortController().signal);
	await h.untilStarted(2);
	assert.equal(w.redis.store.get(keyOf("lan-ollama")), "mini1#g-2");
	const other = endpointWiring({ redis: w.redis, holder: "mini2" });
	const h2 = harness({ getSettings: LOCAL_MODEL, extra: other.extra });
	const d = localJob("l-2", "/srv/b");
	await assert.rejects(() => h2.processor(d.job, "tok-d", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal(h2.seen.logs.find((l) => l.event === "endpoint_busy_deferred").fields.where, "fleet");
	assert.equal(other.endpointSlots.count("lan-ollama"), 0, "the other host gave its in-process slot back before deferring");
	h.releaseNext();
	await second;
	assert.equal(w.redis.store.size, 0);
});

test("a full endpoint gives back EVERYTHING already taken: earlier endpoint slots, the scope's fleet claim and in-process slot, and the host slot", { skip }, async () => {
	const A = { id: "a-ep", host: "a.lan", port: 8000, slots: 1, keyless: false };
	const B = { id: "b-ep", host: "b.lan", port: 8001, slots: 1, keyless: false };
	const lease = leaseRedis();
	lease.store.set(keyOf("b-ep"), "mini2#elsewhere"); // b-ep is full on another host
	const hostSlots = makeInFlight();
	const inFlight = makeInFlight();
	// Two endpoints for one job is the shape allowed-model lists (#502) bring; the seam stands in for them.
	const w = endpointWiring({ endpoints: [A, B], redis: lease, endpointSetFor: () => [A, B] });
	const h = harness({
		limits: limitsOf([{ scope: "acme/web", concurrent: 1 }]),
		inFlight,
		hostBound: { slots: hostSlots, limit: () => 3 },
		getSettings: LOCAL_MODEL,
		extra: { ...w.extra, scopeLease: makeFleetLease({ redis: lease, holderPrefix: "mini1", keyFor: scopeSlotKey, ttlMs: 60_000, timeoutMs: 50 }) },
	});
	const job = ghJob("g-1", "acme/web");
	await assert.rejects(() => h.processor(job.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");

	assert.deepEqual(h.seen.logs.find((l) => l.event === "endpoint_busy_deferred").fields, { jobId: "g-1", endpoint: "b-ep", where: "fleet", delayMs: mod.ENDPOINT_BUSY_RECHECK_MS });
	assert.equal(w.endpointSlots.count("a-ep"), 0, "a-ep's in-process slot came back");
	assert.equal(w.endpointSlots.count("b-ep"), 0, "b-ep's in-process slot came back");
	assert.deepEqual([...lease.store.keys()], [keyOf("b-ep")], "a-ep's fleet claim and the scope's fleet claim are gone; only the other host's claim stands");
	assert.equal(inFlight.count("acme/web"), 0, "the scope's in-process slot came back");
	assert.equal(hostSlots.count(mod.HOST_SLOT_KEY), 0, "the host slot came back");
	assert.equal(h.redis.incrCalls, 0, "and nothing was reserved: the deferral is free");
	assert.equal(h.seen.started, 0);

	// Once the other host lets go, the same job runs, holding all four kinds of slot, and the finally frees them.
	lease.store.delete(keyOf("b-ep"));
	const again = ghJob("g-1", "acme/web");
	const run = h.processor(again.job, "tok", new AbortController().signal);
	await h.untilStarted(1);
	assert.equal(lease.store.size, 3, "two endpoint claims and the scope claim");
	h.releaseNext();
	await run;
	assert.equal(lease.store.size, 0);
	assert.equal(w.endpointSlots.count("a-ep") + w.endpointSlots.count("b-ep") + inFlight.count("acme/web") + hostSlots.count(mod.HOST_SLOT_KEY), 0);
});

test("endpoints are taken in ID order, whatever order the set names them in", { skip }, async () => {
	// Two jobs that each need the same two endpoints must ask in one order, or each can hold one and wait on the other.
	const A = { id: "a-ep", host: "a.lan", port: 8000, slots: 1, keyless: false };
	const Z = { id: "z-ep", host: "z.lan", port: 8001, slots: 1, keyless: false };
	const order = [];
	const inner = makeInFlight();
	const endpointSlots = { ...inner, tryAcquire: (id, limit) => (order.push(id), inner.tryAcquire(id, limit)) };
	const w = endpointWiring({ endpoints: [Z, A], endpointSlots, endpointSetFor: () => [Z, A] });
	const h = harness({ getSettings: LOCAL_MODEL, extra: w.extra });
	const p = h.processor(localJob("l-1", "/f").job, "tok", new AbortController().signal);
	await h.untilStarted(1);
	h.releaseNext();
	await p;
	assert.deepEqual(order, ["a-ep", "z-ep"]);
});

test("a Valkey fault fails the fleet half OPEN, says so, and the in-process bound still holds the host", { skip }, async () => {
	const w = endpointWiring({ redis: leaseRedis({ fail: true }) });
	const h = harness({ getSettings: LOCAL_MODEL, extra: w.extra });
	const first = h.processor(localJob("l-1", "/srv/a").job, "tok", new AbortController().signal);
	await h.untilStarted(1);
	assert.deepEqual(w.leaseLogs, ["fleet_lease_unavailable"], "the lease names the fault");
	assert.deepEqual(h.seen.logs.find((l) => l.event === "endpoint_lease_degraded").fields, { jobId: "l-1", endpoint: "lan-ollama" }, "and the gate names the endpoint it degraded");

	const second = localJob("l-2", "/srv/b");
	await assert.rejects(() => h.processor(second.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal(h.seen.logs.find((l) => l.event === "endpoint_busy_deferred").fields.where, "host", "slots: 1 still means one on this host");
	h.releaseNext();
	await first;
	assert.equal(w.endpointSlots.count("lan-ollama"), 0);
});

test("the endpoint holds are released on the setup-throw path and on an infra throw", { skip }, async () => {
	// The setup guard: a throw between the gates and the main try.
	{
		const w = endpointWiring();
		const processor = mod.makeProcessor({
			cancelJob: () => {}, stopContainer: () => {}, redis: fakeRedis(), getSettings: LOCAL_MODEL,
			now: () => NOW, recordRun: () => {}, timeoutMs: 100000, deps: { log: () => {} }, ...w.extra,
		});
		const boomSignal = { addEventListener: () => { throw new Error("boom-in-setup"); }, removeEventListener: () => {} };
		await assert.rejects(() => processor(localJob("l-1", "/f").job, "tok", boomSignal), /boom-in-setup/);
		assert.equal(w.endpointSlots.count("lan-ollama"), 0, "the in-process half came back synchronously");
		await flush();
		assert.equal(w.redis.store.size, 0, "and the fleet claim is gone");
	}
	// An infra throw (docker exit 125) goes through the main finally.
	{
		const w = endpointWiring();
		const processor = mod.makeProcessor({
			cancelJob: () => {}, stopContainer: () => {}, redis: fakeRedis(), getSettings: LOCAL_MODEL,
			now: () => NOW, recordRun: () => {}, timeoutMs: 100000, ...w.extra,
			deps: { mintToken: async () => "tok", isDefaultBranchProtected: async () => true, prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }), runContainer: async () => ({ code: 125, aborted: false }), cleanup: async () => {}, comment: async () => {}, log: () => {} },
		});
		await assert.rejects(() => processor(localJob("l-1", "/f").job, "tok", new AbortController().signal), (e) => e.name !== "DelayedError");
		assert.equal(w.endpointSlots.count("lan-ollama"), 0);
		assert.equal(w.redis.store.size, 0);
	}
});

test("invalid or unreadable settings take no endpoint slot and read no declaration", { skip }, async () => {
	for (const getSettings of [() => ({ invalid: "boom" }), () => { throw new Error("overlay unreadable"); }]) {
		let reads = 0;
		const w = endpointWiring();
		w.extra.modelEndpoints = () => (reads++, [OLLAMA]);
		const records = [];
		const processor = mod.makeProcessor({
			cancelJob: () => {}, stopContainer: () => {}, redis: fakeRedis(), getSettings,
			now: () => NOW, recordRun: (r) => records.push(r), timeoutMs: 100000, deps: { log: () => {} }, ...w.extra,
		});
		await processor(localJob("l-1", "/f").job, "tok", new AbortController().signal).catch(() => {});
		assert.equal(reads, 0, "the declaration is not even read");
		assert.equal(w.redis.calls.length, 0, "no lease command");
		assert.equal(w.endpointSlots.count("lan-ollama"), 0);
		assert.equal(records.length, 1, "and the job is still recorded");
	}
});

test("getSettings is read ONCE per pickup beside the head's newer-release check, and its throw is recorded exactly as before the read moved", { skip }, async () => {
	// Completed run and endpoint deferral: one read each.
	{
		let calls = 0;
		const w = endpointWiring();
		const h = harness({ getSettings: () => (calls++, LOCAL_MODEL()), extra: w.extra });
		const p = h.processor(localJob("l-1", "/srv/a").job, "tok", new AbortController().signal);
		await h.untilStarted(1);
		assert.equal(calls, 2, "the head's newer-release check, then one read before the gate, none again in the main try");
		await assert.rejects(() => h.processor(localJob("l-2", "/srv/b").job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
		assert.equal(calls, 4, "a deferred pickup reads once too, after its own head check");
		h.releaseNext();
		await p;
		assert.equal(calls, 4);
	}
	// A throw: one record carrying the error, an UnrecoverableError to the queue, every hold released.
	{
		let calls = 0;
		const inFlight = makeInFlight();
		const records = [];
		const w = endpointWiring();
		const processor = mod.makeProcessor({
			cancelJob: () => {}, stopContainer: () => {}, redis: fakeRedis(),
			getSettings: () => { calls++; throw new Error("overlay boom"); },
			inFlight, now: () => NOW, recordRun: (r) => records.push(r), timeoutMs: 100000, deps: { log: () => {} }, ...w.extra,
		});
		await assert.rejects(() => processor(localJob("l-1", "/f").job, "tok", new AbortController().signal), (e) => e.name === "UnrecoverableError" && e.message === "overlay boom");
		assert.equal(calls, 2, "the head's throw falls through to the pickup's read, which records it");
		assert.equal(records.length, 1);
		assert.equal(records[0].error.message, "overlay boom");
		// Plus the pickup-time project (issue #499), null with no projects, and the size resolved beside it (issue #596), the
		// built-in default with no project and no setting: the gate resolved both before the settings read. And the capacity
		// (issue #599): the settings are read after admission, so this job held a slot when it threw.
		assert.deepEqual(Object.keys(records[0]).sort(), ["capacity", "earlier", "endedAt", "error", "job", "limits", "maxTurns", "project", "size", "startedAt"]);
		assert.equal(typeof records[0].capacity, "object");
		assert.notEqual(records[0].capacity, null);
		assert.equal(records[0].project, null);
		assert.deepEqual(records[0].size, { memMiB: 4096, cpuCenti: 200, source: "default" });
		assert.equal(typeof records[0].startedAt, "string", "startedAt is set before the error is recorded, as it was");
		assert.equal(inFlight.count("/f"), 0, "the folder came back");
	}
});

test("NO endpoints declared: no lease command, no overlay read, and the container sees exactly what an unwired processor gives it", { skip }, async () => {
	let overlayReads = 0;
	const w = endpointWiring({ endpoints: [] });
	w.extra.overlayModels = () => (overlayReads++, OVERLAY);
	const seenCtx = [];
	const wired = harness({ getSettings: LOCAL_MODEL, extra: w.extra, onContainer: (ctx) => seenCtx.push(ctx) });
	const bare = harness({ getSettings: LOCAL_MODEL, onContainer: (ctx) => seenCtx.push(ctx) });
	for (const h of [wired, bare]) {
		const p = h.processor(localJob("l-1", "/f").job, "tok", new AbortController().signal);
		await h.untilStarted(1);
		h.releaseNext();
		assert.equal((await p).outcome, "completed");
	}
	assert.equal(w.redis.calls.length, 0, "zero endpoint Valkey commands");
	assert.equal(overlayReads, 0, "the overlay models.json is not read either");
	assert.equal(w.endpointSlots.count("lan-ollama"), 0);
	const golden = (ctx) => JSON.stringify(ctx, (k, v) => (k === "signal" ? "<signal>" : v));
	assert.equal(golden(seenCtx[0]), golden(seenCtx[1]), "the container context, the job argv's source, is byte-identical");
	assert.deepEqual(Object.keys(wired.seen.records[0].result).sort(), Object.keys(bare.seen.records[0].result).sort(), "and the record carries no new field");
});

test("issue #503: a keyless provider runs on ONE overlay read per pickup, gate and container env deciding on the same snapshot", { skip }, async () => {
	// The real gate and the real env builder (env-allowlist.mjs), wired as start.mjs wires them, around the pickup's
	// snapshot. Imported here, not at the top: env-allowlist needs pi-ai, and the file's other tests do not.
	const { buildContainerEnv, resolveProviderCredential } = await import("../src/env-allowlist.mjs");
	const KEYLESS_OVERLAY = { providers: { "local-ollama": { ...OVERLAY.providers["local-ollama"], apiKey: "$PI_DISPATCH_KEYLESS" } } };
	const gate = (seen) => (job, { modelEndpoints = null } = {}) => {
		seen.push(modelEndpoints);
		try {
			resolveProviderCredential({ provider: job.provider, hostEnv: {}, modelEndpoints });
			return { ok: true };
		} catch (error) {
			return { ok: false, message: error.message };
		}
	};
	for (const [endpoint, admitted] of [[OLLAMA, true], [{ ...OLLAMA, keyless: false }, false]]) {
		let overlayReads = 0;
		const w = endpointWiring({ endpoints: [endpoint] });
		w.extra.overlayModels = () => (overlayReads++, KEYLESS_OVERLAY);
		const gateSaw = [];
		const envs = [];
		const h = harness({
			getSettings: LOCAL_MODEL,
			extra: w.extra,
			extraDeps: { checkProviderCredential: gate(gateSaw) },
			onContainer: (ctx) => {
				assert.equal(ctx.modelEndpoints, gateSaw[0], "the container is handed the very snapshot the gate decided on");
				envs.push(buildContainerEnv({ provider: ctx.job.provider, model: ctx.job.model, maxTurns: 5, jobId: "j", hostEnv: {}, modelEndpoints: ctx.modelEndpoints }));
			},
		});
		const p = h.processor(localJob("l-1", "/f").job, "tok", new AbortController().signal);
		if (admitted) {
			await h.untilStarted(1);
			h.releaseNext();
			assert.equal((await p).outcome, "completed");
			assert.equal(envs[0].PI_DISPATCH_KEYLESS, "keyless");
		} else {
			const r = await p;
			assert.equal(r.outcome, "policy");
			assert.equal(r.reason, "provider-unconfigured");
			assert.equal(h.seen.started, 0, "no container");
			// CONST-BUDGET-BEFORE-TOKENS: the refusal is free, before any reservation.
			assert.equal(h.redis.incrCalls, 0, "nothing reserved");
		}
		assert.equal(overlayReads, 1, "models.json is read once per pickup, never again by the gate or the env");
		assert.equal(w.endpointSlots.count("lan-ollama"), 0, "and the slot came back either way");
	}
});

test("PR #520 round 1: a TRANSIENT overlay read at pickup retries a keyless job as infra; a determinate one refuses it", { skip }, async () => {
	// The gate as start.mjs wires it: a transient verdict becomes `{ unavailable }`, a config refusal `{ ok: false }`.
	const { resolveProviderCredential } = await import("../src/env-allowlist.mjs");
	const gate = (job, { modelEndpoints = null } = {}) => {
		try {
			resolveProviderCredential({ provider: job.provider, hostEnv: {}, modelEndpoints });
			return { ok: true };
		} catch (error) {
			if (error?.piDispatchTransient === true) return { ok: false, unavailable: error.code };
			if (error?.piDispatchConfig !== true) throw error;
			return { ok: false, message: error.message };
		}
	};
	// Absence arrives as null, never as a thrown ENOENT: the reader's own rule (round 2), pinned with the real reader below.
	const fault = (code) => () => {
		throw Object.assign(new Error(`${code}: read failed`), { code });
	};
	for (const [read, retried] of [[fault("EIO"), true], [fault("EMFILE"), true], [() => null, false], [() => { throw new Error("overlay models.json is not valid JSON: x"); }, false]]) {
		const w = endpointWiring({ endpoints: [OLLAMA] });
		w.extra.overlayModels = read;
		const h = harness({ getSettings: LOCAL_MODEL, extra: w.extra, extraDeps: { checkProviderCredential: gate } });
		const p = h.processor(localJob("l-1", "/f").job, "tok", new AbortController().signal);
		if (retried) {
			await assert.rejects(p, (e) => e.name === "InfraRetry", "retried, never a permanent public refusal");
			assert.ok(h.seen.logs.some((l) => l.event === "provider_credential_unavailable"));
		} else {
			const r = await p;
			assert.equal(r.reason, "provider-unconfigured", "absent or invalid stays a determinate refusal");
		}
		assert.equal(h.seen.started, 0);
		assert.equal(h.redis.incrCalls, 0, "free either way");
		assert.equal(w.endpointSlots.count("lan-ollama"), 0);
	}
});

test("PR #520 round 2: end to end with the REAL overlay reader: unreadable retries as infra, invalid or absent refuses", { skip: typeof process.getuid === "function" && process.getuid() === 0 ? "root reads a mode-000 file" : skip }, async () => {
	const { resolveProviderCredential } = await import("../src/env-allowlist.mjs");
	const { readOverlayModels } = await import("../src/model-endpoints.mjs");
	const { chmodSync, mkdirSync, writeFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { tempDir } = await import("./helpers/temp-dir.mjs");
	const gate = (job, { modelEndpoints = null } = {}) => {
		try {
			resolveProviderCredential({ provider: job.provider, hostEnv: {}, modelEndpoints });
			return { ok: true };
		} catch (error) {
			if (error?.piDispatchTransient === true) return { ok: false, unavailable: error.code };
			if (error?.piDispatchConfig !== true) throw error;
			return { ok: false, message: error.message };
		}
	};
	const KEYLESS = JSON.stringify({ providers: { "local-ollama": { ...OVERLAY.providers["local-ollama"], apiKey: "$PI_DISPATCH_KEYLESS" } } });
	const fileMode000 = () => {
		const dir = tempDir("pi-overlay-000-");
		writeFileSync(join(dir, "models.json"), KEYLESS);
		chmodSync(join(dir, "models.json"), 0o000);
		return { read: () => readOverlayModels(dir), restore: () => chmodSync(join(dir, "models.json"), 0o600) };
	};
	const parentMode000 = () => {
		const dir = join(tempDir("pi-overlay-parent-"), "overlay");
		mkdirSync(dir);
		writeFileSync(join(dir, "models.json"), KEYLESS);
		chmodSync(dir, 0o000);
		return { read: () => readOverlayModels(dir), restore: () => chmodSync(dir, 0o700) };
	};
	// A real folder and file: the reader walks the path as the job's mount does before it reads (PR #553's review).
	const eio = () => {
		const dir = tempDir("pi-overlay-eio-");
		writeFileSync(join(dir, "models.json"), KEYLESS);
		return { read: () => readOverlayModels(dir, { readFileSync: () => { throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" }); } }), restore: () => {} };
	};
	const invalid = () => {
		const dir = tempDir("pi-overlay-bad-");
		writeFileSync(join(dir, "models.json"), "{ nope");
		return { read: () => readOverlayModels(dir), restore: () => {} };
	};
	const notObject = () => {
		const dir = tempDir("pi-overlay-array-");
		writeFileSync(join(dir, "models.json"), "[]");
		return { read: () => readOverlayModels(dir), restore: () => {} };
	};
	const absent = () => {
		const dir = tempDir("pi-overlay-none-");
		return { read: () => readOverlayModels(dir), restore: () => {} };
	};
	const working = () => {
		const dir = tempDir("pi-overlay-ok-");
		writeFileSync(join(dir, "models.json"), KEYLESS);
		return { read: () => readOverlayModels(dir), restore: () => {} };
	};
	for (const [name, make, expect] of [["mode-000 file", fileMode000, "retry"], ["mode-000 parent", parentMode000, "retry"], ["EIO", eio, "retry"], ["invalid JSON", invalid, "refuse"], ["not an object", notObject, "refuse"], ["absent", absent, "refuse"], ["readable", working, "run"]]) {
		const fixture = make();
		try {
			const w = endpointWiring({ endpoints: [OLLAMA] });
			w.extra.overlayModels = fixture.read;
			const h = harness({ getSettings: LOCAL_MODEL, extra: w.extra, extraDeps: { checkProviderCredential: gate } });
			const p = h.processor(localJob("l-1", "/f").job, "tok", new AbortController().signal);
			if (expect === "retry") {
				await assert.rejects(p, (e) => e.name === "InfraRetry" && e.reason === "container-never-started", name);
			} else if (expect === "refuse") {
				assert.equal((await p).reason, "provider-unconfigured", name);
			} else {
				await h.untilStarted(1);
				h.releaseNext();
				assert.equal((await p).outcome, "completed", name);
			}
			if (expect !== "run") assert.equal(h.seen.started, 0, name);
			if (expect !== "run") assert.equal(h.redis.incrCalls, 0, `${name}: nothing reserved`);
			const unreadable = h.seen.logs.find((l) => l.event === "endpoint_models_unreadable");
			if (expect === "retry") assert.match(unreadable.fields.reason, /^E[A-Z]+$/, `${name}: the log names the errno, not "not valid JSON"`);
			// A determinate fault is named as one, never with the fs-error wording.
			if (name === "not an object") assert.equal(unreadable.fields.reason, "overlay models.json is not a valid models.json");
			if (name === "invalid JSON") assert.equal(unreadable.fields.reason, "overlay models.json is not valid JSON");
		} finally {
			fixture.restore();
		}
	}
});

test("a hosted-model job with endpoints declared takes no slot", { skip }, async () => {
	const w = endpointWiring();
	const h = harness({ extra: w.extra }); // anthropic/m: no endpoint serves it
	const p = h.processor(localJob("l-1", "/f").job, "tok", new AbortController().signal);
	await h.untilStarted(1);
	assert.equal(w.endpointSlots.count("lan-ollama"), 0);
	assert.equal(w.redis.calls.length, 0);
	h.releaseNext();
	await p;
});

test("a host-alias endpoint is bounded per host only: two machines each declaring host.docker.internal share no fleet slot", { skip }, async () => {
	// host.docker.internal is THIS machine's server on every machine, so a fleet key built from the id made two Macs
	// share one bound for two servers (measured on PR #518's gate: mac2 deferred `where: "fleet"` while mac1 held).
	const MAC = { id: "mac-ollama", host: "host.docker.internal", port: 11434, slots: 1, keyless: true };
	const MAC_MODELS = { providers: { "local-ollama": { api: "openai-completions", baseUrl: "http://host.docker.internal:11434/v1", models: [{ id: "qwen" }] } } };
	const lease = leaseRedis();
	const mac1 = endpointWiring({ endpoints: [MAC], models: MAC_MODELS, redis: lease, holder: "mac1" });
	const mac2 = endpointWiring({ endpoints: [MAC], models: MAC_MODELS, redis: lease, holder: "mac2" });
	const h1 = harness({ getSettings: LOCAL_MODEL, extra: mac1.extra });
	const h2 = harness({ getSettings: LOCAL_MODEL, extra: mac2.extra });
	const a = h1.processor(localJob("l-1", "/srv/a").job, "tok", new AbortController().signal);
	const b = h2.processor(localJob("l-2", "/srv/a").job, "tok", new AbortController().signal);
	await h1.untilStarted(1);
	await h2.untilStarted(1);
	assert.equal(lease.calls.length, 0, "no fleet command for a per-machine server");
	// The in-process bound still holds each machine to its own server's slots.
	await assert.rejects(() => h1.processor(localJob("l-3", "/srv/b").job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal(h1.seen.logs.find((l) => l.event === "endpoint_busy_deferred").fields.where, "host");
	h1.releaseNext();
	h2.releaseNext();
	await Promise.all([a, b]);
	assert.equal(mac1.endpointSlots.count("mac-ollama") + mac2.endpointSlots.count("mac-ollama"), 0);
});

test("an endpoint set naming one endpoint twice takes it once, rather than waiting on itself forever", { skip }, async () => {
	const w = endpointWiring({ endpointSetFor: () => [OLLAMA, OLLAMA] });
	const h = harness({ getSettings: LOCAL_MODEL, extra: w.extra });
	const p = h.processor(localJob("l-1", "/f").job, "tok", new AbortController().signal);
	await h.untilStarted(1);
	assert.equal(w.endpointSlots.count("lan-ollama"), 1);
	h.releaseNext();
	assert.equal((await p).outcome, "completed");
	assert.equal(w.endpointSlots.count("lan-ollama"), 0);
});

test("the two fail-open paths: the job runs, takes no slot, and the log names why, without the file's text", { skip }, async () => {
	// An overlay models.json that does not parse. The reason is FIXED: a JSON.parse message quotes the file around the
	// fault, and models.json holds keys.
	{
		const w = endpointWiring();
		w.extra.overlayModels = () => {
			throw Object.assign(new Error('overlay models.json is not valid JSON: /o/models.json (Unexpected token in JSON at position 9: "k": hunter2pla)'), { piDispatchConfig: true });
		};
		const h = harness({ getSettings: LOCAL_MODEL, extra: w.extra });
		const p = h.processor(localJob("l-1", "/f").job, "tok", new AbortController().signal);
		await h.untilStarted(1);
		assert.equal(w.endpointSlots.count("lan-ollama"), 0);
		assert.equal(w.redis.calls.length, 0);
		h.releaseNext();
		assert.equal((await p).outcome, "completed");
		const line = h.seen.logs.find((l) => l.event === "endpoint_models_unreadable");
		assert.deepEqual(line.fields, { jobId: "l-1", reason: "overlay models.json is not valid JSON" });
		assert.ok(!JSON.stringify(h.seen.logs).includes("hunter2"), "no byte of the file reaches the log");
	}
	// A derivation that throws (a defect, not a state).
	{
		const w = endpointWiring({ endpointSetFor: () => { throw new TypeError("boom in derivation"); } });
		const h = harness({ getSettings: LOCAL_MODEL, extra: w.extra });
		const p = h.processor(localJob("l-1", "/f").job, "tok", new AbortController().signal);
		await h.untilStarted(1);
		assert.equal(w.endpointSlots.count("lan-ollama"), 0);
		h.releaseNext();
		assert.equal((await p).outcome, "completed");
		assert.ok(h.seen.logs.some((l) => l.event === "endpoint_gate_unavailable" && l.fields.jobId === "l-1"));
	}
});

test("a link-local endpoint takes the FLEET slot: one neighbour on a shared link is one server", { skip }, async () => {
	// Several hosts on one Thunderbolt bridge reach the same 169.254.x.y; each bounding it alone would put N times
	// `slots` on it (PR #518's second gate). Every address takes the fleet half; only the alias names do not.
	for (const [host, baseHost] of [["169.254.1.2", "169.254.1.2"], ["[fe80::1]", "[fe80::1]"]]) {
		const LINK = { id: "link-ollama", host, port: 11434, slots: 1, keyless: false };
		const models = { providers: { "local-ollama": { api: "openai-completions", baseUrl: `http://${baseHost}:11434/v1`, models: [{ id: "qwen" }] } } };
		const lease = leaseRedis();
		const one = endpointWiring({ endpoints: [LINK], models, redis: lease, holder: "mini1" });
		const two = endpointWiring({ endpoints: [LINK], models, redis: lease, holder: "mini2" });
		const h1 = harness({ getSettings: LOCAL_MODEL, extra: one.extra });
		const h2 = harness({ getSettings: LOCAL_MODEL, extra: two.extra });
		const a = h1.processor(localJob("l-1", "/srv/a").job, "tok", new AbortController().signal);
		await h1.untilStarted(1);
		assert.equal(lease.store.get(keyOf("link-ollama")), "mini1#l-1", `${host}: the fleet claim was taken`);
		await assert.rejects(() => h2.processor(localJob("l-2", "/srv/a").job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
		assert.equal(h2.seen.logs.find((l) => l.event === "endpoint_busy_deferred").fields.where, "fleet", `${host}: the other host waits on it`);
		h1.releaseNext();
		await a;
	}
});

// --- forge-qualified scopes (issue #498) ---------------------------------------------------------------

// Forge-qualified rows need version 2 (released builds refuse such a file rather than read an inert repo string).
const limitsOf2 = (rows) => parseScopedLimits(JSON.stringify({ version: 2, limits: rows }), "sl.json");
const fjJob = (id, repo) => spyJob(id, { kind: "forgejo", repo, target: { number: 1 }, flow: "fix", trigger: { deliveryId: id, sender: { id: 1 } } });

test("a qualified concurrent: 1 row defers a second GitHub job and admits the Forgejo job for the same repo", { skip }, async () => {
	const h = harness({ limits: limitsOf2([{ scope: "github:acme/web", concurrent: 1 }]) });
	const first = h.processor(ghJob("g-1", "acme/web").job, "tok", new AbortController().signal);
	await h.untilStarted(1);
	await assert.rejects(() => h.processor(ghJob("g-2", "acme/web").job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal(h.inFlight.count("github:acme/web"), 1, "the slot is keyed by the ROW's scope");
	const forgejo = h.processor(fjJob("f-1", "acme/web").job, "tok", new AbortController().signal);
	await h.untilStarted(2);
	h.releaseNext();
	h.releaseNext();
	await Promise.all([first, forgejo]);
	assert.equal(h.inFlight.count("github:acme/web") + h.inFlight.count("acme/web"), 0);
});

test("a bare concurrent: 1 row defers across forges: one key, the one it had before qualified scopes", { skip }, async () => {
	const h = harness({ limits: limitsOf([{ scope: "acme/web", concurrent: 1 }]) });
	const first = h.processor(ghJob("g-1", "acme/web").job, "tok", new AbortController().signal);
	await h.untilStarted(1);
	assert.equal(h.inFlight.count("acme/web"), 1);
	await assert.rejects(() => h.processor(fjJob("f-1", "acme/web").job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal(h.seen.started, 1, "the Forgejo job never started while the GitHub one held the bare row");
	h.releaseNext();
	await first;
});

test("the fleet lease key is slot:s:<hash16 of the ROW scope>:<i>, the hash the boot sweeper computes from the file", { skip }, async () => {
	const limits = limitsOf2([{ scope: "forgejo:acme/web", concurrent: 1 }]);
	const lease = leaseRedis();
	const h = harness({ limits, extra: { scopeLease: makeFleetLease({ redis: lease, holderPrefix: "mini1", keyFor: scopeSlotKey, ttlMs: 60_000, timeoutMs: 50 }) } });
	const run = h.processor(fjJob("f-1", "acme/web").job, "tok", new AbortController().signal);
	await h.untilStarted(1);
	// start.mjs sweeps `hash16(r.scope)` for each row: the same string the gate leased under.
	assert.deepEqual([...lease.store.keys()], [scopeSlotKey(hash16(limits[0].scope), 0)]);
	assert.deepEqual([...lease.store.keys()], [`slot:s:${hash16("forgejo:acme/web")}:0`]);
	// The GitHub job for the same repo has no row: no lease at all.
	const other = h.processor(ghJob("g-1", "acme/web").job, "tok", new AbortController().signal);
	await h.untilStarted(2);
	assert.equal(lease.store.size, 1);
	h.releaseNext();
	h.releaseNext();
	await Promise.all([run, other]);
	assert.equal(lease.store.size, 0);
});

// --- project slots (issue #499 part B) -----------------------------------------------------------------

const SHOP = [{ id: "shop", members: ["/srv/shop-a", "/srv/shop-b", "github:acme/web"] }];

test("a project concurrent: 1 row defers a second member's job, keyed project:<id>, and an unrelated folder runs", { skip }, async () => {
	const h = harness({ limits: limitsOf2([{ scope: "project:shop", concurrent: 1 }]), extra: { projects: () => SHOP } });
	const first = h.processor(localJob("p-1", "/srv/shop-a").job, "tok", new AbortController().signal);
	await h.untilStarted(1);
	assert.equal(h.inFlight.count("project:shop"), 1, "the project slot is keyed by the project ROW's scope");
	const second = localJob("p-2", "/srv/shop-b");
	await assert.rejects(() => h.processor(second.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal(second.moves[0].ts, NOW + mod.SCOPE_BUSY_RECHECK_MS, "deferred at the scope re-check cadence");
	assert.deepEqual(h.seen.logs.find((l) => l.event === "scope_busy_deferred").fields, { jobId: "p-2", kind: "local", delayMs: mod.SCOPE_BUSY_RECHECK_MS, ledger: "project" });
	assert.equal(h.inFlight.count("/srv/shop-b"), 0, "the deferred job's own folder slot went back with the deferral");
	assert.equal(h.inFlight.count("project:shop"), 1, "and only the running job holds the project");
	const other = h.processor(localJob("o-1", "/srv/other").job, "tok", new AbortController().signal);
	await h.untilStarted(2);
	h.releaseNext();
	h.releaseNext();
	await Promise.all([first, other]);
	assert.equal(h.inFlight.count("project:shop"), 0, "the finally gave the project slot back");
	assert.equal(h.inFlight.count("/srv/shop-a"), 0);
	// Now the second member runs.
	const again = h.processor(localJob("p-2", "/srv/shop-b").job, "tok", new AbortController().signal);
	await h.untilStarted(3);
	h.releaseNext();
	assert.equal((await again).outcome, "completed");
});

test("the project slot is taken AFTER the repo slot: a busy repo defers before the project is touched", { skip }, async () => {
	const h = harness({ limits: limitsOf2([{ scope: "acme/web", concurrent: 1 }, { scope: "project:shop", concurrent: 5 }]), extra: { projects: () => SHOP } });
	const first = h.processor(ghJob("g-1", "acme/web").job, "tok", new AbortController().signal);
	await h.untilStarted(1);
	assert.equal(h.inFlight.count("project:shop"), 1);
	await assert.rejects(() => h.processor(ghJob("g-2", "acme/web").job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal(h.inFlight.count("project:shop"), 1, "the repo deferral never took a project slot");
	assert.equal(h.seen.logs.find((l) => l.event === "scope_busy_deferred").fields.ledger, undefined, "the repo's deferral line is the one it always was");
	h.releaseNext();
	await first;
	assert.equal(h.inFlight.count("project:shop") + h.inFlight.count("acme/web"), 0);
});

test("a project's FLEET lease is slot:s:<hash16(project:<id>)>, taken for a local member too, and a fleet miss gives back every slot", { skip }, async () => {
	const limits = limitsOf2([{ scope: "project:shop", concurrent: 1 }]);
	const lease = leaseRedis();
	const scopeLease = (holder) => makeFleetLease({ redis: lease, holderPrefix: holder, keyFor: scopeSlotKey, ttlMs: 60_000, timeoutMs: 50 });
	const h1 = harness({ limits, extra: { projects: () => SHOP, scopeLease: scopeLease("mini1") } });
	const h2 = harness({ limits, extra: { projects: () => SHOP, scopeLease: scopeLease("mini2") } });
	const run = h1.processor(localJob("p-1", "/srv/shop-a").job, "tok", new AbortController().signal);
	await h1.untilStarted(1);
	// The key the boot sweeper walks for that row (start.mjs, `scopeClaimRows`): one rule for the gate and the sweep.
	assert.deepEqual([...lease.store.keys()], [`slot:s:${hash16("project:shop")}:0`]);
	assert.deepEqual(scopeClaimRows(limits), [{ concurrent: 1, hash: hash16("project:shop") }]);
	// Another host's member job: its in-process slots are free, the fleet claim is not.
	await assert.rejects(() => h2.processor(localJob("p-2", "/srv/shop-b").job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.deepEqual(h2.seen.logs.find((l) => l.event === "scope_busy_deferred").fields, { jobId: "p-2", kind: "local", delayMs: mod.SCOPE_BUSY_RECHECK_MS, ledger: "project", where: "fleet" });
	assert.equal(h2.inFlight.count("project:shop"), 0, "the in-process project slot went back on the fleet miss");
	assert.equal(h2.inFlight.count("/srv/shop-b"), 0, "and the folder slot before it");
	h1.releaseNext();
	await run;
	assert.equal(lease.store.size, 0, "the finally released the fleet claim");
});

test("a deferral AFTER the project slot (a busy model endpoint) gives the project slot back, last first", { skip }, async () => {
	const endpointSlots = makeInFlight();
	const w = endpointWiring({ endpointSlots, lease: false });
	const limits = limitsOf2([{ scope: "project:shop", concurrent: 2 }]);
	const h = harness({ limits, getSettings: LOCAL_MODEL, extra: { ...w.extra, projects: () => SHOP } });
	assert.ok(endpointSlots.tryAcquire(OLLAMA.id, OLLAMA.slots) && OLLAMA.slots === 1, "the one endpoint slot is taken elsewhere");
	await assert.rejects(() => h.processor(localJob("p-1", "/srv/shop-a").job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.ok(h.seen.logs.some((l) => l.event === "endpoint_busy_deferred"));
	assert.equal(h.inFlight.count("project:shop"), 0, "the project slot was given back on the endpoint deferral");
	assert.equal(h.inFlight.count("/srv/shop-a"), 0);
});

test("a job in no project, or in a project with no row, takes no project slot; the pickup project is read once", { skip }, async () => {
	let reads = 0;
	const h = harness({ limits: limitsOf2([{ scope: "project:shop", concurrent: 1 }]), extra: { projects: () => (reads++, [{ id: "other", members: ["/srv/x"] }, ...SHOP]) } });
	const a = h.processor(localJob("x-1", "/srv/x").job, "tok", new AbortController().signal);
	await h.untilStarted(1);
	assert.equal(h.inFlight.count("project:other"), 0, "project other has no row");
	assert.equal(reads, 1, "one read of the projects ref per pickup");
	h.releaseNext();
	await a;
});

// --- why a slot gate deferred a job (issue #737) ------------------------------------------------------------------

/** The reason a deferral recorded for `job`, in the reader's terms. */
const reasonOf = (redis, job) => {
	const r = deferRecordOf(redis, job.id);
	return r && { why: r.why, bucket: r.bucket, until: r.until, project: r.project, holder: r.holder, endpoint: r.endpoint };
};
const busyAt = (why, more = {}) => ({ why, bucket: why === "chained" ? "run" : "slot", until: NOW + mod.SCOPE_BUSY_RECHECK_MS, project: null, holder: null, endpoint: null, ...more });
const nobody = { acquire: async () => null };

test("each slot gate records its own reason: the host slot, the folder, the repository, the project, a chain, an endpoint", { skip }, async () => {
	// The host slot.
	const hostSlots = makeInFlight();
	hostSlots.tryAcquire(mod.HOST_SLOT_KEY, 1);
	const host = harness({ redis: withDeferRecords(fakeRedis()), hostBound: { slots: hostSlots, limit: () => 1 }, extra: { hostName: "mini1" } });
	const h1 = ghJob("gh-host", "o/a");
	await assert.rejects(() => host.processor(h1.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.deepEqual(reasonOf(host.redis, h1.job), busyAt("host-slot"));
	assert.equal(deferRecordOf(host.redis, h1.job.id).host, "mini1", "the host it waits on, the worker's own name");

	// A local folder, then a chained child of the run that holds it: the chain names its parent.
	const folder = harness({ redis: withDeferRecords(fakeRedis()) });
	const run = folder.processor(localJob("l-1", "/srv/site").job, "tok", new AbortController().signal);
	await folder.untilStarted(1);
	const l2 = localJob("l-2", "/srv/site");
	await assert.rejects(() => folder.processor(l2.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.deepEqual(reasonOf(folder.redis, l2.job), busyAt("scope-folder"));
	const child = spyJob("l-3", { kind: "local", folder: "/srv/site", flow: "tidy", task: "t", parentJobId: "l-1", chainDepth: 1 });
	await assert.rejects(() => folder.processor(child.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.deepEqual(reasonOf(folder.redis, child.job), busyAt("chained", { holder: "l-1" }));
	folder.releaseNext();
	await run;

	// A repository's row, in process and across the fleet.
	const repo = harness({ redis: withDeferRecords(fakeRedis()), limits: limitsOf([{ scope: "acme/web", concurrent: 1 }]) });
	const held = repo.processor(ghJob("g-1", "acme/web").job, "tok", new AbortController().signal);
	await repo.untilStarted(1);
	const g2 = ghJob("g-2", "acme/web");
	await assert.rejects(() => repo.processor(g2.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.deepEqual(reasonOf(repo.redis, g2.job), busyAt("scope-repo"));
	repo.releaseNext();
	await held;
	const fleetRepo = harness({ redis: withDeferRecords(fakeRedis()), limits: limitsOf([{ scope: "acme/web", concurrent: 1 }]), extra: { scopeLease: nobody } });
	const g3 = ghJob("g-3", "acme/web");
	await assert.rejects(() => fleetRepo.processor(g3.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.deepEqual(reasonOf(fleetRepo.redis, g3.job), busyAt("scope-repo"));

	// A project's row, in process and across the fleet, with the pickup project named.
	const project = harness({ redis: withDeferRecords(fakeRedis()), limits: limitsOf2([{ scope: "project:shop", concurrent: 1 }]), extra: { projects: () => SHOP } });
	const p1 = project.processor(localJob("p-1", "/srv/shop-a").job, "tok", new AbortController().signal);
	await project.untilStarted(1);
	const p2 = localJob("p-2", "/srv/shop-b");
	await assert.rejects(() => project.processor(p2.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.deepEqual(reasonOf(project.redis, p2.job), busyAt("scope-project", { project: "shop" }));
	// A chained child held at its PROJECT's row waits on the project's limit, not on its parent.
	const pc = spyJob("p-3", { kind: "local", folder: "/srv/shop-b", flow: "tidy", task: "t", parentJobId: "p-1", chainDepth: 1 });
	await assert.rejects(() => project.processor(pc.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.deepEqual(reasonOf(project.redis, pc.job), busyAt("scope-project", { project: "shop" }));
	project.releaseNext();
	await p1;
	const fleetProject = harness({ redis: withDeferRecords(fakeRedis()), limits: limitsOf2([{ scope: "project:shop", concurrent: 1 }]), extra: { projects: () => SHOP, scopeLease: nobody } });
	const p4 = localJob("p-4", "/srv/shop-a");
	await assert.rejects(() => fleetProject.processor(p4.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.deepEqual(reasonOf(fleetProject.redis, p4.job), busyAt("scope-project", { project: "shop" }));

	// A model endpoint with every slot taken names the endpoint.
	const endpointSlots = makeInFlight();
	endpointSlots.tryAcquire(OLLAMA.id, OLLAMA.slots);
	const w = endpointWiring({ endpointSlots, lease: false });
	const ep = harness({ redis: withDeferRecords(fakeRedis()), getSettings: LOCAL_MODEL, extra: w.extra });
	const e1 = localJob("e-1", "/srv/a");
	await assert.rejects(() => ep.processor(e1.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.deepEqual(reasonOf(ep.redis, e1.job), { why: "endpoint", bucket: "slot", until: NOW + mod.ENDPOINT_BUSY_RECHECK_MS, project: null, holder: null, endpoint: "lan-ollama" });
});

test("the host slot's and an endpoint's deferral name the project the pickup resolved, beside their own fields", { skip }, async () => {
	// The cases above run with no projects, so a record that dropped its project read the same; here the job is a member.
	const hostSlots = makeInFlight();
	hostSlots.tryAcquire(mod.HOST_SLOT_KEY, 1);
	const host = harness({ redis: withDeferRecords(fakeRedis()), hostBound: { slots: hostSlots, limit: () => 1 }, extra: { hostName: "mini1", projects: () => SHOP } });
	const h1 = ghJob("gh-host-shop", "acme/web");
	await assert.rejects(() => host.processor(h1.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.deepEqual(reasonOf(host.redis, h1.job), busyAt("host-slot", { project: "shop" }));

	const endpointSlots = makeInFlight();
	endpointSlots.tryAcquire(OLLAMA.id, OLLAMA.slots);
	const w = endpointWiring({ endpointSlots, lease: false });
	const ep = harness({ redis: withDeferRecords(fakeRedis()), getSettings: LOCAL_MODEL, extra: { ...w.extra, projects: () => SHOP } });
	const e1 = localJob("e-shop", "/srv/shop-a");
	await assert.rejects(() => ep.processor(e1.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.deepEqual(reasonOf(ep.redis, e1.job), { why: "endpoint", bucket: "slot", until: NOW + mod.ENDPOINT_BUSY_RECHECK_MS, project: "shop", holder: null, endpoint: "lan-ollama" });
});

// --- waiting for a busy scope: a backoff per scope, and one episode per job in the log (issue #1023) -------------------

/**
 * A harness on a clock the test moves. A scope's slot can be held and given back from outside, straight on the in-flight
 * map the processor reads, so a test decides when a waiting job finds its scope free without running the holder; a take
 * THROUGH the processor (which is what starts a scope's cadence over) is a real pickup, held open like every other.
 */
function onAClock(options = {}) {
	const clock = options.clock ?? { at: NOW };
	const h = harness({ ...options, extra: { ...options.extra, now: () => clock.at } });
	const lines = (event, id = null) => h.seen.logs.filter((l) => l.event === event && (id === null || l.fields.jobId === id)).map((l) => l.fields);
	/** One pickup of `spy` at `at` that a gate defers: how far out the job was moved. */
	const deferredAt = async (spy, at) => {
		clock.at = at;
		await assert.rejects(() => h.processor(spy.job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
		return spy.moves.at(-1).ts - at;
	};
	/**
	 * The pickups of a job that waits: one at `from`, then each at the instant the deferral before it named, for as long
	 * as that instant is before `until`. The delays, and `due`, when the job comes back next. A scope nobody is deferred
	 * on for longer than a job can be away starts over, so a wait is walked like this and never probed an hour apart.
	 */
	const wakes = async (spy, from, until) => {
		const delays = [];
		let due = from;
		while (due < until) {
			delays.push(await deferredAt(spy, due));
			due += delays.at(-1);
		}
		return { delays, due };
	};
	/**
	 * One pickup of `spy` at `at` that gets through every gate: `{ run }`, its run held open until `h.releaseNext()`
	 * (an object, since an async function that returned the run itself would wait for it to end).
	 */
	const startedAt = async (spy, at) => {
		clock.at = at;
		const before = h.seen.started;
		const run = h.processor(spy.job, "tok", new AbortController().signal);
		// Not `untilStarted`: a pickup that did not get through never starts a container, and that wait would never return.
		let ended = null;
		run.then((result) => (ended = { result }), (error) => (ended = { error }));
		for (let i = 0; i < 1000 && h.seen.started === before && ended === null; i++) await new Promise((r) => setImmediate(r));
		assert.equal(h.seen.started, before + 1, `the job reached its container (${ended === null ? "nothing yet" : (ended.error?.name ?? "it returned")})`);
		return { run };
	};
	return { ...h, clock, lines, deferredAt, wakes, startedAt };
}
const S = 1000;
// A wait walked from NOW until the scope has been busy for 100s is sixteen deferrals: ten of 5s, five of 10s and the
// first of 20s, at 100s, which moves the job to 120s.
const WALKED = [...Array(10).fill(5 * S), ...Array(5).fill(10 * S), 20 * S];

test("a busy scope is asked for again after 5s, then 10s, then 20s as it stays busy, and never later (#1023)", { skip }, async () => {
	const h = onAClock();
	assert.ok(h.inFlight.tryAcquire("/srv/site", 1), "the folder is held elsewhere for the whole test");
	const b = localJob("w-1", "/srv/site");
	// By how long the scope has been busy with a job waiting for it: 5s for the first 50s, 10s for the next 50s, then 20s.
	const byBusy = [];
	for (const busy of [0, 25 * S, 50 * S - 1, 50 * S, 75 * S, 100 * S - 1, 100 * S, 125 * S, 150 * S]) byBusy.push(await h.deferredAt(b, NOW + busy));
	assert.deepEqual(byBusy, [5 * S, 5 * S, 5 * S, 10 * S, 10 * S, 10 * S, 20 * S, 20 * S, 20 * S]);
	assert.equal(h.seen.started, 0, "and no deferral started a container");

	// Wake by wake on a scope of its own, each pickup at the instant the last deferral named: ten at 5s, five at 10s,
	// then 20s, which is 100 wakes across a 30-minute hold where the fixed 5s made 360.
	const walk = onAClock();
	assert.ok(walk.inFlight.tryAcquire("/srv/site", 1));
	const d = localJob("w-2", "/srv/site");
	const half = await walk.wakes(d, NOW, NOW + 1800 * S);
	assert.deepEqual(half.delays.slice(0, 18), [...WALKED, 20 * S, 20 * S]);
	assert.equal(half.delays.length, 100);
	const hour = await walk.wakes(d, half.due, NOW + 3600 * S);
	assert.deepEqual([hour.delays.length, ...new Set(hour.delays)], [90, mod.SCOPE_BUSY_RECHECK_MAX_MS], "an hour in it is still 20s, where the wait gate's own backoff says fifteen minutes");
});

test("every job waiting for one scope gets the same delay, however long each has waited itself (#1023)", { skip }, async () => {
	// A delay per job let a job that had just arrived (5s) take a freed scope ahead of one that had waited an hour (20s).
	const h = onAClock();
	assert.ok(h.inFlight.tryAcquire("/srv/site", 1));
	const old = localJob("w-old", "/srv/site");
	const fresh = localJob("w-fresh", "/srv/site");
	assert.deepEqual(await h.wakes(old, NOW, NOW + 101 * S), { delays: WALKED, due: NOW + 120 * S });
	assert.equal(await h.deferredAt(fresh, NOW + 110 * S), 20 * S, "the job that has just arrived gets the scope's delay, not a first 5s of its own");
	assert.equal(await h.deferredAt(old, NOW + 120 * S), 20 * S);
	assert.deepEqual(h.lines("scope_busy_deferred", "w-fresh"), [{ jobId: "w-fresh", kind: "local", delayMs: 20 * S }], "and its first line says that delay");
	// Another scope is another cadence: a job waiting for a folder that has only now become busy starts at 5s.
	assert.ok(h.inFlight.tryAcquire("/srv/other", 1));
	assert.equal(await h.deferredAt(localJob("w-other", "/srv/other"), NOW + 120 * S), 5 * S);
});

test("a job that takes a scope starts its cadence over: the jobs behind the new holder ask at 5s again (#1023)", { skip }, async () => {
	const h = onAClock();
	assert.ok(h.inFlight.tryAcquire("/srv/site", 1));
	const first = localJob("w-1", "/srv/site");
	const second = localJob("w-2", "/srv/site");
	assert.equal((await h.wakes(first, NOW, NOW + 200 * S)).due, NOW + 200 * S, "twenty deferrals: the sixteen to 120s and four more of 20s");
	assert.equal(await h.deferredAt(second, NOW + 190 * S), 20 * S, "both wait at the scope's 20s");
	// The holder ends and the first job takes the folder, through the processor: a new holder.
	h.inFlight.release("/srv/site");
	try {
		const { run } = await h.startedAt(first, NOW + 200 * S);
		assert.deepEqual(h.lines("scope_busy_ended"), [{ jobId: "w-1", kind: "local", waitedMs: 200 * S, deferrals: 20 }]);
		// Behind the new holder the second job's cadence starts over, and backs off from that deferral, not from the first
		// holder's time: ten of 5s from 210s on, then 10s.
		assert.deepEqual(await h.wakes(second, NOW + 210 * S, NOW + 261 * S), { delays: [...Array(10).fill(5 * S), 10 * S], due: NOW + 270 * S });
		assert.equal(h.lines("scope_busy_deferred", "w-2").length, 1, "still the second job's one wait");
		h.releaseNext();
		assert.equal((await run).outcome, "completed");
		const { run: last } = await h.startedAt(second, NOW + 270 * S);
		assert.deepEqual(h.lines("scope_busy_ended").at(-1), { jobId: "w-2", kind: "local", waitedMs: 80 * S, deferrals: 12 }, "20s, ten of 5s and 10s");
		h.releaseNext();
		await last;
	} finally {
		// Whatever the assertions said: a run left held open keeps the processor's timers, and the file with them.
		h.releaseNext();
	}
});

test("a take starts over the cadence of the scopes the job took, and of no other scope (#1023)", { skip }, async () => {
	const h = onAClock();
	assert.ok(h.inFlight.tryAcquire("/srv/a", 1) && h.inFlight.tryAcquire("/srv/b", 1));
	const a = localJob("t-a", "/srv/a");
	const b = localJob("t-b", "/srv/b");
	// Two folders, each with a job that has waited for it 120s, in step.
	let due = NOW;
	while (due < NOW + 101 * S) {
		const delay = await h.deferredAt(a, due);
		assert.equal(await h.deferredAt(b, due), delay);
		due += delay;
	}
	h.inFlight.release("/srv/a");
	try {
		const { run } = await h.startedAt(a, due);
		assert.equal(await h.deferredAt(b, due), 20 * S, "the other folder has no new holder: its cadence goes on");
		h.releaseNext();
		await run;
	} finally {
		h.releaseNext();
	}
});

test("a job that takes one slot and is deferred at the next gate has not taken it: the jobs waiting for that slot keep their cadence (#1023)", { skip }, async () => {
	// Every slot a later scope gate can follow: the folder's identity before the scope, the scope before the project row
	// and before its own fleet lease, the project row before its fleet lease.
	const project = { limits: limitsOf2([{ scope: "project:shop", concurrent: 1 }]) };
	const local = (folder) => (id) => localJob(id, folder);
	const cases = [
		{ name: "the folder's identity, then the scope", options: { extraDeps: { localWorkspaceIdentity: () => ({ key: "ws:1:2" }) } }, slot: "ws:1:2", next: "/srv/site", waiting: local("/srv/site"), passing: local("/srv/site"), fields: {} },
		{ name: "the scope, then the project row", options: { ...project, extra: { projects: () => SHOP } }, slot: "/srv/shop-a", next: "project:shop", waiting: local("/srv/shop-a"), passing: local("/srv/shop-a"), fields: { ledger: "project" } },
		{ name: "the scope, then its fleet lease", options: { limits: limitsOf([{ scope: "acme/web", concurrent: 1 }]), extra: { scopeLease: nobody } }, slot: "acme/web", next: null, waiting: (id) => ghJob(id, "acme/web"), passing: (id) => ghJob(id, "acme/web"), fields: { where: "fleet" }, kind: "forge" },
		{ name: "the project row, then its fleet lease", options: { ...project, extra: { projects: () => SHOP, scopeLease: nobody } }, slot: "project:shop", next: null, waiting: local("/srv/shop-a"), passing: local("/srv/shop-b"), fields: { ledger: "project", where: "fleet" } },
	];
	for (const c of cases) {
		const h = onAClock(c.options);
		assert.ok(h.inFlight.tryAcquire(c.slot, 1), c.name);
		const waiting = c.waiting("o-1");
		assert.equal((await h.wakes(waiting, NOW, NOW + 101 * S)).due, NOW + 120 * S, c.name);
		// The slot comes free while the next gate is shut. Another job gets the slot, is deferred at that gate and gives
		// the slot back; then someone takes the slot for a run before the waiting job returns.
		h.inFlight.release(c.slot);
		if (c.next) assert.ok(h.inFlight.tryAcquire(c.next, 1), c.name);
		assert.equal(await h.deferredAt(c.passing("o-2"), NOW + 105 * S), 5 * S, `${c.name}: deferred at the next gate, at that gate's own first 5s`);
		assert.deepEqual(h.lines("scope_busy_deferred", "o-2"), [{ jobId: "o-2", kind: c.kind ?? "local", delayMs: 5 * S, ...c.fields }], c.name);
		assert.equal(h.inFlight.count(c.slot), 0, `${c.name}: the slot went back with that deferral`);
		assert.ok(h.inFlight.tryAcquire(c.slot, 1), c.name);
		assert.equal(await h.deferredAt(waiting, NOW + 120 * S), 20 * S, `${c.name}: a job that held the slot for one pickup started nothing over`);
	}
});

test("a job that takes its scope leaves its place among the jobs waiting for the scope it last waited for, whatever it took (#1023)", { skip }, async () => {
	// The limits file is read at every pickup. A row that is gone when the waiting job returns names a slot the job no
	// longer takes, so its take starts nothing over there; that the job has left is what does.
	const row = limitsOf2([{ scope: "project:shop", concurrent: 1 }]);
	let limits = row;
	const h = onAClock({ extra: { projects: () => SHOP, scopedLimits: () => limits } });
	assert.ok(h.inFlight.tryAcquire("project:shop", 1));
	const waited = localJob("l-1", "/srv/shop-a");
	assert.equal((await h.wakes(waited, NOW, NOW + 101 * S)).due, NOW + 120 * S);
	limits = [];
	try {
		const { run } = await h.startedAt(waited, NOW + 120 * S);
		assert.deepEqual(h.lines("scope_busy_ended"), [{ jobId: "l-1", kind: "local", waitedMs: 120 * S, deferrals: 16 }]);
		limits = row;
		assert.equal(await h.deferredAt(localJob("l-2", "/srv/shop-b"), NOW + 125 * S), 5 * S, "nobody is left waiting for the project's slot, so its cadence starts over");
		h.releaseNext();
		await run;
	} finally {
		h.releaseNext();
	}
});

test("a scope nobody has been deferred on for 30s starts over at 5s: a fleet lease behind a job another host ran (#1023)", { skip }, async () => {
	// This host deferred a job on the repository's fleet lease until the lease's cadence was at 20s. Another host then
	// ran the job: this worker sees no take and no end, and still remembers the job waiting.
	let taken = true;
	const lease = { acquire: async () => (taken ? null : { release: async () => {} }) };
	const fleet = (extra = {}) => onAClock({ limits: limitsOf([{ scope: "acme/web", concurrent: 1 }]), extra: { scopeLease: lease, ...extra } });
	const h = fleet();
	assert.deepEqual((await h.wakes(ghJob("d-1", "acme/web"), NOW, NOW + 101 * S)).delays, WALKED);
	// Six hours later another job comes to wait for that lease, which is free 3s after.
	const later = NOW + 6 * 3600 * S;
	const next = ghJob("d-2", "acme/web");
	assert.equal(await h.deferredAt(next, later), 5 * S, "not the 20s of a wait that ended hours ago");
	assert.deepEqual(h.lines("scope_busy_deferred", "d-2"), [{ jobId: "d-2", kind: "forge", delayMs: 5 * S, where: "fleet" }]);
	taken = false;
	try {
		const { run } = await h.startedAt(next, later + 5 * S);
		assert.deepEqual(h.lines("scope_busy_ended"), [{ jobId: "d-2", kind: "forge", waitedMs: 5 * S, deferrals: 1 }], "and the job another host ran never says its end line here");
		h.releaseNext();
		await run;
	} finally {
		h.releaseNext();
		taken = true;
	}

	// Where the line is: 30s after the last deferral is a job 10s late for its 20s, still the same wait. A moment more
	// and it is not.
	for (const [quiet, delay] of [[30 * S, 20 * S], [30 * S + 1, 5 * S]]) {
		const edge = fleet();
		await edge.wakes(ghJob("d-1", "acme/web"), NOW, NOW + 101 * S);
		assert.equal(await edge.deferredAt(ghJob("d-2", "acme/web"), NOW + 100 * S + quiet), delay, `${quiet}ms after the last deferral`);
	}
	assert.equal(mod.SCOPE_BUSY_QUIET_MS, 30 * S);

	// The job that is remembered and gone holds nothing of the new wait: when the job that started it over leaves (here
	// a failed pickup), the lease has no waiter and its cadence goes with it.
	let pause = null;
	const left = fleet({ pauseUntil: () => pause?.() ?? null });
	await left.wakes(ghJob("d-1", "acme/web"), NOW, NOW + 101 * S);
	const failing = ghJob("d-2", "acme/web");
	assert.deepEqual((await left.wakes(failing, later, later + 51 * S)).delays, [...Array(10).fill(5 * S), 10 * S]);
	pause = () => {
		throw new Error("unreadable");
	};
	left.clock.at = later + 60 * S;
	await assert.rejects(() => left.processor(failing.job, "tok", new AbortController().signal), /unreadable/);
	pause = null;
	assert.equal(await left.deferredAt(ghJob("d-3", "acme/web"), later + 65 * S), 5 * S);
});

test("jobs that come back to a scope after it went quiet go on with their waits, at a cadence that starts over for all of them (#1023)", { skip }, async () => {
	// Two jobs wait for one folder and are both away for an hour: a pause window held them, or the worker had no free
	// slot to pick them up with. They are late, not gone.
	const h = onAClock();
	assert.ok(h.inFlight.tryAcquire("/srv/site", 1));
	const a = localJob("q-a", "/srv/site");
	const b = localJob("q-b", "/srv/site");
	let due = NOW;
	while (due < NOW + 101 * S) {
		const delay = await h.deferredAt(a, due);
		assert.equal(await h.deferredAt(b, due), delay);
		due += delay;
	}
	const back = NOW + 3600 * S;
	assert.equal(await h.deferredAt(a, back), 5 * S, "the folder's cadence starts over");
	assert.equal(await h.deferredAt(b, back + 1 * S), 5 * S, "for every job waiting there");
	assert.deepEqual(h.lines("scope_busy_deferred").map((l) => l.jobId), ["q-a", "q-b"], "and neither says its first line again");
	assert.equal(await h.deferredAt(a, back + 25 * S), 5 * S);
	assert.equal(await h.deferredAt(a, back + 50 * S), 10 * S, "backing off from the deferral that started it over");
	assert.equal(await h.deferredAt(b, back + 55 * S), 10 * S);
	h.inFlight.release("/srv/site");
	try {
		const { run } = await h.startedAt(a, back + 60 * S);
		assert.deepEqual(h.lines("scope_busy_ended"), [{ jobId: "q-a", kind: "local", waitedMs: 140 * S, deferrals: 19 }], "one wait, counted whole: 120s before the hour and 20s after");
		h.releaseNext();
		await run;
	} finally {
		h.releaseNext();
	}
});

test("a wait for a busy scope is one episode in the log: a line at its first deferral, one when the job takes its scope, and a later wait of the same job says both again (#1023)", { skip }, async () => {
	// The model server's one slot is taken elsewhere, so the job is deferred again right after it has its folder: it
	// gives the folder back, and can come to wait for it a second time.
	const endpointSlots = makeInFlight();
	const h = onAClock({ getSettings: LOCAL_MODEL, extra: endpointWiring({ endpointSlots, lease: false }).extra });
	assert.ok(endpointSlots.tryAcquire(OLLAMA.id, OLLAMA.slots));
	assert.ok(h.inFlight.tryAcquire("/srv/site", 1));
	const b = localJob("w-1", "/srv/site");

	assert.deepEqual(await h.wakes(b, NOW, NOW + 51 * S), { delays: [...Array(10).fill(5 * S), 10 * S], due: NOW + 60 * S });
	assert.deepEqual(h.lines("scope_busy_deferred"), [{ jobId: "w-1", kind: "local", delayMs: 5 * S }], "eleven deferrals, one line, with the fields it always had");
	assert.deepEqual(h.lines("scope_busy_ended"), [], "nothing ends while the job still waits");

	h.inFlight.release("/srv/site");
	assert.equal(await h.deferredAt(b, NOW + 60 * S), mod.ENDPOINT_BUSY_RECHECK_MS, "it took its folder, and the next gate deferred it");
	assert.deepEqual(h.lines("scope_busy_ended"), [{ jobId: "w-1", kind: "local", waitedMs: 60 * S, deferrals: 11 }], "ten of 5s and one of 10s: the delays its scope gave it");
	assert.equal(h.inFlight.count("/srv/site"), 0, "the folder went back with that deferral");
	await h.deferredAt(b, NOW + 67 * S);
	assert.equal(h.lines("scope_busy_ended").length, 1, "a pickup that did not wait for its scope ends no episode");
	assert.equal(h.lines("scope_busy_deferred").length, 1);

	// The folder is taken again before the job is back: a second wait, said as the first was.
	assert.ok(h.inFlight.tryAcquire("/srv/site", 1));
	assert.equal(await h.deferredAt(b, NOW + 74 * S), 5 * S, "its own take started the folder's cadence over");
	await h.deferredAt(b, NOW + 79 * S);
	assert.deepEqual(h.lines("scope_busy_deferred"), [{ jobId: "w-1", kind: "local", delayMs: 5 * S }, { jobId: "w-1", kind: "local", delayMs: 5 * S }]);
	h.inFlight.release("/srv/site");
	await h.deferredAt(b, NOW + 84 * S);
	assert.deepEqual(h.lines("scope_busy_ended").at(-1), { jobId: "w-1", kind: "local", waitedMs: 10 * S, deferrals: 2 });
	assert.equal(h.lines("scope_busy_ended").length, 2);
});

test("waitedMs is the delays the scope gates gave the job, not the time between the two lines (#1023)", { skip }, async () => {
	// Deferred once by its folder, then held eight hours by a pause window while the folder was long free: the scope
	// cost this job five seconds. The window neither ends the episode nor adds to it.
	let pause = null;
	const h = onAClock({ pauseUntil: () => pause });
	assert.ok(h.inFlight.tryAcquire("/srv/site", 1));
	const b = localJob("w-1", "/srv/site");
	assert.equal(await h.deferredAt(b, NOW), 5 * S);
	h.inFlight.release("/srv/site");
	pause = NOW + 8 * 3600 * S;
	assert.equal(await h.deferredAt(b, NOW + 5 * S), 8 * 3600 * S - 5 * S, "deferred to the window's end, by the pause gate");
	assert.deepEqual(h.lines("scope_busy_ended"), [], "another gate's deferral ends no episode");
	pause = null;
	try {
		const { run } = await h.startedAt(b, NOW + 8 * 3600 * S);
		assert.deepEqual(h.lines("scope_busy_ended"), [{ jobId: "w-1", kind: "local", waitedMs: 5 * S, deferrals: 1 }]);
		assert.equal(h.lines("scope_busy_deferred").length, 1);
		h.releaseNext();
		await run;
	} finally {
		h.releaseNext();
	}
});

test("a job added again under the id of one that was removed while it waited starts its own episode (#1023)", { skip }, async () => {
	// A cancel or a removal of a delayed job never reaches the processor, and a forge delivery's id can come back. The
	// job's own timestamp tells the two apart.
	const h = onAClock();
	const again = (timestamp) => {
		const spy = localJob("gh:acme/web#7", "/srv/site");
		spy.job.timestamp = timestamp;
		return spy;
	};
	assert.ok(h.inFlight.tryAcquire("/srv/site", 1));
	await h.wakes(again(NOW - 60 * S), NOW, NOW + 101 * S);
	// Ten seconds after the removed job's last deferral a new job has that id, and the folder is as busy as it was.
	const later = NOW + 110 * S;
	const added = again(later);
	assert.equal(await h.deferredAt(added, later), 5 * S, "nobody was left waiting for the folder, so its cadence starts over too");
	assert.equal(h.lines("scope_busy_deferred", "gh:acme/web#7").length, 2, "the new job says its own first line");
	h.inFlight.release("/srv/site");
	// And one that finds its folder free says nothing of the wait an earlier job under its id left behind.
	const quiet = onAClock();
	assert.ok(quiet.inFlight.tryAcquire("/srv/site", 1));
	await quiet.deferredAt(again(NOW - 60 * S), NOW);
	quiet.inFlight.release("/srv/site");
	try {
		const { run } = await h.startedAt(added, later + 5 * S);
		assert.deepEqual(h.lines("scope_busy_ended"), [{ jobId: "gh:acme/web#7", kind: "local", waitedMs: 5 * S, deferrals: 1 }], "its own wait, none of the removed job's");
		h.releaseNext();
		await run;
		const { run: free } = await quiet.startedAt(again(later), later);
		assert.deepEqual(quiet.lines("scope_busy_ended"), [], "no wait of this job ended");
		quiet.releaseNext();
		await free;
	} finally {
		h.releaseNext();
		quiet.releaseNext();
	}
});

test("every scope gate shares the one backoff and the one episode: the folder's identity, the scope, its fleet lease, the project row and its fleet lease (#1023)", { skip }, async () => {
	const project = { limits: limitsOf2([{ scope: "project:shop", concurrent: 1 }]) };
	const gates = [
		{ name: "the folder's identity", options: { extraDeps: { localWorkspaceIdentity: () => ({ key: "ws:1:2" }) } }, hold: "ws:1:2", job: () => localJob("g-1", "/srv/site"), fields: {} },
		{ name: "the scope", options: {}, hold: "/srv/site", job: () => localJob("g-1", "/srv/site"), fields: {} },
		{ name: "the scope's fleet lease", options: { limits: limitsOf([{ scope: "acme/web", concurrent: 1 }]), extra: { scopeLease: nobody } }, hold: null, job: () => ghJob("g-1", "acme/web"), fields: { where: "fleet" }, kind: "forge" },
		{ name: "the project row", options: { ...project, extra: { projects: () => SHOP } }, hold: "project:shop", job: () => localJob("g-1", "/srv/shop-a"), fields: { ledger: "project" } },
		{ name: "the project's fleet lease", options: { ...project, extra: { projects: () => SHOP, scopeLease: nobody } }, hold: null, job: () => localJob("g-1", "/srv/shop-a"), fields: { ledger: "project", where: "fleet" } },
	];
	for (const gate of gates) {
		const h = onAClock(gate.options);
		if (gate.hold) assert.ok(h.inFlight.tryAcquire(gate.hold, 1), gate.name);
		assert.deepEqual((await h.wakes(gate.job(), NOW, NOW + 101 * S)).delays, WALKED, gate.name);
		assert.deepEqual(h.lines("scope_busy_deferred"), [{ jobId: "g-1", kind: gate.kind ?? "local", delayMs: 5 * S, ...gate.fields }], `${gate.name}: one line, with the gate's own fields`);
		assert.equal(h.seen.started, 0, gate.name);
	}
});

test("a scope's slot and its fleet lease are two things to wait for, each with its own cadence, and a take of the lease starts the lease's over (#1023)", { skip }, async () => {
	// A job that gets one of the repository's two slots here and is refused the fleet's lease waits for the lease, not
	// for the slot it took and gave back.
	let free = 0;
	const lease = { acquire: async () => (free > 0 ? (free--, { release: async () => {} }) : null) };
	const h = onAClock({ limits: limitsOf([{ scope: "acme/web", concurrent: 2 }]), extra: { scopeLease: lease } });
	try {
		const a = ghJob("g-1", "acme/web");
		assert.equal((await h.wakes(a, NOW, NOW + 101 * S)).due, NOW + 120 * S);
		assert.equal(h.inFlight.count("acme/web"), 0, "the slot went back with each deferral");
		// Both slots are now held here, and a job is deferred on them for the first time: the slot's own 5s, while the
		// lease has been waited for long enough to be at 20s.
		assert.ok(h.inFlight.tryAcquire("acme/web", 2) && h.inFlight.tryAcquire("acme/web", 2));
		assert.equal(await h.deferredAt(ghJob("g-2", "acme/web"), NOW + 110 * S), 5 * S);
		assert.deepEqual(h.lines("scope_busy_deferred", "g-2"), [{ jobId: "g-2", kind: "forge", delayMs: 5 * S }]);
		h.inFlight.release("acme/web");
		h.inFlight.release("acme/web");
		assert.equal(await h.deferredAt(a, NOW + 120 * S), 20 * S, "the lease's cadence went on");
		const c = ghJob("g-3", "acme/web");
		assert.equal(await h.deferredAt(c, NOW + 125 * S), 20 * S, "and every job waiting for the lease shares it");
		assert.deepEqual(h.lines("scope_busy_deferred", "g-3"), [{ jobId: "g-3", kind: "forge", delayMs: 20 * S, where: "fleet" }]);
		// One lease comes free and the first job takes a slot and the lease: one end line for its one wait, and the job
		// still waiting for a lease is behind a new holder.
		free = 1;
		const { run } = await h.startedAt(a, NOW + 140 * S);
		assert.deepEqual(h.lines("scope_busy_ended"), [{ jobId: "g-1", kind: "forge", waitedMs: 140 * S, deferrals: 17 }]);
		assert.equal(await h.deferredAt(c, NOW + 145 * S), 5 * S, "the lease's cadence starts over at its take");
		h.releaseNext();
		assert.equal((await run).outcome, "completed");
	} finally {
		h.releaseNext();
	}
});

test("a project's slot and its fleet lease are two things to wait for as well (#1023)", { skip }, async () => {
	const h = onAClock({ limits: limitsOf2([{ scope: "project:shop", concurrent: 2 }]), extra: { projects: () => SHOP, scopeLease: nobody } });
	const a = localJob("p-1", "/srv/shop-a");
	assert.equal((await h.wakes(a, NOW, NOW + 101 * S)).due, NOW + 120 * S);
	assert.deepEqual(h.lines("scope_busy_deferred", "p-1"), [{ jobId: "p-1", kind: "local", delayMs: 5 * S, ledger: "project", where: "fleet" }]);
	// Both of the project's slots are now held here: a job deferred on them waits for the slot, from its own 5s.
	assert.ok(h.inFlight.tryAcquire("project:shop", 2) && h.inFlight.tryAcquire("project:shop", 2));
	assert.equal(await h.deferredAt(localJob("p-2", "/srv/shop-b"), NOW + 110 * S), 5 * S);
	assert.deepEqual(h.lines("scope_busy_deferred", "p-2"), [{ jobId: "p-2", kind: "local", delayMs: 5 * S, ledger: "project" }]);
	h.inFlight.release("project:shop");
	h.inFlight.release("project:shop");
	assert.equal(await h.deferredAt(a, NOW + 120 * S), 20 * S, "the lease's cadence went on");
});

test("jobs that name one folder by two paths wait for its one identity, at one cadence (#1023)", { skip }, async () => {
	const h = onAClock({ extraDeps: { localWorkspaceIdentity: () => ({ key: "ws:1:2" }) } });
	assert.ok(h.inFlight.tryAcquire("ws:1:2", 1));
	assert.equal((await h.wakes(localJob("i-1", "/srv/site"), NOW, NOW + 101 * S)).due, NOW + 120 * S);
	assert.equal(await h.deferredAt(localJob("i-2", "/srv/link"), NOW + 110 * S), 20 * S, "what is waited for is the identity, whatever path a job names it by");
});

test("a job that goes on to wait for another scope no longer counts as waiting for the first (#1023)", { skip }, async () => {
	// Its folder comes free while its project's row is full: from then on it waits for the project. Nobody is left
	// waiting for the folder, so the folder's cadence is forgotten, and the next job deferred there starts it over.
	const h = onAClock({ limits: limitsOf2([{ scope: "project:shop", concurrent: 1 }]), extra: { projects: () => SHOP } });
	assert.ok(h.inFlight.tryAcquire("/srv/shop-a", 1));
	const moved = localJob("m-1", "/srv/shop-a");
	assert.equal((await h.wakes(moved, NOW, NOW + 101 * S)).due, NOW + 120 * S);
	h.inFlight.release("/srv/shop-a");
	assert.ok(h.inFlight.tryAcquire("project:shop", 1));
	assert.equal(await h.deferredAt(moved, NOW + 120 * S), 5 * S, "the project's own cadence, begun by this deferral");
	assert.equal(h.lines("scope_busy_deferred", "m-1").length, 1, "one wait all the same");
	assert.ok(h.inFlight.tryAcquire("/srv/shop-a", 1), "the folder is taken again");
	assert.equal(await h.deferredAt(localJob("m-2", "/srv/shop-a"), NOW + 125 * S), 5 * S, "and its cadence starts over: the job that waited for it has moved on");
});

test("the defer record is written on every deferral of a wait, with the instant that deferral moved the job to (#1023)", { skip }, async () => {
	// The console's reader holds a record to its job's due time, so a record written once per wait would stop matching at
	// the second deferral. The backoff is what makes the writes fewer.
	const h = onAClock({ redis: withDeferRecords(fakeRedis()) });
	assert.ok(h.inFlight.tryAcquire("/srv/site", 1));
	const b = localJob("w-1", "/srv/site");
	let writes = 0;
	for (const [busy, delay] of [[0, 5 * S], [5 * S, 5 * S], [30 * S, 5 * S], [50 * S, 10 * S], [75 * S, 10 * S], [100 * S, 20 * S], [120 * S, 20 * S]]) {
		assert.equal(await h.deferredAt(b, NOW + busy), delay);
		assert.equal(h.redis.deferSent.length, ++writes, "one write for this deferral");
		assert.deepEqual(reasonOf(h.redis, b.job), { why: "scope-folder", bucket: "slot", until: NOW + busy + delay, project: null, holder: null, endpoint: null });
		assert.equal(b.moves.at(-1).ts, NOW + busy + delay, "the record's until is the instant the job moved to");
	}
	assert.equal(h.lines("scope_busy_deferred").length, 1, "seven records, one line");
});

test("a worker remembers at most WAIT_EPISODES_MAX waiting jobs, the one deferred longest ago dropped first, and no scope without one of them (#1023)", { skip }, async () => {
	// A folder each, so that what is kept of a scope can be told from what is kept of a job.
	const h = onAClock();
	const folder = (i) => `/srv/f-${i}`;
	const waiting = Array.from({ length: mod.WAIT_EPISODES_MAX }, (_, i) => localJob(`w-${i}`, folder(i)));
	for (const i of waiting.keys()) assert.ok(h.inFlight.tryAcquire(folder(i), 1));
	// The first three jobs have waited 50s by now, so their folders' cadence is at 10s; the others arrive now. Every job
	// is deferred at this instant, in order: the bound is reached, the first job the one deferred longest ago.
	const at = NOW + 50 * S;
	for (const spy of waiting.slice(0, 3)) assert.equal((await h.wakes(spy, NOW, at)).due, at);
	for (const [i, spy] of waiting.entries()) assert.equal(await h.deferredAt(spy, at), i < 3 ? 10 * S : 5 * S);
	// Five seconds on, the first job is deferred again: still the same wait, and now the newest entry.
	assert.equal(await h.deferredAt(waiting[0], at + 5 * S), 10 * S);
	assert.equal(h.lines("scope_busy_deferred", "w-0").length, 1);
	// One job more than the bound: the entry deferred longest ago goes, which is the second job's, not the first's.
	assert.ok(h.inFlight.tryAcquire("/srv/f-new", 1));
	await h.deferredAt(localJob("w-new", "/srv/f-new"), at + 5 * S);
	assert.equal(await h.deferredAt(waiting[0], at + 10 * S), 10 * S, "the job deferred a moment ago is still remembered, and its folder's cadence with it");
	assert.equal(h.lines("scope_busy_deferred", "w-0").length, 1);
	// The third job is still remembered, so its folder is: a newcomer there gets the folder's 10s. (Each newcomer is one
	// job more than the bound again, and drops the then-oldest: here the third job itself, after the delay was read.)
	assert.equal(await h.deferredAt(localJob("w-late-2", folder(2)), at + 10 * S), 10 * S, "a scope someone is remembered waiting for stays");
	// The second job's folder had no other job waiting, so it was forgotten with the job: a newcomer there starts the
	// folder's cadence over.
	assert.equal(await h.deferredAt(localJob("w-late-1", folder(1)), at + 10 * S), 5 * S, "a scope goes with its last remembered waiter");
	// And the dropped job itself, when it comes back, is a new wait: its first line again, at its folder's delay.
	assert.equal(await h.deferredAt(waiting[1], at + 11 * S), 5 * S);
	assert.equal(h.lines("scope_busy_deferred", "w-1").length, 2);
	assert.equal(h.seen.started, 0);
});

test("a waiting job that fails or ends before it reaches its scope again is forgotten, and its scope with it; one another gate defers is not (#1023)", { skip }, async () => {
	let pause = null;
	const settled = { outcome: "completed" };
	const h = onAClock({ pauseUntil: () => (typeof pause === "function" ? pause() : pause), extra: { settledRecord: async () => settled } });
	for (const folder of ["/srv/paused", "/srv/failed", "/srv/ended"]) assert.ok(h.inFlight.tryAcquire(folder, 1));
	const waited = [...Array(10).fill(5 * S), 10 * S];

	// A pause window defers the waiting job: it still waits for its folder, so the wait goes on where it stood.
	const paused = localJob("w-paused", "/srv/paused");
	assert.deepEqual(await h.wakes(paused, NOW, NOW + 51 * S), { delays: waited, due: NOW + 60 * S });
	pause = NOW + 80 * S;
	assert.equal(await h.deferredAt(paused, NOW + 60 * S), 20 * S, "deferred to the window's end, by the pause gate");
	pause = null;
	assert.equal(await h.deferredAt(paused, NOW + 80 * S), 10 * S, "the same wait, on a folder 80s busy");
	assert.equal(h.lines("scope_busy_deferred", "w-paused").length, 1);

	// A pickup that throws before the scope gates (here the pause windows' read) is a failed attempt, not a deferral.
	const failed = localJob("w-failed", "/srv/failed");
	assert.deepEqual(await h.wakes(failed, NOW, NOW + 51 * S), { delays: waited, due: NOW + 60 * S });
	pause = () => {
		throw new Error("unreadable");
	};
	h.clock.at = NOW + 60 * S;
	await assert.rejects(() => h.processor(failed.job, "tok", new AbortController().signal), /unreadable/);
	pause = null;
	assert.equal(await h.deferredAt(failed, NOW + 65 * S), 5 * S, "its retry waits anew, and nobody else waited for the folder, so that starts over too");
	assert.equal(h.lines("scope_busy_deferred", "w-failed").length, 2);

	// A pickup that returns before the scope gates (a stalled job whose record says the attempt finished) ends the job.
	const ended = localJob("w-ended", "/srv/ended");
	assert.deepEqual(await h.wakes(ended, NOW, NOW + 51 * S), { delays: waited, due: NOW + 60 * S });
	ended.job.stalledCounter = 1;
	h.clock.at = NOW + 60 * S;
	assert.equal((await h.processor(ended.job, "tok", new AbortController().signal)).outcome, "completed");
	ended.job.stalledCounter = 0;
	assert.equal(await h.deferredAt(ended, NOW + 65 * S), 5 * S, "a job of that id that waits again is a new wait, on a folder nobody was left waiting for");
	assert.equal(h.lines("scope_busy_deferred", "w-ended").length, 2);
	assert.deepEqual(h.lines("scope_busy_ended"), [], "and none of them took its scope, so no wait is said to have ended");
});

test("a logger that throws on the end-of-wait line leaves the job its slots and its run (#1023)", { skip }, async () => {
	// The line is said while the job holds its scope slots and before the processor's own try: a throw there would
	// keep the folder taken for good.
	const logs = [];
	const h = onAClock({
		extraDeps: {
			log: (event, fields) => {
				logs.push({ event, fields });
				if (event === "scope_busy_ended") throw new Error("EPIPE");
			},
		},
	});
	assert.ok(h.inFlight.tryAcquire("/srv/site", 1));
	const b = localJob("w-1", "/srv/site");
	await h.deferredAt(b, NOW);
	h.inFlight.release("/srv/site");
	h.clock.at = NOW + 5 * S;
	const run = h.processor(b.job, "tok", new AbortController().signal);
	// Not `untilStarted`: a pickup the throw ended never starts a container, and that wait would never return.
	let threw = null;
	run.catch((error) => (threw = error));
	for (let i = 0; i < 1000 && h.seen.started < 1 && threw === null; i++) await new Promise((r) => setImmediate(r));
	try {
		assert.equal(threw, null, "the logger's throw did not end the pickup");
		assert.equal(h.seen.started, 1, "the job reached its container");
		assert.equal(logs.filter((l) => l.event === "scope_busy_ended").length, 1, "the line was tried once");
	} finally {
		// Whatever the assertions said: a run left held open keeps the processor's timers, and the file with them.
		h.releaseNext();
	}
	assert.equal((await run).outcome, "completed");
	assert.equal(h.inFlight.count("/srv/site"), 0, "and the folder is free again");
});

test("the scope re-check's delays stay under the wait gate's floor and apart from every other gate's fixed re-check (#1023)", { skip }, async () => {
	// INT-WAIT-PROFILES-CONTRACT: where no defer record says why a job sits in the delayed set, its wake instant is the
	// evidence. The fixed re-checks are held apart here. A delay a gate computes is not: the wait gate's throttled re-ask
	// is the larger of 11s and a quarter of its backoff, plus jitter, and can come to 20s (at an 80s interval), which is
	// why the floor, and not this list, is the contract's rule.
	const { BUDGET_RECHECK_MS, NEVER_FITS_RECHECK_MS } = await import("../src/host-budget.mjs");
	const { WAIT_INTERVAL_FLOOR_MS, waitBackoffMs } = await import("../src/wait-for.mjs");
	// Every delay the scope gate can give, from the rule itself, over a day of a scope staying busy.
	const delays = new Set();
	for (let busy = 0; busy <= 86_400 * S; busy += 5 * S) delays.add(Math.min(waitBackoffMs(mod.SCOPE_BUSY_RECHECK_MS, busy), mod.SCOPE_BUSY_RECHECK_MAX_MS));
	assert.deepEqual([...delays], [5 * S, 10 * S, 20 * S]);
	const fixed = [mod.SUPERSEDE_RECHECK_MS, 11_000, mod.ENDPOINT_BUSY_RECHECK_MS, BUDGET_RECHECK_MS, NEVER_FITS_RECHECK_MS];
	for (const delay of delays) {
		assert.ok(delay < WAIT_INTERVAL_FLOOR_MS, `${delay} is under the wait floor`);
		assert.ok(!fixed.includes(delay), `${delay} is no other gate's fixed re-check (${fixed.join(", ")})`);
	}
	// A scope is quiet once the longest delay and the grace a late wake gets have both passed (SCOPE_BUSY_QUIET_MS).
	const { WAITING_DUE_GRACE_MS } = await import("../src/defer-reasons.mjs");
	assert.equal(mod.SCOPE_BUSY_QUIET_MS, mod.SCOPE_BUSY_RECHECK_MAX_MS + WAITING_DUE_GRACE_MS);
});

// --- a named worker: two queues, two processors, one memory of the waits (issue #1023) ---------------------------------

// The host queue of a worker named mini1, as `hostQueueName` spells it.
const HOST_QUEUE = "pi-jobs@mini1";
/** The job `spy` as BullMQ hands it to the host queue's processor: a job says which queue it is on. */
const onHostQueue = (spy) => {
	spy.job.queueName = HOST_QUEUE;
	return spy;
};
/**
 * A named worker's two processors as `createWorker` wires them: one in-flight map and one wait state for both, each on
 * the one clock the test moves.
 */
function twoQueues(options = {}) {
	const clock = { at: NOW };
	const inFlight = makeInFlight();
	const waitEpisodes = mod.makeWaitEpisodes();
	const of = () => onAClock({ ...options, clock, inFlight, extra: { ...options.extra, waitEpisodes } });
	return { clock, inFlight, shared: of(), host: of() };
}

test("a worker's two queues wait for one scope at one cadence, and a take on either queue starts it over for both (#1023)", { skip }, async () => {
	// One project slot. The project's local runs are on the host queue and its forge jobs on the shared one.
	const jobOn = { host: (id) => onHostQueue(localJob(id, "/srv/shop-a")), shared: (id) => ghJob(id, "acme/web") };
	const kindOn = { host: "local", shared: "forge" };
	for (const [waiting, arriving] of [["host", "shared"], ["shared", "host"]]) {
		const w = twoQueues({ limits: limitsOf2([{ scope: "project:shop", concurrent: 1 }]), extra: { projects: () => SHOP } });
		assert.ok(w.inFlight.tryAcquire("project:shop", 1), "the project's one slot is held");
		const old = jobOn[waiting]("n-old");
		assert.deepEqual(await w[waiting].wakes(old, NOW, NOW + 101 * S), { delays: WALKED, due: NOW + 120 * S }, waiting);
		const fresh = jobOn[arriving]("n-fresh");
		assert.equal(await w[arriving].deferredAt(fresh, NOW + 110 * S), 20 * S, `a job arriving on the ${arriving} queue gets the delay of the scope the ${waiting} queue's job waits for`);
		assert.deepEqual(w[arriving].lines("scope_busy_deferred"), [{ jobId: "n-fresh", kind: kindOn[arriving], delayMs: 20 * S, ledger: "project" }]);
		assert.equal(await w[waiting].deferredAt(old, NOW + 120 * S), 20 * S);
		// The slot comes free and the newcomer takes it, through its own queue's processor.
		w.inFlight.release("project:shop");
		try {
			const { run } = await w[arriving].startedAt(fresh, NOW + 130 * S);
			assert.equal(await w[waiting].deferredAt(old, NOW + 140 * S), 5 * S, `the take on the ${arriving} queue started the cadence over for the ${waiting} queue's job`);
			w[arriving].releaseNext();
			await run;
		} finally {
			w[arriving].releaseNext();
		}
	}
});

test("one job id on a worker's two queues is two jobs, each with its own wait (#1023)", { skip }, async () => {
	const w = twoQueues();
	assert.ok(w.inFlight.tryAcquire("/srv/site", 1));
	const onShared = localJob("same", "/srv/site");
	const onHost = onHostQueue(localJob("same", "/srv/site"));
	await w.shared.deferredAt(onShared, NOW);
	await w.host.deferredAt(onHost, NOW + 1 * S);
	assert.deepEqual([w.shared.lines("scope_busy_deferred").length, w.host.lines("scope_busy_deferred").length], [1, 1], "each says its first line");
	w.inFlight.release("/srv/site");
	try {
		const { run } = await w.shared.startedAt(onShared, NOW + 5 * S);
		assert.deepEqual(w.shared.lines("scope_busy_ended"), [{ jobId: "same", kind: "local", waitedMs: 5 * S, deferrals: 1 }], "its own deferral, not the other queue's job's too");
		await w.host.deferredAt(onHost, NOW + 6 * S);
		assert.equal(w.host.lines("scope_busy_deferred").length, 1, "the host queue's job is still in the wait it began");
		w.shared.releaseNext();
		await run;
		const { run: other } = await w.host.startedAt(onHost, NOW + 11 * S);
		assert.deepEqual(w.host.lines("scope_busy_ended"), [{ jobId: "same", kind: "local", waitedMs: 10 * S, deferrals: 2 }]);
		w.host.releaseNext();
		await other;
	} finally {
		w.shared.releaseNext();
		w.host.releaseNext();
	}
});

test("a job that leaves the host queue's processor is forgotten under its own queue, not the shared queue's job of that id (#1023)", { skip }, async () => {
	let pause = null;
	const w = twoQueues({ pauseUntil: () => pause?.() ?? null });
	assert.ok(w.inFlight.tryAcquire("/srv/site", 1));
	const onShared = localJob("same", "/srv/site");
	const onHost = onHostQueue(localJob("same", "/srv/site"));
	await w.shared.deferredAt(onShared, NOW);
	await w.host.deferredAt(onHost, NOW);
	// The host queue's job fails before the scope gates (here the pause windows' read).
	pause = () => {
		throw new Error("unreadable");
	};
	w.clock.at = NOW + 5 * S;
	await assert.rejects(() => w.host.processor(onHost.job, "tok", new AbortController().signal), /unreadable/);
	pause = null;
	await w.shared.deferredAt(onShared, NOW + 5 * S);
	assert.equal(w.shared.lines("scope_busy_deferred").length, 1, "the shared queue's job is still in the wait it began");
	await w.host.deferredAt(onHost, NOW + 10 * S);
	assert.equal(w.host.lines("scope_busy_deferred").length, 2, "and the failed job's retry waits anew");
});

test("the bound on remembered waits is the worker's, over both its queues (#1023)", { skip }, async () => {
	const w = twoQueues();
	const folder = (i) => `/srv/f-${i}`;
	// Half the bound on each queue, a folder each: the first job is on the shared queue, the second on the host queue.
	const queueOf = (i) => (i % 2 === 0 ? w.shared : w.host);
	const waiting = Array.from({ length: mod.WAIT_EPISODES_MAX }, (_, i) => (i % 2 === 0 ? localJob(`w-${i}`, folder(i)) : onHostQueue(localJob(`w-${i}`, folder(i)))));
	for (const [i, spy] of waiting.entries()) {
		assert.ok(w.inFlight.tryAcquire(folder(i), 1));
		await queueOf(i).deferredAt(spy, NOW);
	}
	// One job more, on the host queue: the wait deferred longest ago goes, and that one is the shared queue's.
	assert.ok(w.inFlight.tryAcquire("/srv/f-new", 1));
	await w.host.deferredAt(onHostQueue(localJob("w-new", "/srv/f-new")), NOW + 1 * S);
	await w.host.deferredAt(waiting[1], NOW + 5 * S);
	assert.equal(w.host.lines("scope_busy_deferred", "w-1").length, 1, "the second job is still remembered");
	await w.shared.deferredAt(waiting[0], NOW + 5 * S);
	assert.equal(w.shared.lines("scope_busy_deferred", "w-0").length, 2, "the first was dropped: it says its first line again");
});

test("published endpoint use is the shared processors' map for per-machine and unnamed workers, including deferral and release", { skip }, async () => {
	const { endpointStatusFields } = await import("../src/endpoint-status.mjs");
	for (const host of ["host.docker.internal", "host.containers.internal", "gpu.lan"]) {
		const endpoint = { ...OLLAMA, host };
		const models = { providers: { "local-ollama": { api: "openai-completions", baseUrl: `http://${host}:11434/v1`, models: [{ id: "qwen" }] } } };
		const wiring = endpointWiring({ endpoints: [endpoint], models, lease: false });
		const shared = harness({ getSettings: LOCAL_MODEL, extra: wiring.extra });
		const own = harness({ getSettings: LOCAL_MODEL, extra: wiring.extra });
		const published = () => JSON.parse(endpointStatusFields([endpoint], wiring.endpointSlots, false).endpoints)[0];
		const running = shared.processor(localJob("first", "/a").job, "token", new AbortController().signal);
		await shared.untilStarted(1);
		assert.deepEqual(published(), { id: "lan-ollama", slots: 1, used: 1, fleet: 0 });
		await assert.rejects(own.processor(localJob("second", "/b").job, "token", new AbortController().signal), (error) => error.name === "DelayedError");
		assert.equal(published().used, 1, "deferring another pickup must not release the original's slot");
		shared.releaseNext();
		await running;
		assert.equal(published().used, 0);
		const next = own.processor(localJob("third", "/b").job, "token", new AbortController().signal);
		await own.untilStarted(1);
		assert.equal(published().used, 1, "the other processor takes the same map after release");
		own.releaseNext(); await next;
		assert.equal(published().used, 0);
	}
});

// Issue #918: a private endpoint's `slots`, in the same two halves as a model endpoint's, keyed `private:<id>`.
const BENCH_PRIVATE = { id: "bench-device", host: "10.0.5.20", port: 22, slots: 1 };
const LAB_PRIVATE = { id: "lab", host: "lab.internal", port: 8022, slots: null };
const grantingDeps = { checkPrivateEndpoints: async (job) => ({ ok: true, ids: job.privateEndpoints ?? [] }) };

test("a granted private endpoint with slots takes one in both halves under private:<id>, a full device defers the next job, and the finally gives both back (#918)", { skip }, async () => {
	const w = endpointWiring({ endpoints: [], privateEndpoints: () => [BENCH_PRIVATE, LAB_PRIVATE] });
	let granted = null;
	const h = harness({ extra: w.extra, extraDeps: grantingDeps, onContainer: (ctx) => (granted = ctx.privateEndpoints) });
	const a = spyJob("l-1", { kind: "local", folder: "/srv/a", flow: "tidy", task: "t", privateEndpoints: ["bench-device", "lab"] });
	const first = h.processor(a.job, "tok-a", new AbortController().signal);
	await h.untilStarted(1);
	assert.deepEqual(granted, [BENCH_PRIVATE, LAB_PRIVATE], "the processor granted what the pickup read");
	assert.equal(w.endpointSlots.count("private:bench-device"), 1);
	assert.equal(w.endpointSlots.count("private:lab"), 0, "no slots, no hold");
	assert.equal(w.endpointSlots.count("bench-device"), 0, "never the bare id a model endpoint would use");
	assert.equal(w.redis.store.get(keyOf("private:bench-device")), "mini1#l-1");

	const b = spyJob("l-2", { kind: "local", folder: "/srv/b", flow: "tidy", task: "t", privateEndpoints: ["bench-device"] });
	await assert.rejects(() => h.processor(b.job, "tok-b", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal(b.moves[0].ts, NOW + mod.ENDPOINT_BUSY_RECHECK_MS, "deferred, never refused");
	assert.deepEqual(h.seen.logs.find((l) => l.event === "private_endpoint_busy_deferred").fields, { jobId: "l-2", endpoint: "bench-device", where: "host", delayMs: mod.ENDPOINT_BUSY_RECHECK_MS });
	assert.equal(h.seen.started, 1);

	const c = spyJob("l-3", { kind: "local", folder: "/srv/c", flow: "tidy", task: "t", privateEndpoints: ["lab"] });
	const third = h.processor(c.job, "tok-c", new AbortController().signal);
	await h.untilStarted(2);
	h.releaseNext();
	h.releaseNext();
	await first;
	await third;
	assert.equal(w.endpointSlots.count("private:bench-device"), 0);
	assert.equal(w.redis.store.size, 0, "the fleet half too");
});

test("a job naming a private endpoint this host does not declare takes no slot, and the processor refuses it on a single host (#918)", { skip }, async () => {
	const w = endpointWiring({ endpoints: [], privateEndpoints: () => [LAB_PRIVATE] });
	const h = harness({ extra: w.extra, extraDeps: grantingDeps });
	const a = spyJob("l-1", { kind: "local", folder: "/srv/a", flow: "tidy", task: "t", privateEndpoints: ["bench-device"] });
	const result = await h.processor(a.job, "tok-a", new AbortController().signal);
	assert.equal(h.seen.started, 0);
	assert.equal(result.reason, "private-endpoint-unknown");
	assert.equal(h.seen.records.at(-1)?.result?.reason, "private-endpoint-unknown", "and it is recorded");
	assert.equal(w.endpointSlots.count("private:bench-device"), 0);
	assert.equal(w.redis.store.size, 0);
});

test("a job its trigger no longer grants takes no slot: it is refused at once, never left waiting on a full device (#918 review)", { skip }, async () => {
	const w = endpointWiring({ endpoints: [], privateEndpoints: () => [BENCH_PRIVATE] });
	const withdrawn = { checkPrivateEndpoints: async (job) => (job.folder === "/srv/a" ? { ok: true, ids: job.privateEndpoints } : { refused: "private-endpoint-withdrawn" }) };
	const h = harness({ extra: w.extra, extraDeps: withdrawn });
	const a = spyJob("l-1", { kind: "local", folder: "/srv/a", flow: "tidy", task: "t", privateEndpoints: ["bench-device"] });
	const first = h.processor(a.job, "tok-a", new AbortController().signal);
	await h.untilStarted(1);
	assert.equal(w.endpointSlots.count("private:bench-device"), 1, "the granted job holds the device's one slot");
	const b = spyJob("l-2", { kind: "local", folder: "/srv/b", flow: "tidy", task: "t", privateEndpoints: ["bench-device"] });
	const result = await h.processor(b.job, "tok-b", new AbortController().signal);
	assert.equal(result.reason, "private-endpoint-withdrawn", "refused now, not deferred until the slot frees");
	assert.equal(b.moves.length, 0);
	assert.equal(h.seen.logs.some((l) => l.event === "private_endpoint_busy_deferred"), false);
	h.releaseNext();
	await first;
});

test("a grant the pickup could not confirm but the processor can is deferred to take its slot, never run beside the slot's holder (#918 review)", { skip }, async () => {
	const w = endpointWiring({ endpoints: [], privateEndpoints: () => [BENCH_PRIVATE] });
	let reads = 0;
	// The file mid-save at the pickup's read, whole again at the processor's.
	const midSave = { checkPrivateEndpoints: async (job) => (++reads === 1 ? { unreadable: true } : { ok: true, ids: job.privateEndpoints }) };
	const h = harness({ extra: w.extra, extraDeps: midSave });
	const a = spyJob("l-1", { kind: "local", folder: "/srv/a", flow: "tidy", task: "t", privateEndpoints: ["bench-device"] });
	await assert.rejects(() => h.processor(a.job, "tok-a", new AbortController().signal), (e) => e.name === "DelayedError");
	assert.equal(h.seen.started, 0, "no container without the slot");
	assert.equal(a.moves[0].ts, NOW + mod.ENDPOINT_BUSY_RECHECK_MS);
	assert.deepEqual(h.seen.logs.find((l) => l.event === "private_endpoint_hold")?.fields, { jobId: "l-1", delayMs: mod.ENDPOINT_BUSY_RECHECK_MS, slot: true });
	assert.equal(w.endpointSlots.count("private:bench-device"), 0);
});

// Issue #1074: the endpoint and private endpoint gates log a wait as one episode, as the scope gates do since #1023,
// at their fixed 7s re-check. Each gate's wait is its own episode under the worker's one bound.
const E = mod?.ENDPOINT_BUSY_RECHECK_MS;

test("a wait for a busy model endpoint is one episode in the log: a line at its first deferral, one when the job holds its slot, at the fixed 7s (#1074)", { skip }, async () => {
	const endpointSlots = makeInFlight();
	const h = onAClock({ getSettings: LOCAL_MODEL, extra: endpointWiring({ endpointSlots, lease: false }).extra });
	assert.ok(endpointSlots.tryAcquire(OLLAMA.id, OLLAMA.slots), "the server's one slot is held elsewhere");
	const b = ghJob("g-1", "acme/web");
	const walked = await h.wakes(b, NOW, NOW + 600 * S);
	assert.deepEqual([walked.delays.length, ...new Set(walked.delays)], [86, E], "ten minutes of wakes, every one at the fixed re-check");
	assert.equal(b.moves.length, 86, "each wake is still a move of its own");
	assert.deepEqual(h.lines("endpoint_busy_deferred"), [{ jobId: "g-1", endpoint: "lan-ollama", where: "host", delayMs: E }], "86 deferrals, one line, with the fields it always had");
	assert.deepEqual(h.lines("endpoint_busy_ended"), [], "nothing ends while the job still waits");
	endpointSlots.release(OLLAMA.id);
	try {
		const { run } = await h.startedAt(b, walked.due);
		assert.deepEqual(h.lines("endpoint_busy_ended"), [{ jobId: "g-1", kind: "forge", waitedMs: 86 * E, deferrals: 86 }]);
		h.releaseNext();
		await run;
	} finally {
		h.releaseNext();
	}
	// The wait was forgotten at its end: the same job waiting again is an episode of its own, said from its start.
	assert.ok(endpointSlots.tryAcquire(OLLAMA.id, OLLAMA.slots));
	await h.deferredAt(b, walked.due + 60 * S);
	await h.deferredAt(b, walked.due + 67 * S);
	assert.equal(h.lines("endpoint_busy_deferred").length, 2);
	assert.equal(h.lines("endpoint_busy_ended").length, 1);
});

test("a wait for a busy private endpoint is one episode, said again only when the job comes to wait for another device (#1074)", { skip }, async () => {
	const RIG_PRIVATE = { id: "rig-device", host: "10.0.5.21", port: 22, slots: 1 };
	const w = endpointWiring({ endpoints: [], privateEndpoints: () => [BENCH_PRIVATE, RIG_PRIVATE], lease: false });
	const h = onAClock({ extra: w.extra, extraDeps: grantingDeps });
	assert.ok(w.endpointSlots.tryAcquire("private:bench-device", 1));
	const b = spyJob("l-2", { kind: "local", folder: "/srv/b", flow: "tidy", task: "t", privateEndpoints: ["bench-device", "rig-device"] });
	const bench = await h.wakes(b, NOW, NOW + 30 * S);
	assert.equal(bench.delays.length, 5);
	// The first device is free, the second is not: the job now waits for something else, and the line says so once.
	w.endpointSlots.release("private:bench-device");
	assert.ok(w.endpointSlots.tryAcquire("private:rig-device", 1));
	const rig = await h.wakes(b, bench.due, bench.due + 20 * S);
	assert.equal(rig.delays.length, 3);
	assert.deepEqual(h.lines("private_endpoint_busy_deferred"), [
		{ jobId: "l-2", endpoint: "bench-device", where: "host", delayMs: E },
		{ jobId: "l-2", endpoint: "rig-device", where: "host", delayMs: E },
	], "a line when the wait starts and one when the device it waits for changes, none per wake");
	assert.deepEqual(h.lines("private_endpoint_busy_ended"), []);
	w.endpointSlots.release("private:rig-device");
	try {
		const { run } = await h.startedAt(b, rig.due);
		assert.deepEqual(h.lines("private_endpoint_busy_ended"), [{ jobId: "l-2", kind: "local", waitedMs: 8 * E, deferrals: 8 }], "one wait, counted whole across both devices");
		h.releaseNext();
		await run;
	} finally {
		h.releaseNext();
	}
});

test("an endpoint wait and a scope wait of one job are two episodes, each said whole: one memory for both would silence the second (#1074)", { skip }, async () => {
	const endpointSlots = makeInFlight();
	const h = onAClock({ getSettings: LOCAL_MODEL, extra: endpointWiring({ endpointSlots, lease: false }).extra });
	assert.ok(endpointSlots.tryAcquire(OLLAMA.id, OLLAMA.slots));
	const b = localJob("w-1", "/srv/site");
	assert.equal(await h.deferredAt(b, NOW), E, "it took its folder, and the endpoint deferred it");
	// The folder is taken while the job is away: it now waits for its scope, which is a wait of its own.
	assert.ok(h.inFlight.tryAcquire("/srv/site", 1));
	assert.equal(await h.deferredAt(b, NOW + 7 * S), 5 * S);
	assert.equal(await h.deferredAt(b, NOW + 12 * S), 5 * S);
	h.inFlight.release("/srv/site");
	assert.equal(await h.deferredAt(b, NOW + 17 * S), E, "its folder again, and the endpoint still busy");
	endpointSlots.release(OLLAMA.id);
	try {
		const { run } = await h.startedAt(b, NOW + 24 * S);
		const said = h.seen.logs.filter((l) => /^(scope|endpoint)_busy_/.test(l.event)).map((l) => [l.event, l.fields]);
		assert.deepEqual(said, [
			["endpoint_busy_deferred", { jobId: "w-1", endpoint: "lan-ollama", where: "host", delayMs: E }],
			["scope_busy_deferred", { jobId: "w-1", kind: "local", delayMs: 5 * S }],
			["scope_busy_ended", { jobId: "w-1", kind: "local", waitedMs: 10 * S, deferrals: 2 }],
			["endpoint_busy_ended", { jobId: "w-1", kind: "local", waitedMs: 2 * E, deferrals: 2 }],
		], "each gate counts only its own deferrals, and the scope wait in the middle neither ends nor adds to the endpoint's");
		h.releaseNext();
		await run;
	} finally {
		h.releaseNext();
	}
});

test("the one bound holds every gate's waits together: an endpoint wait counts toward it, and the one deferred longest ago goes first (#1074)", { skip }, async () => {
	const endpointSlots = makeInFlight();
	const h = onAClock({ getSettings: LOCAL_MODEL, extra: endpointWiring({ endpointSlots, lease: false }).extra });
	assert.ok(endpointSlots.tryAcquire(OLLAMA.id, OLLAMA.slots));
	const folder = (i) => `/srv/f-${i}`;
	const e = localJob("e-0", "/srv/e");
	await h.deferredAt(e, NOW);
	const waiting = Array.from({ length: mod.WAIT_EPISODES_MAX - 1 }, (_, i) => localJob(`w-${i + 1}`, folder(i + 1)));
	for (const [i, spy] of waiting.entries()) {
		assert.ok(h.inFlight.tryAcquire(folder(i + 1), 1));
		await h.deferredAt(spy, NOW + 1 * S);
	}
	// The bound is full, over two gates, and the endpoint wait is still remembered; asked again, it is the newest.
	await h.deferredAt(e, NOW + 7 * S);
	assert.equal(h.lines("endpoint_busy_deferred", "e-0").length, 1);
	// One scope wait more drops the oldest, the first scope wait: with a bound per gate it would have dropped nothing.
	assert.ok(h.inFlight.tryAcquire("/srv/f-new", 1));
	await h.deferredAt(localJob("w-new", "/srv/f-new"), NOW + 8 * S);
	await h.deferredAt(waiting[0], NOW + 9 * S);
	assert.equal(h.lines("scope_busy_deferred", "w-1").length, 2, "the dropped wait says its first line again");
	await h.deferredAt(e, NOW + 14 * S);
	assert.equal(h.lines("endpoint_busy_deferred", "e-0").length, 1, "the endpoint wait, newer, was kept");
	assert.equal(h.seen.started, 0);
});
