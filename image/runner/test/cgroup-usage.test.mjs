import assert from "node:assert/strict";
import { test } from "node:test";
import { CGROUP_ROOT, readCgroupUsage, RESOURCE_KEYS } from "../src/cgroup-usage.mjs";

/** A fake fs over a map of path -> contents; a path not in the map does not exist. */
function fakeFs(files) {
	return {
		readFileSync(path) {
			if (!Object.hasOwn(files, path)) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
			return files[path];
		},
		existsSync: (path) => Object.hasOwn(files, path) || Object.keys(files).some((f) => f.startsWith(`${path}/`)),
	};
}

// What a job saw on every venue of the issue #596 lab (Docker Desktop, rootful Docker 29, rootless Podman 4.9 and 5.8):
// a private cgroup namespace, the container's own cgroup at the mount's root.
const V2 = {
	"/proc/self/cgroup": "0::/\n",
	[`${CGROUP_ROOT}/cgroup.controllers`]: "cpuset cpu io memory hugetlb pids rdma\n",
	[`${CGROUP_ROOT}/memory.peak`]: "602259456\n",
	[`${CGROUP_ROOT}/memory.events`]: "low 0\nhigh 0\nmax 218\noom 10\noom_kill 1\noom_group_kill 0\n",
	[`${CGROUP_ROOT}/memory.pressure`]: "some avg10=0.00 avg60=0.00 avg300=0.00 total=1234\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=567\n",
	[`${CGROUP_ROOT}/cpu.stat`]: "usage_usec 50062\nuser_usec 7964\nsystem_usec 42098\nnr_periods 3\nnr_throttled 2\nthrottled_usec 900\nnr_bursts 0\nburst_usec 0\n",
	[`${CGROUP_ROOT}/pids.peak`]: "6\n",
};

test("reads every key off a cgroup v2 job, in RESOURCE_KEYS order", () => {
	const r = readCgroupUsage({ fs: fakeFs(V2) });
	assert.deepEqual(Object.keys(r), [...RESOURCE_KEYS]);
	assert.deepEqual(r, { memPeak: 602259456, oomKills: 1, memSomeUsec: 1234, memFullUsec: 567, cpuUsec: 50062, throttledUsec: 900, throttled: 2, pidsPeak: 6 });
});

test("only oom_kill is read from memory.events: under crun the job's leaf shows oom 0 and max 0 beside a real kill", () => {
	// Measured on rootless Podman 4.9 and 5.8 (issue #596 lab): the limit sits on the parent scope, so the OOM is counted
	// there, and only the kill is charged to the leaf the job sees.
	const r = readCgroupUsage({ fs: fakeFs({ ...V2, [`${CGROUP_ROOT}/memory.events`]: "low 0\nhigh 0\nmax 0\noom 0\noom_kill 1\noom_group_kill 0\n" }) });
	assert.equal(r.oomKills, 1);
	assert.ok(!("oom" in r) && !("memMax" in r), "the counters that read 0 there are not reported at all");
});

test("a missing file is null for its keys and nothing else", () => {
	const files = { ...V2 };
	delete files[`${CGROUP_ROOT}/memory.pressure`];
	delete files[`${CGROUP_ROOT}/pids.peak`];
	const r = readCgroupUsage({ fs: fakeFs(files) });
	assert.equal(r.memSomeUsec, null);
	assert.equal(r.memFullUsec, null);
	assert.equal(r.pidsPeak, null);
	assert.equal(r.memPeak, 602259456, "the rest still read");
	assert.equal(r.oomKills, 1);
});

test("a malformed value is null, never a guess: signs, floats, exponents, words and 2^53 and up", () => {
	for (const bad of ["-1\n", "1.5\n", "1e9\n", "max\n", "\n", "9007199254740993\n", "12345678901234567\n", "0x10\n"]) {
		const r = readCgroupUsage({ fs: fakeFs({ ...V2, [`${CGROUP_ROOT}/memory.peak`]: bad }) });
		assert.equal(r.memPeak, null, JSON.stringify(bad));
	}
	const mangled = readCgroupUsage({ fs: fakeFs({ ...V2, [`${CGROUP_ROOT}/memory.events`]: "oom_kill one\n", [`${CGROUP_ROOT}/cpu.stat`]: "garbage" }) });
	assert.equal(mangled.oomKills, null);
	assert.equal(mangled.cpuUsec, null);
	const extra = readCgroupUsage({ fs: fakeFs({ ...V2, [`${CGROUP_ROOT}/memory.events`]: "oom_kill 1 2\n" }) });
	assert.equal(extra.oomKills, null, "a line with an extra field is not a key/value");
	const noTotal = readCgroupUsage({ fs: fakeFs({ ...V2, [`${CGROUP_ROOT}/memory.pressure`]: "some avg10=0.00\nfull total=x\n" }) });
	assert.deepEqual([noTotal.memSomeUsec, noTotal.memFullUsec], [null, null]);
});

test("under a host cgroup namespace it reads the job's own cgroup, never the root's whole-machine counters", () => {
	const own = "/system.slice/docker-abc.scope";
	const files = { "/proc/self/cgroup": `0::${own}\n`, [`${CGROUP_ROOT}/cgroup.controllers`]: "cpu memory\n", [`${CGROUP_ROOT}/cpu.stat`]: "usage_usec 999999999\n" };
	for (const [name, body] of Object.entries(V2)) if (name.startsWith(`${CGROUP_ROOT}/`) && !name.endsWith("cgroup.controllers")) files[name.replace(CGROUP_ROOT, `${CGROUP_ROOT}${own}`)] = body;
	const r = readCgroupUsage({ fs: fakeFs(files) });
	assert.equal(r.cpuUsec, 50062, "the job's own cpu.stat, not the host root's");
	assert.equal(r.memPeak, 602259456);
});

test("a cgroup path that tries to leave the mount reads nothing", () => {
	const r = readCgroupUsage({ fs: fakeFs({ ...V2, "/proc/self/cgroup": "0::/../../etc\n" }) });
	assert.equal(r, null);
});

test("cgroup v1 reads the cheap half and leaves the rest null", () => {
	const files = {
		"/proc/self/cgroup": "12:memory:/\n11:cpu,cpuacct:/\n",
		[`${CGROUP_ROOT}/memory/memory.max_usage_in_bytes`]: "123456\n",
		[`${CGROUP_ROOT}/memory/memory.oom_control`]: "oom_kill_disable 0\nunder_oom 0\noom_kill 2\n",
		[`${CGROUP_ROOT}/cpuacct/cpuacct.usage`]: "5000000\n",
		[`${CGROUP_ROOT}/cpu/cpu.stat`]: "nr_periods 10\nnr_throttled 3\nthrottled_time 7000\n",
	};
	const r = readCgroupUsage({ fs: fakeFs(files) });
	assert.deepEqual(r, { memPeak: 123456, oomKills: 2, memSomeUsec: null, memFullUsec: null, cpuUsec: 5000, throttledUsec: 7, throttled: 3, pidsPeak: null });
});

test("no cgroup filesystem at all is null, and nothing a filesystem does makes it throw", () => {
	assert.equal(readCgroupUsage({ fs: fakeFs({}) }), null);
	const throwing = {
		readFileSync() {
			throw new Error("boom");
		},
		existsSync() {
			throw new Error("boom");
		},
	};
	assert.equal(readCgroupUsage({ fs: throwing }), null);
	assert.equal(readCgroupUsage({ fs: null }), null);
	// Every file unreadable under a v2 mount: no key at all, so no block.
	assert.equal(readCgroupUsage({ fs: fakeFs({ "/proc/self/cgroup": "0::/\n", [`${CGROUP_ROOT}/cgroup.controllers`]: "" }) }), null);
});
