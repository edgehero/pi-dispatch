import assert from "node:assert/strict";
import { test } from "node:test";
import { cpuReserveChecks, doctorCpuReserve, finishDoctorCpuReserve } from "../src/doctor.mjs";
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
	const reads = await doctorCpuReserve({ daemon: docker, podman, run, image: "pi-job:pinned", imagePresent: true, platform: "darwin", pid: 4242 });
	assert.deepEqual(reads.map((r) => [r.plan.venue, r.plan.method, r.read]), [["local", "helper", { ok: true, cpuCenti: 1300 }], ["podman", "user-systemd", { ok: true, cpuCenti: 300 }]]);
	// Issue #978: doctor's own helper name (no worker name declared here, issue #1040: this process's pid in it), removed
	// before its read with `rm -f`. A daemon not observed on this host is not swept: no listing.
	const name = "pi-dispatch-cpu-reserve-doctor-e3b0c442-4242";
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

test("issue #978: doctor's helper runs under doctor's own name for the declared worker and its pid, is removed before its read and again after a timeout, both `rm -f` of that name only, and a 125 says the refusal is not another doctor's", async () => {
	const name = helperName("box-1", { doctor: true, pid: 4242 });
	assert.equal(name, "pi-dispatch-cpu-reserve-doctor-96fb257c-4242");
	assert.notEqual(name, helperName("box-1"), "never the worker's, so a doctor never removes the worker's helper mid-step");
	const docker = { answered: true, facts: { cgroupDriver: "cgroupfs", cgroupVersion: "v2", rootless: false } };
	const calls = [];
	const run = async (bin, args, { timeoutMs }) => {
		calls.push([bin, ...args.slice(0, 4), timeoutMs]);
		return args[0] === "run" ? { code: null, stdout: "", error: { timedOut: true } } : { code: 0, stdout: "" };
	};
	const [timedOut] = await doctorCpuReserve({ daemon: docker, run, image: "pi-job:pinned", imagePresent: true, platform: "darwin", workerName: "box-1", pid: 4242 });
	assert.deepEqual(timedOut.read, { ok: false, reason: "timeout" });
	assert.deepEqual(calls, [
		["docker", "rm", "-f", name, 15_000],
		["docker", "run", "--rm", "--name", name, 15_000],
		["docker", "rm", "-f", name, 15_000],
	]);
	// Issue #1040: 125 after doctor's `rm -f` of a name only this run uses is no other doctor's read; the line says what
	// it can be, and that running doctor again (a new pid, a new name) tells the two apart.
	const taken = async (bin, args) => (args[0] === "run" ? { code: 125, stdout: "" } : { code: 0, stdout: "" });
	const [busy] = await doctorCpuReserve({ daemon: docker, run: taken, image: "pi-job:pinned", imagePresent: true, platform: "darwin", workerName: "box-1", pid: 4242 });
	assert.deepEqual(busy.read, { ok: false, reason: "exit-125" });
	const [said] = line([busy], 1300);
	assert.equal(said.warn, true);
	assert.equal(said.label, "local: no host CPU reserve across jobs could be confirmed: the quota of pidispatch.slice was not readable (exit-125: the runtime refused the helper, under a name only this doctor run uses, so it refused the helper itself or kept a name the rm before it did not clear)");
	assert.equal(said.fix, "run doctor again, whose helper gets a name of its own; if it is refused again, the runtime refuses the helper itself: the worker writes it when it starts and re-checks it every ten minutes; start or restart the worker");
	assert.doesNotMatch(`${said.label} ${said.fix}`, /another doctor/);
	// A systemctl read that exits 125 is no helper's name, and keeps the plain line.
	const [plain] = line([{ plan: plan("local", "system-systemd"), read: { ok: false, reason: "exit-125" } }], 300);
	assert.match(plain.label, /was not readable \(exit-125\)$/);
});

/**
 * A daemon by container name for doctor's CPU-reserve step: `ps -a --filter name=<p>` lists every name that contains
 * `p` (the runtime's substring match) with its state, a plain `rm` refuses a running container and removes any other, `rm
 * -f` removes any (a missing name exits 0 under `-f`, 1 without), a helper `run` under a name still taken is refused at
 * once with 125, and one that runs is gone after (AutoRemove). `refuse` names the containers whose rm fails; `list`
 * answers the listing instead.
 */
function namedDaemon(held, { refuse = [], list = null } = {}) {
	const containers = new Map(held);
	const calls = [];
	const run = async (bin, args) => {
		calls.push(args.join(" "));
		if (args[0] === "ps") {
			if (list) return list;
			const sub = args[args.indexOf("--filter") + 1].slice("name=".length);
			return { code: 0, stdout: [...containers].filter(([n]) => n.includes(sub)).map(([n, st]) => `${n}\t${st}\n`).join("") };
		}
		if (args[0] === "rm") {
			const target = args.at(-1);
			if (!containers.has(target)) return { code: args[1] === "-f" ? 0 : 1, stdout: "" };
			if (refuse.includes(target) || (args[1] !== "-f" && containers.get(target) === "running")) return { code: 1, stdout: "" };
			containers.delete(target);
			return { code: 0, stdout: `${target}\n` };
		}
		if (args[0] === "run") return containers.has(args[args.indexOf("--name") + 1]) ? { code: 125, stdout: "" } : { code: 0, stdout: "1300000 100000\n" };
		return { code: 0, stdout: "" };
	};
	return { containers, calls, run };
}
const CGROUPFS = { answered: true, facts: { cgroupDriver: "cgroupfs", cgroupVersion: "v2", rootless: false } };

test("issue #1040: two doctors of one deployment, at once, never remove each other's helper, created or running, on a daemon this host owns or not", async () => {
	const theirs = helperName("box-1", { doctor: true, pid: 100 });
	const mine = helperName("box-1", { doctor: true, pid: 200 });
	assert.notEqual(mine, theirs);
	for (const state of ["created", "running"]) {
		for (const endpointLocal of [true, false]) {
			const d = namedDaemon([[theirs, state]]);
			const [read] = await doctorCpuReserve({ daemon: CGROUPFS, endpointLocal, run: d.run, image: "pi-job:pinned", imagePresent: true, platform: "darwin", workerName: "box-1", pid: 200, isAlive: (p) => p === 100 });
			assert.equal(d.containers.get(theirs), state, `${state}, owned ${endpointLocal}: the other doctor's helper is left`);
			assert.deepEqual(read.read, { ok: true, cpuCenti: 1300 }, "and this doctor reads under its own name");
			assert.ok(!d.calls.some((c) => c.startsWith("rm") && c.endsWith(theirs)), "no rm of the other doctor's name");
			assert.deepEqual(d.calls.filter((c) => c.startsWith("rm")), [`rm -f ${mine}`], "the only rm is of its own name");
			assert.equal(read.swept === undefined, !endpointLocal, "listed only on a daemon this host owns");
		}
	}
	// A create of the other doctor's that lands after its own bound, while this doctor reads: its name is not this one's,
	// so this read is not refused and nothing of the other's is touched.
	const late = namedDaemon([]);
	const run = async (bin, args, opts) => {
		if (args[0] === "run") late.containers.set(theirs, "created");
		return late.run(bin, args, opts);
	};
	const [read] = await doctorCpuReserve({ daemon: CGROUPFS, endpointLocal: true, run, image: "pi-job:pinned", imagePresent: true, platform: "darwin", workerName: "box-1", pid: 200, isAlive: () => true });
	assert.deepEqual(read.read, { ok: true, cpuCenti: 1300 });
	assert.equal(late.containers.get(theirs), "created");
});

test("issue #1040: on a daemon this host owns doctor first removes the helpers of dead doctors by pid, any hex8, any state, and keeps a live pid's, a look-alike's and the old shared name; on a daemon it does not own nothing is listed", async () => {
	const named = (hex8, pid) => `pi-dispatch-cpu-reserve-doctor-${hex8}-${pid}`;
	const held = [
		[named("96fb257c", 100), "created"],
		[named("e3b0c442", 101), "exited"],
		[named("96fb257c", 102), "running"],
		[named("96fb257c", 4242), "created"],
		[named("96fb257c", 200), "created"],
		[named("96fb257c", "0100"), "created"],
		[named("96fb257c", "1e3"), "created"],
		["pi-dispatch-cpu-reserve-doctor-96fb257c", "created"],
		["x-pi-dispatch-cpu-reserve-doctor-96fb257c-100", "created"],
		[named("96FB257C", 100), "created"],
		["pi-dispatch-cpu-reserve-96fb257c", "created"],
	];
	const kept = held.map(([n]) => n).slice(4);
	// This doctor's own pid reads alive, as it is: its own leftover goes by the own-pid rule, not for a dead pid.
	const opts = { daemon: CGROUPFS, image: "pi-job:pinned", imagePresent: true, platform: "darwin", workerName: "box-1", pid: 4242, isAlive: (p) => p === 200 || p === 4242 };
	const d = namedDaemon(held);
	const [read] = await doctorCpuReserve({ ...opts, endpointLocal: true, run: d.run });
	assert.deepEqual([...d.containers.keys()].sort(), [...kept].sort(), "dead pids' helpers and this pid's own leftover go; the rest stay");
	assert.deepEqual(d.calls.slice(0, 5), [
		"ps -a --filter name=pi-dispatch-cpu-reserve-doctor- --format {{.Names}}\t{{.State}}",
		`rm ${named("96fb257c", 100)}`,
		`rm ${named("e3b0c442", 101)}`,
		`rm -f ${named("96fb257c", 102)}`,
		`rm ${named("96fb257c", 4242)}`,
	], "a plain rm for what never ran or has stopped, `rm -f` for a running one, before the read");
	assert.deepEqual(read.read, { ok: true, cpuCenti: 1300 });
	const lines = line([read], 1300);
	assert.deepEqual(lines[0], { ok: true, label: `local: removed the CPU-reserve helpers ${[100, 101, 102, 4242].map((p, i) => named(i === 1 ? "e3b0c442" : "96fb257c", p)).join(", ")}, left by an EARLIER doctor run` });
	assert.match(lines[1].label, /^local: every job runs under pidispatch\.slice, whose quota is 13 CPUs/);
	// Not owned: no listing, nothing removed, only its own name's `rm -f` before the read.
	const far = namedDaemon(held);
	const [remote] = await doctorCpuReserve({ ...opts, endpointLocal: false, run: far.run });
	assert.equal(far.containers.size, held.length - 1);
	assert.ok(!far.calls.some((c) => c.startsWith("ps")), "nothing listed");
	assert.deepEqual(far.calls.filter((c) => c.startsWith("rm")), [`rm -f ${named("96fb257c", 4242)}`]);
	assert.equal(remote.swept, undefined);
	assert.equal(line([remote], 1300).length, 1, "no sweep line");
	// A clean daemon says nothing more than before; a helper that would not go is a warning with the command; a listing
	// that failed is a warning with the listing, and the read still runs.
	const clean = namedDaemon([]);
	assert.equal(line(await doctorCpuReserve({ ...opts, endpointLocal: true, run: clean.run }), 1300).length, 1);
	const stuck = namedDaemon([[named("96fb257c", 100), "created"]], { refuse: [named("96fb257c", 100)] });
	const [s1, s2] = line(await doctorCpuReserve({ ...opts, endpointLocal: true, run: stuck.run }), 1300);
	assert.deepEqual(s1, { ok: false, warn: true, label: `local: the CPU-reserve helper ${named("96fb257c", 100)}, left by an EARLIER doctor run, could not be removed: docker rm -f ${named("96fb257c", 100)}`, fix: "run the command once the daemon answers; the next pi-dispatch doctor on this host tries again" });
	assert.equal(s2.ok, true);
	const blind = namedDaemon([], { list: { code: 1, stdout: "" } });
	const [b1, b2] = line(await doctorCpuReserve({ ...opts, endpointLocal: true, run: blind.run }), 1300);
	assert.deepEqual(b1, { ok: false, warn: true, label: "local: CPU-reserve helpers from an EARLIER doctor run could not be listed: docker ps -a --filter name=pi-dispatch-cpu-reserve-doctor-", fix: "run the command yourself; a daemon that cannot list is usually the real problem, and the next doctor lists them again" });
	assert.equal(b2.ok, true);
	// The job image gone: the sweep still runs (a killed doctor's helper is left either way), the read does not.
	const noImage = namedDaemon([[named("96fb257c", 100), "created"]]);
	const [absent] = await doctorCpuReserve({ ...opts, imagePresent: false, endpointLocal: true, run: noImage.run });
	assert.equal(noImage.containers.size, 0);
	assert.deepEqual(absent.read, { ok: false, reason: "job-image-absent" });
	// Every call of the step is bounded at the reserve's 15 s.
	const bounds = [];
	await doctorCpuReserve({ ...opts, endpointLocal: true, run: async (bin, args, { timeoutMs }) => (bounds.push(timeoutMs), { code: 0, stdout: args[0] === "run" ? "1300000 100000\n" : "" }) });
	assert.ok(bounds.length === 3 && bounds.every((t) => t === 15_000), JSON.stringify(bounds));
});

/**
 * Issue #1113: issue #1022's daemon for doctor's helper. The helper's create is killed at its bound, the guard's rm -f
 * right after it times out, and the create lands after that rm, so the name is held `created` when the step ends.
 * `finalRm(held)` answers the rm at the end of the run and `listing(held, args)` the listing after it; the sweep's own
 * listing (a prefix filter) answers what is held. Every call is recorded with its bound.
 */
function lateCreateDaemon(name, { finalRm = (held) => (held.delete(name), { code: 0, stdout: "" }), listing = (held) => ({ code: 0, stdout: [...held].map(([n, st]) => `${n}\t${st}\n`).join("") }) } = {}) {
	const held = new Map();
	const calls = [];
	let rms = 0;
	const run = async (bin, args, { timeoutMs }) => {
		calls.push(`${bin} ${args.join(" ")} @${timeoutMs}`);
		if (args[0] === "run") return { code: null, stdout: "", error: { timedOut: true } };
		if (args[0] === "rm") {
			rms += 1;
			if (rms === 1) return { code: 0, stdout: "" };
			if (rms === 2) {
				held.set(name, "created");
				return { code: null, stdout: "", error: { timedOut: true } };
			}
			return finalRm(held);
		}
		if (args[0] === "ps") return args.includes(`name=${name}`) ? listing(held, args) : { code: 0, stdout: "" };
		return { code: 0, stdout: "" };
	};
	return { run, calls, held };
}

test("issue #1113: a doctor whose read did not end cleanly runs one more rm -f of its own name at the end of its run, then one listing; gone says nothing, still there warns with who removes it and the command", async () => {
	const name = helperName("box-1", { doctor: true, pid: 4242 });
	const opts = { daemon: CGROUPFS, image: "pi-job:pinned", imagePresent: true, platform: "darwin", workerName: "box-1", pid: 4242, isAlive: () => false };
	const list = `ps -a --filter name=${name} --format {{.Names}}\t{{.State}}`;
	// The late create landed: the step ends with the name held and the guard dirty.
	const d = lateCreateDaemon(name);
	const reads = await doctorCpuReserve({ ...opts, endpointLocal: false, run: d.run });
	assert.deepEqual(reads[0].read, { ok: false, reason: "timeout" });
	assert.equal(d.held.get(name), "created", "the premise: the guard's own rm timed out and the create landed after it");
	assert.equal(reads[0].helper.state.dirty, true);
	const before = d.calls.length;
	assert.deepEqual(await finishDoctorCpuReserve(reads, { run: d.run }), [], "removed: nothing to say");
	assert.deepEqual(d.calls.slice(before), [`docker rm -f ${name} @15000`, `docker ${list} @15000`], "one rm -f of its own name, one listing, both bounded");
	assert.equal(d.held.size, 0);
	// A slow rm (it times out again): the listing finds the name, and the warning says so, per who can remove it later.
	for (const [endpointLocal, later] of [
		[false, "the worker's ten-minute check removes it once it is ten minutes old"],
		[true, "the next doctor run removes it, and so does the worker's ten-minute check once it is ten minutes old"],
	]) {
		const slow = lateCreateDaemon(name, { finalRm: () => ({ code: null, stdout: "", error: { timedOut: true } }) });
		const left = await finishDoctorCpuReserve(await doctorCpuReserve({ ...opts, endpointLocal, run: slow.run }), { run: slow.run });
		assert.deepEqual(left, [{ ok: false, warn: true, label: `local: this doctor run's CPU-reserve helper ${name} is still on the daemon (created) after one more rm -f at the end of the run; ${later}`, fix: `remove it now: docker rm -f ${name}` }]);
		assert.deepEqual(slow.calls.slice(-2), [`docker rm -f ${name} @15000`, `docker ${list} @15000`]);
	}
	// A listing that fails, by an exit or a timeout, cannot say the name is gone: the warning says it may be there.
	for (const [answer, reason] of [[{ code: 1, stdout: "" }, "exit-1"], [{ code: null, stdout: "", error: { timedOut: true } }, "timeout"]]) {
		const blind = lateCreateDaemon(name, { listing: () => answer });
		const [said] = await finishDoctorCpuReserve(await doctorCpuReserve({ ...opts, endpointLocal: false, run: blind.run }), { run: blind.run });
		assert.equal(said.label, `local: this doctor run's CPU-reserve helper ${name} may still be on the daemon: the listing after one more rm -f at the end of the run failed (${reason}); the worker's ten-minute check removes it once it is ten minutes old`);
		assert.deepEqual([said.ok, said.warn, said.fix], [false, true, `remove it now: docker rm -f ${name}`]);
	}
	// The name filter is a substring match: another pid's helper whose name begins with this one is not this one.
	const lookalike = lateCreateDaemon(name, { listing: () => ({ code: 0, stdout: `${name}0\tcreated\nnot a row\n` }) });
	assert.deepEqual(await finishDoctorCpuReserve(await doctorCpuReserve({ ...opts, endpointLocal: false, run: lookalike.run }), { run: lookalike.run }), []);
});

test("issue #1113: a read that ended cleanly, browser setup's read-only run, and a venue whose helper never ran cost nothing at the end of the run", async () => {
	const opts = { daemon: CGROUPFS, image: "pi-job:pinned", platform: "darwin", workerName: "box-1", pid: 4242, isAlive: () => false, endpointLocal: false };
	const calls = [];
	const run = async (bin, args) => (calls.push(args.join(" ")), { code: 0, stdout: args[0] === "run" ? "1300000 100000\n" : "" });
	const clean = await doctorCpuReserve({ ...opts, imagePresent: true, run });
	assert.deepEqual(clean[0].read, { ok: true, cpuCenti: 1300 });
	assert.equal(clean[0].helper.state.dirty, false);
	const before = calls.length;
	assert.deepEqual(await finishDoctorCpuReserve(clean, { run }), []);
	assert.equal(calls.length, before, "no extra call after a clean step");
	// Dirty, but browser setup's run starts and removes nothing (and its read never ran a helper either).
	const dirty = [{ plan: plan("local", "helper"), read: { ok: false, reason: "timeout" }, helper: { name: helperName("box-1", { doctor: true, pid: 4242 }), bin: "docker", state: { dirty: true }, endpointLocal: true } }];
	assert.deepEqual(await finishDoctorCpuReserve(dirty, { run, readOnly: true }), []);
	const readOnly = await doctorCpuReserve({ ...opts, imagePresent: true, run, readOnly: true });
	assert.equal(Object.hasOwn(readOnly[0], "helper"), false);
	// No job image, a systemctl venue, or nothing read at all: no helper, nothing to do.
	const absent = await doctorCpuReserve({ ...opts, imagePresent: false, run });
	const systemd = await doctorCpuReserve({ daemon: { answered: true, facts: { cgroupDriver: "systemd", cgroupVersion: "v2" } }, endpointLocal: true, run: async () => ({ code: 0, stdout: "3s" }), platform: "linux" });
	for (const reads of [absent, systemd, [], null, undefined]) assert.deepEqual(await finishDoctorCpuReserve(reads, { run }), []);
	assert.equal(calls.length, before);
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
