import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { recordReasonEnum } from "./helpers/spec-enum.mjs";
import { test } from "node:test";
import { BUDGET_RECHECK_MS, NEVER_FITS_RECHECK_MS, hostBudgetSettings, makeHostBudget } from "../src/host-budget.mjs";
import { parseProjects } from "../src/projects.mjs";
import { newerRecord } from "../src/run-history.mjs";
import { makeInFlight, parseScopedLimits } from "../src/scoped-limits.mjs";
import { deferRecordOf, withDeferRecords } from "./helpers/defer-redis.mjs";

// The host budget's gates inside the processor (issue #596, phase 2, DES-HOST-BUDGET). index.mjs imports bullmq: skip
// below the node floor or without deps, and hard-fail where CI requires the worker tests (the scope-mutex posture).
let mod;
let importError;
try {
	mod = await import("../src/index.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`host budget gate tests are REQUIRED here but bullmq could not import.\n${importError}`);
}
const skip = mod ? false : `bullmq not installed (node ${process.version} < 22.19.0); CI runs these`;

const NOW = Date.UTC(2026, 9, 6, 12, 0);
const SETTINGS = () => ({ provider: "anthropic", model: "m", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null });
const SHOP = parseProjects(JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["github:acme/web", "/srv/shop"] }] }), "projects.json");
const limitsOf = (rows) => parseScopedLimits(JSON.stringify({ version: 3, limits: rows }), "sl.json");

/** A budget of 36g and 8 CPUs (no reserve), with an injected clock. */
async function budgetOf({ clock = { t: NOW }, limits = () => [], env = { PI_HOST_MEMORY_BUDGET: "36g", PI_HOST_CPU_BUDGET: "8" }, gone = async () => null, count = null } = {}) {
	const logs = [];
	const b = makeHostBudget({ settings: hostBudgetSettings(env, { memMiB: 512, cpuCenti: 25 }), jobDefault: { memMiB: 512, cpuCenti: 25 }, scopedLimits: limits, countLimit: () => count, containerGone: gone, now: () => clock.t, log: (event, fields) => logs.push({ event, fields }) });
	await b.ready;
	return { b, logs };
}

function fakeRedis() {
	const redis = { incrCalls: 0 };
	redis.incr = async () => (redis.incrCalls++, 1);
	redis.decr = async () => 0;
	redis.expire = async () => {};
	return redis;
}

function spyJob(id, data, { queueName = "pi-jobs", stalledCounter = 0 } = {}) {
	const moves = [];
	const updates = [];
	const job = { id, attemptsMade: 0, stalledCounter, name: data.kind, queueName, data, moveToDelayed: async (ts, tok) => moves.push({ ts, tok }), updateData: async (d) => (updates.push(d), (job.data = d)), getState: async () => "delayed" };
	return { job, moves, updates };
}

const localJob = (id, folder = "/srv/shop", opts) => spyJob(id, { kind: "local", folder, flow: "tidy", task: "t" }, opts);
const HOST_QUEUE = { queueName: "pi-jobs@mini1" };
const ghJob = (id, repo = "acme/web", opts) => spyJob(id, { kind: "github", repo, target: { number: 1 }, flow: "fix", trigger: { deliveryId: id, sender: { id: 1 } } }, opts);

function harness({ hostBudget, limits = [], projects = SHOP, hostBound = null, jobSizeEnv = { PI_JOB_MEMORY: "8g", PI_JOB_CPUS: "2" }, inFlight = makeInFlight(), clock = { t: NOW }, hold = true, extra = {}, extraDeps = {} } = {}) {
	const seen = { started: 0, records: [], logs: [], comments: [], sizes: [] };
	const releases = [];
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis: fakeRedis(),
		getSettings: SETTINGS,
		scopedLimits: () => limits,
		projects: () => projects,
		jobSizeEnv,
		inFlight,
		hostBudget,
		hostBound,
		hostName: "mini1",
		now: () => clock.t,
		recordRun: (r) => seen.records.push(r),
		timeoutMs: 100000,
		deps: {
			mintToken: async () => "tok",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			runContainer: async (ctx) => {
				seen.started++;
				seen.sizes.push(ctx.size);
				if (hold) await new Promise((resolve) => releases.push(resolve));
				return { code: 0, aborted: false, turns: 3 };
			},
			cleanup: async () => {},
			comment: async (_data, text) => seen.comments.push(text),
			log: (event, fields) => seen.logs.push({ event, fields }),
			...extraDeps,
		},
		...extra,
	});
	const untilStarted = async (n) => {
		while (seen.started < n) await new Promise((r) => setImmediate(r));
	};
	return { processor, seen, releaseNext: () => releases.shift()?.(), untilStarted };
}

const signal = () => new AbortController().signal;

test("a job the budget cannot hold now is DEFERRED at the budget's own cadence, holds its place, and starts once room frees", { skip }, async () => {
	const { b } = await budgetOf();
	const h = harness({ hostBudget: b, jobSizeEnv: { PI_JOB_MEMORY: "20g", PI_JOB_CPUS: "4" } });
	const a = ghJob("a", "acme/one");
	const first = h.processor(a.job, "tok", signal());
	await h.untilStarted(1);
	assert.deepEqual(b.snapshot().usedMemMiB, 20480);

	const c = ghJob("c", "acme/two");
	await assert.rejects(() => h.processor(c.job, "tok-c", signal()), (e) => e.name === "DelayedError");
	assert.deepEqual(c.moves, [{ ts: NOW + BUDGET_RECHECK_MS, tok: "tok-c" }]);
	const line = h.seen.logs.find((l) => l.event === "host_budget_deferred");
	assert.deepEqual(line.fields, { jobId: "c", project: null, why: "memory", rank: 0, memMiB: 20480, cpuCenti: 400, delayMs: BUDGET_RECHECK_MS });
	assert.equal(h.seen.started, 1, "nothing started for the deferred job");
	assert.deepEqual(b.waiting().map((w) => [w.id, w.suspended]), [["c", false]], "it waits, and its waiter holds");

	h.releaseNext();
	assert.equal((await first).outcome, "completed");
	assert.equal(b.entries().length, 0, "the finished job gave its hold back");
	const again = h.processor(c.job, "tok-c", signal());
	await h.untilStarted(2);
	assert.deepEqual(b.waiting(), [], "admitted, no longer a waiter");
	h.releaseNext();
	assert.equal((await again).outcome, "completed");
	assert.equal(b.entries().length, 0);
});

test("the budget gate is LAST: a job another gate defers never waits on the budget, and a waiter another gate defers is suspended", { skip }, async () => {
	const { b } = await budgetOf();
	const inFlight = makeInFlight();
	const h = harness({ hostBudget: b, inFlight, limits: limitsOf([{ scope: "acme/two", concurrent: 1 }]), jobSizeEnv: { PI_JOB_MEMORY: "20g", PI_JOB_CPUS: "4" } });
	// One local job holds the folder AND 20g.
	const first = h.processor(localJob("a").job, "tok", signal());
	await h.untilStarted(1);
	// A second job on the same folder is deferred by the folder mutex, before the budget is asked: no waiter at all.
	const same = localJob("b");
	await assert.rejects(() => h.processor(same.job, "tok", signal()), (e) => e.name === "DelayedError");
	assert.ok(h.seen.logs.some((l) => l.event === "scope_busy_deferred"));
	assert.deepEqual(b.waiting(), [], "deferred by the scope, it never became a waiter");
	// A job on another repo is deferred by the budget and waits...
	const other = ghJob("c", "acme/two");
	await assert.rejects(() => h.processor(other.job, "tok", signal()), (e) => e.name === "DelayedError");
	assert.deepEqual(b.waiting().map((w) => [w.id, w.suspended]), [["c", false]]);
	// ...and when its next pickup meets a full scope instead, its hold is suspended, never kept.
	inFlight.tryAcquire("acme/two", 1);
	await assert.rejects(() => h.processor(other.job, "tok", signal()), (e) => e.name === "DelayedError");
	assert.deepEqual(b.waiting().map((w) => [w.id, w.suspended]), [["c", true]]);
	inFlight.release("acme/two");
	h.releaseNext();
	await first;
});

test("a size that can never fit this host is REFUSED before anything is spent when the job is on this host's OWN queue, named in the log and the record, never in the comment", { skip }, async () => {
	const { b } = await budgetOf();
	const h = harness({ hostBudget: b, jobSizeEnv: { PI_JOB_MEMORY: "40g", PI_JOB_CPUS: "2" }, extra: { multiHost: true } });
	const local = localJob("big", "/srv/shop", HOST_QUEUE);
	const result = await h.processor(local.job, "tok", signal());
	assert.deepEqual(result, { outcome: "policy", reason: "job-size-exceeds-host", exitCode: null, turns: null, tokens: null, budgetReserved: false, hostBudget: { memMiB: 36864, cpuCenti: 800, hostShare: null } });
	assert.equal(h.seen.started, 0);
	assert.equal(local.moves.length, 0, "a refusal, never a deferral: a job on this host's own queue can run nowhere else");
	assert.deepEqual(h.seen.logs.find((l) => l.event === "job_size_exceeds_host").fields, { jobId: "big", project: "shop", memMiB: 40960, cpuCenti: 200, budgetMemMiB: 36864, budgetCpuCenti: 800, hostShare: null });
	assert.equal(h.seen.records.length, 1);
	assert.equal(h.seen.records[0].result.reason, "job-size-exceeds-host");
	assert.deepEqual(h.seen.records[0].size, { memMiB: 40960, cpuCenti: 200, source: "env" });
	assert.equal(h.seen.records[0].project, "shop", "the pickup project, by hand above the wait gate");
	assert.equal(h.seen.comments.length, 1);
	assert.equal(h.seen.comments[0], mod.SIZE_REFUSAL_COMMENTS["job-size-exceeds-host"]);
	for (const text of Object.values(mod.SIZE_REFUSAL_COMMENTS)) assert.doesNotMatch(text, /[0-9]|shop/, "a forge comment names no size, no budget and no project");
	assert.deepEqual(b.waiting(), [], "a refused job is no waiter");
	// The same size on the SHARED queue, local or forge, is never refused: another host may fit it.
	for (const j of [localJob("big-shared"), ghJob("big-forge")]) {
		await assert.rejects(() => h.processor(j.job, "tok", signal()), (e) => e.name === "DelayedError");
		assert.deepEqual(j.moves, [{ ts: NOW + NEVER_FITS_RECHECK_MS, tok: "tok" }]);
	}
	assert.equal(h.seen.records.length, 1, "no record for a deferral");
});

test("a size over its project's hostShare of the budget is refused as job-size-exceeds-share on this host's own queue, with the share in the record", { skip }, async () => {
	const { b } = await budgetOf();
	const limits = limitsOf([{ scope: "project:shop", memory: "20g", cpus: 2, hostShare: 50 }]);
	const h = harness({ hostBudget: b, limits, extra: { multiHost: true } });
	const result = await h.processor(localJob("s", "/srv/shop", HOST_QUEUE).job, "tok", signal());
	assert.equal(result.reason, "job-size-exceeds-share");
	assert.deepEqual(result.hostBudget, { memMiB: 36864, cpuCenti: 800, hostShare: 50 });
	assert.equal(h.seen.started, 0);
	// The share is a share of THIS host's budget: on the shared queue a larger host may give the project room, so the
	// job waits, exactly as an over-budget one does.
	const shared = ghJob("s2");
	await assert.rejects(() => h.processor(shared.job, "tok", signal()), (e) => e.name === "DelayedError");
	assert.equal(h.seen.logs.at(-1).fields.misfit, "share");
});

test("a job on the SHARED queue too big for this host is NEVER refused: deferred with both sizes named, whatever the registry says", { skip }, async () => {
	const clock = { t: NOW };
	const { b } = await budgetOf({ clock });
	const h = harness({ hostBudget: b, clock, jobSizeEnv: { PI_JOB_MEMORY: "40g", PI_JOB_CPUS: "2" }, extra: { multiHost: true } });
	const j = ghJob("f");
	for (let i = 0; i < 5; i++) {
		await assert.rejects(() => h.processor(j.job, "tok", signal()), (e) => e.name === "DelayedError");
		clock.t += NEVER_FITS_RECHECK_MS;
	}
	assert.equal(j.moves.length, 5);
	assert.deepEqual(j.updates, [], "nothing is remembered on the job: there is no verdict to build up");
	assert.deepEqual(h.seen.logs.find((l) => l.event === "job_size_never_fits_here_deferred").fields, { jobId: "f", project: "shop", misfit: "host", delayMs: NEVER_FITS_RECHECK_MS, memMiB: 40960, cpuCenti: 200, budgetMemMiB: 36864, budgetCpuCenti: 800, hostShare: null });
	assert.equal(h.seen.records.length, 0);
	assert.equal(h.seen.comments.length, 0);
	assert.equal(h.seen.started, 0);
	assert.deepEqual(b.waiting(), [], "a never-fits deferral holds nothing here");
	assert.equal("job-size-exceeds-fleet" in mod.SIZE_REFUSAL_COMMENTS, false, "the fleet refusal is gone");
});

test("a worker with NO host queue (no PI_WORKER_NAME) REFUSES a never-fits job on the shared queue, local or forge, recorded and logged with both sizes", { skip }, async () => {
	const { b } = await budgetOf();
	const limits = limitsOf([{ scope: "project:shop", memory: "20g", cpus: 2, hostShare: 50 }]);
	// The default wiring: `multiHost` false, as createWorker passes it without a host queue.
	const h = harness({ hostBudget: b, jobSizeEnv: { PI_JOB_MEMORY: "40g", PI_JOB_CPUS: "2" } });
	const local = localJob("L1", "/srv/other");
	const forge = ghJob("G1", "acme/other");
	for (const j of [local, forge]) {
		const result = await h.processor(j.job, "tok", signal());
		assert.deepEqual(result, { outcome: "policy", reason: "job-size-exceeds-host", exitCode: null, turns: null, tokens: null, budgetReserved: false, hostBudget: { memMiB: 36864, cpuCenti: 800, hostShare: null } });
		assert.deepEqual(j.moves, [], "refused at once: no other host drains this queue, so a deferral would ask again forever");
	}
	assert.equal(h.seen.started, 0);
	assert.equal(h.seen.records.length, 2);
	assert.deepEqual(h.seen.logs.filter((l) => l.event === "job_size_exceeds_host").map((l) => [l.fields.jobId, l.fields.memMiB, l.fields.budgetMemMiB]), [["L1", 40960, 36864], ["G1", 40960, 36864]], "the log names both sizes");
	assert.deepEqual(h.seen.comments, [mod.SIZE_REFUSAL_COMMENTS["job-size-exceeds-host"], mod.SIZE_REFUSAL_COMMENTS["job-size-exceeds-host"]], "the generic comment");
	assert.equal(h.seen.logs.some((l) => l.event === "job_size_never_fits_here_deferred"), false);
	// Over its project's share, the same: refused -share.
	const hs = harness({ hostBudget: b, limits });
	const shared = ghJob("S1");
	assert.equal((await hs.processor(shared.job, "tok", signal())).reason, "job-size-exceeds-share");
	assert.deepEqual(shared.moves, []);
	// createWorker passes the fact: a host queue armed is a multi-host worker.
	const src = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
	assert.match(src, /multiHost: hostQueue !== null,/);
	assert.match(src, /if \(!multiHost \|\| \(job\.queueName \?\? QUEUE\) !== QUEUE\) \{/);
});

test("the processor tells the gate the job's VENUE and its container NAME: an unread venue stops only its jobs, and a survivor carrying the job's name defers it running-here", { skip }, async () => {
	let podman = () => {
		throw new Error("podman down");
	};
	const b = makeHostBudget({
		settings: hostBudgetSettings({ PI_HOST_MEMORY_BUDGET: "36g", PI_HOST_CPU_BUDGET: "8" }, { memMiB: 512, cpuCenti: 25 }),
		jobDefault: { memMiB: 512, cpuCenti: 25 },
		countLimit: () => null,
		survivors: { local: async () => [{ name: "pi-job-X", memMiB: 1024, cpuCenti: 50 }], podman: async () => podman() },
		defaultVenue: "local",
		now: () => NOW,
	});
	await b.ready;
	const h = harness({ hostBudget: b, hold: false });
	const onPodman = spyJob("P", { kind: "local", folder: "/srv/shop", flow: "tidy", task: "t", backend: "podman" });
	await assert.rejects(() => h.processor(onPodman.job, "tok", signal()), (e) => e.name === "DelayedError");
	assert.equal(h.seen.logs.find((l) => l.event === "host_budget_deferred").fields.why, "unseeded");
	const retried = localJob("X");
	await assert.rejects(() => h.processor(retried.job, "tok", signal()), (e) => e.name === "DelayedError");
	assert.deepEqual(h.seen.logs.filter((l) => l.event === "host_budget_deferred").map((l) => [l.fields.jobId, l.fields.why]), [["P", "unseeded"], ["X", "running-here"]], "job X waits for its old container's name");
	assert.equal(h.seen.started, 0);
	const other = localJob("L");
	await h.processor(other.job, "tok", signal());
	assert.equal(h.seen.started, 1, "a docker job runs beside the unread podman venue and the survivor");
	// A venue the registry does not hold names no container: the gate's name is null rather than a throw, so the job
	// goes on to the registry's own refusal path below the gate (here the fake runs it), exactly as it did before.
	const named = harness({ hostBudget: b, hold: false, extra: { containerName: () => {
		throw Object.assign(new Error("unregistered"), { code: "BACKEND_NOT_REGISTERED" });
	} } });
	await named.processor(localJob("Z").job, "tok", signal());
	assert.equal(named.seen.started, 1, "past the gate: a name the venue cannot build is no name to check");
});

test("the never-fits check is ABOVE the wait gate: a waiting job is refused (or deferred) for its size before it waits", { skip }, async () => {
	const { b } = await budgetOf();
	let waitReads = 0;
	const h = harness({ hostBudget: b, jobSizeEnv: { PI_JOB_MEMORY: "40g", PI_JOB_CPUS: "2" }, extra: { multiHost: true, waitState: new Proxy({}, { get: () => async () => (waitReads++, null) }) } });
	const tomorrow = new Date(NOW + 24 * 3600 * 1000).toISOString();
	const routed = spyJob("w", { kind: "github", repo: "acme/web", target: { number: 1 }, flow: "fix", trigger: { deliveryId: "w", sender: { id: 1 } }, waitFor: [{ after: tomorrow }] }, HOST_QUEUE);
	assert.equal((await h.processor(routed.job, "tok", signal())).reason, "job-size-exceeds-host");
	assert.equal(routed.moves.length, 0, "refused at once, not held until tomorrow");
	const shared = spyJob("w2", { kind: "github", repo: "acme/web", target: { number: 1 }, flow: "fix", trigger: { deliveryId: "w2", sender: { id: 1 } }, waitFor: [{ after: tomorrow }] });
	await assert.rejects(() => h.processor(shared.job, "tok", signal()), (e) => e.name === "DelayedError");
	assert.deepEqual(shared.moves, [{ ts: NOW + NEVER_FITS_RECHECK_MS, tok: "tok" }], "the never-fits cadence, not the wait's");
	assert.equal(waitReads, 0, "the wait gate never ran for either");
});

test("ONE PICKUP, ONE TICKET: a second pickup of a job id still running here is deferred running-here and frees nothing of the first", { skip }, async () => {
	const { b } = await budgetOf({ env: { PI_HOST_MEMORY_BUDGET: "48g", PI_HOST_CPU_BUDGET: "8" } });
	const h = harness({ hostBudget: b, jobSizeEnv: { PI_JOB_MEMORY: "20g", PI_JOB_CPUS: "2" }, extra: { settledRecord: async () => null } });
	const id = "repeat:nightly:1759752000000";
	const first = h.processor(ghJob(id).job, "t1", signal());
	await h.untilStarted(1);
	const again = ghJob(id, "acme/web", { stalledCounter: 1 });
	await assert.rejects(() => h.processor(again.job, "t2", signal()), (e) => e.name === "DelayedError");
	assert.deepEqual(again.moves, [{ ts: NOW + BUDGET_RECHECK_MS, tok: "t2" }]);
	assert.equal(h.seen.logs.find((l) => l.event === "host_budget_deferred").fields.why, "running-here");
	assert.equal(h.seen.started, 1, "no second container");
	assert.equal(b.snapshot().usedMemMiB, 20480, "attempt 1's hold is still held");
	assert.deepEqual(b.waiting(), []);
	// Two more 20g jobs: only one fits beside attempt 1 in 48g.
	const h2 = harness({ hostBudget: b, jobSizeEnv: { PI_JOB_MEMORY: "20g", PI_JOB_CPUS: "2" } });
	const o1 = h2.processor(ghJob("o1", "acme/o1").job, "t", signal());
	await h2.untilStarted(1);
	await assert.rejects(() => h2.processor(ghJob("o2", "acme/o2").job, "t", signal()), (e) => e.name === "DelayedError");
	assert.equal(b.snapshot().usedMemMiB, 40960);
	h.releaseNext();
	await first;
	assert.equal(b.snapshot().usedMemMiB, 20480, "attempt 1 gave back exactly its own hold");
	h2.releaseNext();
	await o1;
	assert.equal(b.entries().length, 0);
});

test("the job COUNT is judged in the budget gate, so a big shared-queue job's hold keeps a slot against a host-queue flood", { skip }, async () => {
	const clock = { t: NOW };
	const { b } = await budgetOf({ clock, count: 3, env: { PI_HOST_MEMORY_BUDGET: "40g", PI_HOST_CPU_BUDGET: "16" } });
	const limits = limitsOf([{ scope: "project:big", memory: "20g", cpus: 2 }]);
	const projects = parseProjects(JSON.stringify({ version: 1, projects: [{ id: "big", members: ["github:acme/big"] }] }), "projects.json");
	// A host slot is wired too, as createWorker wires two queues: with a budget it is not taken.
	const slots = makeInFlight();
	const h = harness({ hostBudget: b, limits, projects, clock, hostBound: { slots, limit: () => 3 }, jobSizeEnv: { PI_JOB_MEMORY: "4g", PI_JOB_CPUS: "1" } });
	let n = 0;
	const smalls = [];
	const startSmall = () => smalls.push(h.processor(localJob(`s${++n}`, `/srv/f${n}`, HOST_QUEUE).job, "t", signal()).catch((e) => e.name));
	for (let i = 0; i < 3; i++) startSmall();
	await h.untilStarted(3);
	const big = ghJob("big-1", "acme/big");
	await assert.rejects(() => h.processor(big.job, "t", signal()), (e) => e.name === "DelayedError");
	assert.deepEqual(h.seen.logs.filter((l) => l.fields?.jobId === "big-1").map((l) => [l.event, l.fields.why]), [["host_budget_deferred", "count"]], "deferred by the budget (the count), never by a host slot");
	assert.equal(slots.count?.("host") ?? 0, 0, "no host slot taken");
	// One small ends; the flood asks FIRST for the freed slot, and is deferred: the slot is the big job's hold.
	h.releaseNext();
	await smalls.shift();
	startSmall();
	for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
	assert.equal(h.seen.started, 3, "the small that asked first did not take the held slot");
	clock.t += BUDGET_RECHECK_MS;
	const ran = h.processor(big.job, "t", signal());
	await h.untilStarted(4);
	assert.ok(b.entries().some((e) => e.id === "big-1"), "the big job started at its first wake after one release");
	for (let i = 0; i < 3; i++) h.releaseNext();
	await ran;
	await Promise.all(smalls);
});

test("stop_did_not_take: the job's hold becomes an ORPHAN that keeps its room until the runtime says the container is gone", { skip }, async () => {
	let gone = null;
	const { b } = await budgetOf({ gone: async () => gone });
	const ac = new AbortController();
	const seen = { logs: [] };
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis: fakeRedis(),
		getSettings: SETTINGS,
		projects: () => SHOP,
		jobSizeEnv: { PI_JOB_MEMORY: "20g", PI_JOB_CPUS: "2" },
		hostBudget: b,
		abortGraceMs: 0,
		now: () => NOW,
		recordRun: () => {},
		timeoutMs: 100000,
		deps: {
			mintToken: async () => "tok",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			// A container whose stop never takes: the run never settles.
			runContainer: async () => {
				ac.abort("job-timeout-30m");
				return new Promise(() => {});
			},
			cleanup: async () => {},
			comment: async () => {},
			log: (event, fields) => seen.logs.push({ event, fields }),
		},
	});
	const result = await processor(ghJob("o").job, "tok", ac.signal);
	assert.equal(result.outcome, "policy");
	assert.ok(seen.logs.some((l) => l.event === "stop_did_not_take"));
	const [entry] = b.entries();
	assert.equal(entry.id, "o");
	assert.equal(entry.orphan.name, "pi-job-o", "the container the abort could not stop");
	assert.equal(b.snapshot().usedMemMiB, 20480, "its room stays held");
	await b.sweep();
	assert.equal(b.entries().length, 1);
	gone = true;
	await b.sweep();
	assert.equal(b.entries().length, 0, "given back once the runtime says it is gone");
});

/** Issue #1104: a processor whose container's CLI client the attempt had to kill after a time limit's abort. */
function killedClientProcessor({ b, exit = { code: 137, aborted: true, clientKilled: true, started: false }, reason = "idle", seen = { logs: [], records: [], runs: 0 }, extraDeps = {}, extra = {}, redis = fakeRedis(), holdMs = 0 }) {
	let ac = null;
	const processor = mod.makeProcessor({
		cancelJob: () => true,
		stopContainer: () => {},
		redis,
		getSettings: SETTINGS,
		projects: () => SHOP,
		jobSizeEnv: { PI_JOB_MEMORY: "20g", PI_JOB_CPUS: "2" },
		...(b ? { hostBudget: b } : {}),
		abortGraceMs: 60_000,
		now: () => NOW,
		recordRun: (r) => seen.records.push(r),
		timeoutMs: 100000,
		deps: {
			mintToken: async () => "tok",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			runContainer: async () => {
				seen.runs += 1;
				ac.abort(reason);
				// The client-kill window, in which the operator-cancel poll may still tick.
				if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
				return exit;
			},
			cleanup: async () => {},
			comment: async () => {},
			log: (event, fields) => seen.logs.push({ event, fields }),
			...extraDeps,
		},
		...extra,
	});
	return { seen, run: (job) => processor(job, "tok", (ac = new AbortController()).signal) };
}

test("issue #1104: a killed client's never-started attempt is retried, its hold becomes a killed client's orphan, and its retry waits until the sweep removed the container", { skip }, async () => {
	let gone = null;
	const asked = [];
	const { b } = await budgetOf({ gone: async (name, venue, ...rest) => (asked.push([name, ...rest]), gone) });
	const h = killedClientProcessor({ b });
	const first = ghJob("k");
	await assert.rejects(() => h.run(first.job), (e) => e.name === "InfraRetry" && e.reason === "container-never-started");
	assert.ok(!h.seen.logs.some((l) => l.event === "stop_did_not_take"), "the attempt ended inside the grace, by its own kill");
	const [entry] = b.entries();
	assert.deepEqual([entry.id, entry.orphan.name, entry.orphan.killedClient], ["k", "pi-job-k", true]);
	assert.equal(h.seen.records.at(-1).error.reason, "container-never-started");
	// The retry: the same job, deferred while the old container may still be started by a runtime that answers again.
	const retry = ghJob("k");
	await assert.rejects(() => h.run(retry.job), (e) => e.name === "DelayedError");
	assert.equal(h.seen.runs, 1, "no second container");
	assert.ok(h.seen.logs.some((l) => l.event === "host_budget_deferred" && l.fields.why === "running-here"), JSON.stringify(h.seen.logs.map((l) => l.event)));
	await b.sweep();
	assert.deepEqual(asked, [["pi-job-k", { force: true }]]);
	assert.equal(b.entries().length, 1, "an unanswered runtime keeps it");
	gone = true;
	await b.sweep();
	assert.equal(b.entries().length, 0);
	// Now the retry runs (its container closes on its own this time).
	const h2 = killedClientProcessor({ b, exit: { code: 0, aborted: false, turns: 1 } });
	const again = await h2.run(ghJob("k").job);
	assert.equal(again.outcome, "completed");
	assert.equal(h2.seen.runs, 1);
});

test("issue #1104: a local job's killed client holds its folder as a killed client's orphan, and no job on that folder starts until the sweep removed it", { skip }, async () => {
	let gone = null;
	const { b } = await budgetOf({ gone: async () => gone });
	const extraDeps = { localWorkspaceIdentity: () => ({ key: "ws:1:2", folder: "/srv/shop" }), localContainerGone: async () => assert.fail("never asked: the runtime that did not answer the stop is not asked again") };
	const h = killedClientProcessor({ b, reason: "max-minutes", extraDeps });
	await assert.rejects(() => h.run(localJob("l1").job), (e) => e.reason === "container-never-started");
	assert.equal(b.entries()[0].orphan.killedClient, true);
	await assert.rejects(() => h.run(localJob("l1").job), (e) => e.name === "DelayedError");
	await assert.rejects(() => h.run(localJob("l2").job), (e) => e.name === "DelayedError");
	assert.deepEqual(h.seen.logs.filter((l) => l.event === "host_budget_deferred").map((l) => [l.fields.jobId, l.fields.why]), [["l1", "workspace-orphan"], ["l2", "workspace-orphan"]]);
	assert.equal(h.seen.runs, 1);
	gone = true;
	await b.sweep();
	assert.deepEqual(b.entries(), []);
});

test("issue #1104: with no host budget nothing would remove the container before a retry, so a killed client's stop is the policy result it always was", { skip }, async () => {
	const h = killedClientProcessor({ b: null });
	const result = await h.run(ghJob("n").job);
	assert.deepEqual([result.outcome, result.reason], ["policy", "idle"]);
	// And a killed client whose container wrote something, or an operator's cancel, stays the stop it was with a budget
	// too.
	for (const [id, exit, reason] of [["w", { code: 137, aborted: true, clientKilled: true, started: true }, "idle"], ["c", { code: 137, aborted: true, clientKilled: true, started: false }, "operator-cancel"]]) {
		const { b } = await budgetOf();
		const stopped = killedClientProcessor({ b, exit, reason });
		assert.deepEqual([(await stopped.run(ghJob(id).job)).reason], [reason]);
		assert.deepEqual(b.entries().map((e) => [e.id, e.orphan?.killedClient]), [[id, true]], `${id}: still an orphan the sweep removes, since its client was killed`);
	}
});

test("issue #1104: on a fleet, a killed client's attempt on the SHARED queue is the stop it was, since another host could start its retry at once; on this host's own queue it is never-started", { skip }, async () => {
	// Another host's budget does not hold this host's orphan, so a retry there would not wait for the removal.
	const shared = await budgetOf();
	const onShared = killedClientProcessor({ b: shared.b, extra: { multiHost: true } });
	const stopped = await onShared.run(ghJob("f1").job);
	assert.deepEqual([stopped.outcome, stopped.reason], ["policy", "idle"], "recorded as the stop, never refunded or retried");
	assert.equal(shared.b.entries()[0].orphan.killedClient, true, "its container is still removed by this host's sweep");
	// The same job on this host's own queue: no other host drains it, so its next attempt waits here.
	const own = await budgetOf();
	const onOwn = killedClientProcessor({ b: own.b, extra: { multiHost: true } });
	await assert.rejects(() => onOwn.run(ghJob("f2", "acme/web", HOST_QUEUE).job), (e) => e.reason === "container-never-started");
	// And a local job on the shared queue of a fleet is the stop it was too: the queue decides, not the kind.
	const local = await budgetOf();
	const onLocal = killedClientProcessor({ b: local.b, extra: { multiHost: true }, extraDeps: { localWorkspaceIdentity: () => ({ key: "ws:9:9", folder: "/srv/shop" }) } });
	assert.deepEqual([(await onLocal.run(localJob("f3").job)).reason], ["idle"]);
});

/** A Valkey that answers the cancel keys it holds, and records the writes the poll makes. */
function cancelRedis(held = {}) {
	const redis = fakeRedis();
	redis.writes = [];
	redis.get = async (key) => held[key] ?? null;
	redis.set = async (...args) => (redis.writes.push(["set", ...args]), "OK");
	redis.del = async (...keys) => {
		redis.writes.push(["del", ...keys]);
		for (const key of keys) delete held[key];
		return 1;
	};
	return redis;
}

test("issue #1104: a cancel the poll acknowledges after a time limit's stop, or one waiting unread, keeps the stop's result: never refunded, never retried", { skip }, async () => {
	// The poll ticks inside the client-kill window, after the idle stop already aborted the signal: it hands the cancel on
	// and writes its ack, while the signal keeps the idle reason.
	const { b } = await budgetOf();
	const acked = cancelRedis({ "cancel:req:c1": "operator-cancel" });
	const late = killedClientProcessor({ b, redis: acked, holdMs: 120, extra: { cancelPollMs: 20 } });
	const result = await late.run(ghJob("c1").job);
	assert.deepEqual([result.outcome, result.reason], ["policy", "idle"], "recorded as the stop, as before this issue");
	assert.ok(acked.writes.some(([op, key]) => op === "set" && key === "cancel:ack:c1"), "the cancel was acknowledged");
	assert.ok(acked.writes.some(([op, key]) => op === "del" && key === "cancel:req:c1"), "and its request consumed, so only the poll's own memory says so");
	// A request the poll never read (its interval longer than the window) is seen before the stop is classified, and left
	// for its requester, as every request that lands while the outcome is decided is.
	const waiting = await budgetOf();
	const unread = cancelRedis({ "cancel:agent:req:c2": "agent-cancel" });
	const pending = killedClientProcessor({ b: waiting.b, redis: unread, extra: { cancelPollMs: 60_000 } });
	const kept = await pending.run(ghJob("c2").job);
	assert.deepEqual([kept.outcome, kept.reason], ["policy", "idle"]);
	assert.deepEqual(unread.writes, [], "neither acknowledged nor consumed here");
	// With no request at all the same attempt is never-started.
	const quiet = await budgetOf();
	const none = killedClientProcessor({ b: quiet.b, redis: cancelRedis(), extra: { cancelPollMs: 20 }, holdMs: 60 });
	await assert.rejects(() => none.run(ghJob("c3").job), (e) => e.reason === "container-never-started");
});

test("issue #1104: the read for a waiting cancel is bounded: a Valkey that stops answering, or answers with an error, leaves the stop's result and holds nothing", { skip }, async () => {
	// Connected but silent on the cancel keys: the job is recorded within the bound, as the stop it was.
	const silent = await budgetOf();
	const hanging = cancelRedis();
	hanging.get = () => new Promise(() => {});
	const h = killedClientProcessor({ b: silent.b, redis: hanging, extra: { cancelPollMs: 60_000, cancelStopBoundMs: 50 } });
	const outcome = await Promise.race([h.run(ghJob("v1").job), new Promise((resolve) => setTimeout(() => resolve("still waiting"), 3000))]);
	assert.notEqual(outcome, "still waiting", "the record is not held by a read that never answers");
	assert.deepEqual([outcome.outcome, outcome.reason], ["policy", "idle"], "a read that ran past its bound counts as a request");
	// A read that fails counts as a request too.
	const failing = await budgetOf();
	const broken = cancelRedis();
	broken.get = async () => {
		throw new Error("connection reset");
	};
	const f = killedClientProcessor({ b: failing.b, redis: broken, extra: { cancelPollMs: 60_000 } });
	assert.deepEqual([(await f.run(ghJob("v2").job)).reason], ["idle"]);
});

test("issue #1104: a killed client classified while the worker shuts down keeps the stop's result: the orphan that would guard a later attempt dies with the process", { skip }, async () => {
	// A shutdown that lands after the time limit's stop leaves the signal's reason `idle`; the mark is read when the
	// killed client is classified.
	const { b } = await budgetOf();
	let reads = 0;
	const h = killedClientProcessor({ b, extra: { shuttingDown: () => ((reads += 1), true) } });
	const result = await h.run(ghJob("s1").job);
	assert.equal(reads, 1);
	assert.deepEqual([result.outcome, result.reason], ["policy", "idle"], "recorded as the stop, neither refunded nor retried");
	// A seam that throws reads as shutting down.
	const other = await budgetOf();
	const t = killedClientProcessor({ b: other.b, extra: { shuttingDown: () => { throw new Error("seam"); } } });
	assert.deepEqual([(await t.run(ghJob("s2").job)).reason], ["idle"]);
	// createWorker's `stop` marks the shutdown before it aborts any job, and every processor reads that mark.
	const src = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
	const stopAt = src.indexOf("const stop = () => stopping ??= (async () => {");
	const markAt = src.indexOf("shutdownRequested = true;", stopAt);
	assert.ok(stopAt > 0 && markAt > stopAt && markAt < src.indexOf('w.cancelAllJobs?.("shutdown")', stopAt), "the mark comes before the abort");
	assert.match(src, /shuttingDown: \(\) => shutdownRequested,/);
});

test("BY SHAPE: every hold is given back through the ONE releaseAllHolds, and no other path releases one", () => {
	const src = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
	const start = src.indexOf("export function makeProcessor(");
	const end = src.indexOf("export function createWorker(");
	const body = src
		.slice(start, end)
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/[^\n]*/g, "");
	const defAt = body.indexOf("const releaseAllHolds = ({ orphan = false, candidateEndpoints = null } = {}) => {");
	assert.notEqual(defAt, -1, "the one release exists");
	const defEnd = body.indexOf("\n\t\t};", defAt);
	const inside = body.slice(defAt, defEnd);
	const outside = body.slice(0, defAt) + body.slice(defEnd);
	// The primitives a release is made of: the host slot, the scope and endpoint drains, and the budget's two doors.
	for (const primitive of [/hostBound\.slots\.release\(/g, /releaseScopeHolds\(/g, /releaseEndpointHolds\(/g, /hostBudget\.release\(/g, /hostBudget\.orphan\(/g]) {
		assert.ok(primitive.test(inside), `${primitive} is inside releaseAllHolds`);
		assert.deepEqual(outside.match(primitive) ?? [], [], `${primitive} appears nowhere else in makeProcessor`);
	}
	// The in-process maps are released only by the two drains, which only releaseAllHolds calls.
	const drains = (outside.match(/\b(?:inFlight|endpointSlots)\.release\(/g) ?? []).length;
	assert.equal(drains, 2, "inFlight.release in the scope drain and endpointSlots.release in the endpoint drain, nowhere else");
	// Every exit calls it: the scope deferral, the endpoint deferral, the budget deferral, the setup guard and the finally
	// (with the orphan flag). The never-fits check is above the wait gate and every hold: it holds nothing.
	assert.equal((outside.match(/releaseAllHolds\(/g) ?? []).length, 15, "random selector CAS rollback, local workspace identity failure and local event claim debounce, five exits, the all-candidate deferral, three candidate endpoint rollbacks, selected subscription deferral, the newer-release settings deferral (issue #761) and the private endpoint deferral (issue #918); new sites must be counted here");
	const subscriptionWait = outside.slice(outside.indexOf("if (error instanceof SubscriptionWait) {"), outside.indexOf("if (error?.holdUntilRestart === true) {"));
	assert.ok(subscriptionWait.includes("await releaseAllHolds();"));
	assert.ok(subscriptionWait.indexOf("await releaseAllHolds();") < subscriptionWait.indexOf("await deferTo("), "subscription bookkeeping precedes release, and every hold is given back before deferral");
	// Issue #599, phase 2: the running-jobs entry is given back there too, and nowhere else; it is added once, at admission.
	assert.ok(/runningJobs\.remove\(/.test(inside), "the running entry is removed inside releaseAllHolds");
	assert.deepEqual(outside.match(/runningJobs\.remove\(/g) ?? [], [], "and nowhere else");
	assert.equal((body.match(/runningJobs\.add\(/g) ?? []).length, 1, "added once");
	assert.match(body, /capacity = capacityNow\(\);\s*runningKey = runningJobs\.add\(/, "right where the job is admitted");
	assert.match(outside, /await releaseAllHolds\(\{ orphan: stopDidNotTake \}\);/);
});

test("the processor's waiter bookkeeping lives in ONE wrapper: budget deferral keeps, another deferral suspends, any other end forgets", () => {
	const src = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
	const body = src.slice(src.indexOf("export function makeProcessor("), src.indexOf("export function createWorker(")).replace(/\/\/[^\n]*/g, "");
	for (const [call, n] of [["hostBudget.suspend(", 1], ["hostBudget.forget(", 2], ["hostBudget.enter(", 1], ["hostBudget.leave(", 1]]) {
		assert.equal(body.split(call).length - 1, n, `${call} ${n} time(s), in the wrapper (forget: on a return and on a non-deferral throw)`);
	}
	// #899 adds an outer terminal-result boundary. Budget bookkeeping still wraps the whole pickup inside
	// processJob; the outer boundary must await it, including its finally, before it may release the window.
	// Issue #969: processJob takes the attempt's counted comment adapter, and the refusal net runs between it and the release.
	const start = body.indexOf("const processJob = async (job, token, signal, said = attemptComment(deps?.comment)) => {");
	const end = body.indexOf("return async function processor(job, token, signal) {");
	assert.ok(start !== -1 && end > start, "both wrappers are present and ordered");
	const wrapper = body.slice(start, end);
	for (const call of ["hostBudget.suspend(", "hostBudget.forget(", "hostBudget.enter(", "hostBudget.leave("]) assert.ok(wrapper.includes(call), `${call} is in the wrapper`);
	assert.match(body.slice(end), /const result = await processJob\(job, token, signal, said\);\s*const net = refusalNetText\([\s\S]*?await Promise\.resolve\(deps\.comment\(job\.data, net\.text\)\)\.catch\(\(\) => \{\}\);\s*\}\s*if \(shouldReleaseSemanticWindow\(result\)\) await releaseSemanticWindow/);
	assert.equal(body.split("hostBudget.gate(").length - 1, 1, "one gate");
});

test("the two never-fits reasons are the record contract's own tokens, each with its one generic comment, and the fleet reason is gone", { skip }, () => {
	// Pinned against the spec's reason enum (INT-RUN-HISTORY-FILE-CONTRACT), read from the file, so a fourth reason or a
	// renamed one cannot ship without the contract naming it.
	const spec = readFileSync(new URL("../../specs/interfaces.md", import.meta.url), "utf8");
	const tokens = recordReasonEnum(spec); // throws when the line is gone
	assert.ok(tokens.length > 0, "the record's reason enum line");
	assert.deepEqual(Object.keys(mod.SIZE_REFUSAL_COMMENTS), ["job-size-exceeds-host", "job-size-exceeds-share"]);
	assert.equal(tokens.includes("job-size-exceeds-fleet"), false, "no longer emitted, so no longer in the contract");
	for (const reason of Object.keys(mod.SIZE_REFUSAL_COMMENTS)) assert.ok(tokens.includes(reason), `${reason} is in the record's reason enum`);
});

test("capacity rides the record only once the job is admitted: the live slots, the budget and the CPUs at the start, none on a never-fits refusal (#599)", { skip }, async () => {
	const { b } = await budgetOf();
	let slots = 4;
	const h = harness({ hostBudget: b, extra: { concurrencyNow: () => slots, cpus: () => 12 } });
	const run = h.processor(ghJob("ran").job, "tok", signal());
	await h.untilStarted(1);
	slots = 2; // a live PI_CONCURRENCY change mid-run: the record keeps what the job started under
	h.releaseNext();
	assert.equal((await run).outcome, "completed");
	assert.deepEqual(h.seen.records.at(-1).capacity, { slots: 4, memMiB: 36864, cpuCenti: 800, cpus: 12 });

	// A refusal BEFORE a slot passes none, so its record says null: it never held one.
	const refusing = harness({ hostBudget: b, jobSizeEnv: { PI_JOB_MEMORY: "40g", PI_JOB_CPUS: "2" }, extra: { concurrencyNow: () => 4, cpus: () => 12 } });
	assert.equal((await refusing.processor(localJob("big").job, "tok", signal())).reason, "job-size-exceeds-host");
	assert.equal(refusing.seen.records.length, 1);
	assert.equal(refusing.seen.records[0].capacity ?? null, null, "never-fits refusal: no capacity");
});

test("capacity without a host budget names the slots and CPUs and leaves both budgets unknown; an unreadable fact is null, never a failed job (#599)", { skip }, async () => {
	const h = harness({ hostBudget: null, extra: { concurrencyNow: () => 3, cpus: () => 8 } });
	const run = h.processor(ghJob("plain").job, "tok", signal());
	await h.untilStarted(1);
	h.releaseNext();
	assert.equal((await run).outcome, "completed");
	assert.deepEqual(h.seen.records.at(-1).capacity, { slots: 3, memMiB: null, cpuCenti: null, cpus: 8 });

	const broken = harness({ hostBudget: null, extra: { concurrencyNow: () => 3, cpus: () => {
		throw new Error("no cpu count");
	} } });
	const ran = broken.processor(ghJob("odd").job, "tok", signal());
	await broken.untilStarted(1);
	broken.releaseNext();
	assert.equal((await ran).outcome, "completed");
	assert.deepEqual(broken.seen.records.at(-1).capacity, { slots: 3, memMiB: null, cpuCenti: null, cpus: null });
});

test("capacity names the RUNTIME's CPU count from the budget's facts read, the worker's own only when no venue answered (#599)", { skip }, async () => {
	const facts = { hostCpus: 6 };
	const b = makeHostBudget({ settings: hostBudgetSettings({ PI_HOST_MEMORY_BUDGET: "36g", PI_HOST_CPU_BUDGET: "4" }, { memMiB: 512, cpuCenti: 25 }), jobDefault: { memMiB: 512, cpuCenti: 25 }, readFacts: async () => facts, countLimit: () => null, now: () => NOW });
	await b.ready;
	assert.equal(b.hostCpus(), 6);
	const h = harness({ hostBudget: b, extra: { concurrencyNow: () => 2, cpus: () => 14 } });
	const run = h.processor(ghJob("vm").job, "tok", signal());
	await h.untilStarted(1);
	h.releaseNext();
	await run;
	assert.deepEqual(h.seen.records.at(-1).capacity, { slots: 2, memMiB: 36864, cpuCenti: 400, cpus: 6 }, "the VM's 6, not the Mac's 14");

	const silent = makeHostBudget({ settings: hostBudgetSettings({ PI_HOST_MEMORY_BUDGET: "36g", PI_HOST_CPU_BUDGET: "4" }, { memMiB: 512, cpuCenti: 25 }), jobDefault: { memMiB: 512, cpuCenti: 25 }, readFacts: async () => ({}), countLimit: () => null, now: () => NOW });
	await silent.ready;
	assert.equal(silent.hostCpus(), null);
	const s2 = harness({ hostBudget: silent, extra: { concurrencyNow: () => 2, cpus: () => 14 } });
	const r2 = s2.processor(ghJob("bare").job, "tok", signal());
	await s2.untilStarted(1);
	s2.releaseNext();
	await r2;
	assert.equal(s2.seen.records.at(-1).capacity.cpus, 14, "no venue answered: the worker's own count");
});

test("a retry or a pickup after a stall reads the record it will replace and carries its slot time as `earlier`; a first attempt reads nothing (#599)", { skip }, async () => {
	const asked = [];
	const previous = { jobId: "again", attempt: 1, host: "mini1", startedAt: "2026-10-06T10:00:00.000Z", endedAt: "2026-10-06T11:00:00.000Z", size: { memMiB: 4096, cpuCenti: 200, source: "env" }, capacity: { slots: 2 } };
	const h = harness({ hostBudget: null, extra: { previousRecord: async (id) => (asked.push(id), previous) } });
	const first = h.processor(ghJob("first").job, "tok", signal());
	await h.untilStarted(1);
	h.releaseNext();
	await first;
	assert.deepEqual(asked, [], "a first attempt reads nothing");
	assert.equal(h.seen.records.at(-1).earlier, null);
	const retry = ghJob("again");
	retry.job.attemptsMade = 1;
	const second = h.processor(retry.job, "tok", signal());
	await h.untilStarted(2);
	h.releaseNext();
	await second;
	assert.deepEqual(asked, ["again"]);
	assert.deepEqual(h.seen.records.at(-1).earlier, [{ host: "mini1", startedAt: previous.startedAt, endedAt: previous.endedAt, memMiB: 4096, cpuCenti: 200 }]);
	// A stalled pickup reads it too, and a reader that throws is no previous record, never a failed job.
	const stalled = ghJob("stalled", "acme/web", { stalledCounter: 1 });
	const failing = harness({ hostBudget: null, extra: { previousRecord: async () => {
		throw new Error("down");
	} } });
	const third = failing.processor(stalled.job, "tok", signal());
	await failing.untilStarted(1);
	failing.releaseNext();
	assert.equal((await third).outcome, "completed");
	assert.equal(failing.seen.records.at(-1).earlier, null);
});

// Issue #811: an id comes back after a lost queue and a hand redelivery, and the record an older job left under it is kept
// for the retention window. Only this job's own previous attempt's record carries its slot time forward, judged on each
// side (this host's file, the fleet's copy) before the higher attempt is kept, so a stale one at a higher attempt hides
// nothing.
test("`earlier` comes only from this job's own previous attempt's record, never from an older job's under the same id (#811)", { skip }, async () => {
	const enqueued = Date.parse("2026-10-06T09:00:00.000Z");
	const own = { jobId: "again", attempt: 1, host: "mini1", startedAt: "2026-10-06T10:00:00.000Z", endedAt: "2026-10-06T11:00:00.000Z", size: { memMiB: 4096, cpuCenti: 200, source: "env" }, capacity: { slots: 2 } };
	const stale = { ...own, attempt: 3, host: "old-host", startedAt: "2026-09-20T10:00:00.000Z", endedAt: "2026-09-20T12:00:00.000Z" };
	/** Both sides as start.mjs `previousRecord` reads them: `keep` holds each to the rule before the higher attempt wins. */
	const twoSides = (local, mirrored, asked) => async (id, { keep = null } = {}) => {
		asked.push(typeof keep === "function");
		return newerRecord(...[local, mirrored].map((record) => (record !== null && typeof keep === "function" && !keep(record) ? null : record)));
	};
	const ownInterval = [{ host: "mini1", startedAt: own.startedAt, endedAt: own.endedAt, memMiB: 4096, cpuCenti: 200 }];
	for (const [label, local, mirrored, expected] of [
		["the stale record here, its own in the fleet's copy", stale, own, ownInterval],
		["its own here, the stale record in the fleet's copy", own, stale, ownInterval],
		["the stale record alone", stale, null, null],
		["the stale record at the same attempt", { ...stale, attempt: 1 }, null, null],
	]) {
		const asked = [];
		const h = harness({ hostBudget: null, extra: { previousRecord: twoSides(local, mirrored, asked) } });
		const retry = ghJob("again");
		Object.assign(retry.job, { attemptsMade: 1, timestamp: enqueued });
		const run = h.processor(retry.job, "tok", signal());
		await h.untilStarted(1);
		h.releaseNext();
		assert.equal((await run).outcome, "completed", label);
		assert.deepEqual(asked, [true], `${label}: one read, each side held to the rule`);
		assert.deepEqual(h.seen.records.at(-1).earlier, expected, label);
	}
	// A reader that ignores `keep` and hands the stale record back is judged again: no earlier attempt.
	const careless = harness({ hostBudget: null, extra: { previousRecord: async () => stale } });
	const retry = ghJob("again");
	Object.assign(retry.job, { attemptsMade: 1, timestamp: enqueued });
	const run = careless.processor(retry.job, "tok", signal());
	await careless.untilStarted(1);
	careless.releaseNext();
	await run;
	assert.equal(careless.seen.records.at(-1).earlier, null);
});

// Issue #599, phase 2: the jobs this host runs now, an entry per admitted pickup, gone on every exit.
test("the running-jobs entry exists exactly while an admitted job runs, and is gone on completion, failure, abort and a refusal after admission (#599)", { skip }, async () => {
	for (const hostBudget of [null, (await budgetOf()).b]) {
		const runningJobs = mod.makeRunningJobs();
		const h = harness({ hostBudget, extra: { runningJobs } });
		const run = h.processor(ghJob("ran").job, "tok", signal());
		await h.untilStarted(1);
		const [entry] = runningJobs.list();
		assert.deepEqual({ ...entry, at: typeof entry.at, holdAt: typeof entry.holdAt }, { id: "ran", project: "shop", memMiB: 8192, cpuCenti: 200, at: "number", holdMicros: 0, holdAt: "number" });
		h.releaseNext();
		assert.equal((await run).outcome, "completed");
		assert.equal(entry.at, Date.parse(h.seen.records.at(-1).startedAt), "admitted at the record's startedAt");
		assert.equal(runningJobs.size(), 0, `completed (budget: ${hostBudget !== null})`);
	}

	// A failure (the container step throws), an abort, and a refusal after admission (an invalid overlay).
	const runningJobs = mod.makeRunningJobs();
	const cases = [
		["failed", { runContainer: async () => { throw new Error("daemon went away"); } }, {}],
		["aborted", { runContainer: async () => ({ code: 137, aborted: true, turns: null }) }, {}],
		["refused after admission", {}, { getSettings: () => ({ invalid: "overlay does not parse" }) }],
	];
	for (const [name, deps, extra] of cases) {
		const seenDuring = [];
		const h = harness({ hold: false, extra: { runningJobs, ...extra } });
		const processor = deps.runContainer
			? mod.makeProcessor({ cancelJob: () => {}, stopContainer: () => {}, redis: fakeRedis(), getSettings: SETTINGS, projects: () => SHOP, jobSizeEnv: { PI_JOB_MEMORY: "8g", PI_JOB_CPUS: "2" }, now: () => NOW, recordRun: () => {}, timeoutMs: 100000, runningJobs, deps: { mintToken: async () => "tok", isDefaultBranchProtected: async () => true, prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }), runContainer: async (...a) => (seenDuring.push(runningJobs.size()), deps.runContainer(...a)), cleanup: async () => {}, comment: async () => {}, log: () => {} } })
			: h.processor;
		await Promise.resolve(processor(ghJob(name).job, "tok", signal())).catch(() => {});
		if (deps.runContainer) assert.deepEqual(seenDuring, [1], `${name}: listed while it ran`);
		else assert.ok(Number.isInteger(h.seen.records.at(-1).capacity?.slots), `${name}: its record says it was admitted`);
		assert.equal(runningJobs.size(), 0, `${name}: gone`);
	}
});

test("a setup throw after admission gives the running-jobs entry back with every other hold (#599)", { skip }, async () => {
	const runningJobs = mod.makeRunningJobs();
	const h = harness({ extra: { runningJobs, containerName: () => {
		throw new Error("no name for this venue");
	} } });
	await assert.rejects(() => h.processor(ghJob("setup").job, "tok", signal()), /no name/);
	assert.equal(runningJobs.size(), 0);
});

test("stop_did_not_take: the running entry goes with the pickup, and the orphan is listed from the budget's ledger alone (#599)", { skip }, async () => {
	const { liveJobsOf } = await import("../src/live-jobs.mjs");
	const { b } = await budgetOf();
	const runningJobs = mod.makeRunningJobs();
	const ac = new AbortController();
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis: fakeRedis(),
		getSettings: SETTINGS,
		projects: () => SHOP,
		jobSizeEnv: { PI_JOB_MEMORY: "2g", PI_JOB_CPUS: "2" },
		hostBudget: b,
		abortGraceMs: 0,
		now: () => NOW,
		recordRun: () => {},
		timeoutMs: 100000,
		runningJobs,
		deps: {
			mintToken: async () => "tok",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			runContainer: async () => {
				ac.abort("job-timeout-30m");
				return new Promise(() => {});
			},
			cleanup: async () => {},
			comment: async () => {},
			log: () => {},
		},
	});
	await processor(ghJob("o").job, "tok", ac.signal);
	assert.equal(runningJobs.size(), 0, "the processor is done with it");
	const { jobs } = liveJobsOf({ running: runningJobs.list(), budgetEntries: b.entries() });
	assert.deepEqual(jobs.map((j) => [j.id, j.o]), [["o", 1]], "listed as an orphan while the budget keeps watching its container");
});

test("the budget's two deferrals record their reasons: the budget's verdict, and a size that fits no slot here (issue #737)", { skip }, async () => {
	const { b } = await budgetOf();
	const redis = withDeferRecords(fakeRedis());
	const h = harness({ hostBudget: b, jobSizeEnv: { PI_JOB_MEMORY: "20g", PI_JOB_CPUS: "4" }, extra: { redis } });
	const first = h.processor(ghJob("a", "acme/one").job, "tok", signal());
	await h.untilStarted(1);
	const c = ghJob("c", "acme/web");
	await assert.rejects(() => h.processor(c.job, "tok-c", signal()), (e) => e.name === "DelayedError");
	const r = deferRecordOf(redis, "c");
	// The actual limiting dimension is recorded; the host is the worker's name, the project the pickup's.
	assert.deepEqual([r.why, r.bucket, r.until, r.budgetWhy, r.host, r.project], ["host-budget", "slot", NOW + BUDGET_RECHECK_MS, "memory", "mini1", "shop"]);
	h.releaseNext();
	await first;

	const { b: small } = await budgetOf();
	const big = withDeferRecords(fakeRedis());
	const nf = harness({ hostBudget: small, jobSizeEnv: { PI_JOB_MEMORY: "40g", PI_JOB_CPUS: "2" }, extra: { multiHost: true, redis: big } });
	const shared = ghJob("big-shared");
	await assert.rejects(() => nf.processor(shared.job, "tok", signal()), (e) => e.name === "DelayedError");
	const n = deferRecordOf(big, "big-shared");
	assert.deepEqual([n.why, n.bucket, n.until, n.host, n.project], ["size-never-fits", "slot", NOW + NEVER_FITS_RECHECK_MS, "mini1", "shop"]);
	// The refusal on the host's own queue is no deferral, and records no reason.
	await nf.processor(localJob("big-own", "/srv/shop", HOST_QUEUE).job, "tok", signal());
	assert.equal(deferRecordOf(big, "big-own"), null);
});

test("a wait for the host budget is one episode in the log: a line at its first deferral and when its why changes, one at admission, at the fixed 9s (#1074)", { skip }, async () => {
	// 36g, and a project whose hostShare is half of it: two of its 16g jobs never run together, and three 16g jobs of
	// any project never do.
	const clock = { t: NOW };
	const { b } = await budgetOf({ clock });
	const limits = limitsOf([{ scope: "project:shop", memory: "16g", cpus: 2, hostShare: 50 }]);
	const h = harness({ hostBudget: b, clock, limits, jobSizeEnv: { PI_JOB_MEMORY: "16g", PI_JOB_CPUS: "2" } });
	const first = h.processor(ghJob("a").job, "tok", signal());
	await h.untilStarted(1);
	const waiter = ghJob("b");
	/** One pickup of the waiting job at `at` that the budget defers: the delay it was given. */
	const deferredAt = async (at) => {
		clock.t = at;
		await assert.rejects(() => h.processor(waiter.job, "tok", signal()), (e) => e.name === "DelayedError");
		return waiter.moves.at(-1).ts - at;
	};
	const lines = (event) => h.seen.logs.filter((l) => l.event === event && l.fields.jobId === "b").map((l) => l.fields);
	// Its project's share stops it while the first job runs: three wakes, one line.
	for (const at of [NOW, NOW + 9_000, NOW + 18_000]) assert.equal(await deferredAt(at), BUDGET_RECHECK_MS);
	assert.deepEqual(lines("host_budget_deferred").map((f) => f.why), ["share"]);
	// The first job ends and two jobs of no project take 32g: the share is no longer what stops it, the memory is. The
	// line is said again, since the one it said no longer says why the job waits; then not at the next wake.
	h.releaseNext();
	await first;
	const others = [h.processor(ghJob("c", "acme/one").job, "tok", signal()), h.processor(ghJob("d", "acme/two").job, "tok", signal())];
	await h.untilStarted(3);
	for (const at of [NOW + 27_000, NOW + 36_000]) assert.equal(await deferredAt(at), BUDGET_RECHECK_MS);
	assert.deepEqual(lines("host_budget_deferred"), [
		{ jobId: "b", project: "shop", why: "share", rank: 0, memMiB: 16384, cpuCenti: 200, delayMs: BUDGET_RECHECK_MS },
		{ jobId: "b", project: "shop", why: "memory", rank: 0, memMiB: 16384, cpuCenti: 200, delayMs: BUDGET_RECHECK_MS },
	]);
	assert.deepEqual(lines("host_budget_ended"), [], "nothing ends while the job still waits");
	// One of them ends: the waiter is admitted at its next wake, and its wait is said to be over once, whole.
	h.releaseNext();
	await others[0];
	clock.t = NOW + 45_000;
	const admitted = h.processor(waiter.job, "tok", signal());
	await h.untilStarted(4);
	assert.deepEqual(lines("host_budget_ended"), [{ jobId: "b", kind: "forge", waitedMs: 5 * BUDGET_RECHECK_MS, deferrals: 5 }]);
	assert.deepEqual(waiter.moves.map((m, i) => m.ts - [NOW, NOW + 9_000, NOW + 18_000, NOW + 27_000, NOW + 36_000][i]), Array(5).fill(BUDGET_RECHECK_MS), "every wake at the fixed re-check, never backed off");
	h.releaseNext();
	h.releaseNext();
	await Promise.all([others[1], admitted]);
	assert.equal(b.entries().length, 0);
});

test("a logger that throws on host_budget_ended leaves the admitted job its room and its run (#1074)", { skip }, async () => {
	const clock = { t: NOW };
	const { b } = await budgetOf({ clock });
	const h = harness({ hostBudget: b, clock, jobSizeEnv: { PI_JOB_MEMORY: "20g", PI_JOB_CPUS: "4" }, extraDeps: { log: (event) => {
		if (event === "host_budget_ended") throw new Error("EPIPE");
	} } });
	const first = h.processor(ghJob("a", "acme/one").job, "tok", signal());
	await h.untilStarted(1);
	const c = ghJob("c", "acme/two");
	await assert.rejects(() => h.processor(c.job, "tok", signal()), (e) => e.name === "DelayedError");
	h.releaseNext();
	await first;
	clock.t = NOW + BUDGET_RECHECK_MS;
	const again = h.processor(c.job, "tok", signal());
	// Not `untilStarted`: a pickup the throw ended never starts a container, and that wait would never return.
	let threw = null;
	again.catch((error) => (threw = error));
	for (let i = 0; i < 1000 && h.seen.started < 2 && threw === null; i++) await new Promise((r) => setImmediate(r));
	try {
		assert.equal(threw, null, "the logger's throw did not end the pickup");
		assert.equal(h.seen.started, 2, "the job reached its container");
		assert.equal(b.snapshot().usedMemMiB, 20480, "and its room is held while it runs");
	} finally {
		h.releaseNext();
	}
	assert.equal((await again).outcome, "completed");
	assert.equal(b.entries().length, 0);
});
