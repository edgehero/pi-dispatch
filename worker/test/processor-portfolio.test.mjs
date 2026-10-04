import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { envelopeDigest, parseEnvelope } from "../src/envelope.mjs";
import { PORTFOLIO_NO_ENVELOPE, runJob } from "../src/processor.mjs";
import { parseProjects } from "../src/projects.mjs";
import { makeCheckPortfolioFlag } from "../src/triggers-file.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #505 part A: the `portfolio-no-envelope` free gate. A portfolio cron job exists to write a priorities plan, and
// a plan applies only where the envelope has delegation on with `portfolio-job` among its writers, so without that the
// job is refused before it spends: before the mint and the clone, as policy, never retried. The live triggers file is
// asked first: a job whose trigger no longer says `portfolio: true` is an ordinary cron job and is not gated at all.

const NOW = new Date("2026-10-05T06:00:00Z");
const TRIGGER = { id: "pm-weekly", pattern: "0 6 * * 1" };
// `github: true` so an ordinary run mints a token: the gate must answer before that mint and before the clone.
const flagged = { kind: "local", folder: "/srv/pm", flow: "pm", task: "plan", github: true, provider: "openai", model: "gpt-x", maxTurns: 8, portfolio: true, trigger: TRIGGER };
const unflagged = (({ portfolio, ...rest }) => rest)(flagged);
const ON = { enabled: true, writers: ["operator-session", "portfolio-job"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 };

function deps(overrides = {}) {
	const calls = [];
	const logs = [];
	const asked = [];
	const base = {
		redis: { incr: async () => 1, decr: async () => 0, incrby: async () => 1, decrby: async () => 0, eval: async () => [0, 0], expire: async () => {}, get: async () => null },
		caps: { day: 10, week: null, month: null },
		softHoldPct: null,
		scopedLedgers: [],
		mintToken: async () => (calls.push("mint"), "tok"),
		isDefaultBranchProtected: async () => true,
		prepareWorkspace: async () => (calls.push("prepare"), { workspaceDir: "/w", jobDir: "/j" }),
		runContainer: async () => (calls.push("run-container"), { code: 0, aborted: false }),
		collectChain: async () => ({ enqueued: 0, refused: 0 }),
		cleanup: async () => {},
		comment: async () => {},
		log: (e, f) => logs.push({ e, f }),
		checkPortfolioFlag: (job) => (asked.push(job.trigger?.id), true),
		envelopeDelegation: ON,
		now: NOW,
	};
	return { deps: { ...base, ...overrides }, calls, logs, asked };
}

test("a portfolio job is refused as portfolio-no-envelope before the mint and the clone, for each of the three causes (#505)", async () => {
	const causes = [
		["no-envelope", null],
		["delegation-off", { enabled: false, writers: [], maxStepPct: null, minIntervalHours: null, maxPlanDays: null }],
		["writer-not-allowed", { ...ON, writers: ["operator-session"] }],
	];
	for (const [why, envelopeDelegation] of causes) {
		const d = deps({ envelopeDelegation });
		const r = await runJob(flagged, d.deps);
		assert.deepEqual([r.outcome, r.reason, r.budgetReserved, r.exitCode], ["policy", PORTFOLIO_NO_ENVELOPE, false, null], why);
		assert.deepEqual(d.calls, [], `${why}: nothing minted, cloned or started`);
		assert.deepEqual(d.logs.find((l) => l.e === "refused_portfolio_no_envelope")?.f, { why });
		assert.deepEqual(d.asked, ["pm-weekly"], "the live file was asked first, by the cron id");
	}
	assert.equal(PORTFOLIO_NO_ENVELOPE, "portfolio-no-envelope");
});

test("a portfolio job on a host whose envelope lets portfolio-job write runs as usual (#505)", async () => {
	const d = deps();
	const r = await runJob(flagged, d.deps);
	assert.equal(r.outcome, "completed");
	assert.deepEqual(d.calls, ["mint", "prepare", "run-container"]);
});

test("an unflagged cron job is not gated and the live file is not asked, with or without an envelope (#505)", async () => {
	for (const envelopeDelegation of [null, ON]) {
		const d = deps({ envelopeDelegation });
		const r = await runJob(unflagged, d.deps);
		assert.equal(r.outcome, "completed");
		assert.deepEqual(d.asked, []);
	}
	// `portfolio: false` is an unflagged job too, and so is a job whose data says true without a cron trigger, or with
	// the chain fields: a manual run and a chained child can never be portfolio jobs, whatever their data says.
	for (const job of [{ ...flagged, portfolio: false }, (({ trigger, ...rest }) => rest)(flagged), { ...flagged, parentJobId: "p", chainDepth: 1 }]) {
		const d = deps({ envelopeDelegation: null });
		assert.equal((await runJob(job, d.deps)).outcome, "completed");
		assert.deepEqual(d.asked, []);
	}
});

test("a job whose live trigger no longer says portfolio:true runs as an ordinary cron job, not refused (#505)", async () => {
	for (const checkPortfolioFlag of [() => false, async () => false, () => { throw new Error("EIO"); }, async () => { throw new Error("EIO"); }]) {
		const d = deps({ envelopeDelegation: null, checkPortfolioFlag });
		const r = await runJob(flagged, d.deps);
		assert.equal(r.outcome, "completed");
		assert.deepEqual(d.calls, ["mint", "prepare", "run-container"]);
		assert.equal(d.logs.some((l) => l.e === "refused_portfolio_no_envelope"), false);
	}
	// An unwired processor confirms no flag, so it never gates either.
	const { checkPortfolioFlag, ...unwired } = deps({ envelopeDelegation: null }).deps;
	assert.equal((await runJob(flagged, unwired)).outcome, "completed");
});

test("makeCheckPortfolioFlag reads the live file through the shared loader, by cron id, and every doubt is false (#505)", () => {
	const dir = tempDir("pi-portfolio-flag-");
	const path = join(dir, "triggers.json");
	const cron = (run) => ({ on: { type: "cron", ...TRIGGER }, run: { kind: "local", folder: "/srv/pm", flow: "pm", task: "plan", ...run } });
	const check = makeCheckPortfolioFlag({ triggersPath: path });
	const job = { folder: "/srv/pm", flow: "pm", task: "plan", trigger: TRIGGER };
	writeFileSync(path, JSON.stringify({ triggers: [cron({ portfolio: true })] }));
	assert.equal(check(job), true);
	writeFileSync(path, JSON.stringify({ triggers: [cron({})] }));
	assert.equal(check(job), false, "the flag removed after the job was queued");
	writeFileSync(path, JSON.stringify({ triggers: [cron({ portfolio: false })] }));
	assert.equal(check(job), false);
	writeFileSync(path, JSON.stringify({ triggers: [cron({ portfolio: "true" })] }));
	assert.equal(check(job), false, "a file the loader refuses grants nothing");
	writeFileSync(path, "{ not json");
	assert.equal(check(job), false);
	writeFileSync(path, JSON.stringify({ triggers: [{ ...cron({ portfolio: true }), on: { type: "cron", id: "other", pattern: "0 6 * * 1" } }] }));
	assert.equal(check(job), false, "another trigger's flag is not this one's");
	assert.equal(makeCheckPortfolioFlag({ triggersPath: join(dir, "absent.json") })(job), false);
	assert.equal(makeCheckPortfolioFlag({ triggersPath: null })(job), false);
	assert.equal(check({}), false, "a job with no trigger id");
});

test("makeCheckPortfolioFlag holds the live entry to the job: an id reused by another flagged entry grants nothing (#505 review)", () => {
	const dir = tempDir("pi-portfolio-reuse-");
	const path = join(dir, "triggers.json");
	const check = makeCheckPortfolioFlag({ triggersPath: path });
	const job = { kind: "local", folder: "/srv/pm", flow: "pm", task: "plan", portfolio: true, trigger: TRIGGER };
	const entry = (run) => ({ on: { type: "cron", ...TRIGGER }, run: { kind: "local", folder: "/srv/pm", flow: "pm", task: "plan", portfolio: true, ...run } });
	writeFileSync(path, JSON.stringify({ triggers: [entry({})] }));
	assert.equal(check(job), true, "the entry the job came from");
	for (const changed of [{ folder: "/srv/other" }, { flow: "other-flow" }, { task: "another task" }]) {
		writeFileSync(path, JSON.stringify({ triggers: [entry(changed)] }));
		assert.equal(check(job), false, `a different entry under the same id (${Object.keys(changed)[0]})`);
	}
	const { flow, task, ...rest } = entry({}).run;
	writeFileSync(path, JSON.stringify({ triggers: [{ on: { type: "cron", ...TRIGGER }, run: { ...rest, command: "pm run", portfolio: false } }] }));
	assert.equal(check(job), false);
	// A command trigger's job matches its own entry only when the command is the same.
	writeFileSync(path, JSON.stringify({ triggers: [{ on: { type: "cron", ...TRIGGER }, run: { ...rest, command: "pm run" } }] }));
	assert.equal(check({ ...job, flow: undefined, task: undefined, command: "pm run" }), false, "not flagged: portfolio beside a command is refused at load");
});

// The pickup half (index.mjs): the processor is handed THIS host's envelope delegation block, and nothing without one.
let mod;
try {
	mod = await import("../src/index.mjs");
} catch (error) {
	if (process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw error;
}
const skip = mod ? false : "index.mjs could not import here (bullmq)";

test("the pickup hands the processor this host's envelope delegation, so the gate judges the loaded envelope (#505)", { skip }, async () => {
	const PROJECTS = [{ id: "shop", members: ["github:acme/web"] }];
	const envelopeOf = (delegation) => parseEnvelope(JSON.stringify({ version: 1, window: "week", totalUsd: "100", floorsUsd: { shop: "10" }, ...(delegation ? { delegation } : {}) }), "/e/envelope.json", { projects: PROJECTS, maxCostMicros: 1_000_000 });
	const pickup = async (allocation) => {
		const seen = { containers: 0, logs: [] };
		const processor = mod.makeProcessor({
			cancelJob: () => {},
			stopContainer: () => {},
			redis: { incr: async () => 1, decr: async () => 0, incrby: async () => 1, decrby: async () => 0, eval: async () => [0, 0], expire: async () => {}, get: async () => null },
			getSettings: () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null, maxCostUsd: 1 }),
			scopedLimits: () => [],
			projects: () => parseProjects(JSON.stringify({ version: 1, projects: PROJECTS }), "p.json"),
			allocation,
			now: () => NOW.getTime(),
			timeoutMs: 100000,
			deps: {
				mintToken: async () => "tok",
				isDefaultBranchProtected: async () => true,
				prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
				runContainer: async () => (seen.containers++, { code: 0, aborted: false, turns: 3 }),
				cleanup: async () => {},
				comment: async () => {},
				log: (e, f) => seen.logs.push({ e, f }),
				checkPortfolioFlag: () => true,
			},
		});
		const job = { id: "manual:pm-weekly:1759644000000", attemptsMade: 0, name: "local", data: flagged, moveToDelayed: async () => {} };
		return { result: await processor(job, "tok", new AbortController().signal), seen };
	};
	const governed = (envelope) => ({ current: () => ({ envelope, digest: envelopeDigest(envelope) }), reconcile: async () => ({ state: { allocations: { shop: 50_000_000, _other: 50_000_000 }, unallocated: 0, repos: {} }, mismatch: false }) });

	const none = await pickup({ current: () => null, fleetGoverned: async () => false });
	assert.deepEqual([none.result.reason, none.seen.containers], [PORTFOLIO_NO_ENVELOPE, 0], "no envelope on this host");
	const off = await pickup(governed(envelopeOf(null)));
	assert.deepEqual([off.result.reason, off.seen.containers], [PORTFOLIO_NO_ENVELOPE, 0], "an envelope with no delegation block");
	assert.deepEqual(off.seen.logs.find((l) => l.e === "refused_portfolio_no_envelope")?.f, { why: "delegation-off" });
	const on = await pickup(governed(envelopeOf({ enabled: true, writers: ["portfolio-job"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 })));
	assert.deepEqual([on.result.outcome, on.seen.containers], ["completed", 1]);
});

// ── issue #505 part B: the snapshot at prepare, and the plan collected on the completed branch only ──────────────

const PLAN = { outcome: "refused", reason: "plan-too-soon", planId: "0123456789abcdef", clamped: false };

function collecting(overrides = {}) {
	const plans = [];
	const prepares = [];
	const d = deps({
		prepareWorkspace: async (job, token, opts) => (prepares.push(opts), { workspaceDir: "/w", jobDir: "/j" }),
		collectPlan: async (ctx) => (plans.push(ctx), PLAN),
		...overrides,
	});
	return { ...d, plans, prepares };
}

test("a confirmed portfolio job's prepare is asked for the snapshot, and its plan is collected after the chain with the pickup's decision (#505)", async () => {
	const order = [];
	const d = collecting({
		collectChain: async () => (order.push("chain"), { enqueued: 0, refused: 0 }),
		collectPlan: async (ctx) => (order.push("plan"), d.plans.push(ctx), PLAN),
	});
	const r = await runJob(flagged, d.deps);
	assert.equal(r.outcome, "completed", "a refused plan leaves the completed job completed");
	assert.deepEqual(r.plan, PLAN);
	assert.deepEqual(order, ["chain", "plan"]);
	assert.equal(d.plans.length, 1);
	assert.equal(d.plans[0].portfolio, true, "the pickup's decision rides to the collector");
	assert.equal(d.prepares[0].portfolio, true, "prepare is told to write the snapshot");
});

test("an unflagged job, or one the live file no longer flags at pickup, gets no snapshot and its collector is told portfolio:false (#505)", async () => {
	for (const [job, check] of [[unflagged, () => true], [flagged, () => false]]) {
		const d = collecting({ checkPortfolioFlag: check, envelopeDelegation: null });
		const r = await runJob(job, d.deps);
		assert.equal(r.outcome, "completed");
		assert.equal("portfolio" in d.prepares[0], false, "the prepare call is unchanged for every other job");
		assert.equal(d.plans[0].portfolio, false);
	}
});

test("a policy or infra exit, an abort and a pre-container refusal collect no plan (#505)", async () => {
	for (const runContainer of [async () => ({ code: 2, aborted: false }), async () => ({ code: 137, aborted: true }), async () => ({ code: 1, aborted: false })]) {
		const d = collecting({ runContainer });
		await runJob(flagged, d.deps).catch(() => {});
		assert.equal(d.plans.length, 0);
	}
	const refused = collecting({ envelopeDelegation: null });
	assert.equal((await runJob(flagged, refused.deps)).reason, PORTFOLIO_NO_ENVELOPE);
	assert.equal(refused.plans.length, 0);
});

test("a snapshot refused at prepare (portfolio-snapshot-oversize) is policy before any reserve and runs no container (#505)", async () => {
	const d = collecting({ prepareWorkspace: async () => ({ outcome: "policy", reason: "portfolio-snapshot-oversize" }) });
	const r = await runJob(flagged, d.deps);
	assert.deepEqual([r.outcome, r.reason], ["policy", "portfolio-snapshot-oversize"]);
	assert.equal(r.budgetReserved, undefined, "returned from prepare, before the reserve");
	assert.ok(!d.calls.includes("run-container"));
	assert.equal(d.plans.length, 0);
});

test("a completed job whose collector found no file has no plan on its result (#505)", async () => {
	const d = collecting({ collectPlan: async () => null });
	const r = await runJob(flagged, d.deps);
	assert.equal(r.outcome, "completed");
	assert.equal("plan" in r, false);
});
