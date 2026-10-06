/**
 * How big one job's container is (issue #596, phase 1): its memory and its CPU weight, per project.
 *
 * A LEAF, importing nothing, for the reason `container-spec.mjs` is one: that module builds every container's argv
 * from a size, and `packages.mjs` relies on it importing nothing heavy. So the project row is matched here by its
 * scope string (`project:<id>`) rather than through `scoped-limits.mjs`; a test holds the two spellings equal.
 *
 * A size is held as TWO INTEGERS, never as the strings an operator writes: `memMiB` (mebibytes) and `cpuCenti`
 * (hundredths of a CPU). Integers so a size compares, sums and records exactly (the host budget of phase 2 adds them
 * up), and so the one spelling the runtime is handed is derived from them (`formatMemory`), never passed through.
 *
 * WHAT A SIZE BECOMES (`containerSizing`, read by `containerSpec`):
 *   - `--memory=<size>` and `--memory-swap=<size>`, equal, so a job gets NO swap beyond its memory. Docker and Podman
 *     give a container swap equal to its memory by default; with the two equal `memory.swap.max` reads 0 on every
 *     venue measured, rootless Podman included (lab, issue #596). A job that needs more memory needs a bigger size,
 *     not a slower one.
 *   - `--cpu-shares=round(cpus x 1024)`: a WEIGHT, not a cap. Under contention each job gets CPU in proportion to its
 *     size; an idle host lets any job use the idle cores. This is the fair share decision 2 of the issue asked for.
 *   - `--shm-size=min(1g, memory/2)`: Chromium needs a large `/dev/shm` (the reason `1g` was there), and `/dev/shm`
 *     is charged to the container's memory, so it may not be most of a small size.
 *   - `--cpus=<host ceiling>`: the host's CPU count minus a reserve (`hostCpuCeiling`), the same for every job. It
 *     keeps any one job off the reserved core; it is not the job's size, which would be the hard cap decision 2
 *     rejected. Absent when the runtime did not say how many CPUs it has (see `hostCpuCeiling`).
 *
 * THE cpu.weight A SHARE BECOMES DEPENDS ON THE OCI RUNTIME'S VERSION (measured, issue #596): runc 1.1.13 and crun
 * 1.14 map shares linearly (1024 to 39, 2048 to 79), runc 1.5.1 and crun 1.27 map 1024 to 100 and 2048 to 174, and a
 * container started without `--cpu-shares` gets 100 on all four. Both mappings keep the ORDER of shares, and every job
 * container carries a share, so the order between jobs, which is what a fair share is about, holds everywhere. What an
 * old runtime changes is a job's weight against a container started WITHOUT a share (the egress proxy, a Valkey): a
 * default job's 79 is below their 100. That is the right direction (the proxy serves every job), and no such container
 * competes with jobs for long, so the flag is passed as is rather than scaled per runtime version.
 */

/** The smallest memory a job may be given: 512 MiB. The runner, pi and a shell need about 200 MB before any tool runs. */
export const JOB_MEMORY_FLOOR_MIB = 512;
/** The largest: 1024 GiB. A bound against a typo (`40000g`), and it keeps every byte count a safe integer. */
export const JOB_MEMORY_CEILING_MIB = 1024 * 1024;
/** The smallest CPU size: 0.25, as hundredths. Its share, 256, is well inside the runtime's range. */
export const JOB_CPUS_FLOOR_CENTI = 25;
/** The largest CPU size: 256, as hundredths, because round(256 x 1024) is 262144, the top of `--cpu-shares`. */
export const JOB_CPUS_CEILING_CENTI = 256 * 100;
/** The valid range of `--cpu-shares` on cgroup v2 (runc and crun clamp to it; 2 is the kernel's cgroup v1 minimum). */
export const CPU_SHARES_MIN = 2;
export const CPU_SHARES_MAX = 262144;
/** `/dev/shm`'s ceiling, the `--shm-size=1g` every job had before sizes. */
export const SHM_CEILING_MIB = 1024;

/** The size every job had before issue #596, and the one a deployment that sets nothing still gets. */
export const DEFAULT_JOB_MEMORY = "4g";
export const DEFAULT_JOB_CPUS = "2";

/** Where a resolved size came from: the job's project row, the deployment's `PI_JOB_*` settings, or the built-in default. */
export const JOB_SIZE_SOURCES = Object.freeze(["project", "env", "default"]);

/** The scope prefix of a project row, as `scoped-limits.mjs` spells it (`PROJECT_SCOPE_PREFIX`; a test holds them equal). */
const PROJECT_ROW_PREFIX = "project:";

/**
 * A memory size, written as an operator writes it (`512m`, `1536m`, `4g`), in MiB. Throws an Error naming the rule for
 * anything else. Lower-case `m` or `g` only, no zero and no leading zero, no fraction, no bytes or kilobytes: one
 * spelling per size, so a row reads the same in the file, the panel and the record. Strings only: a bare number would
 * have to mean bytes to agree with the runtime, and nobody writes a job's memory in bytes.
 */
export function parseMemory(value) {
	if (typeof value !== "string" || !/^[1-9]\d*[mg]$/.test(value)) {
		throw new Error(`a memory size is a whole number of megabytes or gigabytes such as "512m", "1536m" or "4g" (got ${JSON.stringify(value)})`);
	}
	const digits = value.slice(0, -1);
	// Compared as digits first, so a value of any length is refused without ever becoming an unsafe number.
	const ceilingDigits = String(JOB_MEMORY_CEILING_MIB).length;
	const mib = digits.length > ceilingDigits + 1 ? Infinity : Number(digits) * (value.endsWith("g") ? 1024 : 1);
	if (mib < JOB_MEMORY_FLOOR_MIB) throw new Error(`a memory size must be at least ${JOB_MEMORY_FLOOR_MIB}m (got ${JSON.stringify(value)})`);
	if (mib > JOB_MEMORY_CEILING_MIB) throw new Error(`a memory size must be at most ${JOB_MEMORY_CEILING_MIB / 1024}g (got ${JSON.stringify(value)})`);
	return mib;
}

/**
 * A CPU size (`0.5`, `2`, `"1.25"`), in hundredths. A number or a decimal string: above 0, at most two decimals, at
 * least 0.25 and at most 256. Throws an Error naming the rule for anything else. A number is judged by its own decimal
 * spelling (`String(n)`), so `1e-7`, `NaN`, `Infinity` and `0.125` are refused rather than rounded into a size.
 */
export function parseCpus(value) {
	const text = typeof value === "number" ? String(value) : value;
	if (typeof text !== "string" || !/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(text)) {
		throw new Error(`a CPU size is a number above 0 with at most two decimals, such as 0.5, 2 or 1.25 (got ${JSON.stringify(value)})`);
	}
	const [whole, fraction = ""] = text.split(".");
	const centi = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
	if (centi < JOB_CPUS_FLOOR_CENTI) throw new Error(`a CPU size must be at least ${JOB_CPUS_FLOOR_CENTI / 100} (got ${JSON.stringify(value)})`);
	if (centi > JOB_CPUS_CEILING_CENTI) throw new Error(`a CPU size must be at most ${JOB_CPUS_CEILING_CENTI / 100} (got ${JSON.stringify(value)})`);
	return centi;
}

/**
 * The one spelling of a memory size: `<n>g` when it is whole gigabytes, else `<n>m`. Every `--memory`, `--memory-swap`
 * and stored row is written by this function, and `container-spec.mjs`'s `memoryBytes` reads every value it can write
 * (a test walks the whole accepted range), so the OOM rule's 90%-of-the-limit comparison works at every size.
 */
export function formatMemory(memMiB) {
	return memMiB % 1024 === 0 ? `${memMiB / 1024}g` : `${memMiB}m`;
}

/** The one spelling of a CPU size: `2`, `0.5`, `1.25`. Built from the integer, so no float ever prints as `0.30000000000000004`. */
export function formatCpus(cpuCenti) {
	const whole = Math.floor(cpuCenti / 100);
	const fraction = String(cpuCenti % 100).padStart(2, "0").replace(/0+$/, "");
	return fraction === "" ? String(whole) : `${whole}.${fraction}`;
}

/** `--cpu-shares` for a size: round(cpus x 1024), held inside the runtime's range. */
export function cpuSharesOf(cpuCenti) {
	return Math.min(CPU_SHARES_MAX, Math.max(CPU_SHARES_MIN, Math.round((cpuCenti * 1024) / 100)));
}

/** `/dev/shm` for a size, in MiB: half the memory, at most 1g. */
export function shmMiBOf(memMiB) {
	return Math.min(SHM_CEILING_MIB, Math.floor(memMiB / 2));
}

/**
 * The CPUs every job may use at most, `--cpus`: the host's count minus the reserve (one CPU when the host has four or
 * more, else none), or null when the count is unknown.
 *
 * `hostCpus` is the RUNTIME's own count (`docker info`'s `NCPU`, `podman info`'s `host.cpus`), never the worker's
 * `os.availableParallelism()`: on Docker Desktop the daemon runs in a VM with its own count, and Docker refuses a
 * `--cpus` above the CPUs it has. The phase 2 host budget refines this (an operator's reserve, a rootless service's
 * own `cpu.max`); until then the reserve is the default the issue decided.
 *
 * NULL FAILS OPEN, and says so: the argv then carries no `--cpus`, so a job may use every core, reserve included, as a
 * container with no bound does. The shares still apply. The worker logs `cpu_ceiling_unknown` when it happens; it
 * needs a daemon whose `info` did not answer while the job still ran, which only a desktop platform's job user allows.
 */
export function hostCpuCeiling(hostCpus) {
	if (!Number.isSafeInteger(hostCpus) || hostCpus < 1) return null;
	return hostCpus - (hostCpus >= 4 ? 1 : 0);
}

/**
 * What a size becomes on a container's argv, as `containerSpec` fields: `{ memory, memorySwap, cpus, cpuShares,
 * shmSize }`. `memory` and `memorySwap` are the SAME string by construction; `cpus` is the host ceiling or null.
 */
export function containerSizing(size, hostCpus = null) {
	assertJobSize(size);
	const memory = formatMemory(size.memMiB);
	const ceiling = hostCpuCeiling(hostCpus);
	return { memory, memorySwap: memory, cpus: ceiling === null ? null : String(ceiling), cpuShares: cpuSharesOf(size.cpuCenti), shmSize: formatMemory(shmMiBOf(size.memMiB)) };
}

/** Throws unless `size` is `{ memMiB, cpuCenti }` within the floors and ceilings above. */
export function assertJobSize(size) {
	const mem = size?.memMiB;
	const cpu = size?.cpuCenti;
	if (!Number.isSafeInteger(mem) || mem < JOB_MEMORY_FLOOR_MIB || mem > JOB_MEMORY_CEILING_MIB || !Number.isSafeInteger(cpu) || cpu < JOB_CPUS_FLOOR_CENTI || cpu > JOB_CPUS_CEILING_CENTI) {
		throw new Error(`container spec: refusing a job size that is not { memMiB, cpuCenti } within ${JOB_MEMORY_FLOOR_MIB}..${JOB_MEMORY_CEILING_MIB} MiB and ${JOB_CPUS_FLOOR_CENTI}..${JOB_CPUS_CEILING_CENTI} hundredths: ${JSON.stringify(size ?? null)}`);
	}
}

/** The built-in size, `{ memMiB: 4096, cpuCenti: 200, source: "default" }`, derived from the two defaults above. */
export const DEFAULT_JOB_SIZE = Object.freeze({ memMiB: parseMemory(DEFAULT_JOB_MEMORY), cpuCenti: parseCpus(DEFAULT_JOB_CPUS), source: "default" });

/**
 * The deployment's default size from `PI_JOB_MEMORY` and `PI_JOB_CPUS` (unset or empty is the built-in value), as `{
 * memMiB, cpuCenti, memSet, cpuSet }`. Throws an Error naming the key for a value either parser refuses; the worker's
 * config runs this at boot, so a bad value stops the worker there (exit 2) rather than at a job.
 */
export function jobSizeDefaults(env = {}) {
	const read = (key, parse, fallback) => {
		const raw = env?.[key];
		if (raw === undefined || raw === null || raw === "") return { value: parse(fallback), set: false };
		try {
			return { value: parse(raw), set: true };
		} catch (error) {
			throw new Error(`${key}: ${error.message}`);
		}
	};
	const mem = read("PI_JOB_MEMORY", parseMemory, DEFAULT_JOB_MEMORY);
	const cpu = read("PI_JOB_CPUS", parseCpus, DEFAULT_JOB_CPUS);
	return { memMiB: mem.value, cpuCenti: cpu.value, memSet: mem.set, cpuSet: cpu.set };
}

/**
 * The size a job runs at, `{ memMiB, cpuCenti, source }`, resolved ONCE at pickup from the same limits snapshot every
 * other gate reads (issue #596). `project` is the pickup project's id (or null), `limits` the parsed scoped-limits
 * rows, `env` the deployment's settings (`PI_JOB_MEMORY`, `PI_JOB_CPUS`).
 *
 * Field by field: the project row's `memory` and `cpus` win, then the deployment's settings, then the built-in 4g and
 * 2. `source` names the most specific place that supplied ANY field: `project` when the row set memory or CPUs (a row
 * that sets only one takes the other from the deployment), `env` when a setting did and the row none, else `default`.
 *
 * Pure. Never throws on a parsed limits list (its sizes were validated at load); throws on a refused `env` value, which
 * a booted worker cannot have.
 */
export function resolveJobSize({ project = null, limits = [], env = {} } = {}) {
	const defaults = jobSizeDefaults(env);
	const row = typeof project === "string" && Array.isArray(limits) ? (limits.find((l) => l?.scope === `${PROJECT_ROW_PREFIX}${project}`) ?? null) : null;
	const rowMem = typeof row?.memory === "string" ? parseMemory(row.memory) : null;
	const rowCpu = row?.cpus !== null && row?.cpus !== undefined ? parseCpus(row.cpus) : null;
	const source = rowMem !== null || rowCpu !== null ? "project" : defaults.memSet || defaults.cpuSet ? "env" : "default";
	return { memMiB: rowMem ?? defaults.memMiB, cpuCenti: rowCpu ?? defaults.cpuCenti, source };
}

/**
 * A size as a record carries it (INT-RUN-HISTORY-FILE-CONTRACT): `{ memMiB, cpuCenti, source }` REBUILT as an explicit
 * literal, or null for anything that is not one. Integers and a fixed word, so the record stays PII-free.
 */
export function recordedJobSize(size) {
	if (size === null || typeof size !== "object" || Array.isArray(size)) return null;
	try {
		assertJobSize(size);
	} catch {
		return null;
	}
	return JOB_SIZE_SOURCES.includes(size.source) ? { memMiB: size.memMiB, cpuCenti: size.cpuCenti, source: size.source } : null;
}
