import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BUDGET_RECHECK_MS, NEVER_FITS_RECHECK_MS, hostBudgetSettings, makeHostBudget } from "../src/host-budget.mjs";
import { parseProjects } from "../src/projects.mjs";
import { makeInFlight, parseScopedLimits } from "../src/scoped-limits.mjs";

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

function harness({ hostBudget, limits = [], projects = SHOP, hostBound = null, jobSizeEnv = { PI_JOB_MEMORY: "8g", PI_JOB_CPUS: "2" }, inFlight = makeInFlight(), clock = { t: NOW }, hold = true, extra = {} } = {}) {
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
	assert.deepEqual(line.fields, { jobId: "c", project: null, why: "budget", rank: 0, memMiB: 20480, cpuCenti: 400, delayMs: BUDGET_RECHECK_MS });
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
	const h = harness({ hostBudget: b, jobSizeEnv: { PI_JOB_MEMORY: "40g", PI_JOB_CPUS: "2" } });
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
	// The same size on the SHARED queue, local or forge, is never refused (P2G1-L2): another host may fit it.
	for (const j of [localJob("big-shared"), ghJob("big-forge")]) {
		await assert.rejects(() => h.processor(j.job, "tok", signal()), (e) => e.name === "DelayedError");
		assert.deepEqual(j.moves, [{ ts: NOW + NEVER_FITS_RECHECK_MS, tok: "tok" }]);
	}
	assert.equal(h.seen.records.length, 1, "no record for a deferral");
});

test("a size over its project's hostShare of the budget is refused as job-size-exceeds-share on this host's own queue, with the share in the record", { skip }, async () => {
	const { b } = await budgetOf();
	const limits = limitsOf([{ scope: "project:shop", memory: "20g", cpus: 2, hostShare: 50 }]);
	const h = harness({ hostBudget: b, limits });
	const result = await h.processor(localJob("s", "/srv/shop", HOST_QUEUE).job, "tok", signal());
	assert.equal(result.reason, "job-size-exceeds-share");
	assert.deepEqual(result.hostBudget, { memMiB: 36864, cpuCenti: 800, hostShare: 50 });
	assert.equal(h.seen.started, 0);
	// The share is a share of THIS host's budget: on the shared queue a larger host may give the project room, so the
	// job waits, exactly as an over-budget one does (P2G1-L2).
	const shared = ghJob("s2");
	await assert.rejects(() => h.processor(shared.job, "tok", signal()), (e) => e.name === "DelayedError");
	assert.equal(h.seen.logs.at(-1).fields.misfit, "share");
});

test("a job on the SHARED queue too big for this host is NEVER refused: deferred with both sizes named, whatever the registry says (P2G1-L2)", { skip }, async () => {
	const clock = { t: NOW };
	const { b } = await budgetOf({ clock });
	const h = harness({ hostBudget: b, clock, jobSizeEnv: { PI_JOB_MEMORY: "40g", PI_JOB_CPUS: "2" } });
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

test("the never-fits check is ABOVE the wait gate: a waiting job is refused (or deferred) for its size before it waits (P2G1-L6)", { skip }, async () => {
	const { b } = await budgetOf();
	let waitReads = 0;
	const h = harness({ hostBudget: b, jobSizeEnv: { PI_JOB_MEMORY: "40g", PI_JOB_CPUS: "2" }, extra: { waitState: new Proxy({}, { get: () => async () => (waitReads++, null) }) } });
	const tomorrow = new Date(NOW + 24 * 3600 * 1000).toISOString();
	const routed = spyJob("w", { kind: "github", repo: "acme/web", target: { number: 1 }, flow: "fix", trigger: { deliveryId: "w", sender: { id: 1 } }, waitFor: [{ after: tomorrow }] }, HOST_QUEUE);
	assert.equal((await h.processor(routed.job, "tok", signal())).reason, "job-size-exceeds-host");
	assert.equal(routed.moves.length, 0, "refused at once, not held until tomorrow");
	const shared = spyJob("w2", { kind: "github", repo: "acme/web", target: { number: 1 }, flow: "fix", trigger: { deliveryId: "w2", sender: { id: 1 } }, waitFor: [{ after: tomorrow }] });
	await assert.rejects(() => h.processor(shared.job, "tok", signal()), (e) => e.name === "DelayedError");
	assert.deepEqual(shared.moves, [{ ts: NOW + NEVER_FITS_RECHECK_MS, tok: "tok" }], "the never-fits cadence, not the wait's");
	assert.equal(waitReads, 0, "the wait gate never ran for either");
});

test("ONE PICKUP, ONE TICKET (P2G1-L1): a second pickup of a job id still running here is deferred running-here and frees nothing of the first", { skip }, async () => {
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

test("the job COUNT is judged in the budget gate, so a big shared-queue job's hold keeps a slot against a host-queue flood (P2G1-L3)", { skip }, async () => {
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
	assert.deepEqual(h.seen.logs.filter((l) => l.fields?.jobId === "big-1").map((l) => [l.event, l.fields.why]), [["host_budget_deferred", "budget"]], "deferred by the budget (the count), never by a host slot");
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

test("BY SHAPE: every hold is given back through the ONE releaseAllHolds, and no other path releases one", () => {
	const src = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
	const start = src.indexOf("export function makeProcessor(");
	const end = src.indexOf("export function createWorker(");
	const body = src
		.slice(start, end)
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/[^\n]*/g, "");
	const defAt = body.indexOf("const releaseAllHolds = ({ orphan = false } = {}) => {");
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
	// (with the orphan flag). The never-fits check is above the wait gate and every hold (P2G1-L6): it holds nothing.
	assert.equal((outside.match(/releaseAllHolds\(/g) ?? []).length, 5, "five calls; a new exit must be counted here");
	assert.match(outside, /await releaseAllHolds\(\{ orphan: stopDidNotTake \}\);/);
});

test("the processor's waiter bookkeeping lives in ONE wrapper: budget deferral keeps, another deferral suspends, any other end forgets", () => {
	const src = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
	const body = src.slice(src.indexOf("export function makeProcessor("), src.indexOf("export function createWorker(")).replace(/\/\/[^\n]*/g, "");
	for (const [call, n] of [["hostBudget.suspend(", 1], ["hostBudget.forget(", 2], ["hostBudget.enter(", 1], ["hostBudget.leave(", 1]]) {
		assert.equal(body.split(call).length - 1, n, `${call} ${n} time(s), in the wrapper (forget: on a return and on a non-deferral throw)`);
	}
	const wrapper = body.slice(body.indexOf("return async function processor(job, token, signal) {"));
	for (const call of ["hostBudget.suspend(", "hostBudget.forget(", "hostBudget.enter(", "hostBudget.leave("]) assert.ok(wrapper.includes(call), `${call} is in the wrapper`);
	assert.equal(body.split("hostBudget.gate(").length - 1, 1, "one gate");
});

test("the two never-fits reasons are the record contract's own tokens, each with its one generic comment, and the fleet reason is gone", { skip }, () => {
	// Pinned against the spec's reason enum (INT-RUN-HISTORY-FILE-CONTRACT), read from the file, so a fourth reason or a
	// renamed one cannot ship without the contract naming it.
	const spec = readFileSync(new URL("../../specs/interfaces.md", import.meta.url), "utf8");
	const enumLine = spec.split("\n").find((l) => l.includes('"reason":    "<fixed enum:'));
	assert.ok(enumLine, "the record's reason enum line");
	const tokens = enumLine.slice(enumLine.indexOf("<fixed enum:") + "<fixed enum:".length, enumLine.indexOf(">")).split("|");
	assert.deepEqual(Object.keys(mod.SIZE_REFUSAL_COMMENTS), ["job-size-exceeds-host", "job-size-exceeds-share"]);
	assert.equal(tokens.includes("job-size-exceeds-fleet"), false, "no longer emitted, so no longer in the contract (P2G1-L2)");
	for (const reason of Object.keys(mod.SIZE_REFUSAL_COMMENTS)) assert.ok(tokens.includes(reason), `${reason} is in the record's reason enum`);
});
