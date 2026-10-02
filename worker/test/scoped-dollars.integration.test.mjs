import assert from "node:assert/strict";
import { test } from "node:test";
import { runJob } from "../src/processor.mjs";
import { dollarCapsFor, modelDollarRows, parseScopedLimits } from "../src/scoped-limits.mjs";

// scoped-limits.json version 2 against a real Valkey (issues #501 part 5, #502 part 6): the processor's one
// reservation over the deployment, scope and model windows, the give-back on a refusal, and the per-model settle.
// Gated on VALKEY_TEST_URL; in CI PI_DISPATCH_REQUIRE_WORKER_TESTS=1 turns a missing URL into a hard failure. Each run
// names its own model and repo (so its dollar keys are its own), runs on a far-future day (so the job-count keys are
// too), and deletes every key it wrote.
const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error("scoped-dollars.integration REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
}
const skip = url ? false : "needs VALKEY_TEST_URL";
const USD = 1_000_000;

test("a per-model window refuses the second job with dollar-cap, and every other window is given back (live Valkey)", { skip, timeout: 30_000 }, async (t) => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const redis = makeRedisClient(url, {});
	t.after(() => redis.disconnect());
	const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	const model = `m-${tag}`;
	const repo = `pdtest/r-${tag}`;
	const now = new Date("2091-03-14T12:00:00Z");
	const limits = parseScopedLimits(JSON.stringify({ version: 2, limits: [{ scope: repo, dayUsd: "100" }, { scope: `model:PdTest/${model}`, dayUsd: "3" }] }), "sl.json");
	const scope = dollarCapsFor({ kind: "github", repo }, limits);
	const models = modelDollarRows(limits, null);
	assert.equal(models.length, 1);
	const modelDay = `${models[0].keyPrefix}:2091-03-14`;
	const scopeDay = `${scope.keyPrefix}:2091-03-14`;
	const written = [modelDay, scopeDay, "budget:2091-03-14"];
	const job = { kind: "github", repo, provider: "pdtest", model, maxTurns: 5, maxCostMicros: 2 * USD };
	const tokens = { input: 1, output: 1, total: 2, cost: 1.25, calls: 1, metered: true, unresolved: 0, unpriced: 0, costCapMicros: 2 * USD, costRefused: 0, boundExceeded: 0, longContext: 0, costUnjudged: 0, costUnanswered: 0 };
	const usage = { v: 1, piAi: null, truncated: 0, models: [{ provider: "pdtest", model, calls: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total: 2, cost: 1.25, unpriced: 0 }] };
	const deps = (runContainer) => ({
		redis,
		caps: { day: 1000, week: null, month: null },
		softHoldPct: null,
		dollarCaps: null,
		scopedDollars: scope,
		modelDollars: models,
		mintToken: async () => "tok",
		isDefaultBranchProtected: async () => true,
		prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
		runContainer,
		collectChain: async () => ({ enqueued: 0, refused: 0 }),
		cleanup: async () => {},
		comment: async () => {},
		log: () => {},
		now,
	});
	try {
		const first = await runJob(job, deps(async () => ({ code: 0, aborted: false, exitLineCode: 0, tokens, usage })));
		assert.equal(first.outcome, "completed");
		assert.equal(Number(await redis.get(modelDay)), 1_250_000, "the model window settled to the model's own row");
		assert.equal(Number(await redis.get(scopeDay)), 1_250_000);
		assert.ok((await redis.ttl(modelDay)) > 0, "the model key has its TTL");
		// $1.25 settled + $2 = $3.25 > $3: the second job is refused before any container.
		let ran = false;
		const second = await runJob(job, deps(async () => ((ran = true), { code: 0, aborted: false, exitLineCode: 0, tokens, usage })));
		assert.equal(second.reason, "dollar-cap");
		assert.equal(ran, false);
		assert.deepEqual(second.dollars, { reservedMicros: 2 * USD, settledMicros: 0, basis: "refunded", modelBasis: "refunded" });
		assert.equal(Number(await redis.get(modelDay)), 1_250_000, "the refused reservation was given back");
		assert.equal(Number(await redis.get(scopeDay)), 1_250_000, "and the scope window's, reserved before the model refused");
		assert.equal(Number(await redis.get("budget:2091-03-14")), 1, "the job-count slot of the refused job went back");
	} finally {
		await redis.del(...written);
	}
});
