import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { InfraRetry, runJob } from "../src/processor.mjs";
import { configError } from "../src/config.mjs";
import { dollarCapsFor, parseScopedLimits, projectDollarCapsFor, scopeDollarKeyPrefix, scopedLedgers, scopeKeyPrefix } from "../src/scoped-limits.mjs";

// Issue #499 part B (INT-SCOPED-LIMITS-FILE-CONTRACT, DES-SCOPED-LIMITS-AND-FOLDER-MUTEX): a `project:<id>` row caps
// every member of a project as one. The job-count ledgers reserve narrowest first (repo or folder row, project row,
// global) through one helper and give back last first; the dollar ledgers gain the project tier in one hold.

const USD = 1_000_000;
const NOW = new Date("2026-07-16T10:00:00Z");
const G_DAY = "budget:2026-07-16";
const P_PREFIX = scopeKeyPrefix("project:shop");
const P_DAY = `${P_PREFIX}:2026-07-16`;
const dayOf = (scope) => `${scopeKeyPrefix(scope)}:2026-07-16`;

/** A keyed fake: job-count INCR/DECR and dollar INCRBY/DECRBY/settle on one store, every op in order. */
function keyedRedis(preset = {}, { failDecr = false, failDecrOn = null, failIncrOn = null } = {}) {
	const store = new Map(Object.entries(preset));
	const ops = [];
	const at = (k) => store.get(k) ?? 0;
	return {
		store,
		ops,
		async incr(k) {
			ops.push(["incr", k]);
			if (k === failIncrOn) throw Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
			store.set(k, at(k) + 1);
			return at(k);
		},
		async decr(k) {
			ops.push(["decr", k]);
			if (failDecr || k === failDecrOn) throw Object.assign(new Error("READONLY"), { code: "READONLY" });
			store.set(k, at(k) - 1);
			return at(k);
		},
		async incrby(k, n) {
			ops.push(["incrby", k, n]);
			store.set(k, at(k) + n);
			return at(k);
		},
		async decrby(k, n) {
			ops.push(["decrby", k, n]);
			store.set(k, at(k) - n);
			return at(k);
		},
		async eval(_script, _n, k, arg) {
			const d = Number(arg);
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
			{ scope: "github:acme/web", day: 5 },
			{ scope: "github:acme/api", day: 5 },
			{ scope: "project:shop", day: 2, dayUsd: "3" },
		],
	}),
	"sl.json",
);
const web = { kind: "github", repo: "acme/web", provider: "anthropic", model: "m", maxTurns: 20 };
const api = { kind: "github", repo: "acme/api", provider: "anthropic", model: "m", maxTurns: 20 };
const WEB_DAY = dayOf("github:acme/web");
const API_DAY = dayOf("github:acme/api");

function deps(job, overrides = {}) {
	const comments = [];
	const logs = [];
	const calls = [];
	const base = {
		redis: keyedRedis(),
		caps: { day: 10, week: null, month: null },
		softHoldPct: null,
		scopedLedgers: scopedLedgers(job, LIMITS, "shop"),
		mintToken: async () => "tok",
		isDefaultBranchProtected: async () => true,
		prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
		runContainer: async () => (calls.push("run-container"), { code: 0, aborted: false }),
		collectChain: async () => ({ enqueued: 0, refused: 0 }),
		cleanup: async () => {},
		comment: async (_j, t) => comments.push(t),
		log: (e, f) => logs.push({ e, f }),
		now: NOW,
	};
	return { deps: { ...base, ...overrides }, comments, logs, calls };
}

test("(a) a project day: 2 over two member repos: the third job refuses project-cap, its repo slot goes back, the global ledger is untouched", async () => {
	const redis = keyedRedis();
	assert.equal((await runJob(web, deps(web, { redis }).deps)).outcome, "completed");
	assert.equal((await runJob(api, deps(api, { redis }).deps)).outcome, "completed");
	const third = deps(web, { redis });
	const r = await runJob(web, third.deps);
	assert.equal(r.outcome, "policy");
	assert.equal(r.reason, "project-cap");
	assert.equal(r.budgetReserved, false, "budgetReserved stays GLOBAL-only: the global slot was never touched");
	assert.ok(!third.calls.includes("run-container"));
	assert.equal(redis.store.get(WEB_DAY), 1, "the repo slot this job took was given back (INCR then DECR)");
	assert.equal(redis.store.get(API_DAY), 1);
	assert.equal(redis.store.get(P_DAY), 3, "the project keeps its refused reservation (refused-still-counts, per ledger)");
	assert.equal(redis.store.get(G_DAY), 2, "the global ledger saw only the two jobs that ran");
	assert.equal(third.comments[0], "Over the day run cap for this project (2). Not run.");
	assert.deepEqual(third.logs.find((l) => l.e === "over_scope_budget").f, { scopeKey: P_PREFIX, ledger: "project", window: "day", reserved: 3, cap: 2, kind: "forge" });
	// The reserve ORDER: the repo before the project, the project before the global.
	const incrs = redis.ops.filter((o) => o[0] === "incr").map((o) => o[1]);
	assert.deepEqual(incrs.slice(0, 3), [WEB_DAY, P_DAY, G_DAY], "repo, project, global");
});

test("a repo refusal never touches the project or the global ledger", async () => {
	const redis = keyedRedis({ [WEB_DAY]: 5 });
	const r = await runJob(web, deps(web, { redis }).deps);
	assert.equal(r.reason, "scope-cap");
	assert.equal(redis.store.has(P_DAY), false, "a refusal by the narrower ledger never consumes a project slot");
	assert.equal(redis.store.has(G_DAY), false);
});

test("(b) a GLOBAL refusal gives back the project slot and the repo slot, last first", async () => {
	const redis = keyedRedis({ [G_DAY]: 10 });
	const r = await runJob(web, deps(web, { redis }).deps);
	assert.equal(r.reason, "over-budget");
	assert.equal(r.budgetReserved, true);
	assert.equal(redis.store.get(P_DAY), 0, "the project slot went back");
	assert.equal(redis.store.get(WEB_DAY), 0, "the repo slot went back");
	assert.equal(redis.store.get(G_DAY), 11, "the global ledger keeps its refused reservation");
	assert.deepEqual(redis.ops.filter((o) => o[0] === "decr").map((o) => o[1]), [P_DAY, WEB_DAY], "released in reverse order");
});

test("(c) a never-started container refunds all three ledgers; a container that ran refunds none", async () => {
	{
		const redis = keyedRedis();
		await assert.rejects(() => runJob(web, deps(web, { redis, runContainer: async () => ({ code: 125, aborted: false }) }).deps), (e) => e.reason === "container-never-started" && e.budgetReserved === false);
		assert.equal(redis.store.get(WEB_DAY), 0);
		assert.equal(redis.store.get(P_DAY), 0);
		assert.equal(redis.store.get(G_DAY), 0);
		assert.deepEqual(redis.ops.filter((o) => o[0] === "decr").map((o) => o[1]), [G_DAY, P_DAY, WEB_DAY], "last first");
	}
	{
		const redis = keyedRedis();
		await assert.rejects(() => runJob(web, deps(web, { redis, runContainer: async () => ({ code: 1, aborted: false }) }).deps), (e) => e instanceof InfraRetry && e.budgetReserved === true);
		assert.equal(redis.store.get(WEB_DAY), 1);
		assert.equal(redis.store.get(P_DAY), 1);
		assert.equal(redis.store.get(G_DAY), 1);
	}
});

test("(d) a config-refused job releases all three ledgers; a refund that fails says so", async () => {
	const refuse = async () => {
		throw configError("no provider credential");
	};
	{
		const redis = keyedRedis();
		const r = await runJob(web, deps(web, { redis, runContainer: refuse }).deps);
		assert.equal(r.reason, "config-refused");
		assert.equal(r.budgetReserved, false);
		assert.equal(redis.store.get(WEB_DAY), 0);
		assert.equal(redis.store.get(P_DAY), 0);
		assert.equal(redis.store.get(G_DAY), 0);
	}
	{
		const redis = keyedRedis({}, { failDecr: true });
		const d = deps(web, { redis, runContainer: refuse });
		const r = await runJob(web, d.deps);
		assert.equal(r.reason, "config-refused", "a failed refund never replaces the classification");
		assert.equal(r.budgetReserved, true, "the record follows the ledger, not the intent");
		assert.ok(d.logs.some((l) => l.e === "budget_release_failed" && l.f.at === "config-refused"));
	}
});

test("budgetReserved is ONE rule, global-only: a refund whose global give-back landed records false even when a narrower one failed", async () => {
	const P_USD_ = projectDollarCapsFor(LIMITS, "shop");
	// dollar-cap: the project dollar window is full; the project slot's DECR fails after the global DECR landed.
	{
		const redis = keyedRedis({ [`${P_USD_.keyPrefix}:2026-07-16`]: 2 * USD }, { failDecrOn: P_DAY });
		const d = deps(DJOB, { redis, dollarCaps: { day: 50 * USD, week: null, month: null }, projectDollars: P_USD_ });
		const r = await runJob(DJOB, d.deps);
		assert.equal(r.reason, "dollar-cap");
		assert.equal(redis.store.get(G_DAY), 0, "the global slot was given back");
		assert.equal(r.budgetReserved, false, "so the record says it is not held");
		assert.ok(d.logs.some((l) => l.e === "budget_release_failed" && l.f.at === "dollar-cap"), "the stranded project slot is in the log");
	}
	// config-refused: the same.
	{
		const redis = keyedRedis({}, { failDecrOn: P_DAY });
		const r = await runJob(web, deps(web, { redis, runContainer: async () => { throw configError("no provider credential"); } }).deps);
		assert.equal(r.reason, "config-refused");
		assert.equal(redis.store.get(G_DAY), 0);
		assert.equal(r.budgetReserved, false);
	}
	// never-started: the same rule on the InfraRetry.
	{
		const redis = keyedRedis({}, { failDecrOn: P_DAY });
		await assert.rejects(() => runJob(web, deps(web, { redis, runContainer: async () => ({ code: 125, aborted: false }) }).deps), (e) => e.reason === "container-never-started" && e.budgetReserved === false);
	}
});

test("a Valkey fault inside the count reservations gives back every ledger that landed whole before it rethrows", async () => {
	const redis = keyedRedis({}, { failIncrOn: G_DAY });
	const d = deps(web, { redis });
	await assert.rejects(() => runJob(web, d.deps), (e) => e.code === "ECONNRESET");
	assert.ok(!d.calls.includes("run-container"));
	assert.equal(redis.store.get(WEB_DAY), 0, "the repo slot went back");
	assert.equal(redis.store.get(P_DAY), 0, "the project slot went back");
	assert.deepEqual(redis.ops.filter((o) => o[0] === "decr").map((o) => o[1]), [P_DAY, WEB_DAY], "last first");
});

test("a fault on a LATER window of one ledger gives back the whole ledgers before it; that ledger's own earlier window stays counted", async () => {
	// The project row has a day and a week; its week INCR faults after its day INCR landed. The repo ledger, whole, goes
	// back. The project's day stays counted: reserveBudget does not say which of its windows landed, so a give-back
	// could DECR a window that never rose (the pre-existing mid-reserve posture of one ledger, said in processor.mjs).
	const limits = parseScopedLimits(JSON.stringify({ version: 2, limits: [{ scope: "github:acme/web", day: 5 }, { scope: "project:shop", day: 2, week: 9 }] }), "sl.json");
	const P_WEEK = `${P_PREFIX}:w:2026-07-13`;
	const redis = keyedRedis({}, { failIncrOn: P_WEEK });
	const d = deps(web, { redis, scopedLedgers: scopedLedgers(web, limits, "shop") });
	await assert.rejects(() => runJob(web, d.deps), (e) => e.code === "ECONNRESET");
	assert.deepEqual(redis.ops.map((o) => o.join(" ")), [`incr ${WEB_DAY}`, `incr ${P_DAY}`, `incr ${P_WEEK}`, `decr ${WEB_DAY}`]);
	assert.equal(redis.store.get(WEB_DAY), 0, "the repo ledger, whole, went back");
	assert.equal(redis.store.get(P_DAY), 1, "the faulted ledger's earlier window stays counted, as documented");
	assert.equal(redis.store.has(G_DAY), false, "the global ledger was never reached");
});

// ── dollars: the project tier ────────────────────────────────────────────────────────────────────────────

const DJOB = { ...web, provider: "openai", model: "gpt-x", maxCostMicros: 2 * USD };
const P_USD = projectDollarCapsFor(LIMITS, "shop");
const P_USD_DAY = `${P_USD.keyPrefix}:2026-07-16`;
const D_DAY = "budget:usd:2026-07-16";
const TOKENS = (cost) => ({ input: 10, output: 5, total: 15, cost, calls: 2, metered: true, unresolved: 0, unpriced: 0, childTotal: 0, childProcesses: 0, unmeteredChildren: 0, costCapMicros: 2 * USD, costRefused: 0, boundExceeded: 0, longContext: 0, costUnjudged: 0, costUnanswered: 0, costUnreported: 0 });
const ROW = (provider, model, cost) => ({ provider, model, calls: 1, input: 5, output: 2, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total: 7, cost, unpriced: 0 });
const MODEL = { ref: "openai/gpt-x", keyPrefix: "budget:usd:mdl:feedfacefeedface", caps: { day: 100 * USD, week: null, month: null } };
const ranFor = (cost, modelCost) => async () => ({ code: 0, aborted: false, exitLineCode: 0, tokens: TOKENS(cost), usage: { v: 1, piAi: null, truncated: 0, models: [ROW("openai", "gpt-x", modelCost)] } });

test("the project dollar window is under scopeDollarKeyPrefix(project:shop), reserved after the scope and before the models, in ONE hold", async () => {
	assert.equal(P_USD.keyPrefix, scopeDollarKeyPrefix("project:shop"));
	assert.ok(!P_USD.keyPrefix.startsWith("budget:usd:p:"), "no second dollar keyspace for projects");
	const scope = dollarCapsFor(web, parseScopedLimits(JSON.stringify({ version: 2, limits: [{ scope: "github:acme/web", dayUsd: "50" }] }), "sl.json"));
	const redis = keyedRedis();
	const d = deps(DJOB, { redis, dollarCaps: { day: 50 * USD, week: null, month: null }, scopedDollars: scope, projectDollars: P_USD, modelDollars: [MODEL], runContainer: ranFor(0.5, 0.25) });
	const r = await runJob(DJOB, d.deps);
	assert.equal(r.outcome, "completed");
	const reserved = redis.ops.filter((o) => o[0] === "incrby").map((o) => o[1]);
	assert.deepEqual(reserved, [D_DAY, `${scope.keyPrefix}:2026-07-16`, P_USD_DAY, `${MODEL.keyPrefix}:2026-07-16`], "deployment, scope, project, models");
	// The project part settles to the JOB's cost, like the scope part; the model part to its own usage row.
	assert.equal(redis.store.get(P_USD_DAY), 500_000, "the project window holds the job's metered $0.50");
	assert.equal(redis.store.get(`${scope.keyPrefix}:2026-07-16`), 500_000);
	assert.equal(redis.store.get(D_DAY), 500_000);
	assert.equal(redis.store.get(`${MODEL.keyPrefix}:2026-07-16`), 250_000, "the model window holds its own row's $0.25");
});

test("a full project dollar window refuses dollar-cap naming 'this project', and every count and dollar ledger goes back", async () => {
	const redis = keyedRedis({ [P_USD_DAY]: 2 * USD }); // $2 of $3 used; a $2 hold would make $4
	const d = deps(DJOB, { redis, dollarCaps: { day: 50 * USD, week: null, month: null }, projectDollars: P_USD });
	const r = await runJob(DJOB, d.deps);
	assert.equal(r.reason, "dollar-cap");
	assert.equal(r.budgetReserved, false);
	assert.ok(!d.calls.includes("run-container"));
	assert.match(d.comments[0], /^Refused: today's dollar budget for this project has no room left/);
	const logged = d.logs.find((l) => l.e === "over_dollar_budget").f;
	assert.equal(logged.ledger, "project");
	assert.equal(logged.key, P_USD.keyPrefix);
	assert.equal(redis.store.get(P_USD_DAY), 2 * USD, "the refusing window was given back");
	assert.equal(redis.store.get(D_DAY), 0, "the deployment window too");
	assert.equal(redis.store.get(WEB_DAY), 0, "the repo job-count slot went back");
	assert.equal(redis.store.get(P_DAY), 0, "the project job-count slot went back");
	assert.equal(redis.store.get(G_DAY), 0, "the global job-count slot went back");
});

test("a never-started container gives the project dollar hold back with the rest", async () => {
	const redis = keyedRedis();
	const d = deps(DJOB, { redis, dollarCaps: { day: 50 * USD, week: null, month: null }, projectDollars: P_USD, runContainer: async () => ({ code: 125, aborted: false }) });
	await assert.rejects(() => runJob(DJOB, d.deps), (e) => e.reason === "container-never-started");
	assert.equal(redis.store.get(P_USD_DAY), 0);
	assert.equal(redis.store.get(D_DAY), 0);
});

// ── the rule, not the sites ──────────────────────────────────────────────────────────────────────────────

test("processor.mjs has no hand-written job-count reserve or release left: one helper each, and one refund closure", () => {
	const src = readFileSync(new URL("../src/processor.mjs", import.meta.url), "utf8");
	const code = src
		.split("\n")
		.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
		.join("\n");
	assert.doesNotMatch(code, /\breleaseBudget\s*\(/, "no direct releaseBudget call");
	assert.doesNotMatch(code, /\breserveBudget\s*\(/, "no direct reserveBudget call");
	assert.equal((code.match(/\breserveLedgers\s*\(/g) ?? []).length, 1, "one reserve of the ordered ledgers");
	assert.equal((code.match(/\breleaseLedgers\s*\(/g) ?? []).length, 1, "one release, inside refundLedgers");
	assert.doesNotMatch(code, /\bscopedReserved\b|\bscopedCaps\b/, "no per-ledger flag a new ledger could be forgotten in");
});
