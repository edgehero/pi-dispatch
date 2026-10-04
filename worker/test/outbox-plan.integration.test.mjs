import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeAllocationState } from "../src/allocation.mjs";
import { envelopeDigest, parseEnvelope } from "../src/envelope.mjs";
import { makeCollectPlan } from "../src/outbox-plan.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// A portfolio job's plan, collected from a real file by the real collector, racing an operator's apply on a real Valkey
// (issue #505). The compare-and-set is a Lua script and the lock is SET NX PX, so the race is measured here, not
// assumed. Gated on VALKEY_TEST_URL; in CI PI_DISPATCH_REQUIRE_WORKER_TESTS=1 turns a missing URL into a hard failure.
// Each run uses its own key prefix and deletes its keys.
const url = process.env.VALKEY_TEST_URL;
if (!url && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error("outbox-plan.integration REQUIRES VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
}
const skip = url ? false : "needs VALKEY_TEST_URL";
const NOW = new Date("2026-10-07T06:00:00.000Z");
const PROJECTS = [
	{ id: "shop", members: ["github:acme/web"] },
	{ id: "platform", members: ["github:acme/infra"] },
];
const envelope = parseEnvelope(
	JSON.stringify({ version: 1, window: "week", totalUsd: "100", floorsUsd: { shop: "10", platform: "10" }, defaultWeights: { _other: 0 }, delegation: { enabled: true, writers: ["operator-session", "portfolio-job"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 } }),
	"/e/envelope.json",
	{ projects: PROJECTS, maxCostMicros: 1_000_000 },
);
const digest = envelopeDigest(envelope);
const plan = (shop, platform) => JSON.stringify({ version: 1, basis: null, projects: [{ id: "shop", weight: shop }, { id: "platform", weight: platform }, { id: "_other", weight: 0 }] });
const DATA = { kind: "local", folder: "/srv/pm", flow: "pm", trigger: { id: "pm-weekly", pattern: "0 6 * * 1" }, portfolio: true };

test("a job's plan and an operator's apply racing on one basis: one applies, the other is plan-stale or plan-busy, and every row is written (live Valkey)", { skip, timeout: 60_000 }, async (t) => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const prefix = `pi-dispatch-test-plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const admin = makeRedisClient(url, {});
	// One client for the job's host and one for the operator's session, so the commands race on the server.
	const jobSide = makeRedisClient(url, {});
	const operatorSide = makeRedisClient(url, {});
	t.after(() => {
		admin.disconnect();
		jobSide.disconnect();
		operatorSide.disconnect();
	});
	try {
		const winners = { job: 0, operator: 0 };
		for (let round = 0; round < 10; round++) {
			const keys = await admin.keys(`${prefix}*`);
			if (keys.length > 0) await admin.del(...keys);
			const rows = [];
			const audit = { append: (row) => rows.push(row) };
			const host = makeAllocationState({ redis: jobSide, host: "mini1", audit, prefix });
			const session = makeAllocationState({ redis: operatorSide, host: "laptop", audit, prefix });
			await host.reconcile({ envelope, digest, now: NOW });
			const jobDir = tempDir("pi-dispatch-plan-race-");
			mkdirSync(join(jobDir, "outbox"));
			writeFileSync(join(jobDir, "outbox", "priorities.json"), plan(3, 1));
			const collect = makeCollectPlan({ allocation: host, governing: () => ({ envelope, digest }), projects: () => PROJECTS, checkPortfolioFlag: () => true, now: () => NOW });
			const [fromJob, fromOperator] = await Promise.all([
				collect({ job: { id: `repeat:pm-weekly:${round}`, data: DATA }, prepared: { jobDir, portfolio: true }, portfolio: true }),
				session.applyPlan({ envelope, digest, projects: PROJECTS, text: plan(1, 3), writer: { kind: "operator-session" }, now: NOW }),
			]);
			const outcomes = [fromJob.outcome, fromOperator.outcome];
			assert.equal(outcomes.filter((o) => o === "applied").length, 1, `round ${round}: ${JSON.stringify([fromJob, fromOperator])}`);
			const loserReason = fromJob.outcome === "applied" ? fromOperator.reason : fromJob.reason;
			assert.ok(["plan-stale", "plan-busy"].includes(loserReason), `round ${round}: ${loserReason}`);
			if (fromJob.outcome === "applied") winners.job++;
			else winners.operator++;
			const state = JSON.parse(await admin.get(`${prefix}:plan`));
			assert.equal(state.writer, fromJob.outcome === "applied" ? "portfolio-job" : "operator-session", "the state is the winner's");
			assert.equal(state.jobId, fromJob.outcome === "applied" ? `repeat:pm-weekly:${round}` : null);
			assert.equal(rows.filter((r) => r.outcome === "applied").length, 1);
			// The loser's refusal is recorded too: no attempt is silent.
			assert.ok(rows.some((r) => r.outcome !== "applied" && r.outcome !== "neutral"), `round ${round}: the losing attempt has its row`);
			const logged = (await admin.lrange(`${prefix}:log`, 0, -1)).map((x) => JSON.parse(x));
			assert.ok(logged.some((r) => r.writer === "portfolio-job" && r.triggerId === "pm-weekly"), "the job's attempt is in alloc:log, so the next snapshot's lastAttempt can name it");
		}
		t.diagnostic(`winners over 10 rounds: ${JSON.stringify(winners)}`);
	} finally {
		const keys = await admin.keys(`${prefix}*`);
		if (keys.length > 0) await admin.del(...keys);
	}
});

test("lastAttempt on a real Valkey reads the newest row of this trigger's portfolio jobs (live Valkey)", { skip, timeout: 30_000 }, async (t) => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const prefix = `pi-dispatch-test-plan-last-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const redis = makeRedisClient(url, {});
	t.after(() => redis.disconnect());
	try {
		const host = makeAllocationState({ redis, host: "mini1", audit: { append: () => {} }, prefix });
		await host.recordRefusal({ writer: { kind: "portfolio-job", jobId: "a", triggerId: "pm-weekly" }, reason: "plan-parse-error", now: NOW });
		await host.recordRefusal({ writer: { kind: "portfolio-job", jobId: "b", triggerId: "other" }, reason: "plan-oversize", now: NOW });
		await host.recordRefusal({ writer: { kind: "operator-session" }, reason: "plan-busy", now: NOW });
		const last = await host.lastAttempt({ kind: "portfolio-job", triggerId: "pm-weekly" });
		assert.equal(last.jobId, "a");
		assert.equal(last.reason, "plan-parse-error");
		assert.equal(await host.lastAttempt({ kind: "portfolio-job", triggerId: "none" }), null);
	} finally {
		const keys = await redis.keys(`${prefix}*`);
		if (keys.length > 0) await redis.del(...keys);
	}
});
