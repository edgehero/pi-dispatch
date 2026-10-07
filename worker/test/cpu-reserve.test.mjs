import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CGROUP_PARENT,
	HELPER_PARENT_PATH,
	PARENTLESS_SHARES_MAX,
	QUOTA_PERIOD_US,
	RESERVE_RECHECK_MS,
	RESERVE_RETRY_MS,
	RESERVE_STEP_TIMEOUT_MS,
	cgroupParentFor,
	cpuMaxLine,
	cpuQuotaProperty,
	helperArgs,
	makeCpuReserve,
	operatorQuotaCommand,
	parseCpuMaxRead,
	parseQuotaPerSec,
	readQuota,
	reservePlan,
	showQuotaArgs,
	stepFailure,
	userQuotaCommand,
	userSetPropertyArgs,
	writeQuota,
} from "../src/cpu-reserve.mjs";
import { JOB_USER_FACTS_MAX_AGE_MS } from "../src/job-user.mjs";

// ---------------------------------------------------------------------------------------------------------------------
// The constants, as literals: a constant-derived test is blind to a change IN the value.

test("the parent is pidispatch.slice (no dash: a dash nests), the parentless cap 1024, each command bounded at 15 s", () => {
	assert.equal(CGROUP_PARENT, "pidispatch.slice");
	assert.equal(/-/.test(CGROUP_PARENT), false);
	assert.equal(PARENTLESS_SHARES_MAX, 1024);
	assert.equal(RESERVE_STEP_TIMEOUT_MS, 15_000);
	assert.equal(RESERVE_RETRY_MS, 60_000);
	assert.equal(QUOTA_PERIOD_US, 100_000);
	assert.equal(HELPER_PARENT_PATH, "/sys/fs/cgroup/pidispatch.slice");
	// Re-checked on the cadence the runtime's facts are re-read at, so a Docker Desktop restart is found on one clock.
	assert.equal(RESERVE_RECHECK_MS, 600_000);
	assert.equal(RESERVE_RECHECK_MS, JOB_USER_FACTS_MAX_AGE_MS);
});

test("the quota math: the budget's hundredths ARE systemd's percentage, and cpu.max is hundredths x 1000 per 100000", () => {
	assert.equal(cpuQuotaProperty(300), "CPUQuota=300%");
	assert.equal(cpuQuotaProperty(1300), "CPUQuota=1300%");
	assert.equal(cpuQuotaProperty(350), "CPUQuota=350%");
	assert.equal(cpuMaxLine(300), "300000 100000");
	assert.equal(cpuMaxLine(1300), "1300000 100000");
	assert.equal(cpuMaxLine(25), "25000 100000");
	assert.equal(cpuMaxLine(350), "350000 100000");
	// Every budget a setting may name writes an integer quota.
	for (let centi = 1; centi <= 409_600; centi += 997) assert.match(cpuMaxLine(centi), /^[1-9][0-9]* 100000$/);
});

test("the systemctl argv and the two operator commands, literally", () => {
	assert.deepEqual(userSetPropertyArgs(300), ["--user", "set-property", "pidispatch.slice", "CPUQuota=300%"]);
	assert.deepEqual(userSetPropertyArgs(null), ["--user", "set-property", "pidispatch.slice", "CPUQuota="]);
	assert.deepEqual(showQuotaArgs({ user: true }), ["--user", "show", "-P", "CPUQuotaPerSecUSec", "pidispatch.slice"]);
	assert.deepEqual(showQuotaArgs({ user: false }), ["show", "-P", "CPUQuotaPerSecUSec", "pidispatch.slice"]);
	assert.equal(operatorQuotaCommand(300), "sudo systemctl set-property pidispatch.slice CPUQuota=300%");
	assert.equal(operatorQuotaCommand(null), "sudo systemctl set-property pidispatch.slice CPUQuota=");
	assert.equal(userQuotaCommand(1300), "systemctl --user set-property pidispatch.slice CPUQuota=1300%");
	assert.equal(userQuotaCommand(null), "systemctl --user set-property pidispatch.slice CPUQuota=");
});

test("the helper's argv, literally: uid 0, every capability dropped, no network, read-only, the pinned image never pulled, ONLY the parent's own directory mounted", () => {
	assert.deepEqual(helperArgs({ image: "pi-job:pinned", cpuCenti: 1300 }), [
		"run",
		"--rm",
		"--pull=never",
		"--user=0:0",
		"--cap-drop=ALL",
		"--security-opt",
		"no-new-privileges",
		"--network=none",
		"--read-only",
		"--cgroup-parent=pidispatch.slice",
		"-v",
		"/sys/fs/cgroup/pidispatch.slice:/p",
		"--entrypoint",
		"sh",
		"pi-job:pinned",
		"-c",
		'echo "1300000 100000" > /p/cpu.max',
	]);
	// null writes no quota (the budget is off).
	assert.deepEqual(helperArgs({ image: "pi-job:pinned", cpuCenti: null }).slice(-2), ["-c", 'echo "max 100000" > /p/cpu.max']);
	// The read mounts read-only and runs `cat`, no shell.
	const read = helperArgs({ image: "pi-job:pinned", read: true });
	assert.deepEqual(read.slice(10), ["-v", "/sys/fs/cgroup/pidispatch.slice:/p:ro", "--entrypoint", "cat", "pi-job:pinned", "/p/cpu.max"]);
	for (const args of [helperArgs({ image: "i", cpuCenti: 5 }), read]) {
		const mounts = args.filter((_, i) => args[i - 1] === "-v");
		assert.equal(mounts.length, 1);
		assert.ok(mounts[0].startsWith("/sys/fs/cgroup/pidispatch.slice:"), mounts[0]);
	}
	for (const image of ["", "-v", "--privileged", null, 1]) assert.throws(() => helperArgs({ image, cpuCenti: 300 }), /refusing a helper image/, String(image));
	for (const cpuCenti of [0, -1, 1.5, "300", undefined, Infinity]) assert.throws(() => helperArgs({ image: "i", cpuCenti }), /refusing a quota/, String(cpuCenti));
});

test("parseQuotaPerSec reads systemd's timespan in both fractional spellings, infinity as no quota, and nothing else", () => {
	assert.deepEqual(parseQuotaPerSec("infinity\n"), { cpuCenti: null });
	assert.deepEqual(parseQuotaPerSec("3s"), { cpuCenti: 300 });
	assert.deepEqual(parseQuotaPerSec("13s\n"), { cpuCenti: 1300 });
	assert.deepEqual(parseQuotaPerSec("1.500000s"), { cpuCenti: 150 });
	assert.deepEqual(parseQuotaPerSec("1s 500ms"), { cpuCenti: 150 });
	assert.deepEqual(parseQuotaPerSec("500ms"), { cpuCenti: 50 });
	assert.deepEqual(parseQuotaPerSec("2min"), { cpuCenti: 12_000 });
	assert.deepEqual(parseQuotaPerSec("250000us"), { cpuCenti: 25 });
	for (const bad of ["", "3", "s", "garbage", "3 s", "-3s", "5ms", null, undefined, "3s; rm"]) assert.equal(parseQuotaPerSec(bad), null, String(bad));
});

test("parseCpuMaxRead: max is no quota, a quota line is hundredths, anything else is no read", () => {
	assert.deepEqual(parseCpuMaxRead("max 100000\n"), { cpuCenti: null });
	assert.deepEqual(parseCpuMaxRead("1300000 100000"), { cpuCenti: 1300 });
	assert.deepEqual(parseCpuMaxRead("300000 100000"), { cpuCenti: 300 });
	for (const bad of ["", "max", "garbage", "1 2 3", null]) assert.equal(parseCpuMaxRead(bad), null, String(bad));
});

// ---------------------------------------------------------------------------------------------------------------------
// The plans.

test("cgroupParentFor: none only where Podman says its cgroup manager is not systemd", () => {
	assert.equal(cgroupParentFor({ podman: true, cgroupManager: "systemd" }), "pidispatch.slice");
	assert.equal(cgroupParentFor({ podman: true, cgroupManager: "cgroupfs" }), null);
	assert.equal(cgroupParentFor({ podman: true, cgroupManager: null }), "pidispatch.slice");
	assert.equal(cgroupParentFor({ podman: false, cgroupManager: "cgroupfs" }), "pidispatch.slice");
	assert.equal(cgroupParentFor(undefined), "pidispatch.slice");
});

test("reservePlan: every venue the lab measured gets its method, and every other one a named reason", () => {
	const plan = (venue, facts, extra = {}) => reservePlan({ venue, facts, platform: "linux", ...extra });
	assert.deepEqual(plan("podman", { rootless: true, cgroupManager: "systemd", cgroupVersion: "v2" }), { venue: "podman", parent: true, method: "user-systemd", why: null });
	assert.deepEqual(plan("podman", { rootless: true, cgroupManager: "cgroupfs", cgroupVersion: "v2" }), { venue: "podman", parent: false, method: null, why: "podman-cgroupfs" });
	assert.deepEqual(plan("podman", { rootless: true, cgroupManager: "systemd", cgroupVersion: "v1" }), { venue: "podman", parent: true, method: null, why: "cgroup-v1" });
	assert.deepEqual(plan("podman", { rootless: false, cgroupManager: "systemd", cgroupVersion: "v2" }), { venue: "podman", parent: true, method: null, why: "podman-rootful-remote" });
	// Docker Desktop: the cgroupfs driver, read from a mac.
	assert.deepEqual(plan("local", { cgroupDriver: "cgroupfs", cgroupVersion: "v2", rootless: false }, { platform: "darwin" }), { venue: "local", parent: true, method: "helper", why: null });
	// A systemd host's Docker, or rootful Podman's Docker API: read-only, and only where the daemon is this host.
	assert.deepEqual(plan("local", { cgroupDriver: "systemd", cgroupVersion: "v2" }, { endpointLocal: true }), { venue: "local", parent: true, method: "system-systemd", why: null });
	assert.deepEqual(plan("local", { cgroupDriver: "systemd", cgroupVersion: "v2" }, { endpointLocal: false }), { venue: "local", parent: true, method: null, why: "remote-daemon" });
	assert.deepEqual(plan("local", { cgroupDriver: "systemd", cgroupVersion: "v2" }, { endpointLocal: true, platform: "darwin" }), { venue: "local", parent: true, method: null, why: "remote-daemon" });
	assert.deepEqual(plan("local", { cgroupDriver: "cgroupfs", cgroupVersion: "v1" }), { venue: "local", parent: true, method: null, why: "cgroup-v1" });
	assert.deepEqual(plan("local", { cgroupDriver: "systemd", cgroupVersion: "v2", rootless: true }, { endpointLocal: true }), { venue: "local", parent: true, method: null, why: "rootless-docker" });
	assert.deepEqual(plan("local", { cgroupDriver: null, cgroupVersion: "v2" }), { venue: "local", parent: true, method: null, why: "driver-unknown" });
	assert.deepEqual(plan("local", null), { venue: "local", parent: true, method: null, why: "driver-unknown" });
});

test("stepFailure names every way a command fails, from both runner shapes, and nothing for a clean exit", () => {
	assert.equal(stepFailure({ code: null, error: { timedOut: true } }, "docker"), "timeout");
	assert.equal(stepFailure({ code: null, error: { killed: true } }, "docker"), "timeout");
	assert.equal(stepFailure({ code: null, ended: "timeout" }, "systemctl"), "timeout");
	assert.equal(stepFailure({ code: null, ended: "error" }, "systemctl"), "spawn-failed");
	assert.equal(stepFailure({ code: null, error: { code: "ENOENT" } }, "systemctl"), "systemctl-not-found");
	assert.equal(stepFailure({ code: null, error: { code: "EAGAIN" } }, "docker"), "spawn-eagain");
	assert.equal(stepFailure({ code: 1, stdout: "" }, "systemctl"), "exit-1");
	assert.equal(stepFailure({ code: null, error: new Error("x") }, "docker"), "spawn-failed");
	assert.equal(stepFailure({ code: 0, stdout: "3s" }, "systemctl"), null);
	assert.equal(stepFailure({ code: 0, stdout: "", ended: "close" }, "systemctl"), null);
});

// ---------------------------------------------------------------------------------------------------------------------
// Reads and writes, through a fake runner.

const USER = { venue: "podman", parent: true, method: "user-systemd", why: null };
const HELPER = { venue: "local", parent: true, method: "helper", why: null };
const SYSTEM = { venue: "local", parent: true, method: "system-systemd", why: null };

/** A runner that answers from a queue of results and records every call. */
function fakeRun(answers) {
	const calls = [];
	const run = async (bin, args, opts) => {
		calls.push({ bin, args, timeoutMs: opts?.timeoutMs });
		const next = answers.shift();
		if (typeof next === "function") return next(bin, args);
		return next ?? { code: 0, stdout: "" };
	};
	return { run, calls };
}

test("readQuota asks the user manager, the system manager or the helper, bounded, and names what failed", async () => {
	let f = fakeRun([{ code: 0, stdout: "3s\n" }]);
	assert.deepEqual(await readQuota(USER, { run: f.run, image: "i" }), { ok: true, cpuCenti: 300 });
	assert.deepEqual(f.calls, [{ bin: "systemctl", args: ["--user", "show", "-P", "CPUQuotaPerSecUSec", "pidispatch.slice"], timeoutMs: 15_000 }]);
	f = fakeRun([{ code: 0, stdout: "infinity\n" }]);
	assert.deepEqual(await readQuota(SYSTEM, { run: f.run, image: "i" }), { ok: true, cpuCenti: null });
	assert.deepEqual(f.calls[0].args, ["show", "-P", "CPUQuotaPerSecUSec", "pidispatch.slice"]);
	f = fakeRun([{ code: 0, stdout: "1300000 100000\n" }]);
	assert.deepEqual(await readQuota(HELPER, { run: f.run, image: "pi-job:pinned" }), { ok: true, cpuCenti: 1300 });
	assert.deepEqual(f.calls, [{ bin: "docker", args: helperArgs({ image: "pi-job:pinned", read: true }), timeoutMs: 15_000 }]);
	f = fakeRun([{ code: null, error: { timedOut: true } }]);
	assert.deepEqual(await readQuota(HELPER, { run: f.run, image: "i" }), { ok: false, reason: "timeout" });
	f = fakeRun([{ code: 0, stdout: "what" }]);
	assert.deepEqual(await readQuota(USER, { run: f.run, image: "i" }), { ok: false, reason: "unparseable" });
	f = fakeRun([() => Promise.reject(Object.assign(new Error("x"), { code: "ENOENT" }))]);
	assert.deepEqual(await readQuota(USER, { run: f.run, image: "i" }), { ok: false, reason: "systemctl-not-found" });
	f = fakeRun([]);
	assert.deepEqual(await readQuota({ venue: "local", parent: true, method: null, why: "remote-daemon" }, { run: f.run, image: "i" }), { ok: false, reason: "remote-daemon" });
	assert.equal(f.calls.length, 0);
});

test("writeQuota sets the user manager's property or runs the helper, and never writes where only root may", async () => {
	let f = fakeRun([{ code: 0, stdout: "" }]);
	assert.deepEqual(await writeQuota(USER, 300, { run: f.run, image: "i" }), { ok: true });
	assert.deepEqual(f.calls, [{ bin: "systemctl", args: ["--user", "set-property", "pidispatch.slice", "CPUQuota=300%"], timeoutMs: 15_000 }]);
	f = fakeRun([{ code: 0 }]);
	assert.deepEqual(await writeQuota(HELPER, 1300, { run: f.run, image: "pi-job:pinned" }), { ok: true });
	assert.deepEqual(f.calls, [{ bin: "docker", args: helperArgs({ image: "pi-job:pinned", cpuCenti: 1300 }), timeoutMs: 15_000 }]);
	f = fakeRun([{ code: 1 }]);
	assert.deepEqual(await writeQuota(USER, 300, { run: f.run, image: "i" }), { ok: false, reason: "exit-1" });
	f = fakeRun([]);
	assert.deepEqual(await writeQuota(SYSTEM, 300, { run: f.run, image: "i" }), { ok: false, reason: "needs-root" });
	assert.deepEqual(await writeQuota({ venue: "local", parent: true, method: null, why: "cgroup-v1" }, 300, { run: f.run, image: "i" }), { ok: false, reason: "cgroup-v1" });
	assert.equal(f.calls.length, 0, "nothing runs where nothing may be written");
});

// ---------------------------------------------------------------------------------------------------------------------
// The reserve.

function clock(start = 1_000_000) {
	let t = start;
	return { now: () => t, advance: (ms) => (t += ms) };
}

test("sync on rootless Podman: an unset quota is set to the budget and read back as held, logged once", async () => {
	const c = clock();
	const logs = [];
	const f = fakeRun([{ code: 0, stdout: "infinity" }, { code: 0 }, { code: 0, stdout: "3s" }, { code: 0, stdout: "3s" }]);
	const reserve = makeCpuReserve({ run: f.run, image: "i", now: c.now, log: (e, x) => logs.push([e, x]) });
	assert.equal(await reserve.sync({ cpuCenti: 300, plans: [USER] }), true);
	assert.deepEqual(f.calls.map((x) => [x.bin, ...x.args]), [
		["systemctl", "--user", "show", "-P", "CPUQuotaPerSecUSec", "pidispatch.slice"],
		["systemctl", "--user", "set-property", "pidispatch.slice", "CPUQuota=300%"],
		["systemctl", "--user", "show", "-P", "CPUQuotaPerSecUSec", "pidispatch.slice"],
	]);
	assert.equal(reserve.states()[0].status, "held");
	assert.equal(reserve.states()[0].quotaCenti, 300);
	assert.deepEqual(logs, [["cpu_reserve", { venue: "podman", method: "user-systemd", status: "held", wantCenti: 300, quotaCenti: 300, reason: "" }]]);
	// Inside the re-check window nothing runs; past it the quota is READ again, and a held one is not rewritten.
	await reserve.sync({ cpuCenti: 300, plans: [USER] });
	assert.equal(f.calls.length, 3);
	c.advance(RESERVE_RECHECK_MS - 1);
	await reserve.sync({ cpuCenti: 300, plans: [USER] });
	assert.equal(f.calls.length, 3);
	c.advance(1);
	f.calls.length = 0;
	await reserve.sync({ cpuCenti: 300, plans: [USER] });
	assert.deepEqual(f.calls.map((x) => x.args[1]), ["show"]);
	assert.equal(logs.length, 1, "an unchanged state is not logged again");
});

test("sync: a changed budget is re-applied at once, whatever the clock", async () => {
	const c = clock();
	const f = fakeRun([{ code: 0, stdout: "3s" }, { code: 0, stdout: "3s" }, { code: 0 }, { code: 0, stdout: "2s 500ms" }]);
	const reserve = makeCpuReserve({ run: f.run, image: "i", now: c.now });
	await reserve.sync({ cpuCenti: 300, plans: [USER] });
	await reserve.sync({ cpuCenti: 250, plans: [USER] });
	assert.deepEqual(f.calls.map((x) => x.args.at(-1)), ["pidispatch.slice", "pidispatch.slice", "CPUQuota=250%", "pidispatch.slice"]);
	assert.equal(reserve.states()[0].status, "held");
	assert.equal(reserve.states()[0].wantCenti, 250);
});

test("sync on Docker Desktop: the helper writes cpu.max and reads it back; a restart that dropped it is found on the re-check and written again", async () => {
	const c = clock();
	const f = fakeRun([{ code: 0, stdout: "max 100000" }, { code: 0 }, { code: 0, stdout: "1300000 100000" }, { code: 0, stdout: "max 100000" }, { code: 0 }, { code: 0, stdout: "1300000 100000" }]);
	const reserve = makeCpuReserve({ run: f.run, image: "pi-job:pinned", now: c.now });
	await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.deepEqual(f.calls.map((x) => x.args), [helperArgs({ image: "pi-job:pinned", read: true }), helperArgs({ image: "pi-job:pinned", cpuCenti: 1300 }), helperArgs({ image: "pi-job:pinned", read: true })]);
	assert.equal(reserve.states()[0].status, "held");
	c.advance(RESERVE_RECHECK_MS);
	await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.equal(f.calls.length, 6);
	assert.deepEqual(f.calls[4].args, helperArgs({ image: "pi-job:pinned", cpuCenti: 1300 }));
	assert.equal(reserve.states()[0].status, "held");
});

test("sync where only root may set it: read, never written, the state says unset or differs with needs-root, and fails open", async () => {
	const logs = [];
	const f = fakeRun([{ code: 0, stdout: "infinity" }]);
	const reserve = makeCpuReserve({ run: f.run, image: "i", now: () => 0, log: (e, x) => logs.push([e, x]) });
	await reserve.sync({ cpuCenti: 300, plans: [SYSTEM] });
	assert.deepEqual(f.calls.map((x) => [x.bin, ...x.args]), [["systemctl", "show", "-P", "CPUQuotaPerSecUSec", "pidispatch.slice"]]);
	assert.equal(reserve.states()[0].status, "unset");
	assert.equal(reserve.states()[0].reason, "needs-root");
	assert.equal(logs[0][0], "cpu_reserve_fail_open");
	assert.match(logs[0][1].failOpen, /no quota held across them/);
	const g = fakeRun([{ code: 0, stdout: "2s" }]);
	const otherLogs = [];
	const other = makeCpuReserve({ run: g.run, image: "i", now: () => 0, log: (e, x) => otherLogs.push([e, x]) });
	await other.sync({ cpuCenti: 300, plans: [SYSTEM] });
	assert.equal(other.states()[0].status, "differs");
	assert.equal(other.states()[0].quotaCenti, 200);
	// A quota IS held there, the wrong one: never "no quota held".
	assert.equal(otherLogs[0][1].failOpen, "jobs run under the parent held to a quota of 2 CPUs, not the CPU budget of 3: jobs together are capped there, and the reserve kept is not the one configured");
	// The executing review's case: the budget turned off while the operator's quota of 3 CPUs is still set.
	const offLogs = [];
	const off = makeCpuReserve({ run: fakeRun([{ code: 0, stdout: "3s" }]).run, image: "i", now: () => 0, log: (e, x) => offLogs.push([e, x]) });
	await off.sync({ cpuCenti: Infinity, plans: [SYSTEM] });
	assert.deepEqual([off.states()[0].status, off.states()[0].wantCenti, off.states()[0].quotaCenti], ["differs", null, 300]);
	assert.equal(offLogs[0][0], "cpu_reserve_fail_open");
	assert.equal(offLogs[0][1].failOpen, "the CPU budget is off, but the parent still holds a quota of 3 CPUs, so jobs together are still capped to it until it is cleared");
	const h = fakeRun([{ code: 1 }]);
	const third = makeCpuReserve({ run: h.run, image: "i", now: () => 0 });
	await third.sync({ cpuCenti: 300, plans: [SYSTEM] });
	assert.equal(third.states()[0].status, "unreadable");
	assert.equal(third.states()[0].reason, "exit-1");
});

test("sync: a failed write is named, retried after a minute and not before", async () => {
	const c = clock();
	const logs = [];
	const f = fakeRun([{ code: 0, stdout: "infinity" }, { code: 1 }, { code: 0, stdout: "infinity" }]);
	const reserve = makeCpuReserve({ run: f.run, image: "i", now: c.now, log: (e, x) => logs.push([e, x]) });
	await reserve.sync({ cpuCenti: 300, plans: [USER] });
	assert.equal(reserve.states()[0].status, "unset");
	assert.equal(reserve.states()[0].reason, "write-exit-1");
	assert.equal(logs[0][0], "cpu_reserve_fail_open");
	c.advance(RESERVE_RETRY_MS - 1);
	await reserve.sync({ cpuCenti: 300, plans: [USER] });
	assert.equal(f.calls.length, 3);
	c.advance(1);
	await reserve.sync({ cpuCenti: 300, plans: [USER] });
	assert.equal(f.calls.length, 6, "read, write, read again");
	// A read-back that fails after a write that worked names the read.
	const g = fakeRun([{ code: 0, stdout: "infinity" }, { code: 0 }, { code: null, error: { timedOut: true } }]);
	const other = makeCpuReserve({ run: g.run, image: "i", now: c.now });
	await other.sync({ cpuCenti: 300, plans: [USER] });
	assert.equal(other.states()[0].status, "unreadable");
	assert.equal(other.states()[0].reason, "read-timeout");
	// A write that "worked" but did not take is said as such.
	const h = fakeRun([{ code: 0, stdout: "infinity" }, { code: 0 }, { code: 0, stdout: "2s" }]);
	const third = makeCpuReserve({ run: h.run, image: "i", now: c.now });
	await third.sync({ cpuCenti: 300, plans: [USER] });
	assert.equal(third.states()[0].status, "differs");
	assert.equal(third.states()[0].reason, "not-applied");
});

test("sync with the budget off clears a quota the worker set, so an old drop-in does not keep capping jobs", async () => {
	const f = fakeRun([{ code: 0, stdout: "3s" }, { code: 0 }, { code: 0, stdout: "infinity" }]);
	const reserve = makeCpuReserve({ run: f.run, image: "i", now: () => 0 });
	await reserve.sync({ cpuCenti: Infinity, plans: [USER] });
	assert.deepEqual(f.calls[1].args, ["--user", "set-property", "pidispatch.slice", "CPUQuota="]);
	assert.equal(reserve.states()[0].status, "held");
	assert.equal(reserve.states()[0].wantCenti, null);
	// Already none: nothing written.
	const g = fakeRun([{ code: 0, stdout: "max 100000" }]);
	const other = makeCpuReserve({ run: g.run, image: "i", now: () => 0 });
	await other.sync({ cpuCenti: Infinity, plans: [HELPER] });
	assert.equal(g.calls.length, 1);
	assert.equal(other.states()[0].status, "held");
});

test("sync: an unknown budget, a venue without the parent and a venue without a method run nothing and fail open with their reason", async () => {
	const logs = [];
	const f = fakeRun([]);
	const reserve = makeCpuReserve({ run: f.run, image: "i", now: () => 0, log: (e, x) => logs.push([e, x]) });
	await reserve.sync({ cpuCenti: null, plans: [USER] });
	assert.equal(reserve.states()[0].status, "budget-unknown");
	await reserve.sync({ cpuCenti: 300, plans: [{ venue: "podman", parent: false, method: null, why: "podman-cgroupfs" }, { venue: "local", parent: true, method: null, why: "remote-daemon" }] });
	assert.equal(f.calls.length, 0);
	const byVenue = Object.fromEntries(reserve.states().map((s) => [s.venue, s]));
	assert.equal(byVenue.podman.status, "no-parent");
	assert.equal(byVenue.podman.reason, "podman-cgroupfs");
	assert.equal(byVenue.local.status, "unmanaged");
	assert.equal(byVenue.local.reason, "remote-daemon");
	assert.ok(logs.every(([e]) => e === "cpu_reserve_fail_open"));
	assert.match(logs.find(([, x]) => x.status === "no-parent")[1].failOpen, /capped at 1024: a fair share for the proxy and Valkey, not a reserve/);
});

test("sync: one at a time (a sync asked for while one runs is dropped), and a runner that throws is recorded, never thrown", async () => {
	let release;
	const gate = new Promise((r) => (release = r));
	const f = fakeRun([() => gate.then(() => ({ code: 0, stdout: "3s" }))]);
	const reserve = makeCpuReserve({ run: f.run, image: "i", now: () => 0 });
	const first = reserve.sync({ cpuCenti: 300, plans: [USER] });
	assert.equal(await reserve.sync({ cpuCenti: 300, plans: [USER] }), false);
	release();
	assert.equal(await first, true);
	assert.equal(f.calls.length, 1);
	const thrower = makeCpuReserve({
		run: () => {
			throw Object.assign(new Error("boom"), { code: "EMFILE" });
		},
		image: "i",
		now: () => 0,
	});
	assert.equal(await thrower.sync({ cpuCenti: 300, plans: [USER] }), true);
	// A synchronous throw out of `run` happens before the promise exists, so it reaches the per-plan catch.
	assert.equal(thrower.states()[0].status, "unreadable");
	assert.equal(thrower.states()[0].reason, "threw-emfile");
});
