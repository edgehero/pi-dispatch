import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CGROUP_PARENT,
	HELPER_LABEL_KEY,
	HELPER_PARENT_PATH,
	LEGACY_HELPER_CHUNK,
	LEGACY_HELPER_MIN_AGE_MS,
	LEGACY_LIST_ARGS,
	PARENTLESS_SHARES_MAX,
	QUOTA_PERIOD_US,
	RESERVE_RECHECK_MS,
	RESERVE_RETRY_MS,
	RESERVE_STEP_TIMEOUT_MS,
	cgroupParentFor,
	cpuMaxLine,
	cpuQuotaProperty,
	guardHelperRun,
	helperArgs,
	helperName,
	isLegacyHelper,
	makeCpuReserve,
	operatorQuotaCommand,
	parseCpuMaxRead,
	parseQuotaPerSec,
	readQuota,
	removeLegacyHelpers,
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
	// Issue #978: the helper's label, and how old and how many leftovers an older worker's are taken.
	assert.equal(HELPER_LABEL_KEY, "pi.dispatch.helper");
	assert.equal(LEGACY_HELPER_MIN_AGE_MS, 600_000);
	assert.equal(LEGACY_HELPER_CHUNK, 20);
});

test("issue #978: one fixed helper name per role, from the sha256 of the declared worker name, within Docker's name rule", () => {
	// sha256("") begins e3b0c442, sha256("box-1") begins 96fb257c: literals, so a change in the hash or its cut shows.
	assert.equal(helperName(), "pi-dispatch-cpu-reserve-e3b0c442");
	assert.equal(helperName(""), "pi-dispatch-cpu-reserve-e3b0c442");
	assert.equal(helperName("", { doctor: true }), "pi-dispatch-cpu-reserve-doctor-e3b0c442");
	assert.equal(helperName("box-1"), "pi-dispatch-cpu-reserve-96fb257c");
	assert.equal(helperName("box-1", { doctor: true }), "pi-dispatch-cpu-reserve-doctor-96fb257c");
	assert.notEqual(helperName("box-2"), helperName("box-1"), "two named workers on one daemon never share it");
	for (const name of ["", "box-1", "a".repeat(64)]) for (const doctor of [false, true]) assert.match(helperName(name, { doctor }), /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/);
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
	const name = "pi-dispatch-cpu-reserve-e3b0c442";
	assert.deepEqual(helperArgs({ image: "pi-job:pinned", name, cpuCenti: 1300 }), [
		"run",
		"--rm",
		"--name",
		"pi-dispatch-cpu-reserve-e3b0c442",
		"--label",
		"pi.dispatch.helper=cpu-reserve",
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
	assert.deepEqual(helperArgs({ image: "pi-job:pinned", name, cpuCenti: null }).slice(-2), ["-c", 'echo "max 100000" > /p/cpu.max']);
	// The read mounts read-only and runs `cat`, no shell, under the same name and label.
	const read = helperArgs({ image: "pi-job:pinned", name, read: true });
	assert.deepEqual(read.slice(0, 6), ["run", "--rm", "--name", "pi-dispatch-cpu-reserve-e3b0c442", "--label", "pi.dispatch.helper=cpu-reserve"]);
	assert.deepEqual(read.slice(14), ["-v", "/sys/fs/cgroup/pidispatch.slice:/p:ro", "--entrypoint", "cat", "pi-job:pinned", "/p/cpu.max"]);
	for (const args of [helperArgs({ image: "i", name, cpuCenti: 5 }), read]) {
		const mounts = args.filter((_, i) => args[i - 1] === "-v");
		assert.equal(mounts.length, 1);
		assert.ok(mounts[0].startsWith("/sys/fs/cgroup/pidispatch.slice:"), mounts[0]);
	}
	for (const image of ["", "-v", "--privileged", null, 1]) assert.throws(() => helperArgs({ image, name, cpuCenti: 300 }), /refusing a helper image/, String(image));
	for (const cpuCenti of [0, -1, 1.5, "300", undefined, Infinity]) assert.throws(() => helperArgs({ image: "i", name, cpuCenti }), /refusing a quota/, String(cpuCenti));
	// A helper never runs unnamed (an unnamed one is what piled up, issue #978), nor under a name Docker would refuse.
	for (const bad of [undefined, "", "-rm", "a b", "/x", "x"]) assert.throws(() => helperArgs({ image: "i", name: bad, read: true }), /refusing a helper name/, String(bad));
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

test("reservePlan: a venue other than local and podman keeps no quota here, by name, and runs nothing (#681)", async () => {
	// It used to fall through to docker's rules, so a third venue on a cgroupfs-shaped answer was handed docker's helper.
	const p = reservePlan({ venue: "far", facts: { cgroupDriver: "cgroupfs", cgroupVersion: "v2" }, endpointLocal: true, platform: "linux" });
	assert.deepEqual(p, { venue: "far", parent: false, method: null, why: "venue-unmanaged" });
	const ran = [];
	const run = async (...args) => (ran.push(args), { code: 0, stdout: "" });
	assert.deepEqual(await readQuota(p, { run, image: "i" }), { ok: false, reason: "venue-unmanaged" });
	assert.deepEqual(ran, [], "no runtime command for a venue this does not plan");
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
const NAME = "pi-dispatch-cpu-reserve-e3b0c442";

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
	assert.deepEqual(await readQuota(HELPER, { run: f.run, image: "pi-job:pinned", name: NAME }), { ok: true, cpuCenti: 1300 });
	assert.deepEqual(f.calls, [{ bin: "docker", args: helperArgs({ image: "pi-job:pinned", name: NAME, read: true }), timeoutMs: 15_000 }]);
	f = fakeRun([{ code: null, error: { timedOut: true } }]);
	assert.deepEqual(await readQuota(HELPER, { run: f.run, image: "i", name: NAME }), { ok: false, reason: "timeout" });
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
	assert.deepEqual(await writeQuota(HELPER, 1300, { run: f.run, image: "pi-job:pinned", name: NAME }), { ok: true });
	assert.deepEqual(f.calls, [{ bin: "docker", args: helperArgs({ image: "pi-job:pinned", name: NAME, cpuCenti: 1300 }), timeoutMs: 15_000 }]);
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
	// The first helper in a process removes its name first (what the last process may have left), and the first read that
	// holds lists an older worker's leftovers once (issue #978); the re-check does neither.
	const f = fakeRun([{ code: 0 }, { code: 0, stdout: "max 100000" }, { code: 0 }, { code: 0, stdout: "1300000 100000" }, { code: 0, stdout: "" }, { code: 0, stdout: "max 100000" }, { code: 0 }, { code: 0, stdout: "1300000 100000" }]);
	const reserve = makeCpuReserve({ run: f.run, image: "pi-job:pinned", name: NAME, now: c.now });
	await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.deepEqual(f.calls.map((x) => x.args), [["rm", "-f", NAME], helperArgs({ image: "pi-job:pinned", name: NAME, read: true }), helperArgs({ image: "pi-job:pinned", name: NAME, cpuCenti: 1300 }), helperArgs({ image: "pi-job:pinned", name: NAME, read: true }), [...LEGACY_LIST_ARGS]]);
	assert.equal(reserve.states()[0].status, "held");
	c.advance(RESERVE_RECHECK_MS);
	await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.equal(f.calls.length, 8);
	assert.deepEqual(f.calls[6].args, helperArgs({ image: "pi-job:pinned", name: NAME, cpuCenti: 1300 }));
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
	const g = fakeRun([{ code: 0 }, { code: 0, stdout: "max 100000" }, { code: 0, stdout: "" }]);
	const other = makeCpuReserve({ run: g.run, image: "i", name: NAME, now: () => 0 });
	await other.sync({ cpuCenti: Infinity, plans: [HELPER] });
	assert.deepEqual(g.calls.map((x) => x.args[0]), ["rm", "run", "ps"], "the name cleared, one read, the leftover listing: no write");
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

// ---------------------------------------------------------------------------------------------------------------------
// Issue #978: a daemon too slow to start the helper. Each helper is a `docker run --rm`, whose AutoRemove fires only on
// exit, so a CLI killed between create and start leaves a `created` container behind.

/**
 * A fake Docker daemon for the helper: containers by name, where `run --name` of a taken name fails at once with 125
 * and makes nothing, and `rm -f` deletes. `slow(args)` says how a call ends: `ok`; `timeout` (the CLI killed at its
 * bound after the create, the container left in `created`, and a write that still applies); `late` (killed before its
 * create landed, which lands right after the next `rm -f`); `fail` (exit 1, nothing made). The quota is the VM's.
 */
function fakeDaemon({ clock: c, quota = "max 100000", slow = () => "ok" } = {}) {
	const containers = new Map();
	const calls = [];
	const state = { quota, most: 0, late: null, anonymous: 0 };
	const counted = () => (state.most = Math.max(state.most, containers.size));
	const killed = () => {
		c.advance(RESERVE_STEP_TIMEOUT_MS);
		return { code: null, stdout: "", error: { timedOut: true } };
	};
	const run = async (bin, args) => {
		calls.push({ at: c.now(), args: [...args] });
		const how = slow(args);
		if (args[0] === "rm" && args[1] === "-f") {
			if (how === "timeout") return killed();
			containers.delete(args[2]);
			if (state.late) containers.set(state.late, "created"), counted(), (state.late = null);
			return { code: 0, stdout: `${args[2]}\n` };
		}
		if (args[0] !== "run") return { code: 0, stdout: "" };
		const at = args.indexOf("--name");
		const name = at === -1 ? `anonymous-${state.anonymous++}` : args[at + 1];
		if (containers.has(name)) return { code: 125, stdout: "" };
		if (how === "fail") return { code: 1, stdout: "" };
		if (how === "late") return (state.late = name), killed();
		containers.set(name, "created");
		counted();
		const write = /^echo "(.*)" > \/p\/cpu\.max$/.exec(args.at(-1));
		if (write) state.quota = write[1];
		if (how === "timeout") return killed();
		containers.delete(name);
		return { code: 0, stdout: write ? "" : `${state.quota}\n` };
	};
	return { run, calls, containers, state };
}

const kinds = (calls) => calls.map((x) => (x.args[0] === "run" ? (x.args.includes("cat") ? "read" : "write") : x.args.slice(0, 2).join(" ")));

test("issue #978: across hours of timed-out helper steps the daemon never holds more than one helper container, and the reserve holds once it answers again", async () => {
	for (const shape of ["timeout", "late"]) {
		const c = clock();
		let slow = true;
		let n = 0;
		// Every helper is killed at its bound; in the second shape every other create lands after the rm that followed it.
		const d = fakeDaemon({ clock: c, slow: (args) => (slow && args[0] === "run" ? (shape === "late" && n++ % 2 ? "late" : "timeout") : "ok") });
		const name = helperName("box-1");
		const reserve = makeCpuReserve({ run: d.run, image: "pi-job:pinned", name, now: c.now });
		const end = c.now() + 6 * 3_600_000;
		while (c.now() < end) {
			await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
			assert.ok(d.containers.size <= 1, `${shape}: ${d.containers.size} helper containers at ${c.now()}`);
			c.advance(1_000);
		}
		const helpers = d.calls.filter((x) => x.args[0] === "run");
		assert.ok(helpers.length > 30, `${shape}: ${helpers.length} helpers in six hours`);
		assert.ok(helpers.every((x) => x.args[x.args.indexOf("--name") + 1] === name), `${shape}: every helper under the one name`);
		assert.equal(d.state.most, 1, `${shape}: never more than one container at once`);
		// The daemon answers again: the next attempt clears the name, reads, writes, reads back, and nothing is left.
		slow = false;
		c.advance(RESERVE_RECHECK_MS);
		await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
		assert.equal(reserve.states()[0].status, "held", shape);
		assert.equal(d.containers.size, 0, shape);
	}
});

test("issue #978: the first helper in a process removes its name first, a step that did not end cleanly makes the next one do so again, and a clean run does no rm", async () => {
	const f = fakeRun([{ code: 0 }, { code: 1, stdout: "" }, { code: 0 }, { code: 0 }, { code: 0, stdout: "1300000 100000" }, { code: 0, stdout: "" }, { code: 0, stdout: "1300000 100000" }]);
	const c = clock();
	const reserve = makeCpuReserve({ run: f.run, image: "i", name: NAME, now: c.now });
	await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	// The read exits 1 (it ran, or its create was refused): the write is preceded by an rm; the clean write is not.
	assert.deepEqual(kinds(f.calls), ["rm -f", "read", "rm -f", "write", "read", "ps -a"]);
	assert.ok(f.calls.filter((x) => x.args[0] === "rm").every((x) => x.args[2] === NAME && x.timeoutMs === 15_000), "the name, bounded like a step");
	assert.equal(reserve.states()[0].status, "held");
	c.advance(RESERVE_RECHECK_MS);
	await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.deepEqual(kinds(f.calls).slice(6), ["read"], "after clean steps the re-check runs the helper alone");
	// An rm that fails without timing out does not hold the helper back: a name still taken fails the create at once.
	const g = fakeRun([{ code: 1 }, { code: 0, stdout: "1300000 100000" }, { code: 0, stdout: "" }]);
	const other = makeCpuReserve({ run: g.run, image: "i", name: NAME, now: c.now });
	await other.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.deepEqual(kinds(g.calls), ["rm -f", "read", "ps -a"]);
	assert.equal(other.states()[0].status, "held");
});

test("issue #978: an rm before a helper that times out runs no helper: unreadable, cleanup-timeout, and the venue backs off", async () => {
	const c = clock();
	const logs = [];
	const d = fakeDaemon({ clock: c, slow: (args) => (args[0] === "rm" ? "timeout" : "ok") });
	const reserve = makeCpuReserve({ run: d.run, image: "i", name: NAME, now: c.now, log: (e, x) => logs.push([e, x]) });
	await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.deepEqual(kinds(d.calls), ["rm -f"]);
	assert.deepEqual([reserve.states()[0].status, reserve.states()[0].reason, reserve.states()[0].retryMs], ["unreadable", "cleanup-timeout", 60_000]);
	assert.deepEqual(logs.at(-1), ["cpu_reserve_fail_open", { venue: "local", method: "helper", status: "unreadable", wantCenti: 1300, quotaCenti: "unread", reason: "cleanup-timeout", retryMs: 60_000, failOpen: "jobs run under the parent with no quota held across them: the proxy and Valkey are not starved, the host's CPU reserve is not kept" }]);
	c.advance(60_000);
	await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.deepEqual(kinds(d.calls), ["rm -f", "rm -f"]);
	assert.equal(reserve.states()[0].retryMs, 120_000);
});

test("issue #978: an attempt stops at its first timeout: no write after a timed-out read, no read back after a timed-out write, and a timed-out write is never differs", async () => {
	const c = clock();
	// A read that times out: the name removed at once, nothing written.
	let d = fakeDaemon({ clock: c, slow: (args) => (args[0] === "run" ? "timeout" : "ok") });
	let reserve = makeCpuReserve({ run: d.run, image: "i", name: NAME, now: c.now });
	await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.deepEqual(kinds(d.calls), ["rm -f", "read", "rm -f"]);
	assert.deepEqual([reserve.states()[0].status, reserve.states()[0].reason], ["unreadable", "read-timeout"]);
	// A write that times out AND applies (the issue's alternation): no read back, unreadable with write-timeout.
	d = fakeDaemon({ clock: c, slow: (args) => (args[0] === "run" && args.includes("sh") ? "timeout" : "ok") });
	reserve = makeCpuReserve({ run: d.run, image: "i", name: NAME, now: c.now });
	await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.deepEqual(kinds(d.calls), ["rm -f", "read", "write", "rm -f"]);
	assert.equal(d.state.quota, "1300000 100000", "the write applied");
	const s = reserve.states()[0];
	assert.deepEqual([s.status, s.reason, s.quotaCenti], ["unreadable", "write-timeout", undefined]);
	assert.notEqual(s.status, "differs");
	// The next attempt starts with a read, which finds the write that applied.
	c.advance(60_000);
	await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.deepEqual(kinds(d.calls).slice(4), ["rm -f", "read", "ps -a"]);
	assert.equal(reserve.states()[0].status, "held");
	// A write refused at once (its name still taken) whose read back shows the wanted quota: held, never differs at the
	// very quota wanted.
	const g = fakeRun([{ code: 0 }, { code: 0, stdout: "max 100000" }, { code: 125 }, { code: 0 }, { code: 0, stdout: "1300000 100000" }, { code: 0, stdout: "" }]);
	const refused = makeCpuReserve({ run: g.run, image: "i", name: NAME, now: c.now });
	await refused.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.deepEqual(kinds(g.calls), ["rm -f", "read", "write", "rm -f", "read", "ps -a"]);
	assert.deepEqual([refused.states()[0].status, refused.states()[0].quotaCenti], ["held", 1300]);
	// The same on a systemctl venue: a write that timed out is not read back.
	const f = fakeRun([{ code: 0, stdout: "infinity" }, { code: null, error: { timedOut: true } }]);
	const user = makeCpuReserve({ run: f.run, image: "i", name: NAME, now: c.now });
	await user.sync({ cpuCenti: 300, plans: [USER] });
	assert.deepEqual(f.calls.map((x) => x.args[1]), ["show", "set-property"]);
	assert.deepEqual([user.states()[0].status, user.states()[0].reason], ["unreadable", "write-timeout"]);
});

test("issue #978: only timeouts back off, 60, 120, 240, 480, then 600 s, logged; a held read resets it, and any other failure keeps the minute", async () => {
	const c = clock();
	const logs = [];
	let mode = "timeout";
	const d = fakeDaemon({ clock: c, slow: (args) => (args[0] === "run" ? mode : "ok") });
	const reserve = makeCpuReserve({ run: d.run, image: "i", name: NAME, now: c.now, log: (e, x) => logs.push([e, x]) });
	const tick = async (ms) => {
		for (const end = c.now() + ms; c.now() < end; c.advance(1_000)) await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	};
	const reads = () => d.calls.filter((x) => kinds([x])[0] === "read").map((x) => x.at);
	const gaps = (at) => at.slice(1).map((t, i) => (t - at[i]) / 1_000);
	await tick(50 * 60_000);
	// Read to read: the step's own 15 s, then the wait.
	assert.deepEqual(gaps(reads()).slice(0, 6), [75, 135, 255, 495, 615, 615]);
	assert.deepEqual(logs.filter(([e]) => e === "cpu_reserve_fail_open").map(([, x]) => x.retryMs), [60_000, 120_000, 240_000, 480_000, 600_000], "a line per step of the schedule, then quiet at the cap");
	// The daemon answers: the next attempt holds and clears the backoff; a later timeout starts again at a minute.
	mode = "ok";
	await tick(11 * 60_000);
	assert.equal(reserve.states()[0].status, "held");
	assert.equal(reserve.states()[0].retryMs, undefined);
	mode = "timeout";
	while (reserve.states()[0].status === "held") await tick(1_000);
	assert.deepEqual([reserve.states()[0].reason, reserve.states()[0].retryMs], ["read-timeout", 60_000]);
	// Failures that answer (exit 1) are retried every minute, however many there are.
	const e = fakeDaemon({ clock: c, slow: (args) => (args[0] === "run" ? "fail" : "ok") });
	const answering = makeCpuReserve({ run: e.run, image: "i", name: NAME, now: c.now });
	const starts = [];
	for (const end = c.now() + 4 * 60_000; c.now() <= end; c.advance(1_000)) {
		const before = e.calls.length;
		await answering.sync({ cpuCenti: 1300, plans: [HELPER] });
		if (e.calls.length > before) starts.push(c.now());
	}
	assert.deepEqual(gaps(starts), [60, 60, 60, 60]);
	assert.deepEqual([answering.states()[0].status, answering.states()[0].reason, answering.states()[0].retryMs], ["unreadable", "write-exit-1", undefined]);
});

test("guardHelperRun: a helper that throws marks the name dirty and is answered, never thrown", async () => {
	const calls = [];
	const run = async (bin, args) => {
		calls.push(args.slice(0, 2).join(" "));
		if (args[0] === "run") throw Object.assign(new Error("x"), { code: "EMFILE" });
		return { code: 0, stdout: "" };
	};
	const guarded = guardHelperRun({ run, name: NAME });
	const first = await guarded("docker", ["run", "--rm"], { timeoutMs: 1 });
	assert.equal(stepFailure(first, "docker"), "spawn-emfile");
	await guarded("docker", ["run", "--rm"], { timeoutMs: 1 });
	assert.deepEqual(calls, ["rm -f", "run --rm", "rm -f", "run --rm"]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Issue #978: the unnamed helpers an older worker left, removed once by exact fingerprint.

const NOW = 1_800_000_000_000;
const OLD_IMAGE = `sha256:${"a".repeat(64)}`;
const OLD_IMAGE_LABELS = { "dev.pi-dispatch.pi-version": "1.4.0", "org.opencontainers.image.version": "5.4.2" };
const id = (n) => n.toString(16).padStart(64, "0");

/** One container as the inspect template prints it: by default exactly what an older worker's read helper made. */
function leftover(n, over = {}) {
	return { id: id(n), image: OLD_IMAGE, created: new Date(NOW - 2 * 3_600_000).toISOString(), state: "created", entrypoint: ["cat"], cmd: ["/p/cpu.max"], user: "0:0", labels: { ...OLD_IMAGE_LABELS }, parent: "pidispatch.slice", binds: ["/sys/fs/cgroup/pidispatch.slice:/p:ro"], mounts: null, autoRemove: true, network: "none", readOnly: true, ...over };
}

/**
 * A fake daemon for the leftover pass: `ps` lists the `created` rows with their helper label and quoted command,
 * `container inspect` prints the found ones (exit 1 when one is gone), `image inspect` the image's labels, and a plain
 * `rm` removes what is not running (`startsAt`: a row that started between the inspect and the rm) and prints its id.
 */
function fakeLeftovers(rows, { images = { [OLD_IMAGE]: OLD_IMAGE_LABELS }, slow = () => "ok", quota = "1300000 100000" } = {}) {
	const live = new Map(rows.map((r) => [r.id, { ...r }]));
	const calls = [];
	const run = async (bin, args, opts) => {
		calls.push({ args: [...args], opts });
		if (slow(args) === "timeout") return { code: null, stdout: "", error: { timedOut: true } };
		if (args[0] === "ps") {
			const quoted = (r) => JSON.stringify([...(r.entrypoint ?? []), ...(r.cmd ?? []).map((a) => (a.includes(" ") ? `'${a}'` : a))].join(" "));
			return { code: 0, stdout: [...live.values()].filter((r) => r.state === "created" || r.listedCreated).map((r) => `${r.id}\t${r.labels?.["pi.dispatch.helper"] ?? ""}\t${quoted(r)}`).join("\n") };
		}
		if (args[0] === "container" && args[1] === "inspect") {
			const ids = args.slice(4);
			const found = ids.filter((x) => live.has(x)).map((x) => {
				const { listedCreated, startsAt, ...row } = live.get(x);
				return JSON.stringify(row);
			});
			return { code: found.length === ids.length ? 0 : 1, stdout: found.join("\n") };
		}
		if (args[0] === "image" && args[1] === "inspect") return Object.hasOwn(images, args[4]) ? { code: 0, stdout: `${JSON.stringify(images[args[4]])}\n` } : { code: 1, stdout: "" };
		if (args[0] === "rm" && args[1] !== "-f") {
			const gone = args.slice(1).filter((x) => live.has(x) && !live.get(x).startsAt);
			for (const x of gone) live.delete(x);
			return { code: gone.length === args.length - 1 ? 0 : 1, stdout: gone.map((x) => `${x}\n`).join("") };
		}
		if (args[0] === "rm") return { code: 0, stdout: "" };
		if (args[0] === "run") return quota === null ? { code: 1, stdout: "" } : { code: 0, stdout: `${quota}\n` };
		return { code: 0, stdout: "" };
	};
	return { run, calls, live };
}

test("isLegacyHelper: exactly an older worker's read or write helper, never started, ten minutes old, with no label beyond its image's", () => {
	const at = { imageLabels: OLD_IMAGE_LABELS, nowMs: NOW };
	assert.equal(isLegacyHelper(leftover(1), at), true, "the read helper");
	assert.equal(isLegacyHelper(leftover(2, { entrypoint: ["sh"], cmd: ["-c", 'echo "1700000 100000" > /p/cpu.max'], binds: ["/sys/fs/cgroup/pidispatch.slice:/p"] }), at), true, "the write helper");
	assert.equal(isLegacyHelper(leftover(3, { entrypoint: ["sh"], cmd: ["-c", 'echo "max 100000" > /p/cpu.max'], binds: ["/sys/fs/cgroup/pidispatch.slice:/p"] }), at), true, "the write that clears it");
	assert.equal(isLegacyHelper(leftover(4, { labels: null }), { imageLabels: null, nowMs: NOW }), true, "an image with no labels");
	assert.equal(isLegacyHelper(leftover(5, { created: new Date(NOW - LEGACY_HELPER_MIN_AGE_MS).toISOString() }), at), true, "ten minutes old exactly");
	const decoys = {
		"labelled helper": { labels: { ...OLD_IMAGE_LABELS, "pi.dispatch.helper": "cpu-reserve" } },
		"a label of its own": { labels: { ...OLD_IMAGE_LABELS, "com.example.keep": "1" } },
		"an image label changed": { labels: { ...OLD_IMAGE_LABELS, "dev.pi-dispatch.pi-version": "9" } },
		"another file": { cmd: ["/p/other"] },
		"two files": { cmd: ["/p/cpu.max", "/etc/hostname"] },
		"another entrypoint": { entrypoint: ["/bin/cat"] },
		"a longer shell": { entrypoint: ["sh"], cmd: ["-c", 'echo "1 100000" > /p/cpu.max; true'], binds: ["/sys/fs/cgroup/pidispatch.slice:/p"] },
		"another mount": { binds: ["/sys/fs/cgroup/other.slice:/p:ro"] },
		"a second bind": { binds: ["/sys/fs/cgroup/pidispatch.slice:/p:ro", "/tmp:/t"] },
		"a --mount": { mounts: [{ Type: "bind", Source: "/tmp", Target: "/t" }] },
		running: { state: "running" },
		exited: { state: "exited" },
		young: { created: new Date(NOW - LEGACY_HELPER_MIN_AGE_MS + 1_000).toISOString() },
		"unparseable created": { created: "soon" },
		"another parent": { parent: "user.slice" },
		"another user": { user: "1000:1000" },
		"not auto-removed": { autoRemove: false },
		"a network": { network: "bridge" },
		"a writable root": { readOnly: false },
	};
	for (const [what, over] of Object.entries(decoys)) assert.equal(isLegacyHelper(leftover(9, over), at), false, what);
	assert.equal(isLegacyHelper(leftover(9), { imageLabels: undefined, nowMs: NOW }), false, "an image whose labels were not read");
});

test("removeLegacyHelpers: removes exactly the fingerprints, with a plain rm in chunks of 20, every call bounded, and leaves the decoys", async () => {
	const helpers = Array.from({ length: 43 }, (_, i) => leftover(100 + i, i % 2 ? { entrypoint: ["sh"], cmd: ["-c", `echo "${1700000 + i} 100000" > /p/cpu.max`], binds: ["/sys/fs/cgroup/pidispatch.slice:/p"] } : {}));
	const decoys = [
		leftover(1, { labels: { ...OLD_IMAGE_LABELS, "pi.dispatch.helper": "cpu-reserve" } }),
		leftover(2, { cmd: ["/p/cpu.max", "/etc/hostname"] }),
		leftover(3, { binds: ["/sys/fs/cgroup/other.slice:/p:ro"] }),
		leftover(4, { state: "running", listedCreated: true }),
		leftover(5, { created: new Date(NOW - 60_000).toISOString() }),
		leftover(6, { image: `sha256:${"b".repeat(64)}` }),
		{ ...leftover(7), entrypoint: ["valkey-server"], cmd: [] },
	];
	const d = fakeLeftovers([...helpers, ...decoys]);
	const out = await removeLegacyHelpers({ run: d.run, now: () => NOW });
	assert.deepEqual(out, { listed: true, removed: 43, failed: 0 });
	assert.deepEqual([...d.live.keys()].sort(), decoys.map((r) => r.id).sort());
	assert.deepEqual(d.calls[0].args, ["ps", "-a", "--filter", "status=created", "--no-trunc", "--format", '{{.ID}}\t{{.Label "pi.dispatch.helper"}}\t{{.Command}}']);
	const rms = d.calls.filter((x) => x.args[0] === "rm");
	assert.deepEqual(rms.map((x) => x.args.length - 1), [20, 20, 3]);
	assert.ok(rms.every((x) => !x.args.includes("-f") && !x.args.includes("--force")), "never a forced rm");
	assert.ok(d.calls.every((x) => x.opts.timeoutMs === 15_000), "every call bounded");
	assert.ok(d.calls.filter((x) => x.args[0] === "ps" || x.args[1] === "inspect" && x.args[0] === "container").every((x) => x.opts.maxBuffer >= 1024 * 1024), "the long outputs get room");
	assert.equal(d.calls.filter((x) => x.args[0] === "image").length, 2, "each image inspected once");
	assert.ok(!d.calls.some((x) => x.args.some((a) => String(a).startsWith("volume="))), "no volume filter");
	// One that starts between the inspect and the rm is refused by the plain rm and counted, never forced.
	const e = fakeLeftovers([leftover(1), leftover(2, { startsAt: true })]);
	assert.deepEqual(await removeLegacyHelpers({ run: e.run, now: () => NOW }), { listed: true, removed: 1, failed: 1 });
	assert.deepEqual([...e.live.keys()], [id(2)]);
	// A listing that does not answer removes nothing and says so; a timed-out inspect ends the pass.
	const f = fakeLeftovers([leftover(1)], { slow: (args) => (args[0] === "ps" ? "timeout" : "ok") });
	assert.deepEqual(await removeLegacyHelpers({ run: f.run, now: () => NOW }), { listed: false, removed: 0, failed: 0 });
	const g = fakeLeftovers([leftover(1)], { slow: (args) => (args[1] === "inspect" ? "timeout" : "ok") });
	assert.deepEqual(await removeLegacyHelpers({ run: g.run, now: () => NOW }), { listed: true, removed: 0, failed: 0 });
	assert.equal(g.live.size, 1);
});

test("issue #978: the leftover pass runs only after a read that holds, once per process, and logs what it removed once", async () => {
	const c = clock(NOW);
	const logs = [];
	const d = fakeLeftovers([leftover(1), leftover(2)], { quota: null });
	const reserve = makeCpuReserve({ run: d.run, image: "i", name: NAME, now: c.now, log: (e, x) => logs.push([e, x]) });
	await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.equal(reserve.states()[0].status, "unreadable");
	assert.equal(d.calls.filter((x) => x.args[0] === "ps").length, 0, "not on a daemon whose read did not hold");
	assert.equal(d.live.size, 2);
	// Now the read holds: one listing, both removed, one line.
	const e = fakeLeftovers([leftover(1), leftover(2)]);
	const healthy = makeCpuReserve({ run: e.run, image: "i", name: NAME, now: c.now, log: (ev, x) => logs.push([ev, x]) });
	await healthy.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.equal(e.live.size, 0);
	assert.deepEqual(logs.filter(([ev]) => ev === "cpu_reserve_leftovers_removed"), [["cpu_reserve_leftovers_removed", { venue: "local", removed: 2, failed: 0 }]]);
	c.advance(RESERVE_RECHECK_MS);
	await healthy.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.equal(e.calls.filter((x) => x.args[0] === "ps").length, 1, "once per process");
	// A listing that timed out is not the once: the next held read lists again. Nothing found logs nothing.
	let slowList = true;
	const f = fakeLeftovers([], { slow: (args) => (args[0] === "ps" && slowList ? "timeout" : "ok") });
	const later = makeCpuReserve({ run: f.run, image: "i", name: NAME, now: c.now, log: (ev, x) => logs.push([ev, x]) });
	await later.sync({ cpuCenti: 1300, plans: [HELPER] });
	slowList = false;
	c.advance(RESERVE_RECHECK_MS);
	await later.sync({ cpuCenti: 1300, plans: [HELPER] });
	c.advance(RESERVE_RECHECK_MS);
	await later.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.equal(f.calls.filter((x) => x.args[0] === "ps").length, 2);
	assert.equal(logs.filter(([ev]) => ev === "cpu_reserve_leftovers_removed").length, 1);
	// A systemctl venue has no helper and lists nothing.
	const g = fakeRun([{ code: 0, stdout: "3s" }]);
	await makeCpuReserve({ run: g.run, image: "i", name: NAME, now: c.now }).sync({ cpuCenti: 300, plans: [USER] });
	assert.equal(g.calls.length, 1);
});
