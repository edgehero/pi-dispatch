import assert from "node:assert/strict";
import { test } from "node:test";
import {
	BUDGET_RECHECK_MS,
	HOLD_DROP_ON_ERROR_MS,
	HOLD_STATE_READ_BOUND_MS,
	HOLD_VERIFY_AFTER_MS,
	NEVER_FITS_RECHECK_MS,
	RESERVE_MEMORY_MAX_MIB,
	RESERVE_MEMORY_MIN_MIB,
	admit,
	budgetField,
	computeHostBudget,
	hostBudgetSettings,
	largestFit,
	makeHostBudget,
	neverFits,
	parseCpuMax,
	parseMemoryMax,
	pessimisticSize,
	projectBudgetRow,
	publishedBudget,
	rankHolds,
	readUserServiceLimits,
	userServiceCgroupDirs,
} from "../src/host-budget.mjs";
import { parseScopedLimits } from "../src/scoped-limits.mjs";
import { HOST_BEAT_MS } from "../src/host-registry.mjs";
import { memoryMiB, parseDaemonFacts } from "../src/daemon-facts.mjs";

/** No count bound: `countLimit` is required, and these tests judge memory and CPU alone. */
const NO_COUNT = () => null;

const DEFAULT = { memMiB: 4096, cpuCenti: 200 };
const AUTO = hostBudgetSettings({}, DEFAULT);
const settingsOf = (env) => hostBudgetSettings(env, DEFAULT);

// ---------------------------------------------------------------------------------------------------------------------
// Settings.

test("the four settings: unset, empty and auto are auto; off switches a budget off; a value is parsed to integers", () => {
	assert.deepEqual(AUTO, { memory: { mode: "auto" }, cpus: { mode: "auto" }, reserveMemory: { mode: "auto" }, reserveCpus: { mode: "auto" } });
	assert.deepEqual(settingsOf({ PI_HOST_MEMORY_BUDGET: "", PI_HOST_CPU_BUDGET: " auto " }), AUTO);
	const set = settingsOf({ PI_HOST_MEMORY_BUDGET: "64g", PI_HOST_CPU_BUDGET: "3.5", PI_HOST_RESERVE_MEMORY: "1536m", PI_HOST_RESERVE_CPUS: "0.25" });
	assert.deepEqual(set, { memory: { mode: "value", memMiB: 65536 }, cpus: { mode: "value", cpuCenti: 350 }, reserveMemory: { mode: "value", memMiB: 1536 }, reserveCpus: { mode: "value", cpuCenti: 25 } });
	assert.deepEqual(settingsOf({ PI_HOST_MEMORY_BUDGET: "off", PI_HOST_CPU_BUDGET: "off" }).memory, { mode: "off" });
	assert.deepEqual(settingsOf({ PI_HOST_MEMORY_BUDGET: "off", PI_HOST_CPU_BUDGET: "off" }).cpus, { mode: "off" });
	// A reserve may be none at all; a budget may not.
	assert.deepEqual(settingsOf({ PI_HOST_RESERVE_MEMORY: "0", PI_HOST_RESERVE_CPUS: "0" }).reserveMemory, { mode: "value", memMiB: 0 });
	assert.deepEqual(settingsOf({ PI_HOST_RESERVE_MEMORY: "0", PI_HOST_RESERVE_CPUS: "0" }).reserveCpus, { mode: "value", cpuCenti: 0 });
});

test("a bad value is refused naming the key and the rule, and a reserve cannot be off", () => {
	const cases = [
		["PI_HOST_MEMORY_BUDGET", "64G", /PI_HOST_MEMORY_BUDGET: a memory amount/],
		["PI_HOST_MEMORY_BUDGET", "0", /PI_HOST_MEMORY_BUDGET: a memory amount/],
		["PI_HOST_MEMORY_BUDGET", "1.5g", /PI_HOST_MEMORY_BUDGET: a memory amount/],
		["PI_HOST_MEMORY_BUDGET", "65537g", /at most 65536g/],
		["PI_HOST_CPU_BUDGET", "0", /PI_HOST_CPU_BUDGET: a CPU amount must be above 0/],
		["PI_HOST_CPU_BUDGET", "1.255", /PI_HOST_CPU_BUDGET: a CPU amount is a number/],
		["PI_HOST_CPU_BUDGET", "4097", /at most 4096/],
		["PI_HOST_RESERVE_MEMORY", "off", /PI_HOST_RESERVE_MEMORY: a memory amount/],
		["PI_HOST_RESERVE_CPUS", "off", /PI_HOST_RESERVE_CPUS: a CPU amount/],
		["PI_HOST_RESERVE_CPUS", "-1", /PI_HOST_RESERVE_CPUS/],
	];
	for (const [key, value, rule] of cases) assert.throws(() => settingsOf({ [key]: value }), rule, `${key}=${value}`);
});

test("a budget VALUE below one job of the default size is refused at boot, naming both sizes", () => {
	assert.throws(() => settingsOf({ PI_HOST_MEMORY_BUDGET: "2g" }), /PI_HOST_MEMORY_BUDGET: 2g is below one job of the default size \(4g, PI_JOB_MEMORY\)/);
	assert.throws(() => settingsOf({ PI_HOST_CPU_BUDGET: "1.5" }), /PI_HOST_CPU_BUDGET: 1\.5 is below one job of the default size \(2 CPUs, PI_JOB_CPUS\)/);
	// Exactly one job is enough, and the default is the deployment's, not the built-in one.
	assert.equal(settingsOf({ PI_HOST_MEMORY_BUDGET: "4g" }).memory.memMiB, 4096);
	assert.equal(hostBudgetSettings({ PI_HOST_MEMORY_BUDGET: "1g" }, { memMiB: 1024, cpuCenti: 50 }).memory.memMiB, 1024);
});

// ---------------------------------------------------------------------------------------------------------------------
// The budget from facts.

test("auto memory is the host's memory minus 10% of it, the reserve clamped to 1g..4g, never below one default job", () => {
	// Hand-derived rows: total, reserve, budget.
	const rows = [
		[8192, 1024, 7168], // 10% is 819, clamped up to the 1g floor
		[32768, 3276, 29492], // 10% stands
		[65536, 4096, 61440], // 10% is 6553, clamped down to the 4g ceiling
		[4096, 1024, 4096], // 4g minus 1g is 3g, raised to one 4g job (floored)
	];
	for (const [total, reserve, budget] of rows) {
		const b = computeHostBudget(AUTO, { memTotalMiB: total, hostCpus: 8 }, DEFAULT);
		assert.equal(b.detail.memReserveMiB, reserve, `reserve of ${total}`);
		assert.equal(b.memMiB, budget, `budget of ${total}`);
		assert.equal(b.detail.memFloored, total - reserve < DEFAULT.memMiB);
	}
	assert.equal(RESERVE_MEMORY_MIN_MIB, 1024);
	assert.equal(RESERVE_MEMORY_MAX_MIB, 4096);
});

test("auto CPUs are the host's count minus one when it has four or more, else none, never below one default job", () => {
	const rows = [
		[2, 0, 200],
		[3, 0, 300],
		[4, 100, 300],
		[16, 100, 1500],
		[1, 0, 200], // one CPU, raised to one default job of 2 (floored)
	];
	for (const [cpus, reserve, budget] of rows) {
		const b = computeHostBudget(AUTO, { memTotalMiB: 32768, hostCpus: cpus }, DEFAULT);
		assert.equal(b.detail.cpuReserveCenti, reserve, `reserve of ${cpus}`);
		assert.equal(b.cpuCenti, budget, `budget of ${cpus}`);
	}
});

test("auto takes the smaller of the runtime's numbers and a rootless user service's own limits; a set reserve replaces the auto one", () => {
	const b = computeHostBudget(AUTO, { memTotalMiB: 32768, hostCpus: 8, userMemMiB: 16384, userCpuCenti: 350 }, DEFAULT);
	assert.equal(b.detail.memTotalMiB, 16384);
	assert.equal(b.memMiB, 16384 - 1638);
	assert.equal(b.detail.cpuTotalCenti, 350, "3.5 CPUs of cpu.max, below the host's 8");
	assert.equal(b.cpuCenti, 350, "under four CPUs: no reserve");
	const reserved = computeHostBudget(settingsOf({ PI_HOST_RESERVE_MEMORY: "0", PI_HOST_RESERVE_CPUS: "2" }), { memTotalMiB: 32768, hostCpus: 8 }, DEFAULT);
	assert.equal(reserved.memMiB, 32768);
	assert.equal(reserved.cpuCenti, 600);
});

test("a value is the budget whatever the host says; off is Infinity; auto without a fact is null (unknown, fails open)", () => {
	const fixed = computeHostBudget(settingsOf({ PI_HOST_MEMORY_BUDGET: "64g", PI_HOST_CPU_BUDGET: "12" }), {}, DEFAULT);
	assert.deepEqual([fixed.memMiB, fixed.cpuCenti], [65536, 1200]);
	const off = computeHostBudget(settingsOf({ PI_HOST_MEMORY_BUDGET: "off", PI_HOST_CPU_BUDGET: "off" }), { memTotalMiB: 1024, hostCpus: 1 }, DEFAULT);
	assert.deepEqual([off.memMiB, off.cpuCenti], [Infinity, Infinity]);
	const unknown = computeHostBudget(AUTO, {}, DEFAULT);
	assert.deepEqual([unknown.memMiB, unknown.cpuCenti], [null, null]);
});

test("the runtime's memory: docker's MemTotal and podman's host.memTotal in whole MiB, a nonsense value no fact", () => {
	const docker = parseDaemonFacts(JSON.stringify({ ServerVersion: "27.5.1", OperatingSystem: "Ubuntu", NCPU: 4, MemTotal: 8_323_072_000 }));
	assert.equal(docker.facts.memTotalMiB, 7937);
	const podman = parseDaemonFacts(JSON.stringify({ host: { cpus: 4, memTotal: 16 * 1048576 * 1024 }, version: { Version: "5.8.1" } }));
	assert.equal(podman.facts.memTotalMiB, 16384);
	for (const bad of [undefined, "8g", -1, 1.5, 63 * 1048576, 2 ** 53]) assert.equal(memoryMiB(bad), null, String(bad));
	assert.equal(memoryMiB(64 * 1048576), 64);
});

test("a rootless account's limits: the smaller of its slice's and its user service's memory.max and cpu.max, max is no bound", () => {
	assert.deepEqual(userServiceCgroupDirs(1234), ["/sys/fs/cgroup/user.slice/user-1234.slice", "/sys/fs/cgroup/user.slice/user-1234.slice/user@1234.service"]);
	assert.equal(parseMemoryMax("max\n"), null);
	assert.equal(parseMemoryMax("17179869184\n"), 16384);
	assert.equal(parseMemoryMax("garbage"), null);
	assert.equal(parseCpuMax("max 100000\n"), null);
	assert.equal(parseCpuMax("350000 100000\n"), 350);
	assert.equal(parseCpuMax("50000 100000"), 50);
	assert.equal(parseCpuMax("0 100000"), null);
	const files = {
		"/sys/fs/cgroup/user.slice/user-1234.slice/memory.max": "8589934592\n",
		"/sys/fs/cgroup/user.slice/user-1234.slice/cpu.max": "max 100000\n",
		"/sys/fs/cgroup/user.slice/user-1234.slice/user@1234.service/memory.max": "17179869184\n",
		"/sys/fs/cgroup/user.slice/user-1234.slice/user@1234.service/cpu.max": "400000 100000\n",
	};
	const readFile = (path) => {
		if (!(path in files)) throw Object.assign(new Error("absent"), { code: "ENOENT" });
		return files[path];
	};
	// The slice's 8g is below the service's 16g, and the service's 4 CPUs below the slice's none: the smaller of each.
	assert.deepEqual(readUserServiceLimits({ uid: 1234, readFile }), { userMemMiB: 8192, userCpuCenti: 400 });
	assert.deepEqual(readUserServiceLimits({ uid: 99, readFile }), { userMemMiB: null, userCpuCenti: null }, "unreadable is no bound, never an error");
	assert.deepEqual(readUserServiceLimits({ uid: undefined, readFile }), { userMemMiB: null, userCpuCenti: null });
});

// ---------------------------------------------------------------------------------------------------------------------
// The pure rules.

const w = (id, project, memMiB, cpuCenti, firstAt, suspended = false) => ({ id, project, memMiB, cpuCenti, firstAt, suspended });
const run = (id, project, memMiB, cpuCenti) => ({ id, project, memMiB, cpuCenti, orphan: null });

test("rankHolds: tier 1 (each project below its minJobs, its oldest waiter), then tier 2 (the oldest of all); suspended holds nothing", () => {
	const minJobs = { med: 1, light: 2 };
	const waiters = [w("l1", "light", 2048, 100, 5), w("h1", "heavy", 20480, 400, 1), w("m1", "med", 8192, 200, 3), w("m2", "med", 8192, 200, 2), w("l0", "light", 2048, 100, 4, true)];
	const ledger = [run("lr", "light", 2048, 100)];
	const holds = rankHolds(waiters, ledger, (p) => minJobs[p] ?? 0);
	// med runs 0 < 1: its OLDEST (m2) holds; light runs 1 < 2: its oldest UNSUSPENDED (l1) holds; heavy has no minimum
	// but is the oldest of all, so it holds in tier 2, after tier 1.
	assert.deepEqual(holds.map((h) => h.id), ["m2", "l1", "h1"]);
	// When the oldest is already in tier 1 it is not listed twice.
	assert.deepEqual(rankHolds([w("m1", "med", 1, 1, 1), w("x", "other", 1, 1, 2)], [], (p) => minJobs[p] ?? 0).map((h) => h.id), ["m1"]);
	// A project at its minimum holds nothing in tier 1.
	assert.deepEqual(rankHolds([w("m1", "med", 1, 1, 2), w("x", "other", 1, 1, 1)], [run("mr", "med", 1, 1)], (p) => minJobs[p] ?? 0).map((h) => h.id), ["x"]);
	assert.deepEqual(rankHolds([], [], () => 0), []);
});

test("admit: what runs plus the ask plus every hold ranked above it, in BOTH memory and CPU; the share is judged first", () => {
	const budget = { memMiB: 32768, cpuCenti: 800 };
	const ledger = [run("a", "light", 8192, 200), run("b", "light", 8192, 200)];
	const holds = [w("h", "heavy", 16384, 200, 1)];
	// 16g + 2g + 16g held > 32g: a newcomer waits behind the hold.
	assert.deepEqual(admit({ budget, ledger, holds, ask: { id: "n", project: "light", memMiB: 2048, cpuCenti: 100 } }), { ok: false, why: "budget" });
	// The hold itself has nothing above it: 16g + 16g fits.
	assert.deepEqual(admit({ budget, ledger, holds, ask: { id: "h", project: "heavy", memMiB: 16384, cpuCenti: 200 } }), { ok: true });
	// CPU binds alone: memory fits, 4 + 2 + 2 held + 1 > 8.
	assert.deepEqual(admit({ budget, ledger, holds, ask: { id: "n", project: "x", memMiB: 0, cpuCenti: 300 } }), { ok: false, why: "budget" });
	// hostShare 50: light already holds 16g of 32g, so another light is a share stop even with no hold anywhere.
	assert.deepEqual(admit({ budget, ledger, holds: [], ask: { id: "n", project: "light", memMiB: 1024, cpuCenti: 25 }, shareOf: (p) => (p === "light" ? 50 : null) }), { ok: false, why: "share" });
	// Off and unknown budgets never refuse.
	assert.deepEqual(admit({ budget: { memMiB: Infinity, cpuCenti: null }, ledger, holds, ask: { id: "n", project: null, memMiB: 1e6, cpuCenti: 1e6 } }), { ok: true });
});

test("admit: the job COUNT is the third dimension: every running job, the ask and every hold above it is one", () => {
	const budget = { memMiB: 65536, cpuCenti: 1600, count: 3 };
	const ledger = [run("a", null, 1024, 25), run("b", null, 1024, 25)];
	const holds = [w("big", "big", 20480, 200, 1)];
	// Memory and CPU are plentiful; 2 running + the ask + the hold above it = 4 > 3.
	assert.deepEqual(admit({ budget, ledger, holds, ask: { id: "n", project: null, memMiB: 1024, cpuCenti: 25 } }), { ok: false, why: "budget" });
	// The hold itself has nothing above it: 2 + 1 = 3.
	assert.deepEqual(admit({ budget, ledger, holds, ask: { id: "big", project: "big", memMiB: 20480, cpuCenti: 200 } }), { ok: true });
	// Exactly at the count is admitted; one over is not; no count is no bound.
	assert.deepEqual(admit({ budget: { ...budget, count: 4 }, ledger, holds, ask: { id: "n", project: null, memMiB: 1024, cpuCenti: 25 } }), { ok: true });
	assert.deepEqual(admit({ budget: { ...budget, count: null }, ledger: [...ledger, run("c", null, 1, 1), run("d", null, 1, 1)], holds, ask: { id: "n", project: null, memMiB: 1, cpuCenti: 1 } }), { ok: true });
	// hostShare is a share of memory and CPU only: a project at half the count is not share-stopped by it.
	assert.deepEqual(admit({ budget: { ...budget, count: 2 }, ledger: [run("p1", "p", 1024, 25)], holds: [], ask: { id: "p2", project: "p", memMiB: 1024, cpuCenti: 25 }, shareOf: () => 50 }), { ok: true });
});

test("neverFits: host, then share; an off or unknown budget never refuses; the registry's budget fields", () => {
	const budget = { memMiB: 16384, cpuCenti: 400 };
	assert.equal(neverFits({ memMiB: 20480, cpuCenti: 400 }, budget), "host");
	assert.equal(neverFits({ memMiB: 8192, cpuCenti: 500 }, budget), "host");
	assert.equal(neverFits({ memMiB: 12288, cpuCenti: 200 }, budget, 50), "share");
	assert.equal(neverFits({ memMiB: 8192, cpuCenti: 200 }, budget, 50), null);
	assert.equal(neverFits({ memMiB: 1e6, cpuCenti: 1e6 }, { memMiB: null, cpuCenti: Infinity }), null);
	assert.deepEqual([budgetField(Infinity), budgetField(null), budgetField(4096)], ["off", "", "4096"]);
	assert.deepEqual(publishedBudget({ budgetMemMiB: "off", budgetCpuCenti: "x" }), { memMiB: Infinity, cpuCenti: null });
	assert.deepEqual(largestFit({ memMiB: 32768, cpuCenti: 800 }, 25), { memMiB: 8192, cpuCenti: 200 });
});

test("projectBudgetRow reads a project row's hostShare and minJobs from a parsed limits file", () => {
	const limits = parseScopedLimits(JSON.stringify({ version: 3, limits: [{ scope: "project:shop", memory: "2g", cpus: 1, hostShare: 40, minJobs: 2 }] }), "sl.json");
	assert.deepEqual(projectBudgetRow(limits, "shop"), { hostShare: 40, minJobs: 2 });
	assert.deepEqual(projectBudgetRow(limits, "other"), { hostShare: null, minJobs: 0 });
	assert.deepEqual(projectBudgetRow(null, "shop"), { hostShare: null, minJobs: 0 });
});

// ---------------------------------------------------------------------------------------------------------------------
// The stateful budget.

function budgetWith({ facts = { memTotalMiB: 36864, hostCpus: 9 }, limits = [], clock = { t: 1_000_000 }, gone = async () => null, settings = settingsOf({ PI_HOST_RESERVE_MEMORY: "0", PI_HOST_RESERVE_CPUS: "1" }), count = null } = {}) {
	const logs = [];
	const b = makeHostBudget({ settings, jobDefault: { memMiB: 512, cpuCenti: 25 }, readFacts: async () => facts, scopedLimits: () => limits, countLimit: () => count, containerGone: gone, now: () => clock.t, log: (event, fields) => logs.push({ event, fields }) });
	return { b, logs, clock };
}

test("the gate: a hold is taken synchronously, release is idempotent, and a job that does not fit becomes a waiter", async () => {
	const { b } = budgetWith();
	await b.ready;
	assert.deepEqual(b.current(), { memMiB: 36864, cpuCenti: 800 });
	assert.deepEqual(b.gate({ id: "a", project: "p", size: { memMiB: 32768, cpuCenti: 400 } }), { admitted: true });
	const no = b.gate({ id: "b", project: "p", size: { memMiB: 8192, cpuCenti: 100 } });
	assert.deepEqual(no, { admitted: false, why: "budget", rank: 0 });
	assert.equal(b.waiting().length, 1);
	assert.equal(b.release("a"), true);
	assert.equal(b.release("a"), false, "a second release gives back nothing");
	assert.equal(b.release("never"), false);
	assert.deepEqual(b.gate({ id: "b", project: "p", size: { memMiB: 8192, cpuCenti: 100 } }), { admitted: true });
	assert.equal(b.waiting().length, 0, "admitted: no longer a waiter");
	assert.deepEqual(b.snapshot(), { memMiB: 36864, cpuCenti: 800, usedMemMiB: 8192, usedCpuCenti: 100, heldMemMiB: 0, heldCpuCenti: 0, running: 1, orphans: 0, holds: 0, waiters: 0, seeded: true, unseeded: [] });
	// A job its own project's share stops is a waiter that HOLDS NOTHING: the budget is not its obstacle.
	const limits = parseScopedLimits(JSON.stringify({ version: 3, limits: [{ scope: "project:q", memory: "1g", cpus: 1, hostShare: 10 }] }), "sl.json");
	b.gate({ id: "q1", project: "q", size: { memMiB: 1024, cpuCenti: 50 }, limits });
	assert.deepEqual(b.gate({ id: "q2", project: "q", size: { memMiB: 4096, cpuCenti: 50 }, limits }), { admitted: false, why: "share", rank: 0 });
	assert.equal(b.waiting().find((x) => x.id === "q2").suspended, true, "share-stopped: suspended, so it keeps no room");
	b.forget("q2");
});

test("an orphan keeps its hold until the runtime says its container is gone; an unanswered check keeps it too", async () => {
	let answer = null;
	const { b, logs } = budgetWith({ gone: async () => answer });
	await b.ready;
	b.gate({ id: "a", project: null, size: { memMiB: 30000, cpuCenti: 100 } });
	assert.equal(b.orphan("a", { name: "pi-job-a", venue: { kind: "github" } }), true);
	assert.equal(b.release("a"), false, "an orphan is never released by a job path");
	assert.equal(b.gate({ id: "b", project: null, size: { memMiB: 8192, cpuCenti: 100 } }).admitted, false, "its room stays taken");
	await b.sweep();
	assert.equal(b.entries().length, 1, "null: could not ask, so the hold stays");
	answer = false;
	await b.sweep();
	assert.equal(b.entries().length, 1, "false: it still runs");
	answer = true;
	await b.sweep();
	assert.equal(b.entries().length, 0, "true: gone, so the hold is given back");
	assert.ok(logs.some((l) => l.event === "host_budget_orphan_released"));
	assert.equal(b.gate({ id: "b", project: null, size: { memMiB: 8192, cpuCenti: 100 } }).admitted, true);
});

test("a stale hold is verified after 15 s: dropped when finished, gone or active elsewhere, kept while waiting; a Valkey error drops it after 120 s", async () => {
	const clock = { t: 0 };
	const { b } = budgetWith({ clock });
	await b.ready;
	b.gate({ id: "run", project: null, size: { memMiB: 36864, cpuCenti: 100 } });
	const states = { w1: "delayed", w2: "completed", w3: "active", w4: "active", w5: "unknown", w6: "failed" };
	for (const id of Object.keys(states)) b.gate({ id, project: null, size: { memMiB: 1024, cpuCenti: 25 }, getState: async () => states[id] });
	let errors = 0;
	b.gate({ id: "err", project: null, size: { memMiB: 1024, cpuCenti: 25 }, getState: async () => (errors++, Promise.reject(new Error("valkey down"))) });
	b.enter("w4"); // w4 is inside one of this host's processors right now
	clock.t = HOLD_VERIFY_AFTER_MS - 1;
	await b.verify();
	assert.equal(b.waiting().length, 7, "nothing is checked before 15 s");
	clock.t = HOLD_VERIFY_AFTER_MS;
	await b.verify();
	assert.deepEqual(b.waiting().map((x) => x.id).sort(), ["err", "w1", "w4"]);
	assert.equal(errors, 1);
	clock.t = HOLD_DROP_ON_ERROR_MS - 1;
	await b.verify();
	assert.ok(b.waiting().some((x) => x.id === "err"), "an unverifiable hold is kept until its job has been away 120 s");
	clock.t = HOLD_DROP_ON_ERROR_MS;
	await b.verify();
	assert.deepEqual(b.waiting().map((x) => x.id).sort(), ["w1", "w4"]);
});

test("suspend keeps a waiter's age and stops its hold counting; forget drops it", async () => {
	const clock = { t: 0 };
	const { b } = budgetWith({ clock });
	await b.ready;
	b.gate({ id: "run", project: null, size: { memMiB: 30000, cpuCenti: 100 } });
	assert.equal(b.gate({ id: "big", project: null, size: { memMiB: 16384, cpuCenti: 100 } }).admitted, false);
	clock.t = 10;
	assert.equal(b.gate({ id: "small", project: null, size: { memMiB: 4096, cpuCenti: 100 } }).admitted, false, "the older big waiter holds its room");
	b.suspend("big");
	assert.equal(b.gate({ id: "small", project: null, size: { memMiB: 4096, cpuCenti: 100 } }).admitted, true, "suspended, it holds nothing");
	assert.equal(b.waiting().find((x) => x.id === "big").firstAt, 0, "and keeps its age");
	b.forget("big");
	assert.equal(b.waiting().length, 0);
});

test("ONE PICKUP, ONE TICKET: a job id the ledger holds is deferred running-here, and only its own ticket gives it back", async () => {
	const { b } = budgetWith();
	await b.ready;
	const first = b.enter("repeat");
	assert.deepEqual(b.gate({ id: "repeat", ticket: first, project: null, size: { memMiB: 20480, cpuCenti: 200 } }), { admitted: true });
	// The stalled scheduled job handed back while attempt 1 still runs: a second pickup of the same id.
	const second = b.enter("repeat");
	assert.notEqual(second, first);
	assert.deepEqual(b.gate({ id: "repeat", ticket: second, project: null, size: { memMiB: 20480, cpuCenti: 200 } }), { admitted: false, why: "running-here", rank: -1 });
	assert.equal(b.waiting().length, 0, "running-here makes no waiter: it holds nothing");
	assert.equal(b.release("repeat", { ticket: second }), false, "attempt 2 gives back nothing of attempt 1's hold");
	assert.equal(b.orphan("repeat", { name: "pi-job-repeat", ticket: second }), false, "nor orphans it");
	assert.equal(b.release("repeat"), false, "nor does a release with no ticket");
	assert.equal(b.snapshot().usedMemMiB, 20480, "attempt 1 still holds its room");
	b.leave("repeat");
	assert.equal(b.release("repeat", { ticket: first }), true, "attempt 1's own release gives it back");
	b.leave("repeat");
	// C3: an ORPHAN's id is deferred too, and its entry is never overwritten.
	const t = b.enter("o");
	b.gate({ id: "o", ticket: t, project: null, size: { memMiB: 8192, cpuCenti: 100 } });
	assert.equal(b.orphan("o", { name: "pi-job-o", ticket: t }), true);
	assert.equal(b.gate({ id: "o", ticket: b.enter("o"), project: null, size: { memMiB: 1024, cpuCenti: 25 } }).why, "running-here");
	assert.equal(b.entries().find((e) => e.id === "o").orphan.name, "pi-job-o", "the orphan entry is untouched");
});

test("a job being handled by two pickups at once is still handled after one of them leaves (verify does not mistake it for elsewhere)", async () => {
	const clock = { t: 0 };
	const { b } = budgetWith({ clock });
	await b.ready;
	b.gate({ id: "run", project: null, size: { memMiB: 36864, cpuCenti: 100 } });
	b.gate({ id: "w", project: null, size: { memMiB: 1024, cpuCenti: 25 }, getState: async () => "active" });
	b.enter("w");
	b.enter("w");
	b.leave("w");
	clock.t = HOLD_VERIFY_AFTER_MS;
	await b.verify();
	assert.deepEqual(b.waiting().map((x) => x.id), ["w"], "one pickup still handles it: active HERE, kept");
	b.leave("w");
	clock.t = 2 * HOLD_VERIFY_AFTER_MS;
	await b.verify();
	assert.deepEqual(b.waiting(), [], "no pickup handles it: active elsewhere, dropped");
});

test("the count dimension in the gate: the live limit is read per gate, and the oldest waiter's hold keeps a job slot", async () => {
	let limit = 2;
	const clock = { t: 0 };
	const logs = [];
	const b = makeHostBudget({ settings: settingsOf({ PI_HOST_MEMORY_BUDGET: "64g", PI_HOST_CPU_BUDGET: "16" }), jobDefault: { memMiB: 512, cpuCenti: 25 }, countLimit: () => limit, now: () => clock.t, log: (event, fields) => logs.push({ event, fields }) });
	await b.ready;
	const small = { memMiB: 1024, cpuCenti: 25 };
	assert.equal(b.gate({ id: "s1", project: null, size: small }).admitted, true);
	assert.equal(b.gate({ id: "s2", project: null, size: small }).admitted, true);
	clock.t = 1;
	assert.deepEqual(b.gate({ id: "big", project: null, size: { memMiB: 20480, cpuCenti: 200 } }), { admitted: false, why: "budget", rank: 0 }, "the count binds, not the memory");
	b.release("s1");
	clock.t = 2;
	assert.equal(b.gate({ id: "s3", project: null, size: small }).admitted, false, "the freed slot is the head waiter's");
	assert.equal(b.gate({ id: "big", project: null, size: { memMiB: 20480, cpuCenti: 200 } }).admitted, true);
	limit = 4;
	assert.equal(b.gate({ id: "s3", project: null, size: small }).admitted, true, "a raised PI_CONCURRENCY applies at the next gate");
	limit = () => {};
	const throwing = makeHostBudget({ settings: settingsOf({ PI_HOST_MEMORY_BUDGET: "64g", PI_HOST_CPU_BUDGET: "16" }), jobDefault: { memMiB: 512, cpuCenti: 25 }, countLimit: () => {
		throw new Error("x");
	} });
	await throwing.ready;
	assert.equal(throwing.gate({ id: "a", project: null, size: small }).admitted, true, "a count that cannot be read is no count bound (the memory and CPU still are)");
});

test("SEEDED AT BOOT: the surviving job containers are orphans from their labels; unlisted, nothing is admitted", async () => {
	let answer = () => {
		throw new Error("daemon down");
	};
	let gone = false;
	const logs = [];
	const limits = parseScopedLimits(JSON.stringify({ version: 3, limits: [{ scope: "project:ml", memory: "24g", cpus: 6 }, { scope: "acme/web", concurrent: 2 }] }), "sl.json");
	const b = makeHostBudget({ countLimit: NO_COUNT, settings: settingsOf({ PI_HOST_MEMORY_BUDGET: "64g", PI_HOST_CPU_BUDGET: "16" }), jobDefault: { memMiB: 4096, cpuCenti: 200 }, scopedLimits: () => limits, survivors: async () => answer(), containerGone: async () => gone, log: (event, fields) => logs.push({ event, fields }) });
	await b.ready;
	assert.equal(b.snapshot().seeded, false);
	assert.deepEqual(b.gate({ id: "j", project: null, size: { memMiB: 1024, cpuCenti: 25 } }), { admitted: false, why: "unseeded", rank: -1 }, "fail closed");
	assert.equal(b.waiting().length, 0, "and no waiter");
	assert.equal(logs.filter((l) => l.event === "host_budget_seed_unread").length, 1);
	await b.tick();
	assert.equal(logs.filter((l) => l.event === "host_budget_seed_unread").length, 1, "said once per streak");
	answer = () => [
		{ name: "pi-job-a", venue: { backend: "local" }, memMiB: 8192, cpuCenti: 200 },
		{ name: "pi-job-old", venue: { backend: "podman" }, memMiB: null, cpuCenti: null },
		{ name: "pi-job-half", venue: { backend: "local" }, memMiB: 2048, cpuCenti: null },
	];
	await b.tick();
	assert.equal(b.snapshot().seeded, true);
	assert.ok(logs.some((l) => l.event === "host_budget_seed_read"));
	const entries = b.entries();
	assert.deepEqual(entries.map((e) => [e.id, e.memMiB, e.cpuCenti, e.orphan.name, e.orphan.venue.backend]), [
		["container:pi-job-a", 8192, 200, "pi-job-a", "local"],
		["container:pi-job-old", 24576, 600, "pi-job-old", "podman"],
		["container:pi-job-half", 24576, 600, "pi-job-half", "local"],
	], "labelled as labelled; unlabelled (or half labelled) at the largest size any project could have started it at");
	assert.equal(b.gate({ id: "j", project: null, size: { memMiB: 9216, cpuCenti: 100 } }).admitted, false, "8g + 24g + 24g seeded + 9g > 64g");
	b.forget("j");
	gone = true;
	await b.tick();
	assert.equal(b.entries().length, 0, "the sweep gives each back once the runtime says it is gone");
	assert.equal(b.gate({ id: "j", project: null, size: { memMiB: 9216, cpuCenti: 100 } }).admitted, true);
	// No lister wired: nothing to seed, admitted from the start.
	const plain = makeHostBudget({ countLimit: NO_COUNT, settings: settingsOf({ PI_HOST_MEMORY_BUDGET: "64g", PI_HOST_CPU_BUDGET: "16" }), jobDefault: { memMiB: 4096, cpuCenti: 200 } });
	await plain.ready;
	assert.equal(plain.snapshot().seeded, true);
	// A listing that is not an array is not a listing.
	const oddLogs = [];
	const odd = makeHostBudget({ countLimit: NO_COUNT, settings: settingsOf({ PI_HOST_MEMORY_BUDGET: "64g", PI_HOST_CPU_BUDGET: "16" }), jobDefault: { memMiB: 4096, cpuCenti: 200 }, survivors: async () => null, log: (event) => oddLogs.push(event) });
	await odd.ready;
	assert.equal(odd.snapshot().seeded, false);
	assert.deepEqual(oddLogs.filter((e) => e.startsWith("host_budget_seed")), ["host_budget_seed_unread"], "and said, as an unread listing is");
	assert.deepEqual(pessimisticSize([], { memMiB: 4096, cpuCenti: 200 }), { memMiB: 4096, cpuCenti: 200 });
	assert.deepEqual(pessimisticSize([{ scope: "project:x", memory: "2g", cpus: 8 }, { scope: "acme/web", memory: "99g" }], { memMiB: 4096, cpuCenti: 200 }), { memMiB: 4096, cpuCenti: 800 }, "only project rows size a job");
});

test("verify bounds every queue read: a read that never settles is the error branch, and the hold is dropped at 120 s", async () => {
	const clock = { t: 0 };
	const logs = [];
	const b = makeHostBudget({ countLimit: NO_COUNT, settings: settingsOf({ PI_HOST_MEMORY_BUDGET: "36g", PI_HOST_CPU_BUDGET: "8" }), jobDefault: { memMiB: 512, cpuCenti: 25 }, now: () => clock.t, log: (event, fields) => logs.push({ event, fields }), stateReadBoundMs: 5 });
	await b.ready;
	b.gate({ id: "run", project: null, size: { memMiB: 36864, cpuCenti: 100 } });
	let reads = 0;
	b.gate({ id: "hung", project: null, size: { memMiB: 1024, cpuCenti: 25 }, getState: () => (reads++, new Promise(() => {})) });
	clock.t = HOLD_VERIFY_AFTER_MS;
	await b.verify();
	assert.equal(reads, 1, "it was asked");
	assert.equal(b.waiting().length, 1, "an unanswered read before 120 s keeps the hold");
	clock.t = HOLD_DROP_ON_ERROR_MS;
	await b.verify();
	assert.deepEqual(b.waiting(), [], "the verify RETURNED and dropped it");
	assert.deepEqual(logs.filter((l) => l.event === "host_budget_hold_dropped").map((l) => l.fields.because), ["unverifiable"]);
});

test("verify judges the 120 s drop at the clock AFTER the bounded read, since the read itself takes time", async () => {
	const clock = { t: 0 };
	const b = makeHostBudget({ countLimit: NO_COUNT, settings: settingsOf({ PI_HOST_MEMORY_BUDGET: "36g", PI_HOST_CPU_BUDGET: "8" }), jobDefault: { memMiB: 512, cpuCenti: 25 }, now: () => clock.t, stateReadBoundMs: 5 });
	await b.ready;
	b.gate({ id: "run", project: null, size: { memMiB: 36864, cpuCenti: 100 } });
	// The read hangs until its bound, and the clock passes the drop line while it does.
	b.gate({ id: "slow", project: null, size: { memMiB: 1024, cpuCenti: 25 }, getState: () => ((clock.t = HOLD_DROP_ON_ERROR_MS), new Promise(() => {})) });
	clock.t = HOLD_DROP_ON_ERROR_MS - 1;
	await b.verify();
	assert.deepEqual(b.waiting(), [], "away 120 s by the time the read gave up: dropped now, not a tick later");
});

test("tick: one of each piece in flight, and the sweep never waits on a verify, a facts read or a boot listing", async () => {
	const clock = { t: 0 };
	let factsReads = 0;
	let releaseFacts;
	let goneAsks = 0;
	const b = makeHostBudget({ countLimit: NO_COUNT,
		settings: settingsOf({ PI_HOST_MEMORY_BUDGET: "36g", PI_HOST_CPU_BUDGET: "8" }),
		jobDefault: { memMiB: 512, cpuCenti: 25 },
		now: () => clock.t,
		readFacts: () => (factsReads++, factsReads === 1 ? Promise.resolve({}) : new Promise((r) => (releaseFacts = r))),
		containerGone: async () => (goneAsks++, true),
		stateReadBoundMs: 200,
	});
	await b.ready;
	const t = b.enter("o");
	b.gate({ id: "o", ticket: t, project: null, size: { memMiB: 30000, cpuCenti: 100 } });
	b.orphan("o", { name: "pi-job-o", ticket: t });
	let stateReads = 0;
	b.gate({ id: "w", project: null, size: { memMiB: 8192, cpuCenti: 25 }, getState: () => (stateReads++, new Promise(() => {})) });
	clock.t = HOLD_VERIFY_AFTER_MS;
	const first = b.tick();
	const second = b.tick();
	for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
	assert.equal(stateReads, 1, "the second tick did not start a second verify while the first still waits");
	assert.equal(factsReads, 2, "nor a second facts read");
	assert.equal(goneAsks, 1, "the sweep ran beside the hung verify");
	assert.equal(b.entries().some((e) => e.id === "o"), false, "and gave the orphan's room back");
	releaseFacts({});
	void first;
	void second;
});

// ---------------------------------------------------------------------------------------------------------------------
// Properties, seeded and deterministic.

/** mulberry32: a small seeded PRNG, so every run of a property test walks the same sequences. */
function prng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const SIZES = [
	{ memMiB: 512, cpuCenti: 25 },
	{ memMiB: 2048, cpuCenti: 100 },
	{ memMiB: 8192, cpuCenti: 200 },
	{ memMiB: 20480, cpuCenti: 400 },
	{ memMiB: 4096, cpuCenti: 50 },
];

test("PROPERTY: after any sequence of gate, release, orphan, sweep, suspend, forget and verify, the sum held never exceeds the budget in memory, CPU and count", async () => {
	const limits = parseScopedLimits(JSON.stringify({ version: 3, limits: [{ scope: "project:p0", memory: "2g", cpus: 1, minJobs: 2, hostShare: 60 }, { scope: "project:p1", memory: "8g", cpus: 2, minJobs: 1 }] }), "sl.json");
	for (let seed = 1; seed <= 60; seed++) {
		const rand = prng(seed);
		const clock = { t: 0 };
		let goneAnswer = false;
		// The count dimension: from 1 to 6 jobs, or none, per seed.
		const count = seed % 7 === 0 ? null : 1 + (seed % 6);
		const { b } = budgetWith({ clock, limits, gone: async () => goneAnswer, count });
		await b.ready;
		const budget = b.current();
		let next = 0;
		const ids = [];
		for (let step = 0; step < 400; step++) {
			clock.t += Math.floor(rand() * 5000);
			const roll = rand();
			const pick = () => ids[Math.floor(rand() * ids.length)];
			if (roll < 0.45) {
				const id = rand() < 0.3 && ids.length > 0 ? pick() : `j${next++}`;
				if (!ids.includes(id)) ids.push(id);
				const project = ["p0", "p1", "p2", null][Math.floor(rand() * 4)];
				b.gate({ id, project, size: SIZES[Math.floor(rand() * SIZES.length)], getState: async () => ["delayed", "completed", "active"][Math.floor(rand() * 3)], limits });
			} else if (roll < 0.7) {
				b.release(pick());
			} else if (roll < 0.78) {
				b.orphan(pick(), { name: "pi-job-x", venue: null });
			} else if (roll < 0.84) {
				goneAnswer = rand() < 0.5;
				await b.sweep();
			} else if (roll < 0.9) {
				b.suspend(pick());
			} else if (roll < 0.95) {
				b.forget(pick());
			} else {
				await b.verify();
			}
			const used = b.entries().reduce((s, e) => ({ memMiB: s.memMiB + e.memMiB, cpuCenti: s.cpuCenti + e.cpuCenti }), { memMiB: 0, cpuCenti: 0 });
			assert.ok(used.memMiB <= budget.memMiB && used.cpuCenti <= budget.cpuCenti, `seed ${seed} step ${step}: ${JSON.stringify(used)} over ${JSON.stringify(budget)}`);
			assert.ok(count === null || b.entries().length <= count, `seed ${seed} step ${step}: ${b.entries().length} jobs over a count of ${count}`);
			// The project with hostShare 60 never holds more than 60% of either dimension.
			const p0 = b.entries().filter((e) => e.project === "p0").reduce((s, e) => ({ memMiB: s.memMiB + e.memMiB, cpuCenti: s.cpuCenti + e.cpuCenti }), { memMiB: 0, cpuCenti: 0 });
			assert.ok(p0.memMiB * 100 <= 60 * budget.memMiB && p0.cpuCenti * 100 <= 60 * budget.cpuCenti, `seed ${seed} step ${step}: p0 over its share`);
		}
	}
});

test("PROPERTY: release is idempotent: a second release of any id changes nothing, whatever came before", async () => {
	for (let seed = 1; seed <= 30; seed++) {
		const rand = prng(1000 + seed);
		const { b } = budgetWith();
		await b.ready;
		const ids = [];
		for (let i = 0; i < 60; i++) {
			const id = `j${i}`;
			ids.push(id);
			b.gate({ id, project: null, size: SIZES[Math.floor(rand() * SIZES.length)] });
			if (rand() < 0.4) b.release(ids[Math.floor(rand() * ids.length)]);
		}
		for (const id of ids) {
			b.release(id);
			const before = JSON.stringify(b.entries());
			assert.equal(b.release(id), false, `seed ${seed}: ${id}`);
			assert.equal(JSON.stringify(b.entries()), before);
		}
	}
});

test("PROPERTY: the head waiter is admitted within as many releases as there were jobs running when it became the head, with and without a count", async () => {
	// No minJobs, so the head is the tier 2 hold, the oldest waiter. Each step either a fresh job asks (asking FIRST,
	// the adversarial order) or one running job ends and every waiter asks again, oldest first. Seeds above 60 add the
	// count dimension, 2 to 4 jobs: the head's hold keeps a count slot as well, so the bound is unchanged.
	for (let seed = 1; seed <= 120; seed++) {
		const rand = prng(5000 + seed);
		const clock = { t: 0 };
		const { b } = budgetWith({ clock, count: seed > 60 ? 2 + (seed % 3) : null });
		await b.ready;
		let next = 0;
		const running = new Set();
		let head = null;
		let headBound = 0;
		let releasesSince = 0;
		for (let step = 0; step < 500; step++) {
			clock.t += 1000;
			if (rand() < 0.55 || running.size === 0) {
				const id = `j${next++}`;
				if (b.gate({ id, project: null, size: SIZES[Math.floor(rand() * SIZES.length)] }).admitted) running.add(id);
			} else {
				const done = [...running][Math.floor(rand() * running.size)];
				running.delete(done);
				b.release(done);
				if (head !== null) releasesSince++;
				for (const waiter of b.waiting().sort((x, y) => x.firstAt - y.firstAt)) {
					if (b.gate({ id: waiter.id, project: null, size: waiter }).admitted) running.add(waiter.id);
				}
			}
			const oldest = b.waiting().sort((x, y) => x.firstAt - y.firstAt || (x.id < y.id ? -1 : 1))[0]?.id ?? null;
			if (head !== null && !b.waiting().some((x) => x.id === head)) {
				assert.ok(releasesSince <= headBound, `seed ${seed}: the head waited ${releasesSince} releases, bound ${headBound}`);
				head = null;
			}
			if (head === null && oldest !== null) {
				head = oldest;
				headBound = running.size;
				releasesSince = 0;
			}
			if (head !== null) assert.ok(releasesSince <= headBound, `seed ${seed} step ${step}: head ${head} waited ${releasesSince} releases, bound ${headBound}`);
		}
	}
});

// ---------------------------------------------------------------------------------------------------------------------
// The three worked scenarios: heavy 20g/4, medium 8g/2 (minJobs 1), light 2g/1, flooding a 32g/8 budget.

const HEAVY = { memMiB: 20480, cpuCenti: 400 };
const MEDIUM = { memMiB: 8192, cpuCenti: 200 };
const LIGHT = { memMiB: 2048, cpuCenti: 100 };
const DURATION = 8; // ticks every job runs

/**
 * A tick-driven host: each tick, the jobs whose time is up release; then a fresh LIGHT job asks for every free CPU (the
 * flood, asking FIRST, which is the order that starves a big job when nothing holds room); then every waiter asks
 * again, oldest first. `admitFn` decides: the real budget, or a control without holds.
 */
async function floodScenario({ withHolds = true, arrivals = {}, ticks = 80 }) {
	const limits = parseScopedLimits(JSON.stringify({ version: 3, limits: [{ scope: "project:heavy", memory: "20g", cpus: 4 }, { scope: "project:medium", memory: "8g", cpus: 2, minJobs: 1 }, { scope: "project:light", memory: "2g", cpus: 1 }] }), "sl.json");
	const clock = { t: 0 };
	const { b } = budgetWith({ clock, limits, settings: settingsOf({ PI_HOST_MEMORY_BUDGET: "32g", PI_HOST_CPU_BUDGET: "8" }) });
	await b.ready;
	const ends = new Map();
	const started = {};
	const asked = {};
	let next = 0;
	let maxUsed = { memMiB: 0, cpuCenti: 0 };
	const ask = (id, project, size, t) => {
		const ok = withHolds ? b.gate({ id, project, size, limits }).admitted : admit({ budget: b.current(), ledger: b.entries(), holds: [], ask: { id, project, ...size } }).ok && b.gate({ id, project, size, limits: [] }).admitted;
		if (!withHolds && !ok) b.forget(id);
		if (ok) {
			ends.set(id, t + DURATION);
			started[id] ??= t;
		}
		return ok;
	};
	const waiting = new Map();
	for (let t = 0; t < ticks; t++) {
		clock.t = t * 1000;
		for (const [id, end] of [...ends]) {
			if (end <= t) {
				ends.delete(id);
				b.release(id);
			}
		}
		// The flood: fresh light jobs while any CPU looks free, each asking once.
		for (let i = 0; i < 8; i++) {
			const id = `light-${next++}`;
			if (!ask(id, "light", LIGHT, t)) {
				b.forget(id);
				break;
			}
		}
		for (const [id, a] of Object.entries(arrivals)) {
			if (a.at === t) {
				asked[id] = t;
				waiting.set(id, a);
			}
		}
		for (const [id, a] of [...waiting]) if (ask(id, a.project, a.size, t)) waiting.delete(id);
		const used = b.entries().reduce((s, e) => ({ memMiB: s.memMiB + e.memMiB, cpuCenti: s.cpuCenti + e.cpuCenti }), { memMiB: 0, cpuCenti: 0 });
		assert.ok(used.memMiB <= 32768 && used.cpuCenti <= 800, `tick ${t}: over budget ${JSON.stringify(used)}`);
		maxUsed = { memMiB: Math.max(maxUsed.memMiB, used.memMiB), cpuCenti: Math.max(maxUsed.cpuCenti, used.cpuCenti) };
	}
	return { started, asked, maxUsed };
}

test("SCENARIO: a heavy job (20g, 4) waiting while light jobs flood starts within one job duration", async () => {
	const { started, asked, maxUsed } = await floodScenario({ arrivals: { heavy: { at: 10, project: "heavy", size: HEAVY } } });
	assert.ok(Number.isInteger(started.heavy), "it started");
	assert.ok(started.heavy - asked.heavy <= DURATION, `waited ${started.heavy - asked.heavy} ticks, one job runs ${DURATION}`);
	assert.equal(maxUsed.cpuCenti, 800, "the flood really filled the host");
	// THE CONTROL, so this scenario is not vacuous: without holds, the flood takes every freed CPU first and the heavy
	// job never starts in the same 80 ticks.
	const control = await floodScenario({ withHolds: false, arrivals: { heavy: { at: 10, project: "heavy", size: HEAVY } } });
	assert.equal(control.started.heavy, undefined, "without a hold the heavy job starves");
});

test("SCENARIO: a medium job (8g, 2, minJobs 1) behind an older waiting heavy job starts first, and both start within their bound", async () => {
	const { started, asked } = await floodScenario({ arrivals: { heavy: { at: 10, project: "heavy", size: HEAVY }, medium: { at: 12, project: "medium", size: MEDIUM } } });
	// The medium project runs none of its minimum, so its waiter is a tier 1 hold and ranks above the heavy (tier 2).
	assert.ok(started.medium <= started.heavy, `medium at ${started.medium}, heavy at ${started.heavy}`);
	assert.ok(started.medium - asked.medium <= DURATION, `medium waited ${started.medium - asked.medium}`);
	assert.ok(started.heavy - asked.heavy <= 2 * DURATION, `heavy waited ${started.heavy - asked.heavy}: one duration for the medium's room, one for its own`);
});

test("SCENARIO: light jobs alone flood without starving one another, and the budget's ceiling is the CPU of 8 lights", async () => {
	const { maxUsed } = await floodScenario({ ticks: 40 });
	assert.deepEqual(maxUsed, { memMiB: 8 * 2048, cpuCenti: 800 });
});

test("the cadences: a never-fits deferral outlasts a host beat and the budget's own re-check, and every re-check differs from the others", () => {
	assert.ok(NEVER_FITS_RECHECK_MS > HOST_BEAT_MS && NEVER_FITS_RECHECK_MS > BUDGET_RECHECK_MS);
	assert.ok(HOLD_STATE_READ_BOUND_MS < HOLD_DROP_ON_ERROR_MS, "a bounded read leaves the 120 s drop reachable");
	assert.ok(HOLD_VERIFY_AFTER_MS > BUDGET_RECHECK_MS, "a waiter that is still asking is never verified");
});

test("issue #596, phase 2: onRefresh gets every refreshed budget and its facts, unawaited, and a hook that throws or rejects breaks nothing", async () => {
	const seen = [];
	const facts = { memTotalMiB: 16384, hostCpus: 4, reserveVenues: [{ venue: "podman", facts: { rootless: true } }] };
	let release;
	const slow = new Promise((r) => (release = r));
	const budget = makeHostBudget({ countLimit: NO_COUNT, settings: AUTO, jobDefault: DEFAULT, readFacts: async () => facts, onRefresh: (b, f) => {
		seen.push([b, f]);
		return slow;
	} });
	// Resolves while the hook's promise is still pending: the refresh never waits for the reserve.
	await budget.ready;
	assert.deepEqual(seen, [[{ memMiB: 14746, cpuCenti: 300 }, facts]]);
	seen[0][0].cpuCenti = 1;
	assert.equal(budget.current().cpuCenti, 300, "the hook gets a copy, never the live budget");
	release();
	for (const onRefresh of [() => {
		throw new Error("sync");
	}, () => Promise.reject(new Error("async"))]) {
		const b = makeHostBudget({ countLimit: NO_COUNT, settings: AUTO, jobDefault: DEFAULT, readFacts: async () => facts, onRefresh });
		assert.deepEqual(await b.ready, { memMiB: 14746, cpuCenti: 300 });
		assert.deepEqual(await b.refresh(), { memMiB: 14746, cpuCenti: 300 });
	}
});

test("countLimit is REQUIRED: a wiring that forgets it is refused at construction, never run without a count bound", () => {
	assert.throws(() => makeHostBudget({ settings: settingsOf({ PI_HOST_MEMORY_BUDGET: "64g", PI_HOST_CPU_BUDGET: "16" }), jobDefault: DEFAULT }), /countLimit is required/);
	assert.throws(() => makeHostBudget({ settings: settingsOf({ PI_HOST_MEMORY_BUDGET: "64g", PI_HOST_CPU_BUDGET: "16" }), jobDefault: DEFAULT, countLimit: 3 }), /countLimit is required/, "a number is not the live reader");
});

test("SEEDED PER VENUE: an unread venue stops only its own jobs, the default venue stands for a job that names none", async () => {
	let podman = () => {
		throw new Error("podman: command not answering");
	};
	const logs = [];
	const b = makeHostBudget({
		settings: settingsOf({ PI_HOST_MEMORY_BUDGET: "64g", PI_HOST_CPU_BUDGET: "16" }),
		jobDefault: { memMiB: 512, cpuCenti: 25 },
		countLimit: NO_COUNT,
		survivors: { local: async () => [], podman: async () => podman() },
		defaultVenue: "local",
		log: (event, fields) => logs.push({ event, fields }),
	});
	await b.ready;
	const size = { memMiB: 1024, cpuCenti: 25 };
	assert.deepEqual(b.gate({ id: "p", size, venue: "podman" }), { admitted: false, why: "unseeded", rank: -1 }, "podman's own job waits");
	assert.deepEqual(b.gate({ id: "l", size, venue: "local" }), { admitted: true }, "a docker job runs beside an unread podman");
	assert.deepEqual(b.gate({ id: "d", size }), { admitted: true }, "a job naming no venue is the default venue's");
	assert.deepEqual(b.snapshot().unseeded, ["podman"]);
	assert.equal(b.snapshot().seeded, false);
	assert.deepEqual(logs.filter((l) => l.event === "host_budget_seed_unread").map((l) => l.fields.venue), ["podman"], "named, once");
	await b.tick();
	assert.equal(logs.filter((l) => l.event === "host_budget_seed_unread").length, 1, "once per streak");
	podman = () => [{ name: "pi-job-old", venue: { backend: "podman" }, memMiB: 2048, cpuCenti: 50 }];
	await b.tick();
	assert.deepEqual(b.snapshot().unseeded, []);
	assert.equal(b.snapshot().seeded, true);
	assert.deepEqual(logs.find((l) => l.event === "host_budget_seed_read").fields, { venue: "podman", seeded: 1 });
	assert.deepEqual(b.gate({ id: "p", size, venue: "podman" }), { admitted: true });
	assert.equal(b.entries().find((e) => e.id === "container:pi-job-old").memMiB, 2048);
	// Without a default venue a job that names none cannot be placed, so ANY unread venue stops it.
	const blind = makeHostBudget({ settings: settingsOf({ PI_HOST_MEMORY_BUDGET: "64g", PI_HOST_CPU_BUDGET: "16" }), jobDefault: { memMiB: 512, cpuCenti: 25 }, countLimit: NO_COUNT, survivors: { local: async () => [], podman: async () => podman() } });
	podman = () => {
		throw new Error("x");
	};
	await blind.ready;
	assert.equal(blind.gate({ id: "n", size }).why, "unseeded");
	assert.equal(blind.gate({ id: "m", size, venue: "local" }).admitted, true);
	// A whole-host function still stops every venue while it is unread.
	const whole = makeHostBudget({ settings: settingsOf({ PI_HOST_MEMORY_BUDGET: "64g", PI_HOST_CPU_BUDGET: "16" }), jobDefault: { memMiB: 512, cpuCenti: 25 }, countLimit: NO_COUNT, survivors: async () => podman(), defaultVenue: "local" });
	await whole.ready;
	assert.equal(whole.gate({ id: "w", size, venue: "local" }).why, "unseeded");
	assert.deepEqual(whole.snapshot().unseeded, ["*"]);
	// A direct `seed` and the tick's share ONE read in flight: a venue is never listed (and seeded) twice at once.
	let calls = 0;
	let answer;
	const once = makeHostBudget({ settings: settingsOf({ PI_HOST_MEMORY_BUDGET: "64g", PI_HOST_CPU_BUDGET: "16" }), jobDefault: { memMiB: 512, cpuCenti: 25 }, countLimit: NO_COUNT, survivors: { local: () => (calls++, calls === 1 ? Promise.reject(new Error("x")) : new Promise((r) => (answer = r))) }, defaultVenue: "local" });
	await once.ready;
	const ticked = once.tick();
	const direct = once.seed();
	await new Promise((r) => setImmediate(r));
	answer([]);
	assert.deepEqual(await Promise.all([ticked, direct]), [undefined, true]);
	assert.equal(calls, 2, "the boot read, then ONE re-read for both callers");
});

test("A SURVIVOR'S NAME IS TAKEN: the job whose container a seeded survivor carries waits running-here, and the sweep never asks about a live job's name", async () => {
	const asked = [];
	let gone = false;
	let podman = () => {
		throw new Error("down");
	};
	const b = makeHostBudget({
		settings: settingsOf({ PI_HOST_MEMORY_BUDGET: "64g", PI_HOST_CPU_BUDGET: "16" }),
		jobDefault: { memMiB: 512, cpuCenti: 25 },
		countLimit: NO_COUNT,
		survivors: { local: async () => [{ name: "pi-job-X", venue: { backend: "local" }, memMiB: 1024, cpuCenti: 50 }], podman: async () => podman() },
		defaultVenue: "local",
		containerGone: async (name) => (asked.push(name), gone),
	});
	await b.ready;
	const size = { memMiB: 512, cpuCenti: 25 };
	assert.deepEqual(b.gate({ id: "X", ticket: b.enter("X"), size, name: "pi-job-X" }), { admitted: false, why: "running-here", rank: -1 }, "its old container still holds the name");
	assert.equal(b.waiting().length, 0, "and no waiter");
	assert.deepEqual(b.gate({ id: "Y", ticket: b.enter("Y"), size, name: "pi-job-Y" }), { admitted: true }, "another name is admitted");
	gone = true;
	await b.sweep();
	assert.deepEqual(asked, ["pi-job-X"]);
	const tx = b.enter("X");
	assert.deepEqual(b.gate({ id: "X", ticket: tx, size, name: "pi-job-X" }), { admitted: true }, "once the survivor is gone, the job runs");
	// A podman listing read only now names a container the live local job X also carries: the sweep must not ask about
	// it (asking removes a container not yet started, which may be the live job's own).
	podman = () => [{ name: "pi-job-X", venue: { backend: "podman" }, memMiB: 1024, cpuCenti: 50 }];
	await b.seed();
	asked.length = 0;
	await b.sweep();
	assert.deepEqual(asked, [], "a name a live entry carries is never asked about");
	assert.ok(b.entries().some((e) => e.id === "container:pi-job-X"), "and its room stays held");
	assert.equal(b.release("X", { ticket: tx }), true);
	await b.sweep();
	assert.deepEqual(asked, ["pi-job-X"], "asked once the live job is gone");
	assert.equal(b.entries().length, 1, "Y alone");
	// An orphan whose name is not known is not "a live job's name" just because a live entry has none either.
	const ta = b.enter("A");
	b.gate({ id: "A", ticket: ta, size });
	const tn = b.enter("N");
	b.gate({ id: "N", ticket: tn, size });
	b.orphan("N", { name: null, ticket: tn });
	asked.length = 0;
	await b.sweep();
	assert.deepEqual(asked, [null], "asked (the runtime's answer decides), not skipped forever");
});

test("an unlabelled survivor's guessed size is CAPPED at the budget", async () => {
	assert.deepEqual(pessimisticSize([{ scope: "project:giant", memory: "128g", cpus: 64 }], { memMiB: 4096, cpuCenti: 200 }, { memMiB: 65536, cpuCenti: 1600 }), { memMiB: 65536, cpuCenti: 1600 });
	assert.deepEqual(pessimisticSize([{ scope: "project:giant", memory: "128g", cpus: 64 }], { memMiB: 4096, cpuCenti: 200 }, { memMiB: Infinity, cpuCenti: null }), { memMiB: 131072, cpuCenti: 6400 }, "an off or unknown budget caps nothing");
	assert.deepEqual(pessimisticSize([{ scope: "project:a", memory: "8g", cpus: 2 }], { memMiB: 4096, cpuCenti: 200 }, { memMiB: 65536, cpuCenti: 1600 }), { memMiB: 8192, cpuCenti: 200 }, "below the budget, unchanged");
	// Seeded after the first refresh, so the cap is the budget in force, also with an auto budget read from facts.
	const limits = parseScopedLimits(JSON.stringify({ version: 3, limits: [{ scope: "project:giant", memory: "128g", cpus: 64 }] }), "sl.json");
	// The facts answer AFTER the listing would (a timer against a microtask), so a seed that did not wait for the first
	// refresh would size the survivor against no budget at all.
	const b = makeHostBudget({ settings: settingsOf({}), jobDefault: DEFAULT, readFacts: () => new Promise((resolve) => setTimeout(() => resolve({ memTotalMiB: 32768, hostCpus: 8 }), 5)), scopedLimits: () => limits, countLimit: NO_COUNT, survivors: { local: async () => [{ name: "pi-job-old", memMiB: null, cpuCenti: null }] }, defaultVenue: "local" });
	await b.ready;
	const budget = b.current();
	assert.deepEqual(b.entries().map((e) => [e.memMiB, e.cpuCenti]), [[budget.memMiB, budget.cpuCenti]], "the whole budget, never more");
	assert.ok(b.snapshot().usedMemMiB <= budget.memMiB);
});
