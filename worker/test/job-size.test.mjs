import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { containerSpec, memoryBytes, memoryBytesOfArgs } from "../src/container-spec.mjs";
import { buildDockerRunArgs, buildPodmanRunArgs, dockerArgsFromSpec } from "../src/docker-run.mjs";
import {
	cpuRangeRefusal,
	unenforcedSizeFlags,
	CPU_SHARES_MAX,
	CPU_SHARES_MIN,
	DEFAULT_JOB_CPUS,
	DEFAULT_JOB_MEMORY,
	DEFAULT_JOB_SIZE,
	JOB_CPUS_CEILING_CENTI,
	JOB_CPUS_FLOOR_CENTI,
	JOB_MEMORY_CEILING_MIB,
	JOB_MEMORY_FLOOR_MIB,
	JOB_SIZE_SOURCES,
	containerSizing,
	cpuSharesOf,
	formatCpus,
	formatMemory,
	hostCpuCeiling,
	jobSizeDefaults,
	parseCpus,
	parseMemory,
	recordedJobSize,
	resolveJobSize,
	shmMiBOf,
} from "../src/job-size.mjs";
import { projectScope } from "../src/scoped-limits.mjs";

const MiB = 1024 * 1024;

test("parseMemory takes whole m or g at or above 512m, as MiB, and refuses every other spelling naming the rule", () => {
	assert.equal(parseMemory("512m"), 512);
	assert.equal(parseMemory("1536m"), 1536);
	assert.equal(parseMemory("1g"), 1024);
	assert.equal(parseMemory("4g"), 4096);
	assert.equal(parseMemory("1024g"), JOB_MEMORY_CEILING_MIB);
	assert.equal(parseMemory("1048576m"), JOB_MEMORY_CEILING_MIB);
	for (const bad of ["", "4", "4G", "4gb", "4 g", " 4g", "0g", "04g", "4.5g", "-1g", "4k", "4t", "4096b", "1e3m", 4096, null, undefined, {}]) {
		assert.throws(() => parseMemory(bad), /a memory size is a whole number of megabytes or gigabytes/, JSON.stringify(bad) ?? "undefined");
	}
	assert.throws(() => parseMemory("511m"), /at least 512m/);
	assert.throws(() => parseMemory("1025g"), /at most 1024g/);
	assert.throws(() => parseMemory("1048577m"), /at most 1024g/);
	// A value of any length is refused without becoming an unsafe number on the way.
	assert.throws(() => parseMemory(`${"9".repeat(400)}g`), /at most 1024g/);
});

test("parseCpus takes a number or decimal string above 0 with at most two decimals, from 0.25 to 256, as hundredths", () => {
	assert.equal(parseCpus(0.25), 25);
	assert.equal(parseCpus("0.5"), 50);
	assert.equal(parseCpus(2), 200);
	assert.equal(parseCpus("2"), 200);
	assert.equal(parseCpus(1.25), 125);
	assert.equal(parseCpus("1.05"), 105);
	assert.equal(parseCpus(0.29), 29, "0.29 is not 0.28999...: the decimal spelling is read, not the float");
	assert.equal(parseCpus(256), JOB_CPUS_CEILING_CENTI);
	for (const bad of ["", " 2", "2.", ".5", "0.125", 0.125, "1e2", 1e-7, -1, "-1", "+1", NaN, Infinity, "02", "2,5", null, undefined, true]) {
		assert.throws(() => parseCpus(bad), /a CPU size is a number above 0 with at most two decimals/, String(bad));
	}
	assert.throws(() => parseCpus(0), /at least 0.25/);
	assert.throws(() => parseCpus("0.24"), /at least 0.25/);
	assert.throws(() => parseCpus(256.01), /at most 256/);
});

test("formatMemory and formatCpus write one spelling per size, which the parsers read back to the same integer", () => {
	assert.equal(formatMemory(4096), "4g");
	assert.equal(formatMemory(1536), "1536m");
	assert.equal(formatMemory(512), "512m");
	assert.equal(formatCpus(25), "0.25");
	assert.equal(formatCpus(50), "0.5");
	assert.equal(formatCpus(105), "1.05");
	assert.equal(formatCpus(200), "2");
	for (let centi = JOB_CPUS_FLOOR_CENTI; centi <= JOB_CPUS_CEILING_CENTI; centi++) {
		assert.equal(parseCpus(formatCpus(centi)), centi);
		assert.equal(parseCpus(Number(formatCpus(centi))), centi);
	}
});

test("EVERY size parseMemory accepts round-trips through the emitted --memory and memoryBytes, so the 90% OOM rule works at every size", () => {
	// The whole accepted range, both spellings: what an operator writes, the one spelling the worker emits, and the bytes
	// the OOM confirmation reads back off the argv. A size memoryBytes could not read would leave every OOM at it unconfirmed.
	for (let mib = JOB_MEMORY_FLOOR_MIB; mib <= JOB_MEMORY_CEILING_MIB; mib++) {
		assert.equal(parseMemory(`${mib}m`), mib);
		if (mib % 1024 === 0) assert.equal(parseMemory(`${mib / 1024}g`), mib);
		const emitted = formatMemory(mib);
		if (memoryBytes(emitted) !== mib * MiB || parseMemory(emitted) !== mib) assert.fail(`${mib} MiB emits ${emitted}, which reads back as ${memoryBytes(emitted)} bytes`);
	}
	// And through the real argv of both runtimes, for every whole gigabyte and a dense run of odd sizes.
	const sizes = [];
	for (let mib = JOB_MEMORY_FLOOR_MIB; mib <= 9000; mib += 7) sizes.push(mib);
	for (let g = 1; g <= 1024; g++) sizes.push(g * 1024);
	for (const memMiB of sizes) {
		const opts = { image: "i", name: "n", workspace: "/w", size: { memMiB, cpuCenti: 200 } };
		assert.equal(memoryBytesOfArgs(buildDockerRunArgs(opts)), memMiB * MiB, `docker argv at ${memMiB} MiB`);
		assert.equal(memoryBytesOfArgs(buildPodmanRunArgs({ ...opts, user: "1234:1234" })), memMiB * MiB, `podman argv at ${memMiB} MiB`);
	}
});

test("a size becomes --memory, an EQUAL --memory-swap, the host ceiling as --cpus, round(cpus x 1024) shares and min(1g, memory/2) of shm", () => {
	assert.deepEqual(containerSizing({ memMiB: 4096, cpuCenti: 200 }, 14), { memory: "4g", memorySwap: "4g", cpus: "13", cpuShares: 2048, shmSize: "1g" });
	assert.deepEqual(containerSizing({ memMiB: 1024, cpuCenti: 50 }, 4), { memory: "1g", memorySwap: "1g", cpus: "3", cpuShares: 512, shmSize: "512m" });
	assert.deepEqual(containerSizing({ memMiB: 512, cpuCenti: 25 }, 2), { memory: "512m", memorySwap: "512m", cpus: "2", cpuShares: 256, shmSize: "256m" });
	assert.deepEqual(containerSizing({ memMiB: 1536, cpuCenti: 125 }, null), { memory: "1536m", memorySwap: "1536m", cpus: null, cpuShares: 1280, shmSize: "768m" });
	assert.equal(shmMiBOf(2048), 1024);
	assert.equal(shmMiBOf(2049), 1024);
	assert.equal(shmMiBOf(2047), 1023);
	assert.throws(() => containerSizing({ memMiB: 511, cpuCenti: 200 }), /refusing a job size/);
	assert.throws(() => containerSizing({ memMiB: 4096, cpuCenti: 24 }), /refusing a job size/);
	assert.throws(() => containerSizing({ memMiB: "4096", cpuCenti: 200 }), /refusing a job size/);
	assert.throws(() => containerSizing(null), /refusing a job size/);
});

test("cpu shares stay inside the runtime's range at every accepted size, and the clamp holds a hand-built one", () => {
	assert.equal(cpuSharesOf(JOB_CPUS_FLOOR_CENTI), 256);
	assert.equal(cpuSharesOf(JOB_CPUS_CEILING_CENTI), CPU_SHARES_MAX);
	assert.equal(cpuSharesOf(0), CPU_SHARES_MIN);
	assert.equal(cpuSharesOf(JOB_CPUS_CEILING_CENTI + 1), CPU_SHARES_MAX);
	// Measured mapping (issue #596): runc 1.1.13 / crun 1.14 give 2048 -> 79, runc 1.5.1 / crun 1.27 give 2048 -> 174.
	// Both are monotonic, so a bigger size is never a smaller weight; the order between jobs is what the shares carry.
	let last = 0;
	for (let centi = JOB_CPUS_FLOOR_CENTI; centi <= JOB_CPUS_CEILING_CENTI; centi++) {
		const shares = cpuSharesOf(centi);
		assert.ok(shares >= last && shares >= CPU_SHARES_MIN && shares <= CPU_SHARES_MAX, `${centi}`);
		last = shares;
	}
});

test("the --cpus ceiling is the runtime's CPU count minus one when it has four or more, else all of it, else nothing", () => {
	assert.deepEqual([1, 2, 3, 4, 5, 14, 64].map(hostCpuCeiling), [1, 2, 3, 3, 4, 13, 63]);
	for (const unknown of [null, undefined, 0, -4, 2.5, "4", NaN, Infinity]) assert.equal(hostCpuCeiling(unknown), null, String(unknown));
});

test("the default size is 4g and 2, derived from the two default spellings, and a spec built with no size gets it", () => {
	assert.equal(DEFAULT_JOB_MEMORY, "4g");
	assert.equal(DEFAULT_JOB_CPUS, "2");
	assert.deepEqual(DEFAULT_JOB_SIZE, { memMiB: 4096, cpuCenti: 200, source: "default" });
	const spec = containerSpec({ image: "i", name: "n", workspace: "/w" });
	assert.deepEqual([spec.memory, spec.memorySwap, spec.cpus, spec.cpuShares, spec.shmSize], ["4g", "4g", null, 2048, "1g"]);
	const args = dockerArgsFromSpec(spec);
	assert.deepEqual(args.slice(args.indexOf("--memory=4g"), args.indexOf("--memory=4g") + 4), ["--memory=4g", "--memory-swap=4g", "--cpu-shares=2048", "--shm-size=1g"]);
	assert.equal(args.some((a) => a.startsWith("--cpus")), false, "no runtime CPU count, no ceiling");
});

test("PI_JOB_MEMORY and PI_JOB_CPUS: unset or empty is the built-in default, a bad value is refused naming the key", () => {
	assert.deepEqual(jobSizeDefaults({}), { memMiB: 4096, cpuCenti: 200, memSet: false, cpuSet: false });
	assert.deepEqual(jobSizeDefaults({ PI_JOB_MEMORY: "", PI_JOB_CPUS: "" }), { memMiB: 4096, cpuCenti: 200, memSet: false, cpuSet: false });
	assert.deepEqual(jobSizeDefaults({ PI_JOB_MEMORY: "2g", PI_JOB_CPUS: "0.5" }), { memMiB: 2048, cpuCenti: 50, memSet: true, cpuSet: true });
	assert.throws(() => jobSizeDefaults({ PI_JOB_MEMORY: "4GB" }), /^Error: PI_JOB_MEMORY: a memory size is a whole number/);
	assert.throws(() => jobSizeDefaults({ PI_JOB_CPUS: "0.1" }), /^Error: PI_JOB_CPUS: a CPU size must be at least 0.25/);
});

test("resolveJobSize: the project row's fields win one by one, then the deployment's settings, then 4g and 2, and source names the most specific", () => {
	const limits = [
		{ scope: "acme/web", day: 3 },
		{ scope: projectScope("heavy"), memory: "16g", cpus: 4 },
		{ scope: projectScope("memonly"), memory: "1536m", cpus: null },
		{ scope: projectScope("counts"), concurrent: 2, memory: null, cpus: null },
	];
	assert.deepEqual(resolveJobSize({ project: "heavy", limits, env: { PI_JOB_MEMORY: "2g" } }), { memMiB: 16384, cpuCenti: 400, source: "project" });
	assert.deepEqual(resolveJobSize({ project: "memonly", limits, env: { PI_JOB_CPUS: "1" } }), { memMiB: 1536, cpuCenti: 100, source: "project" });
	assert.deepEqual(resolveJobSize({ project: "counts", limits, env: { PI_JOB_CPUS: "1" } }), { memMiB: 4096, cpuCenti: 100, source: "env" });
	assert.deepEqual(resolveJobSize({ project: "counts", limits, env: {} }), { memMiB: 4096, cpuCenti: 200, source: "default" });
	assert.deepEqual(resolveJobSize({ project: null, limits, env: { PI_JOB_MEMORY: "8g" } }), { memMiB: 8192, cpuCenti: 200, source: "env" });
	assert.deepEqual(resolveJobSize({ project: "absent", limits }), { memMiB: 4096, cpuCenti: 200, source: "default" });
	// A repo row never sizes a job, even one whose scope string happens to look like a project id.
	assert.deepEqual(resolveJobSize({ project: "acme/web", limits: [{ scope: "acme/web", memory: "8g" }] }), { memMiB: 4096, cpuCenti: 200, source: "default" });
	assert.deepEqual(resolveJobSize(), { memMiB: 4096, cpuCenti: 200, source: "default" });
});

test("the project row prefix job-size.mjs matches is the one scoped-limits.mjs writes", () => {
	const src = readFileSync(new URL("../src/job-size.mjs", import.meta.url), "utf8");
	const prefix = /const PROJECT_ROW_PREFIX = "([^"]+)";/.exec(src)?.[1];
	assert.equal(`${prefix}x`, projectScope("x"));
	assert.equal(/^import /m.test(src), false, "job-size.mjs is a leaf: container-spec.mjs imports it and must stay import-light");
});

test("a recorded size is rebuilt from its three fields, and anything else is null", () => {
	assert.deepEqual(recordedJobSize({ memMiB: 2048, cpuCenti: 50, source: "project", extra: "x" }), { memMiB: 2048, cpuCenti: 50, source: "project" });
	for (const source of JOB_SIZE_SOURCES) assert.equal(recordedJobSize({ memMiB: 2048, cpuCenti: 50, source })?.source, source);
	assert.deepEqual(JOB_SIZE_SOURCES, ["project", "env", "default"]);
	for (const bad of [null, undefined, [], "4g", { memMiB: 2048, cpuCenti: 50 }, { memMiB: 2048, cpuCenti: 50, source: "trigger" }, { memMiB: 100, cpuCenti: 50, source: "env" }, { memMiB: 2048, cpuCenti: 50.5, source: "env" }]) {
		assert.equal(recordedJobSize(bad), null, JSON.stringify(bad) ?? "undefined");
	}
});

test("cpuRangeRefusal reads the count off Docker's refusal of a --cpus above its CPUs, and nothing else (issue #596)", () => {
	// Measured verbatim, Docker 27.4.0 with `--cpus=99` on a 14-CPU daemon, exit 125.
	assert.equal(cpuRangeRefusal("docker: Error response from daemon: Range of CPUs is from 0.01 to 14.00, as there are only 14 CPUs available.\nSee 'docker run --help'.\n"), 14);
	assert.equal(cpuRangeRefusal("Error response from daemon: range of CPUs is from 0.01 to 4.00, as there are only 4 CPUs available"), 4, "any case");
	for (const other of ["", null, undefined, "docker: Error response from daemon: Conflict. The container name \"/x\" is already in use", "Error: docker.io/library/busybox:1.36: image not known", "Range of CPUs"]) {
		assert.equal(cpuRangeRefusal(other), null, String(other));
	}
});

test("unenforcedSizeFlags names the size flags a Docker daemon says it drops, and reads a null fact as no evidence (issue #596)", () => {
	assert.deepEqual(unenforcedSizeFlags({ swapLimit: true, cpuShares: true }), []);
	assert.deepEqual(unenforcedSizeFlags({ swapLimit: false, cpuShares: true }), ["--memory-swap"]);
	assert.deepEqual(unenforcedSizeFlags({ swapLimit: true, cpuShares: false }), ["--cpu-shares"]);
	assert.deepEqual(unenforcedSizeFlags({ swapLimit: false, cpuShares: false }), ["--memory-swap", "--cpu-shares"]);
	assert.deepEqual(unenforcedSizeFlags({ swapLimit: null, cpuShares: null }), [], "Podman: not read, so not claimed");
	assert.deepEqual(unenforcedSizeFlags(null), []);
});
