import assert from "node:assert/strict";
import { test } from "node:test";
import { configError } from "../src/config.mjs";
import { InfraRetry, isNeverStartedExit, runJob } from "../src/processor.mjs";
import { buildRecord } from "../src/run-history.mjs";
import { scopeKeyPrefix } from "../src/scoped-limits.mjs";
import { DOCKER_NEVER_STARTED_EXITS } from "../src/backends.mjs";

// The job-count ledger list the processor takes (issue #499 part B), from a `budgetCapsFor`-shaped object.
const asLedgers = (c) => (c ? [{ scope: c.scope, keyPrefix: scopeKeyPrefix(c.scope), caps: c.caps, reason: "scope-cap" }] : []);

// Issue #501, parts 3 and 4 (DES-DOLLAR-RESERVE-AND-SETTLE, the worker half), and #503 part 7: the processor reserves
// a job's per-job cap in the dollar windows after both job-count reserves and before the container, settles it once
// for every exit where the container ran, and refunds it whole where none did.

const USD = 1_000_000;
const NOW = new Date("2026-10-07T12:00:00Z");
const DAY = "budget:usd:2026-10-07";
const WEEK = "budget:usd:w:2026-10-05";

/** A keyed fake: the job-count INCR/DECR and the dollar INCRBY/DECRBY on one store, every command logged in order. */
function keyedRedis(preset = {}) {
	const store = new Map(Object.entries(preset));
	const ops = [];
	const at = (k) => store.get(k) ?? 0;
	const redis = {
		store,
		ops,
		async incr(k) {
			ops.push(["incr", k]);
			store.set(k, at(k) + 1);
			return at(k);
		},
		async decr(k) {
			ops.push(["decr", k]);
			store.set(k, at(k) - 1);
			return at(k);
		},
		async incrby(k, n) {
			assert.ok(Number.isSafeInteger(n), `INCRBY integers only, got ${n}`);
			ops.push(["incrby", k, n]);
			store.set(k, at(k) + n);
			return at(k);
		},
		async decrby(k, n) {
			assert.ok(Number.isSafeInteger(n), `DECRBY integers only, got ${n}`);
			ops.push(["decrby", k, n]);
			store.set(k, at(k) - n);
			return at(k);
		},
		async eval(_script, _n, k, arg) {
			const d = Number(arg);
			assert.ok(Number.isSafeInteger(d), `settle delta integers only, got ${arg}`);
			ops.push(["settle", k, d]);
			if (!store.has(k)) return [1, 0];
			store.set(k, Math.max(0, at(k) + d));
			return [0, at(k)];
		},
		async expire() {},
		async get() {
			return null;
		},
	};
	return redis;
}

const usdKeys = (redis) => [...redis.store.keys()].filter((k) => k.startsWith("budget:usd"));

const COMPLETE_TOKENS = { input: 10, output: 5, total: 15, cost: 0.3, metered: true, unresolved: 0, unpriced: 0, childTotal: 0, childProcesses: 0, unmeteredChildren: 0, costCapMicros: 2 * USD, costRefused: 0, boundExceeded: 0, longContext: 0, costUnjudged: 0, costUnanswered: 0 };
const LEDGER = { v: 1, piAi: null, truncated: 0, models: [{ provider: "anthropic", model: "m", calls: 1, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total: 15, cost: 0.3, unpriced: 0 }] };

function deps(overrides = {}) {
	const calls = [];
	const logs = [];
	const redis = overrides.redis ?? keyedRedis();
	const base = {
		redis,
		caps: { day: 10, week: null, month: null },
		softHoldPct: null,
		dollarCaps: { day: 10 * USD, week: 50 * USD, month: null },
		mintToken: async () => "tok",
		isDefaultBranchProtected: async () => true,
		prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
		runContainer: async ({ job }) => (calls.push(["run-container", job.maxCostMicros]), { code: 0, aborted: false, exitLineCode: 0, tokens: COMPLETE_TOKENS, usage: LEDGER }),
		collectChain: async () => ({ enqueued: 0, refused: 0 }),
		cleanup: async () => {},
		comment: async (_j, t) => calls.push(["comment", t]),
		log: (event, fields) => logs.push([event, fields]),
		now: NOW,
	};
	return { deps: { ...base, ...overrides, redis }, calls, logs, redis };
}

const job = { kind: "github", repo: "org/repo", provider: "anthropic", model: "m", maxTurns: 20, maxCostMicros: 2 * USD };

test("no dollar setting: nothing reserved or settled, no budget:usd key, the container gets the job unchanged, no dollars", async () => {
	const { deps: d, calls, redis } = deps({ dollarCaps: null });
	const input = { ...job };
	const r = await runJob(input, d);
	assert.equal(r.outcome, "completed");
	assert.deepEqual(usdKeys(redis), []);
	assert.ok(!redis.ops.some((o) => o[0] === "incrby" || o[0] === "decrby" || o[0] === "settle"));
	assert.equal(Object.hasOwn(r, "dollars"), false, "the result shape is the old one");
	assert.deepEqual(calls.find((c) => c[0] === "run-container"), ["run-container", 2 * USD]);
	assert.deepEqual(input, job, "job data untouched");
	assert.equal(buildRecord({ job: { id: "j", data: {} }, result: r }).dollars, null);
});

test("ORDER: the scoped and global job-count reserves, then the dollar reserve, then the container, then one settle", async () => {
	const { deps: d, redis } = deps({ scopedLedgers: asLedgers({ scope: "org/repo", caps: { day: 5, week: null, month: null } }) });
	const marks = [];
	const run = d.runContainer;
	d.runContainer = async (ctx) => (marks.push(redis.ops.length), run(ctx));
	const r = await runJob(job, d);
	const before = redis.ops.slice(0, marks[0]).map((o) => o.slice(0, 2));
	assert.deepEqual(before, [
		["incr", `${scopeKeyPrefix("org/repo")}:2026-10-07`],
		["incr", "budget:2026-10-07"],
		["incrby", DAY],
		["incrby", WEEK],
	]);
	const after = redis.ops.slice(marks[0]);
	assert.deepEqual(after, [["settle", DAY, 300_000 - 2 * USD], ["settle", WEEK, 300_000 - 2 * USD]], "settled ONCE, to the metered cost");
	assert.equal(redis.store.get(DAY), 300_000);
	assert.deepEqual(r.dollars, { reservedMicros: 2 * USD, settledMicros: 300_000, basis: "metered", modelBasis: null });
});

test("a full dollar window refuses dollar-cap, gives back BOTH job-count slots and its own dollars, and starts nothing", async () => {
	const scope = { scope: "org/repo", caps: { day: 5, week: null, month: null } };
	const { deps: d, calls, logs, redis } = deps({ redis: keyedRedis({ [DAY]: 9 * USD }), scopedLedgers: asLedgers(scope) });
	const r = await runJob(job, d);
	assert.deepEqual(r, { outcome: "policy", reason: "dollar-cap", exitCode: null, turns: null, tokens: null, provider: "anthropic", model: "m", budgetReserved: false, dollars: { reservedMicros: 2 * USD, settledMicros: 0, basis: "refunded", modelBasis: null } });
	assert.ok(!calls.some((c) => c[0] === "run-container"), "no container");
	assert.equal(redis.store.get("budget:2026-10-07"), 0, "the global job-count slot is back");
	assert.equal(redis.store.get(`${scopeKeyPrefix("org/repo")}:2026-10-07`), 0, "the scoped slot is back");
	assert.equal(redis.store.get(DAY), 9 * USD, "the refused dollars are back");
	assert.match(calls.find((c) => c[0] === "comment")[1], /^Refused: today's dollar budget/);
	assert.doesNotMatch(calls.find((c) => c[0] === "comment")[1], /\d/, "no amount in the comment");
	assert.deepEqual(logs.find((l) => l[0] === "over_dollar_budget")[1], { ledger: "deployment", window: "day", reservedMicros: 11 * USD, capMicros: 10 * USD, amountMicros: 2 * USD, refunded: true });
	assert.equal(buildRecord({ job: { id: "j", data: {} }, result: r }).reason, "dollar-cap");
});

test("settles ONCE on every path where the container ran: completed, policy, abort, exit 1, unknown exit, detached", async () => {
	const cases = [
		["completed", { code: 0, aborted: false, exitLineCode: 0, tokens: COMPLETE_TOKENS, usage: LEDGER }, "return", "metered", 300_000],
		["policy", { code: 2, aborted: false, exitLineCode: 2, tokens: COMPLETE_TOKENS, usage: LEDGER, exitReason: "cost-cap" }, "return", "metered", 300_000],
		["abort", { code: 137, aborted: true, tokens: null }, "return", "floor", 2 * USD],
		["cancel", { code: 137, aborted: true, abortReason: "operator-cancel", tokens: { ...COMPLETE_TOKENS, costUnanswered: 1 }, usage: LEDGER }, "return", "floor", 2 * USD],
		["exit-1", { code: 1, aborted: false, exitLineCode: 1, tokens: COMPLETE_TOKENS, usage: LEDGER }, "throw", "metered", 300_000],
		["unknown", { code: 99, aborted: false, exitLineCode: 99, tokens: null }, "throw", "floor", 2 * USD],
		// Detached: the worker stopped the container, so its exit line is not trusted (round 3): the floor.
		["detached", { code: 125, aborted: false, detached: true, exitLineCode: 125, tokens: COMPLETE_TOKENS, usage: LEDGER }, "throw", "floor", 2 * USD],
	];
	for (const [name, exit, how, basis, settled] of cases) {
		const { deps: d, redis } = deps({ runContainer: async () => exit });
		let out;
		if (how === "return") out = await runJob(job, d);
		else {
			await assert.rejects(runJob(job, d), (e) => (out = e) instanceof InfraRetry, name);
		}
		assert.deepEqual(out.dollars, { reservedMicros: 2 * USD, settledMicros: settled, basis, modelBasis: null }, name);
		assert.equal(redis.store.get(DAY), settled, `${name}: the window holds the settled amount`);
		assert.equal(redis.ops.filter((o) => o[0] === "incrby" && o[1] === DAY).length, 1, `${name}: one reserve`);
		assert.equal(redis.ops.filter((o) => o[0] === "settle" && o[1] === DAY).length, settled === 2 * USD ? 0 : 1, `${name}: at most one settle`);
		assert.equal(redis.ops.filter((o) => o[0] === "decrby").length, 0, `${name}: never also refunded`);
		const record = how === "return" ? buildRecord({ job: { id: "j", data: {} }, result: out }) : buildRecord({ job: { id: "j", data: {} }, error: out });
		assert.equal(record.dollars.basis, basis, `${name}: the record says so`);
	}
});

test("tokens: null (no exit line) settles at the floor: the whole reservation stays", async () => {
	const { deps: d, redis } = deps({ runContainer: async () => ({ code: 0, aborted: false, exitLineCode: 0, tokens: null, usage: null }) });
	const r = await runJob(job, d);
	assert.deepEqual(r.dollars, { reservedMicros: 2 * USD, settledMicros: 2 * USD, basis: "floor", modelBasis: null });
	assert.equal(redis.store.get(DAY), 2 * USD);
});

test("a never-started exit is NOT settled: the catch refunds the dollars and the job-count slot together", async () => {
	for (const code of DOCKER_NEVER_STARTED_EXITS) {
		const { deps: d, redis, logs } = deps({ runContainer: async () => ({ code, aborted: false, tokens: null }) });
		let err;
		await assert.rejects(runJob(job, d), (e) => (err = e) instanceof InfraRetry);
		assert.equal(err.reason, "container-never-started");
		assert.deepEqual(err.dollars, { reservedMicros: 2 * USD, settledMicros: 0, basis: "refunded", modelBasis: null }, String(code));
		assert.equal(err.budgetReserved, false);
		assert.equal(redis.store.get(DAY), 0, "dollars back");
		assert.equal(redis.store.get("budget:2026-10-07"), 0, "job-count slot back");
		assert.ok(!logs.some((l) => l[0] === "dollar_settled"), "never settled");
	}
});

test("isNeverStartedExit: the one answer, false for a detached or aborted container and for the runner's own codes", () => {
	const nev = [125, 126, 127];
	assert.equal(isNeverStartedExit({ code: 125 }, nev), true);
	assert.equal(isNeverStartedExit({ code: 125, detached: true }, nev), false);
	assert.equal(isNeverStartedExit({ code: 125, aborted: true }, nev), false);
	for (const code of [0, 1, 2]) assert.equal(isNeverStartedExit({ code }, [0, 1, 2]), false, String(code));
	assert.equal(isNeverStartedExit({ code: 99 }, nev), false);
	assert.equal(isNeverStartedExit({ code: 125 }, null), false);
});

test("a spawn fault (runContainer throws never-started) and a config refusal from runContainer both refund the dollars in full", async () => {
	{
		const { deps: d, redis } = deps({ runContainer: async () => { throw new InfraRetry("spawn", { reason: "container-never-started" }); } });
		let err;
		await assert.rejects(runJob(job, d), (e) => (err = e) instanceof InfraRetry);
		assert.equal(err.dollars.basis, "refunded");
		assert.equal(redis.store.get(DAY), 0);
	}
	{
		const { deps: d, redis } = deps({ runContainer: async () => { throw configError("no forge"); } });
		const r = await runJob(job, d);
		assert.equal(r.reason, "config-refused");
		assert.deepEqual(r.dollars, { reservedMicros: 2 * USD, settledMicros: 0, basis: "refunded", modelBasis: null });
		assert.equal(redis.store.get(DAY), 0);
		assert.equal(redis.store.get(WEEK), 0);
		assert.equal(redis.store.get("budget:2026-10-07"), 0);
	}
});

test("an unexpected throw after the reservation LEAVES the hold (the floor) and logs dollar_hold_unsettled", async () => {
	const { deps: d, redis, logs } = deps({ runContainer: async () => { throw new TypeError("a defect"); } });
	let err;
	await assert.rejects(runJob(job, d), (e) => (err = e) instanceof TypeError);
	assert.equal(redis.store.get(DAY), 2 * USD, "the reservation stands");
	assert.deepEqual(logs.find((l) => l[0] === "dollar_hold_unsettled")[1], { reservedMicros: 2 * USD, error: "TypeError" });
	assert.deepEqual(err.dollars, { reservedMicros: 2 * USD, settledMicros: 2 * USD, basis: "floor", modelBasis: null });
	assert.equal(buildRecord({ job: { id: "j", data: {} }, error: err }).dollars.basis, "floor");
});

test("a Valkey fault in the dollar reserve is a never-started retry: the job-count slot is refunded and nothing is held", async () => {
	const redis = keyedRedis();
	redis.incrby = async () => {
		throw Object.assign(new Error("down"), { code: "ECONNREFUSED" });
	};
	const { deps: d, calls, logs } = deps({ redis });
	let err;
	await assert.rejects(runJob(job, d), (e) => (err = e) instanceof InfraRetry);
	assert.equal(err.reason, "container-never-started");
	assert.equal(err.budgetReserved, false);
	assert.equal(redis.store.get("budget:2026-10-07"), 0);
	assert.ok(!calls.some((c) => c[0] === "run-container"));
	assert.deepEqual(logs.find((l) => l[0] === "dollar_reserve_error")[1], { code: "ECONNREFUSED" });
});

test("a dollar window with no per-job cap on the job is refused as configuration, both job-count slots refunded", async () => {
	const { deps: d, redis, calls } = deps();
	const r = await runJob({ ...job, maxCostMicros: null }, d);
	assert.equal(r.reason, "config-refused");
	assert.equal(r.budgetReserved, false);
	assert.equal(redis.store.get("budget:2026-10-07"), 0);
	assert.deepEqual(usdKeys(redis), []);
	assert.ok(!calls.some((c) => c[0] === "run-container"));
});

// ---- PR #542's review: zero-call runs, the floor's lower bound, and the paths no test held ----

// What the runner writes when it made no provider call: metered, calls 0, cost 0, the cap counters, and NO usage
// ledger (usage-meter.mjs `usageSnapshot` returns null for a zero-call run, so run-job.mjs omits the key).
const ZERO_CALL = { input: 0, output: 0, total: 0, cost: 0, metered: true, rootTotal: 0, otherTotal: 0, looseTotal: 0, sessions: 0, calls: 0, unresolved: 0, unpriced: 0, childTotal: 0, childProcesses: 0, unmeteredChildren: 0, costCapMicros: 2 * USD, costRefused: 0, boundExceeded: 0, longContext: 0, costUnjudged: 0, costUnanswered: 0 };

test("a run that made NO provider call settles metered at 0: the guard refused call 1, a command job, an early exit 1", async () => {
	const cases = [
		["first call refused by the guard", { code: 2, aborted: false, exitLineCode: 2, exitReason: "cost-cap", tokens: { ...ZERO_CALL, costRefused: 1 } }, "return"],
		["a command job that called no model", { code: 0, aborted: false, exitLineCode: 0, tokens: ZERO_CALL }, "return"],
		["an early exit 1", { code: 1, aborted: false, exitLineCode: 1, tokens: ZERO_CALL }, "throw"],
	];
	for (const [name, exit, how] of cases) {
		const { deps: d, redis } = deps({ runContainer: async () => exit });
		let out;
		if (how === "return") out = await runJob(job, d);
		else await assert.rejects(runJob(job, d), (e) => (out = e) instanceof InfraRetry, name);
		assert.deepEqual(out.dollars, { reservedMicros: 2 * USD, settledMicros: 0, basis: "metered", modelBasis: null }, name);
		assert.equal(redis.store.get(DAY), 0, `${name}: the window gets its whole cap back`);
		assert.equal(redis.store.get(WEEK), 0, name);
	}
});

test("a runner's config refusal AFTER a spent load-time call (issue #543) settles on the exit line, never refunded", async () => {
	// The runner writes its tokens on every exit line once the meter is installed, so a job whose extension spent at
	// load and that then failed a pre-prompt check (command-unregistered) settles at what it spent. A runner
	// config exit is a container that ran, so it is settled, never refunded like the worker's own config refusal;
	// without tokens (an older runner) it stays at the floor.
	const spent = { code: 2, aborted: false, exitLineCode: 2, exitReason: "command-unregistered", tokens: COMPLETE_TOKENS, usage: LEDGER };
	const { deps: d, redis } = deps({ runContainer: async () => spent });
	const out = await runJob(job, d).catch((error) => error);
	assert.deepEqual(out.dollars, { reservedMicros: 2 * USD, settledMicros: 300_000, basis: "metered", modelBasis: null });
	assert.equal(redis.store.get(DAY), 300_000, "the window keeps what the load-time call spent");
	const old = deps({ runContainer: async () => ({ ...spent, tokens: null, usage: null }) });
	const floored = await runJob(job, old.deps).catch((error) => error);
	assert.deepEqual(floored.dollars, { reservedMicros: 2 * USD, settledMicros: 2 * USD, basis: "floor", modelBasis: null });
});

test("a floor never charges less than a reported metered cost: $5 metered with boundExceeded under a $2 hold charges $5", async () => {
	const { deps: d, redis } = deps({ runContainer: async () => ({ code: 0, aborted: false, exitLineCode: 0, tokens: { ...COMPLETE_TOKENS, cost: 5, boundExceeded: 1 }, usage: LEDGER }) });
	const r = await runJob(job, d);
	assert.deepEqual(r.dollars, { reservedMicros: 2 * USD, settledMicros: 5 * USD, basis: "floor", modelBasis: null });
	assert.equal(redis.store.get(DAY), 5 * USD);
});

test("a settle that adjusted NO key records the floor, whatever the computed basis was", async () => {
	const redis = keyedRedis();
	redis.eval = async () => {
		throw Object.assign(new Error("down"), { code: "ECONNRESET" });
	};
	const { deps: d, logs } = deps({ redis });
	const r = await runJob(job, d);
	assert.deepEqual(r.dollars, { reservedMicros: 2 * USD, settledMicros: 2 * USD, basis: "floor", modelBasis: null });
	assert.equal(redis.store.get(DAY), 2 * USD, "the reservation stands");
	assert.deepEqual(logs.find((l) => l[0] === "dollar_settle_error")[1], { code: "ECONNRESET", applied: 0, of: 2 });
});

test("an InfraRetry that is NOT never-started, thrown by runContainer, keeps the hold: the container may have run", async () => {
	const { deps: d, redis, logs } = deps({ runContainer: async () => { throw new InfraRetry("lost the daemon mid-run", { reason: "container-detached" }); } });
	let err;
	await assert.rejects(runJob(job, d), (e) => (err = e) instanceof InfraRetry);
	assert.equal(redis.store.get(DAY), 2 * USD);
	assert.deepEqual(err.dollars, { reservedMicros: 2 * USD, settledMicros: 2 * USD, basis: "floor", modelBasis: null });
	assert.deepEqual(logs.find((l) => l[0] === "dollar_hold_unsettled")[1], { reservedMicros: 2 * USD, error: "infra-retry" });
});

test("a dollar refusal whose job-count refund FAILED says budgetReserved: true", async () => {
	const redis = keyedRedis({ [DAY]: 9 * USD });
	redis.decr = async () => {
		throw Object.assign(new Error("down"), { code: "ECONNRESET" });
	};
	const { deps: d, logs } = deps({ redis });
	const r = await runJob(job, d);
	assert.equal(r.reason, "dollar-cap");
	assert.equal(r.budgetReserved, true, "the slot is still out there");
	assert.equal(logs.find((l) => l[0] === "over_dollar_budget")[1].refunded, false);
});

test("a dollar refusal whose dollar give-back failed for a key records the floor, not refunded", async () => {
	const redis = keyedRedis({ [WEEK]: 49 * USD });
	const decrby = redis.decrby;
	let n = 0;
	redis.decrby = async (k, v) => {
		if (n++ === 0) throw Object.assign(new Error("down"), { code: "ECONNRESET" });
		return decrby(k, v);
	};
	const { deps: d, logs } = deps({ redis });
	const r = await runJob(job, d);
	assert.equal(r.reason, "dollar-cap");
	assert.deepEqual(r.dollars, { reservedMicros: 2 * USD, settledMicros: 2 * USD, basis: "floor", modelBasis: null });
	assert.deepEqual(logs.find((l) => l[0] === "dollar_giveback_error")[1], { code: "ECONNRESET", key: DAY });
	assert.equal(redis.store.get(WEEK), 49 * USD, "the other key was still given back");
});

test("a never-started exit whose release only partly lands records the floor, not refunded", async () => {
	const redis = keyedRedis();
	const evalOk = redis.eval;
	let n = 0;
	redis.eval = async (...a) => {
		if (n++ === 1) throw Object.assign(new Error("down"), { code: "ECONNRESET" });
		return evalOk(...a);
	};
	const { deps: d } = deps({ redis, runContainer: async () => ({ code: 125, aborted: false, exitLineCode: 125, tokens: null }) });
	let err;
	await assert.rejects(runJob(job, d), (e) => (err = e) instanceof InfraRetry);
	assert.deepEqual(err.dollars, { reservedMicros: 2 * USD, settledMicros: 2 * USD, basis: "floor", modelBasis: null });
	assert.equal(redis.store.get(DAY), 0);
	assert.equal(redis.store.get(WEEK), 2 * USD, "the week the release did not reach still holds it");
});

test("a job whose per-job cap is ALREADY 0 (and is not zero-rated) reserves nothing and records unreserved", async () => {
	const { deps: d, calls, redis } = deps();
	const r = await runJob({ ...job, maxCostMicros: 0 }, d);
	assert.equal(r.outcome, "completed");
	assert.deepEqual(r.dollars, { reservedMicros: 0, settledMicros: 0, basis: "unreserved", modelBasis: null });
	assert.deepEqual(usdKeys(redis), []);
	assert.deepEqual(calls.find((c) => c[0] === "run-container"), ["run-container", 0]);
});

test("an unreserved job whose exit line reports a cost above 0 is logged dollar_unreserved_spent, and still writes no key", async () => {
	const { deps: d, logs, redis } = deps({ modelEndpoints: { endpoints: [{ id: "mac-ollama", host: "host.docker.internal", port: 11434, slots: 2, keyless: true }], models: { providers: { "local-ollama": { baseUrl: "http://host.docker.internal:11434/v1", models: [{ id: "q" }] } } }, set: [] }, runContainer: async () => ({ code: 0, aborted: false, exitLineCode: 0, tokens: { ...COMPLETE_TOKENS, cost: 0.0000014 }, usage: LEDGER }) });
	const r = await runJob({ ...job, provider: "local-ollama", model: "q" }, d);
	assert.equal(r.dollars.basis, "unreserved");
	assert.deepEqual(logs.find((l) => l[0] === "dollar_unreserved_spent")[1], { meteredMicros: 2 });
	assert.deepEqual(usdKeys(redis), []);
});

// ---- PR #542's review, round 3: an exit line the job's own tools forged ----

// What a tool child writes to the runner's stdout before the container is stopped: a "clean" zero-call line.
const FORGED = { ...ZERO_CALL };

test("a forged $0 exit line followed by a worker stop (timeout, shutdown, cancel) settles at the FLOOR", async () => {
	for (const abortReason of [undefined, "operator-cancel"]) {
		const { deps: d, redis } = deps({ runContainer: async () => ({ code: 137, aborted: true, ...(abortReason ? { abortReason } : {}), exitLineCode: 0, tokens: FORGED }) });
		const r = await runJob(job, d);
		assert.deepEqual(r.dollars, { reservedMicros: 2 * USD, settledMicros: 2 * USD, basis: "floor", modelBasis: null }, String(abortReason));
		assert.equal(redis.store.get(DAY), 2 * USD, "the hold stands");
	}
});

test("a forged line that GUESSES the stop code (137) is still the floor: a stopped container's line is never trusted", async () => {
	for (const abortReason of [undefined, "operator-cancel"]) {
		const { deps: d, redis } = deps({ runContainer: async () => ({ code: 137, aborted: true, ...(abortReason ? { abortReason } : {}), exitLineCode: 137, tokens: FORGED }) });
		const r = await runJob(job, d);
		assert.equal(r.dollars.basis, "floor", String(abortReason));
		assert.equal(redis.store.get(DAY), 2 * USD);
	}
});

test("a forged exit line whose code is not the container's exit code settles at the floor; so does a missing one", async () => {
	for (const exit of [
		{ code: 137, aborted: false, exitLineCode: 0, tokens: FORGED }, // the kernel's kill, a forged clean line
		{ code: 1, aborted: false, exitLineCode: 0, tokens: FORGED },
		{ code: 0, aborted: false, tokens: COMPLETE_TOKENS, usage: LEDGER }, // a sink that reports no line code
		{ code: 0, aborted: false, exitLineCode: "0", tokens: COMPLETE_TOKENS, usage: LEDGER },
	]) {
		const { deps: d, redis } = deps({ runContainer: async () => exit });
		let out;
		try {
			out = await runJob(job, d);
		} catch (e) {
			out = e;
		}
		assert.equal(out.dollars.basis, "floor", JSON.stringify(exit));
		assert.equal(redis.store.get(DAY), 2 * USD);
	}
});

test("a genuine clean run (not stopped, its line's code the container's) is still metered", async () => {
	const { deps: d, redis } = deps({ runContainer: async () => ({ code: 0, aborted: false, exitLineCode: 0, tokens: COMPLETE_TOKENS, usage: LEDGER }) });
	const r = await runJob(job, d);
	assert.equal(r.dollars.basis, "metered");
	assert.equal(redis.store.get(DAY), 300_000);
});

// ---- #503 part 7: a job that cannot spend reserves nothing ----

const OVERLAY = {
	providers: {
		"local-ollama": { api: "openai-completions", baseUrl: "http://host.docker.internal:11434/v1", apiKey: "$PI_DISPATCH_KEYLESS", models: [{ id: "qwen2.5:0.5b" }, { id: "llama3:8b" }] },
		openai: { models: [{ id: "priced-local", api: "openai-completions", baseUrl: "http://host.docker.internal:11434/v1", cost: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 } }] },
	},
};
const ENDPOINTS = [{ id: "mac-ollama", host: "host.docker.internal", port: 11434, slots: 2, keyless: true }];
const snapshot = { endpoints: ENDPOINTS, models: OVERLAY, set: ENDPOINTS };
const localJob = { kind: "local", folder: "/x", task: "t", provider: "local-ollama", model: "qwen2.5:0.5b", maxCostMicros: 2 * USD };

test("a zero-rated job on a declared endpoint writes NO budget:usd key, runs under a cap of 0, and records unreserved", async () => {
	const { deps: d, calls, redis } = deps({ modelEndpoints: snapshot });
	const r = await runJob(localJob, d);
	assert.equal(r.outcome, "completed");
	assert.deepEqual(usdKeys(redis), [], "no dollar key at all");
	assert.deepEqual(calls.find((c) => c[0] === "run-container"), ["run-container", 0], "PI_MAX_COST_MICROS=0 reaches the container");
	assert.deepEqual(r.dollars, { reservedMicros: 0, settledMicros: 0, basis: "unreserved", modelBasis: null });
	assert.equal(localJob.maxCostMicros, 2 * USD, "the job itself is not mutated");
});

test("zero reservation reads the WHOLE allowed list: one listed model off the endpoint or priced means the job reserves", async () => {
	for (const models of [["local-ollama/qwen2.5:0.5b", "anthropic/claude-sonnet-4-5"], ["local-ollama/qwen2.5:0.5b", "openai/priced-local"]]) {
		const { deps: d, calls, redis } = deps({ modelEndpoints: snapshot });
		const r = await runJob({ ...localJob, models }, d);
		assert.equal(redis.store.get(DAY), 300_000, `${models[1]}: reserved and settled`);
		assert.deepEqual(calls.find((c) => c[0] === "run-container"), ["run-container", 2 * USD]);
		assert.equal(r.dollars.basis, "metered");
	}
	const { deps: d, redis } = deps({ modelEndpoints: snapshot });
	await runJob({ ...localJob, models: ["local-ollama/qwen2.5:0.5b", "local-ollama/llama3:8b"] }, d);
	assert.deepEqual(usdKeys(redis), [], "every listed model local and zero-rated: nothing reserved");
});

test("no endpoint snapshot, or an overlay that could not be read, reserves as usual (fail closed)", async () => {
	for (const modelEndpoints of [null, { endpoints: ENDPOINTS, models: null, set: [] }, { endpoints: [], models: OVERLAY, set: [] }]) {
		const { deps: d, redis } = deps({ modelEndpoints });
		await runJob(localJob, d);
		assert.equal(redis.store.get(DAY), 300_000, JSON.stringify(modelEndpoints));
	}
});

// ---- the wiring: makeProcessor resolves the windows from the settings and hands them to runJob ----

let mod;
try {
	mod = await import("../src/index.mjs");
} catch (error) {
	if (process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error(`processor-dollars REQUIRES bullmq here.\n${error}`);
}
const skip = mod ? false : "bullmq not installed; CI runs these";

function harness(settings, redis) {
	const seen = { records: [], container: null };
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis,
		getSettings: () => settings,
		recordRun: (rec) => seen.records.push(rec),
		timeoutMs: 100000,
		deps: {
			mintToken: async () => "tok",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			runContainer: async ({ job }) => ((seen.container = job), { code: 0, aborted: false, exitLineCode: 0, tokens: COMPLETE_TOKENS, usage: LEDGER }),
			cleanup: async () => {},
			comment: async () => {},
			log: () => {},
		},
	});
	return { processor, seen };
}

const settingsOf = (over = {}) => ({ provider: "anthropic", model: "claude-sonnet-4-5", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null, maxCostUsd: null, dailyCostUsd: null, weeklyCostUsd: null, monthlyCostUsd: null, ...over });
const bullJob = (data = {}) => ({ id: "d-1", attemptsMade: 0, name: "github", data: { kind: "github", repo: "o/r", flow: "fix", ...data } });

test("makeProcessor: windows in the settings reserve and settle the per-job cap; the record carries dollars", { skip }, async () => {
	const redis = keyedRedis();
	const { processor, seen } = harness(settingsOf({ maxCostUsd: "2", dailyCostUsd: "10" }), redis);
	const result = await processor(bullJob(), undefined, new AbortController().signal);
	assert.equal(result.outcome, "completed");
	const day = `budget:usd:${new Date().toISOString().slice(0, 10)}`;
	assert.equal(redis.store.get(day), 300_000);
	assert.equal(seen.container.maxCostMicros, 2 * USD);
	assert.deepEqual(seen.records[0].result.dollars, { reservedMicros: 2 * USD, settledMicros: 300_000, basis: "metered", modelBasis: null });
});

test("makeProcessor: with NO dollar setting nothing is written, job data is untouched, and the record's dollars is null", { skip }, async () => {
	for (const settings of [settingsOf(), settingsOf({ maxCostUsd: "2" })]) {
		const redis = keyedRedis();
		const { processor, seen } = harness(settings, redis);
		const queued = bullJob();
		const before = JSON.stringify(queued.data);
		await processor(queued, undefined, new AbortController().signal);
		assert.deepEqual(usdKeys(redis), [], "no budget:usd key");
		assert.ok(!redis.ops.some((o) => o[0] === "incrby"), "no INCRBY at all");
		assert.equal(JSON.stringify(queued.data), before, "job data byte-identical");
		assert.equal(Object.hasOwn(seen.records[0].result, "dollars"), false);
	}
});

test("makeProcessor: a job the operator cancelled while it was failing records its dollars on the cancel record (endCancelled)", { skip }, async () => {
	const redis = keyedRedis();
	const controller = new AbortController();
	const seen = { records: [] };
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis,
		getSettings: () => settingsOf({ maxCostUsd: "2", dailyCostUsd: "10" }),
		recordRun: (rec) => seen.records.push(rec),
		timeoutMs: 100000,
		deps: {
			mintToken: async () => "tok",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			// The container dies as infrastructure while the operator's cancel lands: the processor's catch ends the job as
			// the cancel (endCancelled) instead of retrying it, and that record must still say what the window was charged.
			runContainer: async () => {
				controller.abort("operator-cancel");
				throw new InfraRetry("the daemon went away mid-run", { reason: "container-detached" });
			},
			cleanup: async () => {},
			comment: async () => {},
			log: () => {},
		},
	});
	const result = await processor(bullJob(), undefined, controller.signal);
	assert.equal(result.reason, "operator-cancel");
	assert.deepEqual(result.dollars, { reservedMicros: 2 * USD, settledMicros: 2 * USD, basis: "floor", modelBasis: null });
	assert.deepEqual(seen.records.at(-1).result.dollars, result.dollars);
});

// ---- issue #545: an image that signs its exit line ----

test("an image declaring exitAuth gets a key (runContainer exitAuth: true); one that does not, runs as before", async () => {
	for (const [capabilities, want] of [[["costCap", "exitAuth"], true], [["costCap"], undefined], [undefined, undefined]]) {
		let seen = "unset";
		const { deps: d, logs } = deps({
			imagePreflight: async () => ({ ok: true, image: "pi-job:x", ...(capabilities ? { capabilities } : {}) }),
			runContainer: async (args) => ((seen = args.exitAuth), { code: 0, aborted: false, exitLineCode: 0, tokens: COMPLETE_TOKENS, usage: LEDGER, ...(want ? { exitAuth: "verified" } : {}) }),
		});
		const r = await runJob(job, d);
		assert.equal(seen, want, JSON.stringify(capabilities));
		assert.equal(r.dollars.basis, "metered");
		const exit = logs.find(([event]) => event === "container_exit")[1];
		assert.equal(exit.exitAuth, want ? "verified" : undefined);
	}
});

test("an unverified run (a key issued, no signed line) settles at the FLOOR and records tokens as unknown", async () => {
	const { deps: d, redis, logs } = deps({
		imagePreflight: async () => ({ ok: true, image: "pi-job:x", capabilities: ["exitAuth"] }),
		runContainer: async () => ({ code: 0, aborted: false, turns: null, tokens: null, session: null, usage: null, context: null, exitReason: null, exitLineCode: null, exitAuth: "unverified" }),
	});
	const r = await runJob(job, d);
	assert.equal(r.dollars.basis, "floor");
	assert.equal(r.tokens, null);
	assert.equal(redis.store.get(DAY), 2 * USD);
	assert.equal(logs.find(([event]) => event === "container_exit")[1].exitAuth, "unverified");
});

test("a verified line still meets the #542 rule: a stopped container's signed line settles at the floor", async () => {
	const { deps: d } = deps({
		imagePreflight: async () => ({ ok: true, image: "pi-job:x", capabilities: ["exitAuth"] }),
		runContainer: async () => ({ code: 143, aborted: true, exitLineCode: 143, tokens: COMPLETE_TOKENS, usage: LEDGER, exitAuth: "verified" }),
	});
	const r = await runJob(job, d);
	assert.equal(r.dollars.basis, "floor");
	assert.equal(r.tokens.total, 15, "the token record keeps the runner's real count, which the SIGTERM handler now writes");
});
