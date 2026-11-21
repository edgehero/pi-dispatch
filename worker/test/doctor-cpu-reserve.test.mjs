import assert from "node:assert/strict";
import { test } from "node:test";
import { cpuReserveChecks, doctorCpuReserve } from "../src/doctor.mjs";
import { cgroupParentVerdict } from "../src/live-probes.mjs";
import { helperArgs, helperName } from "../src/cpu-reserve.mjs";

// Issue #596, phase 2: doctor's lines for the aggregate CPU reserve, and `--live`'s read-back of where a job sits.

const plan = (venue, method, why = null, parent = true) => ({ venue, parent, method, why });
const line = (reads, cpuCenti) => cpuReserveChecks(reads, cpuCenti);

test("doctor: a held quota is one ok line naming the parent, the budget and who keeps it, per method", () => {
	const [user] = line([{ plan: plan("podman", "user-systemd"), read: { ok: true, cpuCenti: 300 } }], 300);
	assert.deepEqual(user, { ok: true, label: "podman: every job runs under pidispatch.slice, whose quota is 3 CPUs, the host's CPU budget, so all jobs together leave the reserve free (set by the worker through this account's systemd user manager when it starts, and kept across reboots)" });
	const [helper] = line([{ plan: plan("local", "helper"), read: { ok: true, cpuCenti: 1300 } }], 1300);
	assert.equal(helper.ok, true);
	assert.match(helper.label, /quota is 13 CPUs.*one-shot helper container of the job image; a Docker Desktop restart drops it and the worker writes it again within ten minutes/);
	const [system] = line([{ plan: plan("local", "system-systemd"), read: { ok: true, cpuCenti: 350 } }], 350);
	assert.match(system.label, /quota is 3\.5 CPUs.*set by the operator with systemctl/);
});

test("doctor: on a systemd host an unset or different quota warns 'no host CPU reserve across jobs' with the exact operator command", () => {
	const [unset] = line([{ plan: plan("local", "system-systemd"), read: { ok: true, cpuCenti: null } }], 300);
	assert.deepEqual(unset, { ok: false, warn: true, label: "local: no host CPU reserve across jobs: pidispatch.slice has no CPU quota, not the CPU budget of 3 CPUs", fix: "run once, as root (persistent across reboots): `sudo systemctl set-property pidispatch.slice CPUQuota=300%`" });
	const [differs] = line([{ plan: plan("local", "system-systemd"), read: { ok: true, cpuCenti: 200 } }], 300);
	assert.match(differs.label, /has a quota of 2 CPUs, not the CPU budget of 3 CPUs/);
	assert.match(differs.fix, /CPUQuota=300%/);
	const [unread] = line([{ plan: plan("local", "system-systemd"), read: { ok: false, reason: "timeout" } }], 300);
	assert.equal(unread.warn, true);
	assert.match(unread.label, /no host CPU reserve across jobs could be confirmed: the quota of pidispatch\.slice was not readable \(timeout\)/);
	assert.match(unread.fix, /sudo systemctl set-property pidispatch\.slice CPUQuota=300%/);
	// Where the worker sets it itself, the fix says so and gives its command.
	const [user] = line([{ plan: plan("podman", "user-systemd"), read: { ok: true, cpuCenti: null } }], 300);
	assert.match(user.fix, /the worker sets it when it starts.*`systemctl --user set-property pidispatch\.slice CPUQuota=300%`/);
	const [helper] = line([{ plan: plan("local", "helper"), read: { ok: false, reason: "job-image-absent" } }], 300);
	assert.match(helper.fix, /the worker writes it when it starts and re-checks it every ten minutes/);
});

test("doctor: the budget off says no quota is set; a quota still set while off warns with the command that clears it", () => {
	const [off] = line([{ plan: plan("local", "system-systemd"), read: { ok: true, cpuCenti: null } }], Infinity);
	assert.deepEqual(off, { ok: true, label: "local: the CPU budget is off (PI_HOST_CPU_BUDGET=off), so no quota is set on pidispatch.slice: jobs share the parent and together may use every core" });
	const [stale] = line([{ plan: plan("local", "system-systemd"), read: { ok: true, cpuCenti: 300 } }], Infinity);
	assert.equal(stale.warn, true);
	assert.match(stale.label, /the CPU budget is off, but pidispatch\.slice still has a quota of 3 CPUs/);
	assert.match(stale.fix, /`sudo systemctl set-property pidispatch\.slice CPUQuota=`/);
	const [unmanagedOff] = line([{ plan: plan("local", null, "remote-daemon"), read: null }], Infinity);
	assert.equal(unmanagedOff.ok, true);
	assert.match(unmanagedOff.label, /the CPU budget is off/);
});

test("doctor: without the parent the line says the proxy and Valkey get a fair share, not a reserve; an unknown budget and every unmanaged venue warn with a named reason", () => {
	const [noParent] = line([{ plan: plan("podman", null, "podman-cgroupfs", false), read: null, cgroupManager: "cgroupfs" }], 300);
	assert.equal(noParent.warn, true);
	assert.match(noParent.label, /jobs run without the pidispatch\.slice parent cgroup \(Podman uses the cgroupfs cgroup manager here\), so each job's CPU weight is capped at 1024: the egress proxy and Valkey get a fair share of the CPU, not a reserve/);
	const [unknown] = line([{ plan: plan("local", "helper"), read: null }], null);
	assert.match(unknown.label, /no host CPU reserve across jobs yet: the CPU budget is unknown/);
	const whys = { "cgroup-v1": /cgroup v1/, "remote-daemon": /not observed on this host/, "rootless-docker": /rootless Docker/, "driver-unknown": /did not say which cgroup driver/, "podman-rootful-remote": /rootful or remote/, other: /keeps no quota on this venue/ };
	for (const [why, said] of Object.entries(whys)) {
		const [c] = line([{ plan: plan("local", null, why), read: null }], 300);
		assert.equal(c.warn, true, why);
		assert.match(c.label, /^local: no host CPU reserve across jobs: every job runs under pidispatch\.slice, but /, why);
		assert.match(c.label, said, why);
		assert.ok(c.fix, why);
	}
	assert.match(line([{ plan: plan("local", null, "remote-daemon"), read: null }], 300)[0].fix, /on the daemon's host, run once as root: `sudo systemctl set-property pidispatch\.slice CPUQuota=300%`/);
});

test("doctorCpuReserve: reads (never writes) per answered venue, through the worker's own readQuota; the helper only with the job image present", async () => {
	const calls = [];
	const run = async (bin, args) => {
		calls.push([bin, ...args]);
		return bin === "systemctl" ? { code: 0, stdout: "3s" } : { code: 0, stdout: "1300000 100000" };
	};
	const docker = { answered: true, facts: { cgroupDriver: "cgroupfs", cgroupVersion: "v2", rootless: false } };
	const podman = { answered: true, info: { rootless: true, cgroupManager: "systemd", cgroupVersion: "v2", serviceIsRemote: false } };
	const reads = await doctorCpuReserve({ daemon: docker, podman, run, image: "pi-job:pinned", imagePresent: true, platform: "darwin" });
	assert.deepEqual(reads.map((r) => [r.plan.venue, r.plan.method, r.read]), [["local", "helper", { ok: true, cpuCenti: 1300 }], ["podman", "user-systemd", { ok: true, cpuCenti: 300 }]]);
	// Issue #978: doctor's own helper name (no worker name declared here), removed before its read.
	const name = "pi-dispatch-cpu-reserve-doctor-e3b0c442";
	assert.deepEqual(calls, [["docker", "rm", "-f", name], ["docker", ...helperArgs({ image: "pi-job:pinned", name, read: true })], ["systemctl", "--user", "show", "-P", "CPUQuotaPerSecUSec", "pidispatch.slice"]]);
	assert.ok(calls.every((c) => !c.includes("set-property") && !c.some((a) => String(a).includes("> /p/cpu.max"))), "doctor never writes");
	calls.length = 0;
	const absent = await doctorCpuReserve({ daemon: docker, run, image: "pi-job:pinned", imagePresent: false });
	assert.deepEqual(absent[0].read, { ok: false, reason: "job-image-absent" });
	assert.equal(calls.length, 0);
	// A venue not run, or not answering, adds nothing; one without a method is listed with no read.
	assert.deepEqual(await doctorCpuReserve({ daemon: undefined, podman: { answered: false }, run }), []);
	const unmanaged = await doctorCpuReserve({ daemon: { answered: true, facts: { cgroupDriver: "systemd", cgroupVersion: "v2" } }, endpointLocal: false, run, platform: "linux" });
	assert.deepEqual(unmanaged.map((r) => [r.plan.why, r.read]), [["remote-daemon", null]]);
	assert.equal(calls.length, 0);
});

test("issue #978: doctor's helper runs under doctor's own name for the declared worker, is removed before its read and again after a timeout, and a 125 names another doctor as a cause", async () => {
	const name = helperName("box-1", { doctor: true });
	assert.equal(name, "pi-dispatch-cpu-reserve-doctor-96fb257c");
	assert.notEqual(name, helperName("box-1"), "never the worker's, so a doctor never removes the worker's helper mid-step");
	const docker = { answered: true, facts: { cgroupDriver: "cgroupfs", cgroupVersion: "v2", rootless: false } };
	const calls = [];
	const run = async (bin, args, { timeoutMs }) => {
		calls.push([bin, ...args.slice(0, 4), timeoutMs]);
		return args[0] === "run" ? { code: null, stdout: "", error: { timedOut: true } } : { code: 0, stdout: "" };
	};
	const [timedOut] = await doctorCpuReserve({ daemon: docker, run, image: "pi-job:pinned", imagePresent: true, platform: "darwin", workerName: "box-1" });
	assert.deepEqual(timedOut.read, { ok: false, reason: "timeout" });
	assert.deepEqual(calls, [
		["docker", "rm", "-f", name, 15_000],
		["docker", "run", "--rm", "--name", name, 15_000],
		["docker", "rm", "-f", name, 15_000],
	]);
	// 125 after doctor's own rm: any refusal by the runtime (stderr is never read), one of which is another doctor of this
	// deployment reading under the same name at that moment. Named as a cause, not as the cause.
	const taken = async (bin, args) => (args[0] === "run" ? { code: 125, stdout: "" } : { code: 0, stdout: "" });
	const [busy] = await doctorCpuReserve({ daemon: docker, run: taken, image: "pi-job:pinned", imagePresent: true, platform: "darwin", workerName: "box-1" });
	assert.deepEqual(busy.read, { ok: false, reason: "exit-125" });
	const [said] = line([busy], 1300);
	assert.equal(said.warn, true);
	assert.equal(said.label, "local: no host CPU reserve across jobs could be confirmed: the quota of pidispatch.slice was not readable (exit-125: the runtime refused the helper, which another doctor reading the quota at the same moment causes)");
	assert.equal(said.fix, "if another doctor was running, run doctor again once it has finished; otherwise the worker writes it when it starts and re-checks it every ten minutes; start or restart the worker");
	// A systemctl read that exits 125 is no helper's name, and keeps the plain line.
	const [plain] = line([{ plan: plan("local", "system-systemd"), read: { ok: false, reason: "exit-125" } }], 300);
	assert.match(plain.label, /was not readable \(exit-125\)$/);
});

// ---------------------------------------------------------------------------------------------------------------------
// --live: where the runtime put the probe container.

const files = (map) => (path) => {
	if (Object.hasOwn(map, path)) return map[path];
	throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
};
const ROOTLESS = "/user.slice/user-1234.slice/user@1234.service/pidispatch.slice/libpod-abc.scope/container";

test("--live: the probe under pidispatch.slice with the budget as its quota holds; the parent dir is derived from the process's own cgroup", () => {
	const v = cgroupParentVerdict({
		inspected: { code: 0, stdout: "pidispatch.slice|4242\n" },
		cpuBudgetCenti: 300,
		readFile: files({ "/proc/4242/cgroup": `0::${ROOTLESS}\n`, "/sys/fs/cgroup/user.slice/user-1234.slice/user@1234.service/pidispatch.slice/cpu.max": "300000 100000\n" }),
		bin: "podman",
	});
	assert.equal(v.ok, true);
	assert.equal(v.warn, undefined);
	assert.equal(v.placed, "/user.slice/user-1234.slice/user@1234.service/pidispatch.slice");
	assert.equal(v.quota, 300);
	assert.match(v.detail, /a quota of 3 CPUs \(300000 100000\), the host's CPU budget, so all jobs together keep the reserve/);
	// A leading slash in the record (cgroupfs spells it so) is the same parent.
	assert.equal(cgroupParentVerdict({ inspected: { code: 0, stdout: "/user.slice/user-1234.slice/user@1234.service/pidispatch.slice|7" }, readFile: files({ "/proc/7/cgroup": `0::${ROOTLESS}\n` }) }).ok, true, "a record of where the slice resolved");
	assert.equal(cgroupParentVerdict({ inspected: { code: 0, stdout: "/x/notpidispatch.slice|7" }, readFile: files({}) }).ok, false);
	assert.equal(cgroupParentVerdict({ inspected: { code: 0, stdout: "/pidispatch.slice|7" }, readFile: files({ "/proc/7/cgroup": "0::/pidispatch.slice/abc\n", "/sys/fs/cgroup/pidispatch.slice/cpu.max": "max 100000" }) }).ok, true);
});

test("--live: a wrong record or a cgroup outside the parent FAILS; a quota that is not the budget warns 'no host CPU reserve across jobs'", () => {
	const wrong = cgroupParentVerdict({ inspected: { code: 0, stdout: "user.slice|1" }, readFile: files({}) });
	assert.equal(wrong.ok, false);
	assert.match(wrong.detail, /recorded the parent "user\.slice", not pidispatch\.slice/);
	const outside = cgroupParentVerdict({ inspected: { code: 0, stdout: "pidispatch.slice|1" }, readFile: files({ "/proc/1/cgroup": "0::/system.slice/docker-abc.scope\n" }) });
	assert.equal(outside.ok, false);
	assert.match(outside.detail, /is \/system\.slice\/docker-abc\.scope, not under it/);
	const unset = cgroupParentVerdict({ inspected: { code: 0, stdout: "pidispatch.slice|1" }, cpuBudgetCenti: 300, readFile: files({ "/proc/1/cgroup": "0::/pidispatch.slice/docker-abc.scope\n", "/sys/fs/cgroup/pidispatch.slice/cpu.max": "max 100000\n" }) });
	assert.equal(unset.ok, true);
	assert.equal(unset.warn, true);
	assert.match(unset.detail, /which has no quota, not the CPU budget of 3: no host CPU reserve across jobs/);
	const off = cgroupParentVerdict({ inspected: { code: 0, stdout: "pidispatch.slice|1" }, cpuBudgetCenti: Infinity, readFile: files({ "/proc/1/cgroup": "0::/pidispatch.slice/x\n", "/sys/fs/cgroup/pidispatch.slice/cpu.max": "max 100000\n" }) });
	assert.equal(off.warn, undefined);
	assert.match(off.detail, /no quota, as the CPU budget is off/);
	const stale = cgroupParentVerdict({ inspected: { code: 0, stdout: "pidispatch.slice|1" }, cpuBudgetCenti: Infinity, readFile: files({ "/proc/1/cgroup": "0::/pidispatch.slice/x\n", "/sys/fs/cgroup/pidispatch.slice/cpu.max": "300000 100000\n" }) });
	assert.equal(stale.warn, true);
	assert.match(stale.detail, /not none \(the CPU budget is off\)/);
});

test("--live: what this host cannot read is said as such, never passed as proven", () => {
	const inVm = cgroupParentVerdict({ inspected: { code: 0, stdout: "pidispatch.slice|0" }, readFile: files({}) });
	assert.equal(inVm.ok, true);
	assert.equal(inVm.warn, true);
	assert.match(inVm.detail, /recorded the parent pidispatch\.slice; the container's own cgroup is not readable from this host/);
	const noQuota = cgroupParentVerdict({ inspected: { code: 0, stdout: "pidispatch.slice|5" }, cpuBudgetCenti: 300, readFile: files({ "/proc/5/cgroup": "0::/pidispatch.slice/x\n" }) });
	assert.equal(noQuota.warn, true);
	assert.match(noQuota.detail, /cpu\.max is not readable here/);
	const notChecked = cgroupParentVerdict({ inspected: { code: 0, stdout: "pidispatch.slice|5" }, readFile: files({ "/proc/5/cgroup": "0::/pidispatch.slice/x\n", "/sys/fs/cgroup/pidispatch.slice/cpu.max": "300000 100000" }) });
	assert.equal(notChecked.warn, undefined);
	assert.match(notChecked.detail, /which has a quota of 3 CPUs/);
	const noInspect = cgroupParentVerdict({ inspected: { code: 1, stdout: "" }, bin: "podman" });
	assert.deepEqual([noInspect.ok, noInspect.warn, noInspect.detail], [false, true, "not read back: podman inspect did not answer"]);
	// A venue that runs jobs without the parent: none recorded is right, and said as the fair-share fallback.
	const parentless = cgroupParentVerdict({ inspected: { code: 0, stdout: "user.slice|5" }, expected: null });
	assert.equal(parentless.ok, true);
	assert.match(parentless.detail, /capped at 1024: the egress proxy and Valkey get a fair share of the CPU, not a reserve/);
	assert.equal(cgroupParentVerdict({ inspected: { code: 0, stdout: "pidispatch.slice|5" }, expected: null }).ok, false);
});
