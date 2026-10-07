import assert from "node:assert/strict";
import { test } from "node:test";
import { SIZE_LABEL_PS_ARGS, budgetLedgerChecks, doctorHostBudget, fleetBudgetChecks, hostBudgetChecks, parseSizeLabels, projectSizes } from "../src/doctor.mjs";
import { parseScopedLimits } from "../src/scoped-limits.mjs";

// Doctor's host budget lines (issue #596, phase 2, DES-HOST-BUDGET): computed by the worker's own functions from the
// reads doctor already makes, and the fleet's budgets from the registry rows.

const DOCKER = (over = {}) => ({ answered: true, facts: { hostCpus: 8, memTotalMiB: 32768, ...over } });
const limitsOf = (rows) => parseScopedLimits(JSON.stringify({ version: 3, limits: rows }), "sl.json");
const labels = (checks) => checks.map((c) => `${c.ok ? "ok" : c.warn ? "warn" : "FAIL"}: ${c.label}`);

test("the budget line names each half and where it comes from, and says which of it and PI_CONCURRENCY binds first", () => {
	const view = doctorHostBudget({}, { daemon: DOCKER() });
	assert.deepEqual([view.memMiB, view.cpuCenti], [29492, 700]);
	assert.deepEqual(labels(hostBudgetChecks(view, { concurrency: 3 })), [
		"ok: Host budget: memory 29492m (auto: 32g here, 3276m kept for the host), CPUs 7 (auto: 8 here, 1 kept for the host); a job starts only when its size fits beside what already runs on this host",
		// the CPU half is a reservation in the arithmetic and a weight at the runtime.
		"ok: The budget counts each job's cpus as CPU reserved for it, although the runtime uses them as a weight (a busy job may use idle cores beyond them): so a job's cpus must fit the CPU budget beside what runs, even on an idle host",
		// min(29492 / 4096, 700 / 200) = min(7, 3) = 3 default jobs: equal to PI_CONCURRENCY, which binds first.
		"ok: PI_CONCURRENCY (3) binds first: the budget holds 3 jobs of the default size (4g, 2 CPUs) at once",
	]);
	assert.match(labels(hostBudgetChecks(view, { concurrency: 4 }))[2], /^ok: The host budget binds first: it holds 3 jobs of the default size \(4g, 2 CPUs\) at once, fewer than PI_CONCURRENCY \(4\)/);
	const cpuOff = labels(hostBudgetChecks(doctorHostBudget({ PI_HOST_CPU_BUDGET: "off" }, { daemon: DOCKER() })));
	assert.equal(cpuOff.some((l) => l.includes("as CPU reserved")), false, "with the CPU budget off nothing counts CPUs, so nothing is said");
	const set = doctorHostBudget({ PI_HOST_MEMORY_BUDGET: "off", PI_HOST_CPU_BUDGET: "12" }, { daemon: DOCKER() });
	assert.match(labels(hostBudgetChecks(set))[0], /memory off \(off: PI_HOST_MEMORY_BUDGET\), CPUs 12 \(PI_HOST_CPU_BUDGET\)/);
	const floored = doctorHostBudget({}, { daemon: DOCKER({ memTotalMiB: 4096, hostCpus: 1 }) });
	assert.match(labels(hostBudgetChecks(floored))[0], /memory 4g \(auto: 4g here, 1g kept for the host, raised to one job of the default size\), CPUs 2 \(auto: 1 here, 0 kept for the host, raised to one job of the default size\)/);
});

test("an unknown budget is a warning naming host_budget_unknown, and a setting that does not parse FAILS: the worker refuses to start", () => {
	const unknown = hostBudgetChecks(doctorHostBudget({}, { daemon: { answered: false, reason: "timeout" } }));
	assert.deepEqual(labels(unknown).slice(0, 4), [
		"ok: Host budget: memory unknown (auto), CPUs unknown (auto); a job starts only when its size fits beside what already runs on this host",
		"ok: The budget counts each job's cpus as CPU reserved for it, although the runtime uses them as a weight (a busy job may use idle cores beyond them): so a job's cpus must fit the CPU budget beside what runs, even on an idle host",
		"warn: host budget: the runtime gave no memory or CPU count, so a worker holds no job back on either until it does (host_budget_unknown)",
		"ok: PI_CONCURRENCY (3) is the only bound on how many jobs run at once here: the budget is not known yet",
	]);
	const bad = hostBudgetChecks(doctorHostBudget({ PI_HOST_MEMORY_BUDGET: "1g" }, { daemon: DOCKER() }));
	assert.equal(bad.length, 1);
	assert.equal(bad[0].ok, false);
	assert.notEqual(bad[0].warn, true, "a failure, not a warning");
	assert.match(bad[0].label, /PI_HOST_MEMORY_BUDGET: 1g is below one job of the default size .* REFUSES TO START/);
});

test("on rootless Podman doctor reads the user service's limits as the worker does, and takes the smaller of the venues", () => {
	const files = { "/sys/fs/cgroup/user.slice/user-1234.slice/user@1234.service/memory.max": "8589934592\n" };
	const readFile = (path) => {
		if (!(path in files)) throw Object.assign(new Error("absent"), { code: "ENOENT" });
		return files[path];
	};
	const podman = { answered: true, info: { rootless: true, hostCpus: 4, memTotalMiB: 16384 } };
	const view = doctorHostBudget({}, { daemon: DOCKER(), podman, readFile, euid: 1234 });
	assert.deepEqual(view.facts, { memTotalMiB: 16384, hostCpus: 4, userMemMiB: 8192, userCpuCenti: null });
	assert.equal(view.memMiB, 8192 - 1024);
	assert.equal(doctorHostBudget({}, { podman: { ...podman, info: { ...podman.info, rootless: false } }, readFile, euid: 1234 }).facts.userMemMiB, undefined, "rootful: no user service read");
});

test("project sizes: a size the budget can never hold, a size over its share, and minimums the budget cannot keep are WARNINGS", () => {
	const view = doctorHostBudget({ PI_HOST_MEMORY_BUDGET: "32g", PI_HOST_CPU_BUDGET: "8" }, {});
	const limits = limitsOf([
		{ scope: "project:huge", memory: "40g", cpus: 2 },
		{ scope: "project:greedy", memory: "20g", cpus: 2, hostShare: 50 },
		{ scope: "project:many", memory: "8g", cpus: 2, hostShare: 40, minJobs: 2 },
		{ scope: "project:ok", memory: "2g", cpus: 1, minJobs: 3 },
		{ scope: "project:counted", concurrent: 2 },
	]);
	assert.deepEqual(projectSizes(limits, {}).map((p) => p.id), ["huge", "greedy", "many", "ok"], "a project row without a size runs at the default and is not listed");
	const lines = labels(hostBudgetChecks(view, { limits, env: { PI_WORKER_NAME: "mini1" } }));
	// a worker without PI_WORKER_NAME declares no fleet, so it refuses every never-fits job, on whatever queue.
	assert.deepEqual(labels(hostBudgetChecks(view, { limits })).slice(3, 5), [
		"warn: project huge: its job size (40g, 2 CPUs) is larger than this host's budget (32g, 8 CPUs), so every job of it is refused before anything is spent (job-size-exceeds-host): with no PI_WORKER_NAME this host declares no fleet, so there is no other host to wait for",
		"warn: project greedy: its job size (20g, 2 CPUs) is larger than its hostShare (50%) of this host's budget, so every job of it is refused before anything is spent (job-size-exceeds-share): with no PI_WORKER_NAME this host declares no fleet, so there is no other host to wait for",
	]);
	// Beside peers in the registry such a worker is not alone: it declares no fleet, and naming it is the fix.
	const besidePeers = hostBudgetChecks(view, { limits, peers: true }).slice(3, 5);
	assert.deepEqual(labels(besidePeers), [
		"warn: project huge: its job size (40g, 2 CPUs) is larger than this host's budget (32g, 8 CPUs), so every job of it is refused before anything is spent (job-size-exceeds-host): this worker declares no fleet (no PI_WORKER_NAME), so it refuses jobs a bigger peer could run",
		"warn: project greedy: its job size (20g, 2 CPUs) is larger than its hostShare (50%) of this host's budget, so every job of it is refused before anything is spent (job-size-exceeds-share): this worker declares no fleet (no PI_WORKER_NAME), so it refuses jobs a bigger peer could run",
	]);
	assert.deepEqual(besidePeers.map((c) => c.fix), [
		"lower project:huge's memory or cpus in scoped-limits.json, or raise this host's budget, or set PI_WORKER_NAME on this worker so a job of it on the shared queue waits for a peer it fits on",
		"raise project:greedy's hostShare or lower its size in scoped-limits.json, or set PI_WORKER_NAME on this worker so a job of it on the shared queue waits for a peer it fits on",
	]);
	assert.deepEqual(hostBudgetChecks(view, { limits }).slice(3, 5).map((c) => c.fix), ["lower project:huge's memory or cpus in scoped-limits.json, or raise this host's budget", "raise project:greedy's hostShare or lower its size in scoped-limits.json"], "alone: no name to set");
	assert.deepEqual(lines.slice(3), [
		"warn: project huge: its job size (40g, 2 CPUs) is larger than this host's budget (32g, 8 CPUs), so a job of it on this host's own queue is refused before anything is spent (job-size-exceeds-host), and one on the shared queue waits for a host it fits on",
		"warn: project greedy: its job size (20g, 2 CPUs) is larger than its hostShare (50%) of this host's budget, so a job of it on this host's own queue is refused before anything is spent (job-size-exceeds-share), and one on the shared queue waits for a host it fits on",
		// 2 x 8g = 16g > 40% of 32g (12.8g): the minimum cannot all run here.
		"warn: project many: minJobs 2 of its size (8g, 2 CPUs) is more than its hostShare (40%) of this host's budget, so this host can never keep room for all of them at once",
		// many 16g/4 + ok 6g/3 = 22g and 7 CPUs: inside 32g and 8. Raise ok's minimum and the sum is over.
	]);
	const over = labels(hostBudgetChecks(view, { limits: limitsOf([{ scope: "project:a", memory: "8g", cpus: 2, minJobs: 3 }, { scope: "project:b", memory: "4g", cpus: 1, minJobs: 3 }]) }));
	assert.equal(over.at(-1), "warn: the projects' minJobs together (36g, 9 CPUs) are more than this host's budget (32g, 8 CPUs), so this host cannot keep every minimum at once: the oldest waiting jobs are served first");
	// CPU alone over: 6g of 32g, but 9 CPUs of 8.
	const cpuOver = labels(hostBudgetChecks(view, { limits: limitsOf([{ scope: "project:a", memory: "1g", cpus: 2, minJobs: 3 }, { scope: "project:b", memory: "1g", cpus: 1, minJobs: 3 }]) }));
	assert.match(cpuOver.at(-1), /^warn: the projects' minJobs together \(6g, 9 CPUs\)/);
});

test("the fleet: a line per host with a budget, the projects each fits on, and a warning for a size no host fits", () => {
	const limits = limitsOf([{ scope: "project:heavy", memory: "20g", cpus: 4 }, { scope: "project:light", memory: "2g", cpus: 1, minJobs: 2 }, { scope: "project:giant", memory: "128g", cpus: 4 }]);
	const rows = [
		{ name: "mini1", budgetMemMiB: "16384", budgetCpuCenti: "700", usedMemMiB: "4096", usedCpuCenti: "200" },
		{ name: "big", budgetMemMiB: "65536", budgetCpuCenti: "1500", usedMemMiB: "0", usedCpuCenti: "0" },
		{ name: "old" },
	];
	assert.deepEqual(labels(fleetBudgetChecks(rows, { limits })), [
		"ok: Host mini1: budget 16g and 7 CPUs, in use 4g and 2 CPUs; largest project size that fits: 2g, 1 CPUs (light)",
		"ok: Host big: budget 64g and 15 CPUs, in use 0 and 0 CPUs; largest project size that fits: 20g, 4 CPUs (heavy)",
		"ok: Project heavy (20g, 4 CPUs) fits on: big",
		"ok: Project light (2g, 1 CPUs) fits on: mini1, big",
		"warn: Project giant (128g, 4 CPUs) fits on no live host's budget, so its jobs on the shared queue wait (they are never refused for it) until a host it fits on is live",
	]);
	assert.deepEqual(fleetBudgetChecks([{ name: "old" }], { limits }), [], "no host publishes a budget: nothing said");
	const tight = labels(fleetBudgetChecks([{ name: "small", budgetMemMiB: "4096", budgetCpuCenti: "800" }], { limits: limitsOf([{ scope: "project:light", memory: "2g", cpus: 1, minJobs: 3 }]) }));
	assert.equal(tight[1], "warn: Host small: the projects' minJobs together (6g, 3 CPUs) are more than its budget, so it cannot keep every minimum at once");
});

test("the ledger against the labels: equal is a green line, a difference and an unlabelled container are warnings", () => {
	assert.deepEqual(SIZE_LABEL_PS_ARGS, ["ps", "--filter", "name=pi-job-", "--format", '{{.Names}}\t{{.Label "pi.dispatch.mem"}}\t{{.Label "pi.dispatch.cpu"}}']);
	const listed = parseSizeLabels("pi-job-1\t4096\t200\npi-job-2\t2048\t100\nmy-pi-job-3\t1\t1\npi-job-4\t\t\n");
	assert.deepEqual(listed, [
		{ name: "pi-job-1", memMiB: 4096, cpuCenti: 200 },
		{ name: "pi-job-2", memMiB: 2048, cpuCenti: 100 },
		{ name: "pi-job-4", memMiB: null, cpuCenti: null },
	]);
	assert.deepEqual(labels(budgetLedgerChecks({ usedMemMiB: "6144", usedCpuCenti: "300" }, listed.slice(0, 2))), ["ok: Host budget ledger matches the running job containers (2 running, 6g and 3 CPUs)"]);
	assert.deepEqual(labels(budgetLedgerChecks({ usedMemMiB: "4096", usedCpuCenti: "200" }, listed)), [
		"warn: Host budget ledger holds 4g and 2 CPUs, while the running job containers are labelled 6g and 3 CPUs",
		"warn: 1 running job container carries no size label (pi-job-4), so the ledger cannot be checked against it (started by a worker from before the host budget); a worker that found it at its start counts each at the largest size a project may run at, capped at the budget, until it is gone",
	]);
	assert.deepEqual(budgetLedgerChecks({ usedMemMiB: "" }, listed), [], "a row without the ledger: nothing to hold against");
	assert.equal(budgetLedgerChecks({ usedMemMiB: "6144", usedCpuCenti: "250" }, listed.slice(0, 2))[0].warn, true, "the CPU half alone differing is a difference");
	assert.deepEqual(labels(budgetLedgerChecks({ usedMemMiB: "0", usedCpuCenti: "0" }, [])), ["ok: Host budget ledger matches the running job containers (0 running, 0 and 0 CPUs)"]);
	// each unlabelled container is NAMED (five at most, then a count), and a half-labelled one is unlabelled.
	const seven = Array.from({ length: 7 }, (_, i) => ({ name: `pi-job-u${i}`, memMiB: i === 0 ? 1024 : null, cpuCenti: null }));
	assert.match(labels(budgetLedgerChecks({ usedMemMiB: "0", usedCpuCenti: "0" }, seven))[1], /^warn: 7 running job containers carry no size label \(pi-job-u0, pi-job-u1, pi-job-u2, pi-job-u3, pi-job-u4 and 2 more\), so the ledger cannot be checked against them /);
});
