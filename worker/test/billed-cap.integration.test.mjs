import assert from "node:assert/strict";
import { test } from "node:test";
import { runJob } from "../src/processor.mjs";
import { DOLLAR_KEY_PREFIX } from "../src/dollar-budget.mjs";
import { dollarCapsFor, modelDollarRows, parseScopedLimits } from "../src/scoped-limits.mjs";

// Issue #1008 against a real Valkey: the processor's reserve and settle for a job whose subscription snapshot the worker
// marked notional (a connection with no paid extra usage), driven through runJob with a fake subscription runtime and a
// scripted exit line, reading the deployment, scope and model window counters. Gated on VALKEY_TEST_URL; in CI
// PI_DISPATCH_REQUIRE_WORKER_TESTS=1 turns a missing URL into a hard failure. Each case names its own repo and models
// and runs on its own far-future day, so every key it writes is its own, and deletes them all.
const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error("billed-cap.integration REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
}
const skip = url ? false : "needs VALKEY_TEST_URL";
const USD = 1_000_000;

/** The exit line's tokens of a complete metered run under `capMicros`, every floor counter 0. */
const exitTokens = (capMicros, cost, extra = {}) => ({ input: 1, output: 1, total: 2, cost, calls: 2, metered: true, unresolved: 0, unpriced: 0, childTotal: 0, childProcesses: 0, unmeteredChildren: 0, costUnreported: 0, ...extra, costCapMicros: capMicros, costRefused: 0, boundExceeded: 0, longContext: 0, costUnjudged: 0, costUnanswered: 0 });
const row = (provider, model, cost) => ({ provider, model, calls: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total: 2, cost, unpriced: 0 });

/** One case's world: its own models, repo and day; `run` drives runJob with the given snapshot marker and exit line. */
async function world(t, day) {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const redis = makeRedisClient(url, {});
	const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	const claude = `opus-${tag}`;
	const aux = `aux-${tag}`;
	const repo = `pdtest/billed-${tag}`;
	const limits = parseScopedLimits(JSON.stringify({ version: 2, limits: [{ scope: repo, dayUsd: "100" }, { scope: `model:anthropic/${claude}`, dayUsd: "50" }, { scope: `model:pdtest/${aux}`, dayUsd: "50" }] }), "sl.json");
	const scope = dollarCapsFor({ kind: "github", repo }, limits);
	const models = modelDollarRows(limits, null);
	assert.equal(models.length, 2);
	const key = {
		deployment: `${DOLLAR_KEY_PREFIX}:${day}`,
		scope: `${scope.keyPrefix}:${day}`,
		claude: `${models.find((m) => m.ref === `anthropic/${claude}`).keyPrefix}:${day}`,
		aux: `${models.find((m) => m.ref === `pdtest/${aux}`).keyPrefix}:${day}`,
		count: `budget:${day}`,
	};
	// One hook, so the keys are deleted before the client disconnects.
	t.after(async () => {
		try {
			await redis.del(...Object.values(key));
		} finally {
			redis.disconnect();
		}
	});
	const read = async () => Object.fromEntries(await Promise.all(Object.entries(key).filter(([name]) => name !== "count").map(async ([name, k]) => [name, (await redis.get(k)) === null ? null : Number(await redis.get(k))])));
	const run = async ({ job, snapshot, exit }) => {
		const logs = [];
		const seen = {};
		const result = await runJob({ kind: "github", repo, maxTurns: 5, ...job }, {
			redis,
			caps: { day: 1000, week: null, month: null },
			softHoldPct: null,
			dollarCaps: { day: 100 * USD, week: null, month: null },
			scopedDollars: scope,
			// The rows of the job's own list, as the pickup passes them (index.mjs `modelDollarRows(limits, models)`).
			modelDollars: modelDollarRows(limits, job.models),
			// The fake subscription runtime: the snapshot the worker prepared for the job's anthropic connection.
			prepareSubscriptionAuth: async () => ({ ok: true, snapshots: [{ provider: "anthropic", connectionId: "claude", adapter: "pi-anthropic-oauth@0.3.6", generation: 1, env: { ANTHROPIC_OAUTH_TOKEN: "access-only" }, ...snapshot }] }),
			validateSubscriptionAuth: async () => true,
			mintToken: async () => "tok",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			runContainer: async (ctx) => {
				seen.cap = ctx.job.maxCostMicros;
				seen.notional = ctx.subscriptionAuth?.map((s) => s.notional === true);
				return { code: 0, aborted: false, exitLineCode: 0, ...exit };
			},
			collectChain: async () => ({ enqueued: 0, refused: 0 }),
			cleanup: async () => {},
			comment: async () => {},
			log: (event, fields) => logs.push([event, fields]),
			now: new Date(`${day}T12:00:00Z`),
		});
		return { result, logs, seen };
	};
	return { claude, aux, read, run };
}

test("a subscription-only attempt on a notional connection reserves nothing, keeps its real cap and settles nothing in any window (live Valkey)", { skip, timeout: 30_000 }, async (t) => {
	const w = await world(t, "2093-07-19");
	const { result, logs, seen } = await w.run({
		job: { provider: "anthropic", model: w.claude, models: [`anthropic/${w.claude}`], maxCostMicros: 2 * USD },
		snapshot: { notional: true },
		// $5 at list price, above the $2 cap: notional, so the runner never charged it.
		exit: { tokens: exitTokens(2 * USD, 5, { costNotional: 5 }), usage: { v: 1, piAi: null, truncated: 0, models: [row("anthropic", w.claude, 5)] } },
	});
	assert.equal(result.outcome, "completed");
	assert.equal(seen.cap, 2 * USD, "the container keeps the real cap, never 0: an older image still counts the calls under it");
	assert.deepEqual(seen.notional, [true]);
	assert.deepEqual(result.dollars, { reservedMicros: 0, settledMicros: 0, basis: "unreserved", modelBasis: null });
	assert.deepEqual(await w.read(), { deployment: null, scope: null, claude: null, aux: null }, "no window was touched");
	assert.deepEqual(result.notionalProviders, ["anthropic"]);
	assert.deepEqual(logs.find(([event]) => event === "dollar_unreserved")?.[1], { models: 2, notional: true }, "the main model and its list entry");
	assert.equal(logs.some(([event]) => event === "dollar_unreserved_spent"), false, "nothing billed");
});

test("an older image's subscription-only attempt settles nothing, and its dollar_unreserved_spent line names the missing costNotional (live Valkey)", { skip, timeout: 30_000 }, async (t) => {
	const w = await world(t, "2093-07-23");
	const job = { provider: "anthropic", model: w.claude, models: [`anthropic/${w.claude}`], maxCostMicros: 2 * USD };
	const usage = { v: 1, piAi: null, truncated: 0, models: [row("anthropic", w.claude, 1.5)] };
	const older = await w.run({ job, snapshot: { notional: true }, exit: { tokens: exitTokens(2 * USD, 1.5), usage } });
	assert.deepEqual(older.result.dollars, { reservedMicros: 0, settledMicros: 0, basis: "unreserved", modelBasis: null });
	assert.deepEqual(await w.read(), { deployment: null, scope: null, claude: null, aux: null });
	assert.deepEqual(older.logs.find(([event]) => event === "dollar_unreserved_spent")?.[1], { meteredMicros: 1_500_000, missing: "costNotional" }, "the image wrote no costNotional, and the line says which key");
	// A newer image's billed call on such a job is logged without it.
	const billed = await w.run({ job, snapshot: { notional: true }, exit: { tokens: exitTokens(2 * USD, 1.5, { costNotional: 1 }), usage } });
	assert.deepEqual(billed.logs.find(([event]) => event === "dollar_unreserved_spent")?.[1], { meteredMicros: 500_000 });
});

test("a mixed attempt reserves the cap, settles only the billed part, and the notional model's window is never held (live Valkey)", { skip, timeout: 30_000 }, async (t) => {
	const w = await world(t, "2093-07-20");
	const job = { provider: "anthropic", model: w.claude, models: [`anthropic/${w.claude}`, `pdtest/${w.aux}`], maxCostMicros: 5 * USD };
	const usage = { v: 1, piAi: null, truncated: 0, models: [row("anthropic", w.claude, 3), row("pdtest", w.aux, 0.25)] };
	const reserved = [];
	const { result, seen } = await w.run({ job, snapshot: { notional: true }, exit: { tokens: exitTokens(5 * USD, 3.25, { costNotional: 3 }), usage } });
	reserved.push(seen.cap);
	assert.equal(result.outcome, "completed");
	assert.equal(seen.cap, 5 * USD);
	assert.deepEqual(result.dollars.basis, "metered");
	assert.equal(result.dollars.reservedMicros, 5 * USD, "the cap bounds the API-key route, so it is reserved");
	assert.equal(result.dollars.settledMicros, 250_000, "$3.25 metered less $3.00 notional");
	assert.equal(result.dollars.modelBasis, "metered");
	assert.deepEqual(await w.read(), { deployment: 250_000, scope: 250_000, claude: null, aux: 250_000 }, "billed only; the notional model's window never held");
});

test("an older image's exit line (no costNotional) settles the whole cost, the safe overcharge (live Valkey)", { skip, timeout: 30_000 }, async (t) => {
	const w = await world(t, "2093-07-21");
	const job = { provider: "anthropic", model: w.claude, models: [`anthropic/${w.claude}`, `pdtest/${w.aux}`], maxCostMicros: 5 * USD };
	const usage = { v: 1, piAi: null, truncated: 0, models: [row("anthropic", w.claude, 3), row("pdtest", w.aux, 0.25)] };
	const { result } = await w.run({ job, snapshot: { notional: true }, exit: { tokens: exitTokens(5 * USD, 3.25), usage } });
	assert.deepEqual([result.dollars.basis, result.dollars.settledMicros], ["metered", 3_250_000]);
	assert.deepEqual(await w.read(), { deployment: 3_250_000, scope: 3_250_000, claude: null, aux: 250_000 });
});

test("a connection with paid extra usage is not marked: its subscription-only attempt reserves and settles as before (live Valkey)", { skip, timeout: 30_000 }, async (t) => {
	const w = await world(t, "2093-07-22");
	const job = { provider: "anthropic", model: w.claude, models: [`anthropic/${w.claude}`], maxCostMicros: 2 * USD };
	const { result, seen } = await w.run({ job, snapshot: {}, exit: { tokens: exitTokens(2 * USD, 1.5, { costNotional: 0 }), usage: { v: 1, piAi: null, truncated: 0, models: [row("anthropic", w.claude, 1.5)] } } });
	assert.deepEqual(seen.notional, [false]);
	assert.deepEqual(result.dollars.basis, "metered");
	assert.equal(result.dollars.reservedMicros, 2 * USD);
	assert.equal(result.dollars.settledMicros, 1_500_000);
	assert.deepEqual(await w.read(), { deployment: 1_500_000, scope: 1_500_000, claude: 1_500_000, aux: null }, "every window, the model's included");
	assert.equal(Object.hasOwn(result, "notionalProviders"), false);
});
