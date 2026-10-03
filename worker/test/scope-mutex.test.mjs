import assert from "node:assert/strict";
import { test } from "node:test";
import { RELEASE_IF_MINE, endpointSlotKey, hash16, makeFleetLease, scopeSlotKey } from "../src/fleet-lease.mjs";
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
	// Nothing records WHY a job sits in the delayed set, so the instant is the only evidence; 11s is the wait
	// throttle floor, which index.mjs does not export.
	const instants = [mod.SCOPE_BUSY_RECHECK_MS, mod.SUPERSEDE_RECHECK_MS, 11_000, mod.ENDPOINT_BUSY_RECHECK_MS];
	assert.equal(typeof mod.ENDPOINT_BUSY_RECHECK_MS, "number");
	assert.equal(new Set(instants).size, instants.length, `four distinct instants: ${instants.join(", ")}`);
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

test("getSettings is read ONCE per pickup, and its throw is recorded exactly as before the read moved", { skip }, async () => {
	// Completed run and endpoint deferral: one read each.
	{
		let calls = 0;
		const w = endpointWiring();
		const h = harness({ getSettings: () => (calls++, LOCAL_MODEL()), extra: w.extra });
		const p = h.processor(localJob("l-1", "/srv/a").job, "tok", new AbortController().signal);
		await h.untilStarted(1);
		assert.equal(calls, 1, "one read before the gate, none again in the main try");
		await assert.rejects(() => h.processor(localJob("l-2", "/srv/b").job, "tok", new AbortController().signal), (e) => e.name === "DelayedError");
		assert.equal(calls, 2, "a deferred pickup reads once too");
		h.releaseNext();
		await p;
		assert.equal(calls, 2);
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
		assert.equal(calls, 1);
		assert.equal(records.length, 1);
		assert.equal(records[0].error.message, "overlay boom");
		assert.deepEqual(Object.keys(records[0]).sort(), ["endedAt", "error", "job", "startedAt"]);
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
