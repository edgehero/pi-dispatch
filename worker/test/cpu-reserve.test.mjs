import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CGROUP_PARENT,
	HELPER_LABEL_KEY,
	HELPER_NAME_RE,
	HELPER_PARENT_PATH,
	LEGACY_HELPER_CHUNK,
	LEGACY_HELPER_MIN_AGE_MS,
	LEGACY_INSPECT_FORMAT,
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
	legacyHelperVerdict,
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
	// A write refused at once whose read back shows the wanted quota: held, never differs at the very quota wanted. (A
	// 125 with no conflict text is not retried, issue #1021.)
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

test("issue #978: a read back that times out after a write that worked is unreadable with read-timeout and backs off", async () => {
	const c = clock();
	const timedOut = { code: null, error: { timedOut: true } };
	const f = fakeRun([{ code: 0 }, { code: 0, stdout: "max 100000" }, { code: 0 }, timedOut, { code: 0 }, { code: 0 }, { code: 0, stdout: "max 100000" }, { code: 0 }, timedOut, { code: 0 }]);
	const reserve = makeCpuReserve({ run: f.run, image: "i", name: NAME, now: c.now });
	await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.deepEqual(kinds(f.calls), ["rm -f", "read", "write", "read", "rm -f"]);
	assert.deepEqual([reserve.states()[0].status, reserve.states()[0].reason, reserve.states()[0].retryMs], ["unreadable", "read-timeout", 60_000]);
	c.advance(60_000);
	await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.equal(reserve.states()[0].retryMs, 120_000);
});

test("issue #978: a timed-out read where only root may set the quota backs off too", async () => {
	const c = clock();
	const timedOut = { code: null, error: { timedOut: true } };
	const f = fakeRun([timedOut, timedOut]);
	const reserve = makeCpuReserve({ run: f.run, image: "i", name: NAME, now: c.now });
	await reserve.sync({ cpuCenti: 300, plans: [SYSTEM] });
	assert.deepEqual([reserve.states()[0].status, reserve.states()[0].reason, reserve.states()[0].retryMs], ["unreadable", "timeout", 60_000]);
	c.advance(60_000);
	await reserve.sync({ cpuCenti: 300, plans: [SYSTEM] });
	assert.equal(f.calls.length, 2);
	assert.equal(reserve.states()[0].retryMs, 120_000);
});

test("issue #978: when the rm before the read back times out, no read back runs: cleanup-timeout, and the venue backs off", async () => {
	const c = clock();
	// The write exits 1 (dirty), so the read back must clear the name first, and that rm times out.
	const f = fakeRun([{ code: 0 }, { code: 0, stdout: "max 100000" }, { code: 1 }, { code: null, error: { timedOut: true } }]);
	const reserve = makeCpuReserve({ run: f.run, image: "i", name: NAME, now: c.now });
	await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.deepEqual(kinds(f.calls), ["rm -f", "read", "write", "rm -f"]);
	assert.deepEqual([reserve.states()[0].status, reserve.states()[0].reason, reserve.states()[0].retryMs], ["unreadable", "cleanup-timeout", 60_000]);
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
// Issue #978: the unnamed helpers an older worker left, removed by exact fingerprint until one pass finishes.

const NOW = 1_800_000_000_000;
const PARENT = "/sys/fs/cgroup/pidispatch.slice";
// Two images as Docker 28.0.4 printed them: one with no labels (its config has no `Labels` key, and its containers `{}`),
// one with labels, which its containers inherit into `.Config.Labels`.
const BARE_IMAGE = "sha256:bf8527eb54c3680e728d5b4b383a8ba730d72dae7236fbc8dff97ed6b224a731";
const LABELLED_IMAGE = "sha256:cfbf02b8c072ade254641df8612e717166c87d56425d0959d7f197752bcf44ce";
const LAB_LABELS = { "dev.pi-dispatch.lab": "1", "org.opencontainers.image.title": "lab" };
const IMAGES = { [BARE_IMAGE]: { Id: BARE_IMAGE, Config: {} }, [LABELLED_IMAGE]: { Id: LABELLED_IMAGE, Config: { Labels: LAB_LABELS } } };
const id = (n) => n.toString(16).padStart(64, "0");
// Docker prints nanoseconds (`2026-11-21T11:08:39.557881254Z`); these carry nine digits too, exact to the millisecond.
const createdAgo = (ms) => `${new Date(NOW - ms).toISOString().slice(0, 23)}000000Z`;
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const merged = (base, over) => Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(over)])].map((k) => [k, plain(base[k]) && plain(over[k]) ? merged(base[k], over[k]) : Object.hasOwn(over, k) ? over[k] : base[k]]));

/**
 * An older worker's read helper as `docker container inspect` printed it (Docker 28.0.4, made with 5.4.2's argv;
 * only the keys the format reads, and `Name`, which `ps` prints). `HostConfig` has no `Mounts` key: the daemon omits it
 * without a `--mount`. Unnamed, so the daemon named it (`/<adjective>_<name>`).
 */
function readHelper(n, over = {}) {
	const doc = {
		Id: id(n),
		Name: `/eager_turing${n}`,
		Created: createdAgo(2 * 3_600_000),
		State: { Status: "created" },
		Image: BARE_IMAGE,
		Config: { User: "0:0", Entrypoint: ["cat"], Cmd: ["/p/cpu.max"], Labels: {} },
		HostConfig: { Binds: [`${PARENT}:/p:ro`], CgroupParent: "pidispatch.slice", AutoRemove: true, NetworkMode: "none", ReadonlyRootfs: true },
		Mounts: [{ Type: "bind", Source: PARENT, Destination: "/p", Mode: "ro", RW: false, Propagation: "rprivate" }],
	};
	return merged(doc, over);
}

/** Its write helper, the same: `sh -c`, and the parent bound read-write. */
function writeHelper(n, line = "150000 100000", over = {}) {
	return merged(readHelper(n, { Config: { Entrypoint: ["sh"], Cmd: ["-c", `echo "${line}" > /p/cpu.max`] }, HostConfig: { Binds: [`${PARENT}:/p`] }, Mounts: [{ Type: "bind", Source: PARENT, Destination: "/p", Mode: "", RW: true, Propagation: "rprivate" }] }), over);
}

/**
 * The docker CLI's inspect `--format`, as far as these formats use it: `{{json (index . "K" ...)}}`, whose absent last
 * key answers null, and a dotted `{{json .K.L}}`, whose absent key refuses the template, as the CLI does when it falls
 * back to the raw JSON with missing keys as errors (Docker 28.0.4 on `.HostConfig.Mounts`: exit 1, no output). Null
 * when refused.
 */
function render(format, doc) {
	let refused = false;
	const out = format.replace(/\{\{json (?:\(index \. ((?:"[^"]+" ?)+)\)|((?:\.[A-Za-z]+)+))\}\}/g, (_, keys, dotted) => {
		const path = keys ? [...keys.matchAll(/"([^"]+)"/g)].map((m) => m[1]) : dotted.split(".").slice(1);
		let v = doc;
		for (const [i, k] of path.entries()) {
			if (!plain(v)) return (refused = true), "";
			if (!Object.hasOwn(v, k)) return keys && i === path.length - 1 ? "null" : ((refused = true), "");
			v = v[k];
		}
		return JSON.stringify(v ?? null);
	});
	return refused || out.includes("{{") ? null : out;
}
const rowOf = (doc) => JSON.parse(render(LEGACY_INSPECT_FORMAT, doc));

/**
 * A fake daemon holding real-shaped containers: `ps` lists the `created` ones as the CLI prints them (full id, the name
 * without its slash, the helper label, the quoted command), `container inspect` renders the given format per container (exit 1 when one is refused or
 * gone), `image inspect` the same over the image, a plain `rm` removes what has not started (`startsAt`: one that
 * started between the inspect and the rm) and prints its id. `slow(args, n)` makes the n-th call `timeout` or `refuse`.
 */
function fakeLeftovers(docs, { images = IMAGES, slow = () => "ok", quota = "1300000 100000" } = {}) {
	const live = new Map(docs.map((d) => [d.Id, d]));
	const calls = [];
	const run = async (bin, args, opts) => {
		calls.push({ args: [...args], opts });
		const how = slow(args, calls.length - 1);
		if (how === "timeout") return { code: null, stdout: "", error: { timedOut: true } };
		if (how === "refuse") return { code: 1, stdout: "" };
		if (args[0] === "ps") {
			const command = (d) => JSON.stringify([d.Config.Entrypoint[0], ...[...d.Config.Entrypoint.slice(1), ...d.Config.Cmd].map((a) => (a.includes(" ") ? `'${a}'` : a))].join(" "));
			return { code: 0, stdout: [...live.values()].filter((d) => d.State.Status === "created" || d.listedCreated).map((d) => `${d.Id}\t${d.Name.slice(1)}\t${d.Config.Labels?.["pi.dispatch.helper"] ?? ""}\t${command(d)}`).join("\n") };
		}
		if (args[0] === "container" && args[1] === "inspect") {
			const out = args.slice(4).map((x) => (live.has(x) ? render(args[3], live.get(x)) : null));
			return { code: out.every((o) => o !== null) ? 0 : 1, stdout: out.filter((o) => o !== null).join("\n") };
		}
		if (args[0] === "image" && args[1] === "inspect") {
			const out = Object.hasOwn(images, args[4]) ? render(args[3], images[args[4]]) : null;
			return out === null ? { code: 1, stdout: "" } : { code: 0, stdout: `${out}\n` };
		}
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

test("isLegacyHelper on what the format prints from Docker's own JSON: exactly an older worker's read or write helper, never started, ten minutes old, no label beyond its image's", () => {
	const at = (doc) => ({ imageLabels: IMAGES[doc.Image]?.Config.Labels ?? null, nowMs: NOW });
	const is = (doc, opts = at(doc)) => isLegacyHelper(rowOf(doc), opts);
	// The format reads every container, the one with no `HostConfig.Mounts` included; a dotted path to it would not.
	assert.equal(rowOf(readHelper(1)).hostMounts, null);
	assert.equal(render('{{json .HostConfig.Mounts}}', readHelper(1)), null, "the dotted form the CLI refused");
	assert.equal(is(readHelper(1)), true, "the read helper");
	assert.equal(is(writeHelper(2)), true, "the write helper");
	assert.equal(is(writeHelper(3, "max 100000")), true, "the write that clears it");
	assert.equal(is(readHelper(4, { Image: LABELLED_IMAGE, Config: { Labels: LAB_LABELS } })), true, "a read on an image with labels");
	assert.equal(is(writeHelper(5, "250000 100000", { Image: LABELLED_IMAGE, Config: { Labels: LAB_LABELS } })), true, "a write on an image with labels");
	assert.equal(is(readHelper(6, { Created: createdAgo(LEGACY_HELPER_MIN_AGE_MS) })), true, "ten minutes old exactly");
	const decoys = {
		"labelled helper": readHelper(9, { Config: { Labels: { "pi.dispatch.helper": "cpu-reserve" } } }),
		"a label of its own": readHelper(9, { Config: { Labels: { own: "1" } } }),
		"a label of its own on a labelled image": readHelper(9, { Image: LABELLED_IMAGE, Config: { Labels: { ...LAB_LABELS, own: "1" } } }),
		"an image label changed": readHelper(9, { Image: LABELLED_IMAGE, Config: { Labels: { ...LAB_LABELS, "dev.pi-dispatch.lab": "2" } } }),
		"another file": readHelper(9, { Config: { Cmd: ["/p/other"] } }),
		"two files": readHelper(9, { Config: { Cmd: ["/p/cpu.max", "/etc/hostname"] } }),
		"another entrypoint": readHelper(9, { Config: { Entrypoint: ["/bin/cat"] } }),
		"a longer shell": writeHelper(9, "1 100000", { Config: { Cmd: ["-c", 'echo "1 100000" > /p/cpu.max; true'] } }),
		"another mount": readHelper(9, { HostConfig: { Binds: ["/sys/fs/cgroup/other.slice:/p:ro"] }, Mounts: [{ Type: "bind", Source: "/sys/fs/cgroup/other.slice", Destination: "/p", Mode: "ro", RW: false }] }),
		"a second bind": readHelper(9, { HostConfig: { Binds: [`${PARENT}:/p:ro`, "/tmp:/t"] }, Mounts: [{ Type: "bind", Source: PARENT, Destination: "/p", Mode: "ro", RW: false }, { Type: "bind", Source: "/tmp", Destination: "/t", Mode: "", RW: true }] }),
		"a --mount": readHelper(9, { HostConfig: { Mounts: [{ Type: "bind", Source: "/tmp", Target: "/t" }] } }),
		"a read bound read-write": readHelper(9, { HostConfig: { Binds: [`${PARENT}:/p`] }, Mounts: [{ Type: "bind", Source: PARENT, Destination: "/p", Mode: "", RW: true }] }),
		"a write bound read-only": writeHelper(9, "150000 100000", { HostConfig: { Binds: [`${PARENT}:/p:ro`] }, Mounts: [{ Type: "bind", Source: PARENT, Destination: "/p", Mode: "ro", RW: false }] }),
		"a read whose mount is writable": readHelper(9, { Mounts: [{ Type: "bind", Source: PARENT, Destination: "/p", Mode: "", RW: true }] }),
		"a volume at /p": readHelper(9, { Mounts: [{ Type: "volume", Name: "v", Source: PARENT, Destination: "/p", RW: false }] }),
		running: readHelper(9, { State: { Status: "running" } }),
		exited: readHelper(9, { State: { Status: "exited" } }),
		young: readHelper(9, { Created: createdAgo(LEGACY_HELPER_MIN_AGE_MS - 1_000) }),
		"unparseable created": readHelper(9, { Created: "soon" }),
		"another parent": readHelper(9, { HostConfig: { CgroupParent: "user.slice" } }),
		"another user": readHelper(9, { Config: { User: "1000:1000" } }),
		"not auto-removed": readHelper(9, { HostConfig: { AutoRemove: false } }),
		"a network": readHelper(9, { HostConfig: { NetworkMode: "bridge" } }),
		"a writable root": readHelper(9, { HostConfig: { ReadonlyRootfs: false } }),
	};
	for (const [what, doc] of Object.entries(decoys)) assert.equal(is(doc), false, what);
	assert.equal(is(readHelper(9), { imageLabels: undefined, nowMs: NOW }), false, "an image whose labels were not read");
});

test("removeLegacyHelpers: removes exactly the fingerprints, with a plain rm in chunks of 20, every call bounded, and leaves the decoys", async () => {
	const helpers = Array.from({ length: 43 }, (_, i) => {
		const image = i % 3 === 0 ? { Image: LABELLED_IMAGE, Config: { Labels: LAB_LABELS } } : {};
		return i % 2 ? writeHelper(100 + i, `${1700000 + i} 100000`, image) : readHelper(100 + i, image);
	});
	const decoys = [
		readHelper(1, { Config: { Labels: { "pi.dispatch.helper": "cpu-reserve" } } }),
		readHelper(2, { Config: { Cmd: ["/p/cpu.max", "/etc/hostname"] } }),
		readHelper(3, { HostConfig: { Binds: ["/sys/fs/cgroup/other.slice:/p:ro"] }, Mounts: [{ Type: "bind", Source: "/sys/fs/cgroup/other.slice", Destination: "/p", RW: false }] }),
		readHelper(4, { State: { Status: "running" }, listedCreated: true }),
		readHelper(5, { Created: createdAgo(60_000) }),
		readHelper(6, { Image: `sha256:${"b".repeat(64)}` }),
		readHelper(7, { Config: { Entrypoint: ["valkey-server"], Cmd: [] } }),
		readHelper(8, { HostConfig: { Binds: [`${PARENT}:/p`] }, Mounts: [{ Type: "bind", Source: PARENT, Destination: "/p", RW: true }] }),
	];
	const d = fakeLeftovers([...helpers, ...decoys]);
	const out = await removeLegacyHelpers({ run: d.run, now: () => NOW });
	// Listed: the 43, and every decoy but the labelled one under no helper name and the one whose command is another's;
	// the 60 s old one is young, the rest kept.
	assert.deepEqual(out, { complete: true, reason: null, listed: 49, removed: 43, failed: 0, young: 1, kept: 5 });
	assert.deepEqual([...d.live.keys()].sort(), decoys.map((r) => r.Id).sort());
	assert.deepEqual(d.calls[0].args, ["ps", "-a", "--filter", "status=created", "--no-trunc", "--format", '{{.ID}}\t{{.Names}}\t{{.Label "pi.dispatch.helper"}}\t{{.Command}}']);
	const rms = d.calls.filter((x) => x.args[0] === "rm");
	assert.deepEqual(rms.map((x) => x.args.length - 1), [20, 20, 3]);
	assert.ok(rms.every((x) => !x.args.includes("-f") && !x.args.includes("--force")), "never a forced rm");
	assert.ok(d.calls.every((x) => x.opts.timeoutMs === 15_000), "every call bounded");
	assert.ok(d.calls.filter((x) => x.args[0] === "ps" || (x.args[1] === "inspect" && x.args[0] === "container")).every((x) => x.opts.maxBuffer >= 1024 * 1024), "the long outputs get room");
	assert.deepEqual(d.calls.filter((x) => x.args[0] === "image").map((x) => x.args.at(-1)).sort(), [BARE_IMAGE, LABELLED_IMAGE, `sha256:${"b".repeat(64)}`].sort(), "each image inspected once");
	assert.ok(!d.calls.some((x) => x.args.some((a) => String(a).startsWith("volume="))), "no volume filter");
	// One that starts between the inspect and the rm is refused by the plain rm and counted, never forced.
	const e = fakeLeftovers([readHelper(1), readHelper(2, { startsAt: true })]);
	assert.deepEqual(await removeLegacyHelpers({ run: e.run, now: () => NOW }), { complete: true, reason: null, listed: 2, removed: 1, failed: 1, young: 0, kept: 0 });
	assert.deepEqual([...e.live.keys()], [id(2)]);
	// Nothing listed is a pass that finished.
	assert.deepEqual(await removeLegacyHelpers({ run: fakeLeftovers([]).run, now: () => NOW }), { complete: true, reason: null, listed: 0, removed: 0, failed: 0, young: 0, kept: 0 });
});

test("removeLegacyHelpers: a timeout at any step, a listing that failed, or an inspect that answered without rows cuts the pass short, and nothing runs after it", async () => {
	// 25 leftovers: two chunks, so a pass that went on after the cut would show a later call.
	const docs = Array.from({ length: 25 }, (_, i) => readHelper(200 + i, i < 20 ? {} : { Image: LABELLED_IMAGE, Config: { Labels: LAB_LABELS } }));
	const cases = [
		["timeout", (a) => a[0] === "ps", "list-timeout"],
		["refuse", (a) => a[0] === "ps", "list-exit-1"],
		["timeout", (a) => a[0] === "container", "inspect-timeout"],
		["refuse", (a) => a[0] === "container", "inspect-exit-1"],
		["timeout", (a) => a[0] === "image", "image-timeout"],
		["timeout", (a) => a[0] === "rm", "rm-timeout"],
	];
	for (const [how, at, reason] of cases) {
		let fired = -1;
		const d = fakeLeftovers(docs, { slow: (args, n) => (fired === -1 && at(args) ? ((fired = n), how) : "ok") });
		const out = await removeLegacyHelpers({ run: d.run, now: () => NOW });
		assert.deepEqual([out.complete, out.reason], [false, reason], reason);
		assert.equal(d.calls.length, fired + 1, `${reason}: no call after the cut`);
		assert.deepEqual([out.removed, out.failed], reason === "rm-timeout" ? [0, 20] : [0, 0], reason);
	}
	// An inspect that exits 0 and prints no row of its chunk established nothing either.
	const e = fakeLeftovers(docs, { slow: () => "ok" });
	const silent = async (bin, args, opts) => (args[0] === "container" ? { code: 0, stdout: "" } : e.run(bin, args, opts));
	assert.deepEqual(await removeLegacyHelpers({ run: silent, now: () => NOW }), { complete: false, reason: "inspect-no-rows", listed: 25, removed: 0, failed: 0, young: 0, kept: 0 });
});

test("issue #978: the leftover pass runs only after a read that holds, again after each until one leaves nothing to come back for, then never; a pass cut short is said once, one that removed always, with its own counts", async () => {
	const c = clock(NOW);
	const logs = [];
	const said = () => logs.filter(([e]) => e === "cpu_reserve_leftovers_removed").map(([, x]) => x);
	// A read that does not hold lists nothing.
	const d = fakeLeftovers([readHelper(1), readHelper(2)], { quota: null });
	const reserve = makeCpuReserve({ run: d.run, image: "i", name: NAME, now: c.now, log: (e, x) => logs.push([e, x]) });
	await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.equal(reserve.states()[0].status, "unreadable");
	assert.equal(d.calls.filter((x) => x.args[0] === "ps").length, 0, "not on a daemon whose read did not hold");
	assert.equal(d.live.size, 2);
	// 25 leftovers. The first pass removes the first chunk and its second inspect times out; the second pass's listing
	// times out; the third finishes. Cut short is said once (by the first line, which removed); the end once, with the
	// five that pass listed and removed (issue #1021: every count is that pass's).
	let inspects = 0;
	let lists = 0;
	const docs = Array.from({ length: 25 }, (_, i) => readHelper(300 + i));
	const e = fakeLeftovers(docs, { slow: (args) => (args[0] === "container" && ++inspects === 2 ? "timeout" : args[0] === "ps" && ++lists === 2 ? "timeout" : "ok") });
	const healthy = makeCpuReserve({ run: e.run, image: "i", name: NAME, now: c.now, log: (ev, x) => logs.push([ev, x]) });
	const pass = async () => {
		c.advance(RESERVE_RECHECK_MS);
		await healthy.sync({ cpuCenti: 1300, plans: [HELPER] });
		assert.equal(healthy.states()[0].status, "held");
	};
	await pass();
	assert.equal(e.live.size, 5);
	assert.deepEqual(said(), [{ venue: "local", listed: 25, removed: 20, failed: 0, young: 0, kept: 0, complete: false, reason: "inspect-timeout" }]);
	await pass();
	assert.equal(said().length, 1, "a second pass cut short is not said again");
	await pass();
	assert.equal(e.live.size, 0);
	assert.deepEqual(said().at(-1), { venue: "local", listed: 5, removed: 5, failed: 0, young: 0, kept: 0, complete: true });
	await pass();
	assert.equal(e.calls.filter((x) => x.args[0] === "ps").length, 3, "after a pass that left nothing to come back for, never again");
	assert.equal(said().length, 2);
	// A pass that finds nothing finishes quietly.
	const f = fakeLeftovers([]);
	const quiet = makeCpuReserve({ run: f.run, image: "i", name: NAME, now: c.now, log: (ev, x) => logs.push([ev, x]) });
	await quiet.sync({ cpuCenti: 1300, plans: [HELPER] });
	c.advance(RESERVE_RECHECK_MS);
	await quiet.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.equal(f.calls.filter((x) => x.args[0] === "ps").length, 1);
	assert.equal(said().length, 2);
	// A systemctl venue has no helper and lists nothing.
	const g = fakeRun([{ code: 0, stdout: "3s" }]);
	await makeCpuReserve({ run: g.run, image: "i", name: NAME, now: c.now }).sync({ cpuCenti: 300, plans: [USER] });
	assert.equal(g.calls.length, 1);
});

// ---------------------------------------------------------------------------------------------------------------------
// Issue #1021: what one pass leaves behind, the helper of a worker since renamed, and a name a clean exit did not free.

/** `Created` as Docker prints it (nine fractional digits) for an instant on the test's clock. */
const createdAt = (ms) => `${new Date(ms).toISOString().slice(0, 23)}000000Z`;
/** A helper as `helperArgs` makes it now: an older worker's argv plus the name and the label. */
const namedHelper = (n, name, over = {}) => merged(readHelper(n, { Name: `/${name}`, Config: { Labels: { [HELPER_LABEL_KEY]: "cpu-reserve" } } }), over);

test("issue #1021: young fingerprints keep the venue not done, said once with what was kept, and a later held read removes them once old", async () => {
	const c = clock(NOW);
	const logs = [];
	const said = () => logs.filter(([e]) => e === "cpu_reserve_leftovers_removed").map(([, x]) => x);
	// Three leftovers a minute old (the issue's measured pass: every match younger than ten minutes) and one that is no
	// fingerprint (a label of its own).
	const young = [readHelper(1, { Created: createdAgo(60_000) }), writeHelper(2, "150000 100000", { Created: createdAgo(60_000) }), readHelper(3, { Created: createdAgo(60_000) })];
	const d = fakeLeftovers([...young, readHelper(4, { Config: { Labels: { own: "1" } } })]);
	const reserve = makeCpuReserve({ run: d.run, image: "i", name: NAME, now: c.now, log: (e, x) => logs.push([e, x]) });
	await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.equal(reserve.states()[0].status, "held");
	assert.deepEqual(said(), [{ venue: "local", listed: 4, removed: 0, failed: 0, young: 3, kept: 1, complete: true }], "a pass that only kept is said");
	assert.equal(d.live.size, 4);
	// The next read that holds is the recheck, ten minutes on: the three are old now, and that pass removes them.
	c.advance(RESERVE_RECHECK_MS - 1);
	await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.equal(d.calls.filter((x) => x.args[0] === "ps").length, 1, "nothing before the recheck");
	c.advance(1);
	await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.deepEqual([...d.live.keys()], [id(4)]);
	assert.deepEqual(said().at(-1), { venue: "local", listed: 4, removed: 3, failed: 0, young: 0, kept: 1, complete: true }, "a pass that removed is said");
	assert.equal(said().length, 2);
	// Nothing young, nothing refused: done, never listed again in this process.
	c.advance(RESERVE_RECHECK_MS);
	await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.equal(d.calls.filter((x) => x.args[0] === "ps").length, 2);
	assert.equal(said().length, 2);
});

test("issue #1021: an older worker beside this one keeps making young ones: a listing each recheck, one line, never a line per recheck", async () => {
	const c = clock(NOW);
	const logs = [];
	const d = fakeLeftovers([]);
	const reserve = makeCpuReserve({ run: d.run, image: "i", name: NAME, now: c.now, log: (e, x) => logs.push([e, x]) });
	for (let n = 0; n < 4; n += 1) {
		// The one it made last time started and went (AutoRemove); a new one is a minute old at this pass.
		d.live.clear();
		const doc = readHelper(500 + n, { Created: createdAt(c.now() - 60_000) });
		d.live.set(doc.Id, doc);
		await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
		c.advance(RESERVE_RECHECK_MS);
	}
	assert.equal(d.calls.filter((x) => x.args[0] === "ps").length, 4, "never done while young ones are left");
	assert.deepEqual(logs.filter(([e]) => e === "cpu_reserve_leftovers_removed").map(([, x]) => x), [{ venue: "local", listed: 1, removed: 0, failed: 0, young: 1, kept: 0, complete: true }]);
});

test("issue #1021: a fingerprint whose rm is refused keeps the venue not done, said once, and goes once the rm gets through", async () => {
	const c = clock(NOW);
	const logs = [];
	const said = () => logs.filter(([e]) => e === "cpu_reserve_leftovers_removed").map(([, x]) => x);
	const d = fakeLeftovers([readHelper(1, { startsAt: true })]);
	const reserve = makeCpuReserve({ run: d.run, image: "i", name: NAME, now: c.now, log: (e, x) => logs.push([e, x]) });
	await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.deepEqual(said(), [{ venue: "local", listed: 1, removed: 0, failed: 1, young: 0, kept: 0, complete: true }]);
	c.advance(RESERVE_RECHECK_MS);
	await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.equal(d.calls.filter((x) => x.args[0] === "rm" && x.args[1] !== "-f").length, 2, "tried again on the next read that holds");
	assert.equal(said().length, 1, "the same refusal is not said every recheck");
	delete d.live.get(id(1)).startsAt;
	c.advance(RESERVE_RECHECK_MS);
	await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.equal(d.live.size, 0);
	assert.deepEqual(said().at(-1), { venue: "local", listed: 1, removed: 1, failed: 0, young: 0, kept: 0, complete: true });
	c.advance(RESERVE_RECHECK_MS);
	await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.equal(d.calls.filter((x) => x.args[0] === "ps").length, 3, "done once nothing is left to come back for");
});

test("issue #1021: a pass that listed only containers that are no fingerprint is done, and says so once", async () => {
	const c = clock(NOW);
	const logs = [];
	const decoys = [readHelper(1, { Config: { Cmd: ["/p/cpu.max", "/etc/hostname"] } }), readHelper(2, { HostConfig: { NetworkMode: "bridge" } })];
	const d = fakeLeftovers(decoys);
	const reserve = makeCpuReserve({ run: d.run, image: "i", name: NAME, now: c.now, log: (e, x) => logs.push([e, x]) });
	await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	c.advance(RESERVE_RECHECK_MS);
	await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.equal(d.calls.filter((x) => x.args[0] === "ps").length, 1, "a fingerprint that misses everything is not looked for again");
	assert.equal(d.live.size, 2);
	assert.deepEqual(logs.filter(([e]) => e === "cpu_reserve_leftovers_removed").map(([, x]) => x), [{ venue: "local", listed: 2, removed: 0, failed: 0, young: 0, kept: 2, complete: true }]);
});

test("issue #1021: a stuck helper labelled under another helper name is removed with a plain rm; this worker's own name never; a young, running or extra-labelled one is kept", async () => {
	assert.match(helperName("old-name"), HELPER_NAME_RE);
	assert.match(helperName("", { doctor: true }), HELPER_NAME_RE);
	for (const bad of ["pi-dispatch-cpu-reserve-E3B0C442", "pi-dispatch-cpu-reserve-e3b0c44", "x-pi-dispatch-cpu-reserve-e3b0c442", "pi-dispatch-cpu-reserve-e3b0c442,other", "pi-dispatch-cpu-reserve-other-e3b0c442"]) assert.doesNotMatch(bad, HELPER_NAME_RE, bad);
	const renamed = namedHelper(1, helperName("old-name"));
	const doctorStuck = writeHelper(2, "150000 100000", { Name: `/${helperName("", { doctor: true })}`, Config: { Labels: { [HELPER_LABEL_KEY]: "cpu-reserve" } } });
	const onLabelledImage = namedHelper(3, helperName("older"), { Image: LABELLED_IMAGE, Config: { Labels: { ...LAB_LABELS, [HELPER_LABEL_KEY]: "cpu-reserve" } } });
	const own = namedHelper(4, NAME);
	const youngOne = namedHelper(5, helperName("young"), { Created: createdAgo(60_000) });
	const running = namedHelper(6, helperName("running"), { State: { Status: "running" }, listedCreated: true });
	const extra = namedHelper(7, helperName("extra"), { Config: { Labels: { own: "1" } } });
	const notAHelperName = namedHelper(8, "my-helper");
	// Another helper role's label under a helper name: not this role's leftover, so not even listed.
	const otherRole = namedHelper(12, helperName("probe"), { Config: { Labels: { [HELPER_LABEL_KEY]: "egress-probe" } } });
	const d = fakeLeftovers([renamed, doctorStuck, onLabelledImage, own, youngOne, running, extra, notAHelperName, otherRole]);
	const out = await removeLegacyHelpers({ run: d.run, now: () => NOW, ownName: NAME });
	assert.deepEqual(out, { complete: true, reason: null, listed: 6, removed: 3, failed: 0, young: 1, kept: 2 });
	assert.deepEqual([...d.live.keys()].sort(), [own, youngOne, running, extra, notAHelperName, otherRole].map((x) => x.Id).sort());
	assert.ok(!d.calls.some((x) => x.args.includes(own.Id)), "this worker's own helper is never inspected nor removed");
	assert.ok(!d.calls.some((x) => x.args.includes(otherRole.Id)), "another role's labelled container is never inspected");
	assert.ok(d.calls.filter((x) => x.args[0] === "rm").every((x) => !x.args.includes("-f") && !x.args.includes("--force")), "never a forced rm");
	// The fingerprint itself: a named helper's carries exactly the label, an unnamed one's none.
	const at = (doc) => ({ imageLabels: IMAGES[doc.Image]?.Config.Labels ?? null, nowMs: NOW });
	assert.equal(legacyHelperVerdict(rowOf(renamed), { ...at(renamed), labelled: true }), "remove");
	assert.equal(legacyHelperVerdict(rowOf(renamed), at(renamed)), "kept", "unnamed rules: no label of its own");
	assert.equal(legacyHelperVerdict(rowOf(readHelper(9)), { ...at(readHelper(9)), labelled: true }), "kept", "named rules: the label must be there");
	assert.equal(legacyHelperVerdict(rowOf(youngOne), { ...at(youngOne), labelled: true }), "young");
	assert.equal(legacyHelperVerdict(rowOf(readHelper(9, { Created: "soon" })), at(readHelper(9))), "kept", "a Created no later pass could read is not young");
	assert.equal(legacyHelperVerdict(rowOf(namedHelper(9, helperName("x"), { Config: { Labels: { [HELPER_LABEL_KEY]: "other" } } })), { ...at(readHelper(9)), labelled: true }), "kept");
	// Wired: the worker passes its own name, so its own stuck helper is its guard's alone.
	const e = fakeLeftovers([namedHelper(10, NAME), namedHelper(11, helperName("old-name"))]);
	await makeCpuReserve({ run: e.run, image: "i", name: NAME, now: () => NOW }).sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.deepEqual([...e.live.keys()], [id(10)]);
});

test("issue #1021: a create refused for its name after a clean step gets one rm and one more try; any other 125, or one without stderr, does not; a second refusal is answered and leaves the name dirty; a refusal right after the guard's own rm is not retried", async () => {
	// The daemon's own words for a name still taken (Docker 28.0.4, and Podman's), and two other refusals that exit 125.
	const CONFLICT = 'docker: Error response from daemon: Conflict. The container name "/pi-dispatch-cpu-reserve-e3b0c442" is already in use by container "4f2a". You have to remove (or rename) that container to be able to reuse that name.\n';
	const PODMAN_CONFLICT = 'Error: creating container storage: the container name "pi-dispatch-cpu-reserve-e3b0c442" is already in use by 4f2a. You have to remove that container to be able to reuse that name: that name is already in use\n';
	const held = { code: 125, stdout: "", stderr: CONFLICT };
	const calls = [];
	const answers = [];
	const run = async (bin, args) => {
		calls.push(args[0] === "run" ? "run" : args.slice(0, 2).join(" "));
		return args[0] === "run" ? answers.shift() : { code: 0, stdout: "" };
	};
	const guarded = guardHelperRun({ run, name: NAME });
	// The first step: the name is dirty, so it is cleared first, and the refusal that follows is not retried.
	answers.push(held);
	assert.equal((await guarded("docker", ["run"], {})).code, 125);
	assert.deepEqual(calls.splice(0), ["rm -f", "run"]);
	// Dirty again: cleared, then a clean step.
	answers.push({ code: 0, stdout: "ok" });
	assert.equal((await guarded("docker", ["run"], {})).stdout, "ok");
	assert.deepEqual(calls.splice(0), ["rm -f", "run"]);
	// After a clean step the name is not cleared, and a refusal for the name there is a name a clean exit did not free:
	// one rm, one retry. Podman's words count the same.
	for (const stderr of [CONFLICT, PODMAN_CONFLICT]) {
		answers.push({ code: 125, stdout: "", stderr }, { code: 0, stdout: "ok" });
		assert.equal((await guarded("docker", ["run"], {})).stdout, "ok");
		assert.deepEqual(calls.splice(0), ["run", "rm -f", "run"]);
	}
	// Any other 125 is answered at once: an image the runtime refuses, a flag it does not know, a runner with no stderr.
	for (const refusal of [{ code: 125, stdout: "", stderr: 'Unable to find image "pi-job:pinned" locally\ndocker: Error response from daemon: No such image: pi-job:pinned.\n' }, { code: 125, stdout: "", stderr: "unknown flag: --pull\n" }, { code: 125, stdout: "" }]) {
		answers.push(refusal);
		assert.equal((await guarded("docker", ["run"], {})).code, 125);
		assert.deepEqual(calls.splice(0), ["run"], JSON.stringify(refusal));
		answers.push({ code: 0, stdout: "ok" });
		await guarded("docker", ["run"], {});
		assert.deepEqual(calls.splice(0), ["rm -f", "run"], "that 125 left the name dirty, as any failed step does");
	}
	// Twice refused: the second is answered, and the next step clears the name first.
	answers.push(held, held);
	assert.equal((await guarded("docker", ["run"], {})).code, 125);
	assert.deepEqual(calls.splice(0), ["run", "rm -f", "run"]);
	answers.push({ code: 0, stdout: "ok" });
	await guarded("docker", ["run"], {});
	assert.deepEqual(calls.splice(0), ["rm -f", "run"]);
	// A retry whose rm times out runs no second step: cleanup-timeout, as before any step.
	const slow = async (bin, args) => (args[0] === "rm" ? { code: null, stdout: "", error: { timedOut: true } } : answers.shift());
	const state = { dirty: false };
	answers.push(held);
	assert.equal(stepFailure(await guardHelperRun({ run: slow, name: NAME, state })("docker", ["run"], {}), "docker"), "cleanup-timeout");
	assert.equal(answers.length, 0);
	// Wired: a write refused for its name right after a clean read is retried, the reserve holds with no fail-open line,
	// and the daemon's words reach no line.
	const logs = [];
	const f = fakeRun([{ code: 0 }, { code: 0, stdout: "max 100000" }, held, { code: 0 }, { code: 0 }, { code: 0, stdout: "1300000 100000" }, { code: 0, stdout: "" }]);
	const reserve = makeCpuReserve({ run: f.run, image: "i", name: NAME, now: () => NOW, log: (e, x) => logs.push([e, x]) });
	await reserve.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.deepEqual(kinds(f.calls), ["rm -f", "read", "write", "rm -f", "write", "read", "ps -a"]);
	assert.equal(reserve.states()[0].status, "held");
	assert.deepEqual(logs.map(([e]) => e), ["cpu_reserve"], "no write-exit-125 fail-open line");
	// Twice refused, wired: the attempt fails open as write-exit-125, and neither the line nor the state carries stderr.
	const words = [];
	const g = fakeRun([{ code: 0 }, { code: 0, stdout: "max 100000" }, held, { code: 0 }, held, { code: 0 }, { code: 0, stdout: "max 100000" }]);
	const twice = makeCpuReserve({ run: g.run, image: "i", name: NAME, now: () => NOW, log: (e, x) => words.push(JSON.stringify([e, x])) });
	await twice.sync({ cpuCenti: 1300, plans: [HELPER] });
	assert.deepEqual([twice.states()[0].status, twice.states()[0].reason], ["unset", "write-exit-125"]);
	assert.ok(![...words, JSON.stringify(twice.states())].some((w) => /already in use|Conflict/.test(w)), "stderr is matched, never said");
});

test("issue #1021: the rm before a helper is plain with forceBefore false (doctor's), forced by default (the worker's); after a timeout it is always forced", async () => {
	const seen = (forceBefore) => {
		const calls = [];
		const run = async (bin, args) => {
			calls.push(args.slice(0, 3));
			return args[0] === "run" ? { code: null, stdout: "", error: { timedOut: true } } : { code: 0, stdout: "" };
		};
		return { calls, guarded: guardHelperRun({ run, name: NAME, ...(forceBefore === undefined ? {} : { forceBefore }) }) };
	};
	for (const [forceBefore, before] of [[undefined, ["rm", "-f", NAME]], [true, ["rm", "-f", NAME]], [false, ["rm", NAME]]]) {
		const { calls, guarded } = seen(forceBefore);
		await guarded("docker", ["run", "--rm", "x"], { timeoutMs: 1 });
		assert.deepEqual(calls, [before, ["run", "--rm", "x"], ["rm", "-f", NAME]], String(forceBefore));
	}
});
