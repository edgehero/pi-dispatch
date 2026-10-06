import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BUDGET_RECHECK_MS, FLEET_NO_FIT_CONFIRM_MS, NEVER_FITS_RECHECK_MS, hostBudgetSettings, makeHostBudget } from "../src/host-budget.mjs";
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
async function budgetOf({ clock = { t: NOW }, limits = () => [], env = { PI_HOST_MEMORY_BUDGET: "36g", PI_HOST_CPU_BUDGET: "8" }, gone = async () => null } = {}) {
	const logs = [];
	const b = makeHostBudget({ settings: hostBudgetSettings(env, { memMiB: 512, cpuCenti: 25 }), jobDefault: { memMiB: 512, cpuCenti: 25 }, scopedLimits: limits, containerGone: gone, now: () => clock.t, log: (event, fields) => logs.push({ event, fields }) });
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

function spyJob(id, data, { queueName = "pi-jobs" } = {}) {
	const moves = [];
	const updates = [];
	const job = { id, attemptsMade: 0, name: data.kind, queueName, data, moveToDelayed: async (ts, tok) => moves.push({ ts, tok }), updateData: async (d) => (updates.push(d), (job.data = d)), getState: async () => "delayed" };
	return { job, moves, updates };
}

const localJob = (id, folder = "/srv/shop") => spyJob(id, { kind: "local", folder, flow: "tidy", task: "t" });
const ghJob = (id, repo = "acme/web", opts) => spyJob(id, { kind: "github", repo, target: { number: 1 }, flow: "fix", trigger: { deliveryId: id, sender: { id: 1 } } }, opts);

function harness({ hostBudget, limits = [], projects = SHOP, fleetHosts = null, jobSizeEnv = { PI_JOB_MEMORY: "8g", PI_JOB_CPUS: "2" }, inFlight = makeInFlight(), clock = { t: NOW }, hold = true, extra = {} } = {}) {
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
		fleetHosts,
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

test("a size that can never fit this host is REFUSED before anything is spent, named in the log and the record, never in the comment", { skip }, async () => {
	const { b } = await budgetOf();
	const h = harness({ hostBudget: b, jobSizeEnv: { PI_JOB_MEMORY: "40g", PI_JOB_CPUS: "2" } });
	const local = localJob("big");
	const result = await h.processor(local.job, "tok", signal());
	assert.deepEqual(result, { outcome: "policy", reason: "job-size-exceeds-host", exitCode: null, turns: null, tokens: null, budgetReserved: false, hostBudget: { memMiB: 36864, cpuCenti: 800, hostShare: null } });
	assert.equal(h.seen.started, 0);
	assert.equal(local.moves.length, 0, "a refusal, never a deferral: a local job can run nowhere else");
	assert.deepEqual(h.seen.logs.find((l) => l.event === "job_size_exceeds_host").fields, { jobId: "big", project: "shop", memMiB: 40960, cpuCenti: 200, budgetMemMiB: 36864, budgetCpuCenti: 800, hostShare: null });
	assert.equal(h.seen.records.length, 1);
	assert.equal(h.seen.records[0].result.reason, "job-size-exceeds-host");
	assert.deepEqual(h.seen.records[0].size, { memMiB: 40960, cpuCenti: 200, source: "env" });
	assert.equal(h.seen.comments.length, 1);
	assert.equal(h.seen.comments[0], mod.SIZE_REFUSAL_COMMENTS["job-size-exceeds-host"]);
	for (const text of Object.values(mod.SIZE_REFUSAL_COMMENTS)) assert.doesNotMatch(text, /[0-9]|shop/, "a forge comment names no size, no budget and no project");
	assert.deepEqual(b.waiting(), [], "a refused job is no waiter");
});

test("a size over its project's hostShare of the budget is refused as job-size-exceeds-share, with the share in the record", { skip }, async () => {
	const { b } = await budgetOf();
	const limits = limitsOf([{ scope: "project:shop", memory: "20g", cpus: 2, hostShare: 50 }]);
	const h = harness({ hostBudget: b, limits });
	const result = await h.processor(localJob("s").job, "tok", signal());
	assert.equal(result.reason, "job-size-exceeds-share");
	assert.deepEqual(result.hostBudget, { memMiB: 36864, cpuCenti: 800, hostShare: 50 });
	assert.equal(h.seen.started, 0);
});

test("a FORGE job too big for this host waits for a host it fits on, and is refused for the fleet only after two reads agree", { skip }, async () => {
	const clock = { t: NOW };
	const { b } = await budgetOf({ clock });
	let read = { hosts: [{ name: "mini1", budgetMemMiB: "36864", budgetCpuCenti: "800" }, { name: "big", budgetMemMiB: "", budgetCpuCenti: "" }] };
	const h = harness({ hostBudget: b, clock, fleetHosts: async () => read, jobSizeEnv: { PI_JOB_MEMORY: "40g", PI_JOB_CPUS: "2" } });
	const j = ghJob("f");
	// A peer without a published budget may fit it: deferred, nothing marked.
	await assert.rejects(() => h.processor(j.job, "tok", signal()), (e) => e.name === "DelayedError");
	assert.deepEqual(j.moves, [{ ts: NOW + NEVER_FITS_RECHECK_MS, tok: "tok" }]);
	assert.deepEqual(j.updates, []);
	assert.equal(h.seen.logs.find((l) => l.event === "job_size_never_fits_here_deferred").fields.fleet, "unknown");
	// Every live host publishes a budget and none fits: the FIRST such read only marks the job.
	read = { hosts: [{ name: "mini1", budgetMemMiB: "36864", budgetCpuCenti: "800" }, { name: "big", budgetMemMiB: "32768", budgetCpuCenti: "1600" }] };
	await assert.rejects(() => h.processor(j.job, "tok", signal()), (e) => e.name === "DelayedError");
	assert.equal(j.job.data.sizeNoFitAtMs, NOW);
	// A second "none" inside the confirm window still defers.
	clock.t = NOW + FLEET_NO_FIT_CONFIRM_MS - 1;
	await assert.rejects(() => h.processor(j.job, "tok", signal()), (e) => e.name === "DelayedError");
	// A failed read in between defers too, and keeps the mark.
	const keep = read;
	read = { unreachable: "registry timeout" };
	await assert.rejects(() => h.processor(j.job, "tok", signal()), (e) => e.name === "DelayedError");
	assert.equal(j.job.data.sizeNoFitAtMs, NOW);
	read = keep;
	clock.t = NOW + FLEET_NO_FIT_CONFIRM_MS;
	const result = await h.processor(j.job, "tok", signal());
	assert.equal(result.reason, "job-size-exceeds-fleet");
	assert.equal(h.seen.started, 0);
	assert.equal(h.seen.comments.at(-1), mod.SIZE_REFUSAL_COMMENTS["job-size-exceeds-fleet"]);
});

test("a forge job's fleet mark is forgotten when a host it fits on appears, and a fleet of this host alone refuses with this host's reason", { skip }, async () => {
	const clock = { t: NOW };
	const { b } = await budgetOf({ clock });
	let read = { hosts: [{ name: "mini1", budgetMemMiB: "36864", budgetCpuCenti: "800" }] };
	const h = harness({ hostBudget: b, clock, fleetHosts: async () => read, jobSizeEnv: { PI_JOB_MEMORY: "40g", PI_JOB_CPUS: "2" } });
	const j = ghJob("f");
	await assert.rejects(() => h.processor(j.job, "tok", signal()), (e) => e.name === "DelayedError");
	assert.equal(j.job.data.sizeNoFitAtMs, NOW);
	read = { hosts: [{ name: "mini1", budgetMemMiB: "36864", budgetCpuCenti: "800" }, { name: "big", budgetMemMiB: "65536", budgetCpuCenti: "1600" }] };
	await assert.rejects(() => h.processor(j.job, "tok", signal()), (e) => e.name === "DelayedError");
	assert.equal("sizeNoFitAtMs" in j.job.data, false, "a fitting host clears the mark: two none reads must stand together");
	read = { hosts: [{ name: "mini1", budgetMemMiB: "36864", budgetCpuCenti: "800" }] };
	await assert.rejects(() => h.processor(j.job, "tok", signal()), (e) => e.name === "DelayedError");
	clock.t += FLEET_NO_FIT_CONFIRM_MS;
	assert.equal((await h.processor(j.job, "tok", signal())).reason, "job-size-exceeds-host", "the fleet is this host: its own reason");
	// A job on this host's OWN queue can run nowhere else: refused at once.
	const routed = ghJob("r", "acme/web", { queueName: "pi-jobs@mini1" });
	assert.equal((await h.processor(routed.job, "tok", signal())).reason, "job-size-exceeds-host");
	assert.equal(routed.moves.length, 0);
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
	// Every exit calls it: the scope deferral, the endpoint deferral, the never-fits refusal and deferral, the budget
	// deferral, the setup guard and the finally (with the orphan flag).
	assert.equal((outside.match(/releaseAllHolds\(/g) ?? []).length, 7, "seven calls; a new exit must be counted here");
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

test("the three never-fits reasons are the record contract's own tokens, each with its one generic comment", { skip }, () => {
	// Pinned against the spec's reason enum (INT-RUN-HISTORY-FILE-CONTRACT), read from the file, so a fourth reason or a
	// renamed one cannot ship without the contract naming it.
	const spec = readFileSync(new URL("../../specs/interfaces.md", import.meta.url), "utf8");
	const enumLine = spec.split("\n").find((l) => l.includes('"reason":    "<fixed enum:'));
	assert.ok(enumLine, "the record's reason enum line");
	const tokens = enumLine.slice(enumLine.indexOf("<fixed enum:") + "<fixed enum:".length, enumLine.indexOf(">")).split("|");
	assert.deepEqual(Object.keys(mod.SIZE_REFUSAL_COMMENTS), ["job-size-exceeds-host", "job-size-exceeds-share", "job-size-exceeds-fleet"]);
	for (const reason of Object.keys(mod.SIZE_REFUSAL_COMMENTS)) assert.ok(tokens.includes(reason), `${reason} is in the record's reason enum`);
});
