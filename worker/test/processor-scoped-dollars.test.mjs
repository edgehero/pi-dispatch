import assert from "node:assert/strict";
import { test } from "node:test";
import { InfraRetry, runJob } from "../src/processor.mjs";
import { buildRecord } from "../src/run-history.mjs";
import { dollarCapsFor, modelDollarRows, parseScopedLimits, scopeKeyPrefix } from "../src/scoped-limits.mjs";

// The job-count ledger list the processor takes (issue #499 part B), from a `budgetCapsFor`-shaped object.
const asLedgers = (c) => (c ? [{ scope: c.scope, keyPrefix: scopeKeyPrefix(c.scope), caps: c.caps, reason: "scope-cap" }] : []);

// Issues #501 part 5 and #502 part 6 (scoped-limits.json version 2; DES-DOLLAR-RESERVE-AND-SETTLE, the worker half):
// a job reserves its per-job cap in the deployment's dollar windows, its repo or folder row's, and every model row it
// may reach, in ONE reservation; a refusal anywhere gives everything back. The deployment and scope windows settle to
// the job's cost, each model window to its own usage row.

const USD = 1_000_000;
const NOW = new Date("2026-10-07T12:00:00Z");
const DAY = "budget:usd:2026-10-07";

/** The keyed fake of processor-dollars.test.mjs: job-count INCR/DECR and dollar INCRBY/DECRBY/settle on one store. */
function keyedRedis(preset = {}) {
	const store = new Map(Object.entries(preset));
	const ops = [];
	const at = (k) => store.get(k) ?? 0;
	return {
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
}

const LIMITS = parseScopedLimits(
	JSON.stringify({
		version: 2,
		limits: [
			{ scope: "org/repo", dayUsd: "10" },
			{ scope: "model:openai/gpt-x", dayUsd: "3" },
			{ scope: "model:Anthropic/Claude-X", dayUsd: "100" },
		],
	}),
	"sl.json",
);
const [GPT, CLAUDE] = modelDollarRows(LIMITS, null);
const SCOPE = dollarCapsFor({ kind: "github", repo: "org/repo" }, LIMITS);
const gptDay = `${GPT.keyPrefix}:2026-10-07`;
const claudeDay = `${CLAUDE.keyPrefix}:2026-10-07`;
const scopeDay = `${SCOPE.keyPrefix}:2026-10-07`;

const TOKENS = (cost) => ({ input: 10, output: 5, total: 15, cost, calls: 2, metered: true, unresolved: 0, unpriced: 0, childTotal: 0, childProcesses: 0, unmeteredChildren: 0, costCapMicros: 2 * USD, costRefused: 0, boundExceeded: 0, longContext: 0, costUnjudged: 0, costUnanswered: 0 });
const ROW = (provider, model, cost) => ({ provider, model, calls: 1, input: 5, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total: 7, cost, unpriced: 0 });
const USAGE = (rows, truncated = 0) => ({ v: 1, piAi: null, truncated, models: rows });

function deps(overrides = {}) {
	const calls = [];
	const logs = [];
	const redis = overrides.redis ?? keyedRedis();
	const base = {
		redis,
		caps: { day: 10, week: null, month: null },
		softHoldPct: null,
		dollarCaps: { day: 50 * USD, week: null, month: null },
		mintToken: async () => "tok",
		isDefaultBranchProtected: async () => true,
		prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
		runContainer: async () => (calls.push("run-container"), { code: 0, aborted: false, exitLineCode: 0, tokens: TOKENS(0.5), usage: USAGE([ROW("openai", "gpt-x", 0.5)]) }),
		collectChain: async () => ({ enqueued: 0, refused: 0 }),
		cleanup: async () => {},
		comment: async (_j, t) => calls.push(["comment", t]),
		log: (event, fields) => logs.push([event, fields]),
		now: NOW,
	};
	return { deps: { ...base, ...overrides, redis }, calls, logs, redis };
}

// An unrestricted job (no `models`): it reserves in EVERY model row.
const job = { kind: "github", repo: "org/repo", provider: "openai", model: "gpt-x", maxTurns: 20, maxCostMicros: 2 * USD };

test("a per-model window refuses the SECOND job with dollar-cap, names the model, and gives every other window back", async () => {
	const redis = keyedRedis();
	const first = deps({ redis, scopedDollars: SCOPE, modelDollars: modelDollarRows(LIMITS, ["openai/gpt-x"]) });
	const r1 = await runJob({ ...job, models: ["openai/gpt-x"] }, first.deps);
	assert.equal(r1.outcome, "completed");
	assert.equal(redis.store.get(gptDay), 500_000, "the model window settled to its own row");
	assert.deepEqual(r1.dollars, { reservedMicros: 2 * USD, settledMicros: 500_000, basis: "metered", modelBasis: "metered" });
	// $0.50 settled + a $2 hold = $2.50 fits under $3; a second $2 hold would make $4.50. Hold one open, then refuse.
	const hold = deps({ redis, scopedDollars: SCOPE, modelDollars: modelDollarRows(LIMITS, ["openai/gpt-x"]) });
	let release;
	const parked = new Promise((r) => (release = r));
	hold.deps.runContainer = async () => (await parked, { code: 0, aborted: false, exitLineCode: 0, tokens: TOKENS(0.5), usage: USAGE([ROW("openai", "gpt-x", 0.5)]) });
	const running = runJob({ ...job, models: ["openai/gpt-x"] }, hold.deps);
	await new Promise((r) => setImmediate(r));
	assert.equal(redis.store.get(gptDay), 2_500_000);
	const second = deps({ redis, scopedDollars: SCOPE, modelDollars: modelDollarRows(LIMITS, ["openai/gpt-x"]) });
	const before = { deployment: redis.store.get(DAY), scope: redis.store.get(scopeDay), global: redis.store.get("budget:2026-10-07") };
	const r2 = await runJob({ ...job, models: ["openai/gpt-x"] }, second.deps);
	assert.equal(r2.reason, "dollar-cap");
	assert.equal(r2.budgetReserved, false);
	assert.deepEqual(r2.dollars, { reservedMicros: 2 * USD, settledMicros: 0, basis: "refunded", modelBasis: "refunded" });
	assert.ok(!second.calls.includes("run-container"), "no container");
	assert.equal(redis.store.get(DAY), before.deployment, "the deployment reservation was given back");
	assert.equal(redis.store.get(scopeDay), before.scope, "the scope reservation was given back");
	assert.equal(redis.store.get(gptDay), 2_500_000, "the refusing window was given back too");
	assert.equal(redis.store.get("budget:2026-10-07"), before.global, "the job-count slot went back");
	const logged = second.logs.find((l) => l[0] === "over_dollar_budget")[1];
	assert.deepEqual(logged, { ledger: "model", key: GPT.keyPrefix, model: "openai/gpt-x", window: "day", reservedMicros: 4_500_000, capMicros: 3 * USD, amountMicros: 2 * USD, refunded: true });
	assert.match(second.calls.find((c) => c[0] === "comment")[1], /^Refused: today's dollar budget for the model openai\/gpt-x has no room left/);
	release();
	await running;
});

test("a FULL scope window refuses the job and gives back the deployment reservation it had already taken", async () => {
	const redis = keyedRedis({ [scopeDay]: 9 * USD });
	const { deps: d, calls, logs } = deps({ redis, scopedDollars: SCOPE, modelDollars: [], scopedLedgers: asLedgers({ scope: "org/repo", caps: { day: 5, week: null, month: null } }) });
	const r = await runJob(job, d);
	assert.equal(r.reason, "dollar-cap");
	assert.deepEqual(r.dollars, { reservedMicros: 2 * USD, settledMicros: 0, basis: "refunded", modelBasis: null });
	// The deployment window reserved FIRST, then the scope refused: both given back, in that order.
	assert.deepEqual(redis.ops.filter((o) => o[0] === "incrby" || o[0] === "decrby"), [["incrby", DAY, 2 * USD], ["incrby", scopeDay, 2 * USD], ["decrby", DAY, 2 * USD], ["decrby", scopeDay, 2 * USD]]);
	assert.equal(redis.store.get(DAY), 0);
	assert.equal(redis.store.get(scopeDay), 9 * USD);
	assert.equal(redis.store.get(`${scopeKeyPrefix("org/repo")}:2026-10-07`), 0, "the scoped job-count slot went back");
	assert.ok(!calls.includes("run-container"));
	const logged = logs.find((l) => l[0] === "over_dollar_budget")[1];
	assert.equal(logged.ledger, "scope");
	assert.equal(logged.key, SCOPE.keyPrefix, "the scope is named by its hashed key prefix");
	assert.ok(!JSON.stringify(logged).includes("org/repo"), "never the scope string in the log");
	assert.match(calls.find((c) => c[0] === "comment")[1], /dollar budget for org\/repo has no room/);
	assert.equal(Object.hasOwn(logged, "capBelowJob"), false, "a full window that could fit the cap is the no-room case");
	// A local job's comment says "this folder", never the path.
	const local = deps({ redis: keyedRedis({ [`${dollarCapsFor({ kind: "local", folder: "/srv/site" }, parseScopedLimits(JSON.stringify({ version: 2, limits: [{ scope: "/srv/site", dayUsd: "1" }] }), "x"))?.keyPrefix}:2026-10-07`]: USD }), scopedDollars: dollarCapsFor({ kind: "local", folder: "/srv/site" }, parseScopedLimits(JSON.stringify({ version: 2, limits: [{ scope: "/srv/site", dayUsd: "1" }] }), "x")), prepareWorkspace: async () => ({ workspaceDir: "/srv/site", jobDir: "/j" }) });
	const lr = await runJob({ kind: "local", folder: "/srv/site", provider: "openai", model: "gpt-x", maxTurns: 5, maxCostMicros: 2 * USD }, local.deps);
	assert.equal(lr.reason, "dollar-cap");
	const lc = local.calls.find((c) => c[0] === "comment")[1];
	// Its $1 window is below the $2 per-job cap: the comment says the window is too small, not "no room left today".
	assert.match(lc, /^Refused: the daily dollar budget for this folder is smaller than this run's cost limit/);
	assert.equal(local.logs.find((l) => l[0] === "over_dollar_budget")[1].capBelowJob, true);
	assert.ok(!lc.includes("/srv/site"));
});

test("issue #498: a FULL qualified scope window refuses the job, and the comment names the repo without the forge prefix", async () => {
	const limits = parseScopedLimits(JSON.stringify({ version: 2, limits: [{ scope: "forgejo:acme/web", dayUsd: "10" }] }), "sl.json");
	const fj = { ...job, kind: "forgejo", repo: "acme/web" };
	const scoped = dollarCapsFor(fj, limits);
	assert.equal(scoped.scope, "forgejo:acme/web", "the matched row's scope");
	const { deps: d, calls } = deps({ redis: keyedRedis({ [`${scoped.keyPrefix}:2026-10-07`]: 9 * USD }), scopedDollars: scoped, modelDollars: [] });
	const r = await runJob(fj, d);
	assert.equal(r.reason, "dollar-cap");
	const text = calls.find((c) => c[0] === "comment")[1];
	assert.match(text, /dollar budget for acme\/web has no room/);
	assert.ok(!text.includes("forgejo:"), "the comment lives on that forge already");
});

test("an UNRESTRICTED job reserves in every model row; a listed one only in its listed rows; each settles from its OWN usage row", async () => {
	const redis = keyedRedis();
	const all = modelDollarRows(LIMITS, null);
	assert.deepEqual(all.map((m) => m.ref), ["openai/gpt-x", "anthropic/claude-x"]);
	const { deps: d } = deps({ redis, modelDollars: all, runContainer: async () => ({ code: 0, aborted: false, exitLineCode: 0, tokens: TOKENS(1.75), usage: USAGE([ROW("openai", "gpt-x", 0.25), ROW("anthropic", "claude-x", 1.5)]) }) });
	const r = await runJob(job, d);
	assert.deepEqual(redis.ops.filter((o) => o[0] === "incrby").map((o) => o[1]), [DAY, gptDay, claudeDay], "the deployment, then every model row");
	assert.equal(redis.store.get(DAY), 1_750_000, "the deployment window: the job's cost");
	assert.equal(redis.store.get(gptDay), 250_000, "gpt-x: its own row");
	assert.equal(redis.store.get(claudeDay), 1_500_000, "claude-x: its own row, never the job total");
	assert.deepEqual(r.dollars, { reservedMicros: 2 * USD, settledMicros: 1_750_000, basis: "metered", modelBasis: "metered" });
	assert.equal(buildRecord({ job: { id: "j", data: {} }, result: r }).dollars.modelBasis, "metered");
	// A listed job: only the rows of its list.
	const listed = keyedRedis();
	await runJob({ ...job, models: ["openai/gpt-x"] }, deps({ redis: listed, modelDollars: modelDollarRows(LIMITS, ["openai/gpt-x"]) }).deps);
	assert.deepEqual(listed.ops.filter((o) => o[0] === "incrby").map((o) => o[1]), [DAY, gptDay], "its listed row only, claude-x untouched");
	// A model on the job's list with no usage row made no call: settled to 0.
	const idle = keyedRedis();
	await runJob(job, deps({ redis: idle, modelDollars: all }).deps);
	assert.equal(idle.store.get(claudeDay), 0);
});

test("model settlement floors when the ledger is incomplete: truncated, an other/other cost, no ledger with calls, an untrusted line", async () => {
	const cases = [
		["truncated > 0", { usage: USAGE([ROW("openai", "gpt-x", 0.25)], 1) }],
		["other/other with a cost", { usage: USAGE([ROW("openai", "gpt-x", 0.25), ROW("other", "other", 0.1)]) }],
		["no ledger while calls were made", { usage: null }],
		["an untrusted exit line", { usage: USAGE([ROW("openai", "gpt-x", 0.25)]), exitLineCode: 2 }],
		["the deployment basis is floor", { usage: USAGE([ROW("openai", "gpt-x", 0.25)]), tokens: { ...TOKENS(0.25), unpriced: 1 } }],
	];
	for (const [name, out] of cases) {
		const redis = keyedRedis();
		const { deps: d } = deps({ redis, modelDollars: modelDollarRows(LIMITS, null), runContainer: async () => ({ code: 0, aborted: false, exitLineCode: 0, tokens: TOKENS(0.25), ...out }) });
		const r = await runJob(job, d);
		assert.equal(r.dollars.modelBasis, "floor", name);
		assert.equal(redis.store.get(gptDay), 2 * USD, `${name}: the model window keeps the reservation`);
		assert.equal(redis.store.get(claudeDay), 2 * USD, name);
	}
	// truncated alone leaves the DEPLOYMENT metered: only the per-model split is unknown.
	const redis = keyedRedis();
	const r = await runJob(job, deps({ redis, modelDollars: modelDollarRows(LIMITS, null), runContainer: async () => ({ code: 0, aborted: false, exitLineCode: 0, tokens: TOKENS(0.25), usage: USAGE([ROW("openai", "gpt-x", 0.25)], 1) }) }).deps);
	assert.deepEqual(r.dollars, { reservedMicros: 2 * USD, settledMicros: 250_000, basis: "metered", modelBasis: "floor" });
	assert.equal(redis.store.get(DAY), 250_000);
});

test("scope and model rows reserve with NO deployment window; a job with no per-job cap is config-refused; a zero-rated job reserves nowhere", async () => {
	const redis = keyedRedis();
	const r = await runJob(job, deps({ redis, dollarCaps: null, scopedDollars: SCOPE, modelDollars: modelDollarRows(LIMITS, null) }).deps);
	assert.equal(r.outcome, "completed");
	assert.deepEqual(redis.ops.filter((o) => o[0] === "incrby").map((o) => o[1]), [scopeDay, gptDay, claudeDay]);
	assert.equal(redis.store.get(scopeDay), 500_000, "the scope window settles to the job's cost");
	const none = keyedRedis();
	const c = await runJob({ ...job, maxCostMicros: null }, deps({ redis: none, dollarCaps: null, modelDollars: modelDollarRows(LIMITS, null) }).deps);
	assert.equal(c.reason, "config-refused");
	assert.ok(![...none.store.keys()].some((k) => k.startsWith("budget:usd")), "nothing reserved");
	// A cap of 0 (the zero-reservation rule) reserves in no window at all, model rows included.
	const zero = keyedRedis();
	const z = await runJob({ ...job, maxCostMicros: 0 }, deps({ redis: zero, scopedDollars: SCOPE, modelDollars: modelDollarRows(LIMITS, null) }).deps);
	assert.deepEqual(z.dollars, { reservedMicros: 0, settledMicros: 0, basis: "unreserved", modelBasis: null });
	assert.ok(![...zero.store.keys()].some((k) => k.startsWith("budget:usd")));
});

test("a never-started exit refunds the model windows too, and the record says modelBasis refunded", async () => {
	const redis = keyedRedis();
	const { deps: d } = deps({ redis, modelDollars: modelDollarRows(LIMITS, null), runContainer: async () => ({ code: 125, aborted: false, tokens: null }) });
	const err = await runJob(job, d).then(
		() => null,
		(e) => e,
	);
	assert.ok(err instanceof InfraRetry);
	assert.deepEqual(err.dollars, { reservedMicros: 2 * USD, settledMicros: 0, basis: "refunded", modelBasis: "refunded" });
	assert.equal(redis.store.get(gptDay), 0);
	assert.equal(redis.store.get(claudeDay), 0);
});

// ---- the wiring (PR #549's review): makeProcessor reads the limits seam and hands runJob the scope and model rows ----

let mod;
try {
	mod = await import("../src/index.mjs");
} catch (error) {
	if (process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error(`processor-scoped-dollars REQUIRES bullmq here.\n${error}`);
}
const skip = mod ? false : "bullmq not installed; CI runs these";

const WIRED_LIMITS = parseScopedLimits(
	JSON.stringify({
		version: 2,
		limits: [
			{ scope: "o/r", dayUsd: "10" },
			{ scope: "model:anthropic/claude-sonnet-4-5", dayUsd: "10" },
			{ scope: "model:openai/gpt-x", dayUsd: "10" },
		],
	}),
	"sl.json",
);

function wired({ allowedModels = null, redis = keyedRedis() } = {}) {
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis,
		getSettings: () => ({ provider: "anthropic", model: "claude-sonnet-4-5", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null, maxCostUsd: "2", dailyCostUsd: null, weeklyCostUsd: null, monthlyCostUsd: null }),
		scopedLimits: () => WIRED_LIMITS,
		recordRun: () => {},
		timeoutMs: 100000,
		deps: {
			...(allowedModels ? { allowedModels } : {}),
			mintToken: async () => "tok",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			runContainer: async () => ({ code: 0, aborted: false, exitLineCode: 0, tokens: TOKENS(0.5), usage: USAGE([ROW("anthropic", "claude-sonnet-4-5", 0.5)]) }),
			cleanup: async () => {},
			comment: async () => {},
			log: () => {},
		},
	});
	return { processor, redis };
}

const reservedPrefixes = (redis) => redis.ops.filter((o) => o[0] === "incrby").map((o) => o[1].replace(/:\d{4}-\d{2}-\d{2}$/, ""));
const [WIRED_SONNET, WIRED_GPT] = modelDollarRows(WIRED_LIMITS, null);
const WIRED_SCOPE = dollarCapsFor({ kind: "github", repo: "o/r" }, WIRED_LIMITS);
const bull = (data = {}) => ({ id: "s-1", attemptsMade: 0, name: "github", data: { kind: "github", repo: "o/r", flow: "fix", ...data } });

test("makeProcessor: the limits seam's scope row and EVERY model row are reserved for an unrestricted job", { skip }, async () => {
	const { processor, redis } = wired();
	const result = await processor(bull(), undefined, new AbortController().signal);
	assert.equal(result.outcome, "completed");
	assert.deepEqual(reservedPrefixes(redis), [WIRED_SCOPE.keyPrefix, WIRED_SONNET.keyPrefix, WIRED_GPT.keyPrefix]);
	assert.equal(result.dollars.modelBasis, "metered");
});

test("makeProcessor: PI_ALLOWED_MODELS (the env list, no trigger list) limits which model rows are reserved", { skip }, async () => {
	const { processor, redis } = wired({ allowedModels: ["anthropic/claude-sonnet-4-5"] });
	const result = await processor(bull(), undefined, new AbortController().signal);
	assert.equal(result.outcome, "completed");
	assert.deepEqual(reservedPrefixes(redis), [WIRED_SCOPE.keyPrefix, WIRED_SONNET.keyPrefix], "gpt-x is not on the effective list");
	// A trigger list replaces the env list.
	const t = wired({ allowedModels: ["anthropic/claude-sonnet-4-5"] });
	await t.processor(bull({ models: ["anthropic/claude-sonnet-4-5", "openai/gpt-x"] }), undefined, new AbortController().signal);
	assert.deepEqual(reservedPrefixes(t.redis), [WIRED_SCOPE.keyPrefix, WIRED_SONNET.keyPrefix, WIRED_GPT.keyPrefix]);
});

// ---- the modelBasis labels on the fault paths (PR #549's review, survivors S5 S6 S7) ----

test("a settle fault on a model window's keys records modelBasis floor, while the deployment settled metered", async () => {
	const redis = keyedRedis();
	const evalOk = redis.eval;
	redis.eval = async (script, n, k, arg) => {
		if (k.startsWith("budget:usd:mdl:")) throw Object.assign(new Error("down"), { code: "ECONNRESET" });
		return evalOk(script, n, k, arg);
	};
	const { deps: d, logs } = deps({ redis, modelDollars: modelDollarRows(LIMITS, null) });
	const r = await runJob(job, d);
	assert.deepEqual(r.dollars, { reservedMicros: 2 * USD, settledMicros: 500_000, basis: "metered", modelBasis: "floor" });
	assert.equal(redis.store.get(gptDay), 2 * USD, "the model window kept the reservation");
	assert.ok(logs.some((l) => l[0] === "dollar_settle_error"));
});

test("a dollar-cap refusal whose give-back could not reach a key records modelBasis floor", async () => {
	const redis = keyedRedis({ [claudeDay]: 99 * USD });
	const decrbyOk = redis.decrby;
	redis.decrby = async (k, n) => {
		if (k === gptDay) throw Object.assign(new Error("down"), { code: "ECONNRESET" });
		return decrbyOk(k, n);
	};
	const r = await runJob(job, deps({ redis, modelDollars: modelDollarRows(LIMITS, null) }).deps);
	assert.equal(r.reason, "dollar-cap");
	assert.deepEqual(r.dollars, { reservedMicros: 2 * USD, settledMicros: 2 * USD, basis: "floor", modelBasis: "floor" });
});

test("an unexpected throw after the reserve leaves the hold standing and records modelBasis floor", async () => {
	const redis = keyedRedis();
	const { deps: d } = deps({
		redis,
		modelDollars: modelDollarRows(LIMITS, null),
		runContainer: async () => {
			throw new TypeError("a defect");
		},
	});
	const err = await runJob(job, d).then(
		() => null,
		(e) => e,
	);
	assert.ok(err);
	assert.deepEqual(err.dollars, { reservedMicros: 2 * USD, settledMicros: 2 * USD, basis: "floor", modelBasis: "floor" });
	assert.equal(redis.store.get(gptDay), 2 * USD);
});

test("the BOUNDARY: a full window whose cap EQUALS the per-job cap says no room left, never too small (PR #549's review)", async () => {
	const limits = parseScopedLimits(JSON.stringify({ version: 2, limits: [{ scope: "org/repo", dayUsd: "2" }] }), "sl.json");
	const scope = dollarCapsFor({ kind: "github", repo: "org/repo" }, limits);
	const { deps: d, calls, logs } = deps({ redis: keyedRedis({ [`${scope.keyPrefix}:2026-10-07`]: USD }), scopedDollars: scope });
	const r = await runJob(job, d);
	assert.equal(r.reason, "dollar-cap");
	assert.match(calls.find((c) => c[0] === "comment")[1], /^Refused: today's dollar budget for org\/repo has no room left/);
	assert.equal(Object.hasOwn(logs.find((l) => l[0] === "over_dollar_budget")[1], "capBelowJob"), false);
});

test("a release (never-started) whose give-back fails part-way records modelBasis floor (PR #549's review)", async () => {
	const redis = keyedRedis();
	const evalOk = redis.eval;
	redis.eval = async (script, n, k, arg) => {
		if (k === claudeDay) throw Object.assign(new Error("down"), { code: "ECONNRESET" });
		return evalOk(script, n, k, arg);
	};
	const { deps: d } = deps({ redis, modelDollars: modelDollarRows(LIMITS, null), runContainer: async () => ({ code: 125, aborted: false, tokens: null }) });
	const err = await runJob(job, d).then(
		() => null,
		(e) => e,
	);
	assert.ok(err instanceof InfraRetry);
	assert.deepEqual(err.dollars, { reservedMicros: 2 * USD, settledMicros: 2 * USD, basis: "floor", modelBasis: "floor" });
});
