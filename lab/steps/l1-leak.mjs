// L1: helpers on a daemon whose container STARTS hang (containerd stopped in pulses, creates still answered).
// First the fixed makeCpuReserve, then 5.4.2's anonymous argv. The 5.4.2 leftovers stay for L2.
import { existsSync, readFileSync } from "node:fs";
import { execDockerBounded } from "../../worker/src/backend-local.mjs";
import { helperName, makeCpuReserve, reservePlan } from "../../worker/src/cpu-reserve.mjs";
import { IMAGE, containers, pulse, sh, sleep, write } from "../lib.mjs";

// 5.4.2's helperArgs, verbatim in effect.
export function oldHelperArgs(image, { write: w = false, line = "" } = {}) {
	return ["run", "--rm", "--pull=never", "--user=0:0", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--network=none", "--read-only", "--cgroup-parent=pidispatch.slice", "-v", `/sys/fs/cgroup/pidispatch.slice:/p${w ? "" : ":ro"}`, "--entrypoint", w ? "sh" : "cat", image, ...(w ? ["-c", `echo "${line}" > /p/cpu.max`] : ["/p/cpu.max"])];
}

const STEP_MS = 4_000;
const PHASE_MS = 120_000;
const PARENT = "/sys/fs/cgroup/pidispatch.slice";

// The parent exists once docker has placed one container under it.
const seed = await sh("docker", ["run", "--rm", "--cgroup-parent=pidispatch.slice", IMAGE, "true"]);
const parent = { seedCode: seed.code, exists: existsSync(PARENT), cpuMax: existsSync(`${PARENT}/cpu.max`) ? readFileSync(`${PARENT}/cpu.max`, "utf8").trim() : null };

const isHelperCmd = (c) => c.command.includes("/p/cpu.max");
const NAME = helperName("lab-worker");

// Sample the daemon every 500 ms: containers under the fixed name, and anonymous helper containers.
function sampler() {
	let on = true;
	const seen = { samples: 0, maxNamed: 0, maxAnon: 0, namedStates: {}, anonAtStart: null };
	const loop = (async () => {
		while (on) {
			const all = await containers(["status=created", "status=running", "status=exited"]);
			const named = all.filter((c) => c.name === NAME);
			const anon = all.filter((c) => isHelperCmd(c) && !c.name.startsWith("pi-dispatch-cpu-reserve-"));
			if (seen.anonAtStart === null) seen.anonAtStart = anon.length;
			seen.samples++;
			seen.maxNamed = Math.max(seen.maxNamed, named.length);
			seen.maxAnon = Math.max(seen.maxAnon, anon.length);
			for (const c of named) seen.namedStates[c.state] = (seen.namedStates[c.state] ?? 0) + 1;
			await sleep(500);
		}
	})();
	return {
		async end() {
			on = false;
			await loop;
			return seen;
		},
	};
}

async function phase(target) {
	// --- fixed: the real makeCpuReserve, the real execDockerBounded with its bound cut to STEP_MS.
	const events = [];
	let fake = Date.now();
	const run = (bin, args, { timeoutMs, maxBuffer }) => execDockerBounded(args, { bin, timeoutMs: Math.min(timeoutMs, STEP_MS), maxBuffer });
	const reserve = makeCpuReserve({ run, image: IMAGE, name: NAME, now: () => fake, log: (event, fields) => events.push({ t: Date.now(), event, ...fields }) });
	const plan = reservePlan({ venue: "local", facts: { cgroupDriver: "cgroupfs", cgroupVersion: "v2" }, endpointLocal: true, platform: "linux" });

	const s1 = sampler();
	const p1 = pulse({ target, stopMs: 10_000, contMs: 3_000 });
	const t1 = Date.now();
	let attempts = 0;
	while (Date.now() - t1 < PHASE_MS) {
		// Eleven minutes of fake time per sync, past any backoff, so every sync makes an attempt.
		fake += 11 * 60_000;
		await reserve.sync({ cpuCenti: 150, plans: [plan] });
		attempts++;
	}
	await p1.end();
	const healthy = [];
	for (let i = 0; i < 3; i++) {
		fake += 11 * 60_000;
		await reserve.sync({ cpuCenti: 150, plans: [plan] });
		healthy.push(reserve.states()[0]);
	}
	await sleep(3_000);
	const fixedSeen = await s1.end();
	const namedAfter = (await containers([`name=^${NAME}$`])).length;
	const reasons = {};
	for (const e of events) if (e.event === "cpu_reserve_fail_open") reasons[e.reason] = (reasons[e.reason] ?? 0) + 1;
	const fixed = {
		name: NAME,
		attempts,
		maxNamedAtOnce: fixedSeen.maxNamed,
		anonCreatedByFixed: fixedSeen.maxAnon - fixedSeen.anonAtStart,
		namedStates: fixedSeen.namedStates,
		namedAfterHealthy: namedAfter,
		healthyStatus: healthy.map((s) => s.status),
		retryMsSeen: [...new Set(events.filter((e) => e.retryMs !== undefined).map((e) => e.retryMs))],
		reasons,
		samples: fixedSeen.samples,
		cpuMaxAfter: existsSync(`${PARENT}/cpu.max`) ? readFileSync(`${PARENT}/cpu.max`, "utf8").trim() : null,
	};

	// --- baseline: 5.4.2's read, write, read back, anonymous, killed at the same bound.
	const before = (await containers(["status=created"])).filter(isHelperCmd).length;
	const p2 = pulse({ target, stopMs: 10_000, contMs: 3_000 });
	const t2 = Date.now();
	const base = { runs: 0, timeouts: 0, ok: 0, other: {} };
	while (Date.now() - t2 < PHASE_MS) {
		for (const args of [oldHelperArgs(IMAGE), oldHelperArgs(IMAGE, { write: true, line: "150000 100000" }), oldHelperArgs(IMAGE)]) {
			const r = await execDockerBounded(args, { timeoutMs: STEP_MS });
			base.runs++;
			if (r.error?.timedOut) base.timeouts++;
			else if (r.code === 0) base.ok++;
			else base.other[String(r.code)] = (base.other[String(r.code)] ?? 0) + 1;
			if (r.error?.timedOut) break;
		}
	}
	await p2.end();
	await sleep(15_000);
	const leftovers = (await containers(["status=created"])).filter(isHelperCmd).filter((c) => !c.name.startsWith("pi-dispatch-cpu-reserve-"));
	const baseline = { ...base, createdBefore: before, createdLeftovers: leftovers.length - before, sample: leftovers.slice(0, 3) };

	return { fixed, baseline, events };
}

const modes = {};
for (const target of ["dockerd", "containerd"]) modes[target] = await phase(target);
const ok = (m) => m.fixed.maxNamedAtOnce <= 1 && m.fixed.anonCreatedByFixed === 0 && m.fixed.namedAfterHealthy === 0 && m.fixed.healthyStatus.includes("held");

write("l1-leak", {
	summary: {
		pass: ok(modes.dockerd) && ok(modes.containerd) && modes.dockerd.baseline.createdLeftovers > 0,
		...Object.fromEntries(Object.entries(modes).map(([k, m]) => [k, { fixedMaxNamedAtOnce: m.fixed.maxNamedAtOnce, fixedAnon: m.fixed.anonCreatedByFixed, fixedNamedAfterHealthy: m.fixed.namedAfterHealthy, fixedReasons: m.fixed.reasons, retryMsSeen: m.fixed.retryMsSeen, baselineRuns: m.baseline.runs, baselineTimeouts: m.baseline.timeouts, baselineLeftovers: m.baseline.createdLeftovers }])),
	},
	parent,
	modes,
});
