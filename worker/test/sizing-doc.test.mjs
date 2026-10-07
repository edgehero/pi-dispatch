import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { operatorQuotaCommand, reservePlan } from "../src/cpu-reserve.mjs";
import { ISOLATION_FLAGS } from "../src/docker-run.mjs";
import { cpuReserveChecks, doctorHostBudget, hostBudgetChecks, jobSizeChecks, render, sizeSuggestionChecks } from "../src/doctor.mjs";
import { BUDGET_RECHECK_MS, NEVER_FITS_RECHECK_MS, RESERVE_CPUS_FROM, RESERVE_MEMORY_MAX_MIB, RESERVE_MEMORY_MIN_MIB, computeHostBudget, hostBudgetSettings, makeHostBudget } from "../src/host-budget.mjs";
import { DEFAULT_JOB_SIZE, SHM_CEILING_MIB, formatCpus, formatMemory, parseCpus, parseMemory, shmMiBOf } from "../src/job-size.mjs";
import { parseProjects } from "../src/projects.mjs";
import { parseScopedLimits } from "../src/scoped-limits.mjs";
import { SUGGEST_MIN_SAMPLES, SUGGEST_WINDOW_DAYS, SUGGEST_WINDOW_RUNS, suggestSize } from "../src/size-suggest.mjs";

// `docs/sizing.md` (issue #596) carries a worked example: a limits file, a projects file and an `.env`, the doctor
// lines they produce, an out-of-memory suggestion, and what the host budget does under two floods. Every one of
// those restates a derivable source (doctor's own labels, the budget's admission), so it is BOLTED here (CLAUDE.md:
// a hand-written table is derived or pinned, never trusted).
//
// THE PAGE'S OWN FILES ARE THE INPUT. The JSON and `.env` blocks are read out of the page and fed to the worker's own
// loaders and doctor's own functions, and the lines those print are required in the page VERBATIM, after the HTML
// comments a reader never sees are removed (`backends-doc.test.mjs` records why a generated line, never a parsed-back
// one, is the only form of this check that holds). So an edit to the example's files that changes what doctor says,
// or an edit to doctor's wording, turns this red until the page shows the new line.
//
// THE PROSE NUMBERS ARE PINNED TOO. The flood scenarios are driven through `makeHostBudget`, and every number the page
// says about them (how many start, the sums of what runs, the share in CPUs) is computed here from the budget's own
// entries and required in the page. So are the rules the page restates: the re-check cadences, the reserve, the shm
// and process caps, the run counts and the factors of a suggestion (the factors are not exported, so they are read
// out of the page and checked against `suggestSize` at their boundary). What stays unpinned is only the reasoning a
// sentence gives: a sentence can still mis-explain WHY a job waited while naming the right numbers.

const doc = readFileSync(new URL("../../docs/sizing.md", import.meta.url), "utf8").replace(/<!--[\s\S]*?-->/g, "");
/** The page's prose with every run of whitespace one space, so a sentence is found wherever its lines wrap. */
const flat = doc.replace(/\s+/g, " ");
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const word = (n) => WORDS[n] ?? String(n);
const Word = (n) => word(n).charAt(0).toUpperCase() + word(n).slice(1);
/** Requires `text` in the page's prose. */
const says = (text) => assert.ok(flat.includes(text), `docs/sizing.md must say: ${text}`);

/** The fenced block of `lang` that directly follows the line `label` (a file name in backticks and a colon). */
function blockAfter(label, lang) {
	const at = doc.indexOf(`\n${label}\n`);
	assert.ok(at >= 0, `docs/sizing.md names ${label}`);
	const open = doc.indexOf(`\`\`\`${lang}\n`, at);
	const close = doc.indexOf("\n```", open + 4);
	assert.ok(open > at && close > open, `a ${lang} block follows ${label}`);
	return doc.slice(open + lang.length + 4, close);
}

const limitsText = blockAfter("`scoped-limits.json`:", "json");
const projectsText = blockAfter("`projects.json`:", "json");
const envText = blockAfter("`.env` (the budget settings are left unset, so all four are `auto`):", "sh");
const env = Object.fromEntries(
	envText
		.split("\n")
		.filter((l) => /^[A-Z_]+=/.test(l))
		.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const limits = parseScopedLimits(limitsText, "docs/sizing.md");
const projects = parseProjects(projectsText, "docs/sizing.md");

// The machine the example names in prose. The page must say both numbers; the lines below are computed from them.
const MEM_TOTAL_MIB = 64204;
const HOST_CPUS = 16;
const daemon = { answered: true, facts: { memTotalMiB: MEM_TOTAL_MIB, hostCpus: HOST_CPUS, swapLimit: true, cpuShares: true } };
const view = doctorHostBudget(env, { daemon });
/** Doctor's own printer: the lines exactly as an operator sees them. */
const show = (checks) => {
	let text = "";
	render(checks, (s) => {
		text += s;
	});
	return text.replace(/\n$/, "").split("\n");
};
const SYSTEMD = reservePlan({ venue: "local", facts: { cgroupDriver: "systemd", cgroupVersion: "v2" }, endpointLocal: true, platform: "linux" });
const NOW = Date.parse("2026-10-14T12:00:00Z");

test("docs/sizing.md's example files load with the worker's own loaders, and the env sets no budget", () => {
	assert.deepEqual(
		projects.map((p) => p.id),
		["heavy", "medium", "light"],
	);
	assert.deepEqual(
		limits.map((l) => [l.scope, l.memory, l.cpus, l.hostShare, l.minJobs]),
		[
			["project:heavy", "20g", 4, null, 1],
			["project:medium", "8g", 2, null, 1],
			["project:light", "2g", 1, 50, null],
		],
	);
	for (const key of ["PI_HOST_MEMORY_BUDGET", "PI_HOST_CPU_BUDGET", "PI_HOST_RESERVE_MEMORY", "PI_HOST_RESERVE_CPUS", "PI_JOB_MEMORY", "PI_JOB_CPUS"]) assert.equal(env[key], undefined, `${key} is left at its default`);
	assert.ok(doc.includes(`${MEM_TOTAL_MIB}m of memory`) && doc.includes(`and ${HOST_CPUS} CPUs`), "the page names the machine the lines are computed for");
});

test("docs/sizing.md shows doctor's sizing lines for its example verbatim", () => {
	const checks = [
		...jobSizeChecks(env, { daemon, cpuBudgetCenti: view.cpuCenti }),
		...hostBudgetChecks(view, { concurrency: Number(env.PI_CONCURRENCY), limits, env }),
		...sizeSuggestionChecks({ projects, limits, env, records: [], budget: { memMiB: view.memMiB, cpuCenti: view.cpuCenti }, total: { memMiB: MEM_TOTAL_MIB, cpuCenti: HOST_CPUS * 100 }, nowMs: NOW }),
		...cpuReserveChecks([{ plan: SYSTEMD, read: { ok: true, cpuCenti: null }, cgroupManager: "systemd" }], view.cpuCenti),
	];
	assert.equal(checks.length, 9, "no doctor warning about the example's sizes, minimums or shares");
	const lines = show(checks);
	assert.ok(doc.includes(`\`\`\`text\n${lines.join("\n")}\n\`\`\``), `docs/sizing.md must show, as one block:\n${lines.join("\n")}`);
	const held = show(cpuReserveChecks([{ plan: SYSTEMD, read: { ok: true, cpuCenti: view.cpuCenti }, cgroupManager: "systemd" }], view.cpuCenti));
	assert.ok(doc.includes(`\`\`\`text\n${held.join("\n")}\n\`\`\``), `docs/sizing.md must show, once the quota is set:\n${held.join("\n")}`);
	assert.ok(doc.includes(`sudo systemctl set-property pidispatch.slice CPUQuota=${view.cpuCenti}%`), "the root command names the example's budget");
});

test("docs/sizing.md's standalone root commands are the ones doctor prints, for the example's budget and to clear it", () => {
	// Separately from the doctor block: the page's own sh blocks, which a reader copies.
	for (const cpuCenti of [view.cpuCenti, null]) {
		const block = `\`\`\`sh\n${operatorQuotaCommand(cpuCenti)}\n\`\`\``;
		assert.ok(doc.includes(block), `docs/sizing.md must show, as its own block:\n${block}`);
	}
	says(`For a CPU budget of ${formatCpus(view.cpuCenti)} the root command is:`);
	says(`all jobs together may use at most ${formatCpus(view.cpuCenti)} CPUs (\`${view.cpuCenti}%\` is ${formatCpus(view.cpuCenti)} times one CPU)`);
	// With the budget off, the operator's quota stays: the page quotes doctor's warning for the example's quota.
	const off = cpuReserveChecks([{ plan: SYSTEMD, read: { ok: true, cpuCenti: view.cpuCenti }, cgroupManager: "systemd" }], Infinity);
	assert.equal(off.length, 1);
	says(`"${off[0].label.replace(/^local: /, "")}"`);
	assert.equal(off[0].fix.endsWith(`\`${operatorQuotaCommand(null)}\``), true);
	// The helper's read without the job image: the reason the page quotes.
	const helper = reservePlan({ venue: "local", facts: { cgroupDriver: "cgroupfs", cgroupVersion: "v2" }, endpointLocal: true, platform: "linux" });
	const absent = cpuReserveChecks([{ plan: helper, read: { ok: false, reason: "job-image-absent" }, cgroupManager: "cgroupfs" }], view.cpuCenti);
	const quoted = "the quota of pidispatch.slice was not readable (job-image-absent)";
	assert.ok(absent[0].label.endsWith(quoted));
	says(`"${quoted}"`);
});

test("docs/sizing.md's out of memory suggestion is the line doctor prints for one oom-killed medium run", () => {
	const medium = limits.find((l) => l.scope === "project:medium");
	const size = { memMiB: parseMemory(medium.memory), cpuCenti: parseCpus(medium.cpus), source: "project" };
	const run = (day, oom) => ({
		project: "medium",
		size,
		resources: { memPeak: (oom ? size.memMiB : 5000) * 1048576, cpuUsec: 600e6, throttledUsec: 0, memFullUsec: 0 },
		startedAt: new Date(NOW - day * 86400000 - 600000).toISOString(),
		endedAt: new Date(NOW - day * 86400000).toISOString(),
		reason: oom ? "oom-killed" : "completed",
	});
	const records = [run(1, true), ...Array.from({ length: 13 }, (_, i) => run(i + 2, false))];
	const lines = show(sizeSuggestionChecks({ projects: [{ id: "medium" }], limits, env, records, budget: { memMiB: view.memMiB, cpuCenti: view.cpuCenti }, total: { memMiB: MEM_TOTAL_MIB, cpuCenti: HOST_CPUS * 100 }, nowMs: NOW }));
	assert.ok(doc.includes(`\`\`\`text\n${lines.join("\n")}\n\`\`\``), `docs/sizing.md must show:\n${lines.join("\n")}`);
});

test("docs/sizing.md's CPU reserve table names who sets the quota, and where doctor reads it back, as reservePlan decides", () => {
	const local = (facts, extra = {}) => reservePlan({ venue: "local", facts, endpointLocal: true, platform: "linux", ...extra });
	const podman = (rootless) => reservePlan({ venue: "podman", facts: { cgroupManager: "systemd", cgroupVersion: "v2", rootless } });
	// Each row of the page, with the plans of the runtimes it names. A plan with a method is one doctor reads back
	// (`doctorCpuReserve` reads only those); one without leaves doctor's warning standing whatever the operator ran.
	const expected = [
		["Rootless Podman", [podman(true)]],
		["Docker Desktop, and Docker with the `cgroupfs` driver", [local({ cgroupDriver: "cgroupfs", cgroupVersion: "v2" }), local({ cgroupDriver: "cgroupfs", cgroupVersion: "v2" }, { endpointLocal: false, platform: "darwin" })]],
		["Docker with systemd on this machine", [local({ cgroupDriver: "systemd", cgroupVersion: "v2" })]],
		["Rootful Podman, and a Docker daemon with systemd on another machine", [podman(false), local({ cgroupDriver: "systemd", cgroupVersion: "v2" }, { endpointLocal: false })]],
		["Rootless Docker", [local({ cgroupDriver: "systemd", cgroupVersion: "v2", rootless: true })]],
	];
	assert.deepEqual(expected.map(([, plans]) => plans.map((p) => p.method)), [["user-systemd"], ["helper", "helper"], ["system-systemd"], [null, null], [null]]);
	const table = doc.slice(doc.indexOf("| Runtime | Who sets the quota | Does doctor read it back |"));
	const rows = table.slice(0, table.indexOf("\n\n")).split("\n").slice(2).map((l) => l.split("|").map((c) => c.trim()));
	assert.deepEqual(
		rows.map((r) => [r[1], r[3]]),
		expected.map(([name, plans]) => [name, plans.every((p) => p.method) ? "Yes" : "No"]),
	);
	// cgroup v1 keeps no quota, on either runtime.
	assert.equal(local({ cgroupDriver: "systemd", cgroupVersion: "v1" }).method, null);
	assert.equal(reservePlan({ venue: "podman", facts: { cgroupManager: "systemd", cgroupVersion: "v1", rootless: true } }).method, null);
	says("On a host with cgroup v1 no quota is kept at all.");
});

/** A budget for the example's machine, with an injected clock, and `ask(id, project)` through its gate. */
async function exampleBudget(rows = limits) {
	let t = 1_000;
	const sizes = Object.fromEntries(rows.map((l) => [l.scope.slice("project:".length), { memMiB: parseMemory(l.memory), cpuCenti: parseCpus(l.cpus) }]));
	const budget = makeHostBudget({ settings: hostBudgetSettings(env), readFacts: async () => ({ memTotalMiB: MEM_TOTAL_MIB, hostCpus: HOST_CPUS }), scopedLimits: () => rows, countLimit: () => Number(env.PI_CONCURRENCY), now: () => t });
	await budget.ready;
	const ask = (id, project) => {
		t += 1;
		return budget.gate({ id, ticket: id, project, size: sizes[project], limits: rows }).admitted;
	};
	const end = (id) => budget.release(id, { ticket: id });
	/** What runs now, summed from the budget's own entries: `{ mem, cpus, jobs }` as the page spells them. */
	const held = (project = null) => {
		const e = budget.entries().filter((x) => project === null || x.project === project);
		return { mem: formatMemory(e.reduce((n, x) => n + x.memMiB, 0)), cpus: formatCpus(e.reduce((n, x) => n + x.cpuCenti, 0)), jobs: e.length };
	};
	return { budget, ask, end, held, sizes };
}

test("docs/sizing.md's light flood: seven light jobs start, then a heavy and a medium start at once", async () => {
	const { ask, held, sizes } = await exampleBudget();
	const started = Array.from({ length: 30 }, (_, i) => ask(`l${i}`, "light")).filter(Boolean).length;
	assert.equal(started, 7);
	says(`**Thirty \`light\` jobs arrive at once.** ${Word(started)} start: \`light\`'s \`hostShare\` of 50% allows ${formatCpus((view.cpuCenti * 50) / 100)} CPUs, and each job counts ${formatCpus(sizes.light.cpuCenti)} CPU.`);
	says(`The other ${30 - started} wait`);
	const light = held("light");
	assert.equal(ask("h", "heavy"), true);
	assert.equal(ask("m", "medium"), true);
	const all = held();
	says(`${light.jobs} light jobs (\`${light.mem}\`, ${light.cpus} CPUs) plus \`${formatMemory(sizes.heavy.memMiB)}\` and ${formatCpus(sizes.heavy.cpuCenti)} CPUs plus \`${formatMemory(sizes.medium.memMiB)}\` and ${formatCpus(sizes.medium.cpuCenti)} CPUs is \`${all.mem}\`, ${all.cpus} CPUs and ${all.jobs} jobs, all inside the budget.`);
	// Without the share, the light jobs take every job slot, and the heavy job starts when the first of them ends.
	const noShare = limits.map((l) => (l.scope === "project:light" ? { ...l, hostShare: null } : l));
	const bare = await exampleBudget(noShare);
	assert.equal(Array.from({ length: 30 }, (_, i) => bare.ask(`l${i}`, "light")).filter(Boolean).length, Number(env.PI_CONCURRENCY));
	assert.equal(bare.ask("h", "heavy"), false);
	bare.end("l0");
	assert.equal(bare.ask("l10", "light"), false, "the freed slot is kept for the heavy job");
	assert.equal(bare.ask("h", "heavy"), true);
});

test("docs/sizing.md's medium flood: room is kept for the heavy job, which starts once three medium jobs end", async () => {
	const { ask, end, held, sizes } = await exampleBudget();
	const running = [];
	for (let i = 0; i < 20; i++) if (ask(`m${i}`, "medium")) running.push(`m${i}`);
	assert.equal(running.length, 7);
	const full = held();
	says(`**A stream of \`medium\` jobs arrives.** ${Word(full.jobs)} start, which fills the budget in both memory (\`${full.mem}\` of ${view.memMiB}m) and CPU (${full.cpus} of ${formatCpus(view.cpuCenti)}).`);
	assert.equal(ask("h", "heavy"), false);
	let left = null;
	for (let ended = 1; ended <= 3; ended++) {
		end(running.shift());
		assert.equal(ask(`m${7 + ended}`, "medium"), false, "no medium job takes the room kept for the heavy one");
		assert.equal(ask("m7", "medium"), false, "not even the oldest waiting medium job");
		if (ended === 3) left = held();
		assert.equal(ask("h", "heavy"), ended === 3, `the heavy job starts after ${ended === 3 ? "" : "not "}${ended} ended`);
	}
	says(`When ${word(3)} have ended, ${left.jobs} medium jobs (\`${left.mem}\`, ${left.cpus} CPUs) leave room for \`${formatMemory(sizes.heavy.memMiB)}\` and ${formatCpus(sizes.heavy.cpuCenti)} CPUs, and the \`heavy\` job starts at its next check, within about ${word(BUDGET_RECHECK_MS / 1000)} seconds.`);
	end(running.shift());
	assert.equal(ask("m7", "medium"), true, "then the medium jobs start again as others end");
	// Without minJobs, the medium jobs queued before the heavy one go first.
	const noMin = limits.map((l) => (l.scope === "project:heavy" ? { ...l, minJobs: null } : l));
	const bare = await exampleBudget(noMin);
	const r = [];
	for (let i = 0; i < 20; i++) if (bare.ask(`m${i}`, "medium")) r.push(`m${i}`);
	assert.equal(bare.ask("h", "heavy"), false);
	bare.end(r.shift());
	assert.equal(bare.ask("m7", "medium"), true, "the oldest medium job, queued before the heavy one, starts first");
});

test("docs/sizing.md's never-fits size is larger than the example's budget", () => {
	assert.ok(doc.includes("If `heavy` were set to `64g`"));
	assert.ok(parseMemory("64g") > view.memMiB);
	assert.ok(doc.includes(`budget of ${view.memMiB}m`));
});

test("docs/sizing.md's example minimums are what its limits file asks for together", () => {
	let mem = 0;
	let cpu = 0;
	for (const l of limits.filter((r) => Number.isInteger(r.minJobs))) {
		mem += l.minJobs * parseMemory(l.memory);
		cpu += l.minJobs * parseCpus(l.cpus);
	}
	says(`the two minimums together (\`${formatMemory(mem)}\`, ${formatCpus(cpu)} CPUs) fit`);
});

test("docs/sizing.md restates the budget's rules as the code has them", () => {
	says(`asks again about every ${word(BUDGET_RECHECK_MS / 1000)} seconds`);
	says(`it is put back for ${NEVER_FITS_RECHECK_MS / 1000} seconds for a machine it fits on`);
	// The auto reserve: its share of memory, read off a machine where neither bound binds, its bounds, and the CPU rule.
	const auto = hostBudgetSettings({});
	const mid = computeHostBudget(auto, { memTotalMiB: 20480, hostCpus: RESERVE_CPUS_FROM }).detail;
	const below = computeHostBudget(auto, { memTotalMiB: 20480, hostCpus: RESERVE_CPUS_FROM - 1 }).detail;
	assert.equal(below.cpuReserveCenti, 0);
	says(`is ${(mid.memReserveMiB * 100) / mid.memTotalMiB}% of the memory, at least \`${formatMemory(RESERVE_MEMORY_MIN_MIB)}\` and at most \`${formatMemory(RESERVE_MEMORY_MAX_MIB)}\`, and ${formatCpus(mid.cpuReserveCenti)} CPU on a machine with ${RESERVE_CPUS_FROM} or more (else none)`);
	// The reserve values the page gives as examples are accepted, and `0g` is not.
	const values = hostBudgetSettings({ PI_HOST_RESERVE_MEMORY: "2g", PI_HOST_RESERVE_CPUS: "0.5" });
	assert.deepEqual([values.reserveMemory.memMiB, values.reserveCpus.cpuCenti], [2048, 50]);
	assert.equal(hostBudgetSettings({ PI_HOST_RESERVE_MEMORY: "0", PI_HOST_RESERVE_CPUS: "0" }).reserveMemory.memMiB, 0);
	assert.throws(() => hostBudgetSettings({ PI_HOST_RESERVE_MEMORY: "0g" }));
	for (const line of ["PI_HOST_RESERVE_MEMORY=2g", "PI_HOST_RESERVE_CPUS=0.5", "PI_HOST_MEMORY_BUDGET=off", "PI_HOST_CPU_BUDGET=off"]) assert.ok(doc.includes(`\n${line}\n`), `docs/sizing.md shows ${line}`);
	assert.deepEqual(hostBudgetSettings({ PI_HOST_MEMORY_BUDGET: "off", PI_HOST_CPU_BUDGET: "off" }).memory, { mode: "off" });
	// A 4 CPU machine's auto budget, and how many default jobs it holds.
	const small = computeHostBudget(auto, { memTotalMiB: 65536, hostCpus: 4 });
	says(`a 4 CPU machine has a CPU budget of ${formatCpus(small.cpuCenti)}, which holds ${word(Math.floor(small.cpuCenti / DEFAULT_JOB_SIZE.cpuCenti))} default job of ${formatCpus(DEFAULT_JOB_SIZE.cpuCenti)} CPUs at a time`);
	// The fixed caps every size shares.
	const pids = ISOLATION_FLAGS.find((f) => f.startsWith("--pids-limit=")).slice("--pids-limit=".length);
	says(`**Processes** are capped at ${pids} per job`);
	says(`**Processes** stay at ${pids} per job whatever the size`);
	assert.equal(shmMiBOf(2000), 1000, "half");
	assert.equal(shmMiBOf(SHM_CEILING_MIB * 4), SHM_CEILING_MIB);
	says(`**\`/dev/shm\`** is half the job's memory, at most \`${formatMemory(SHM_CEILING_MIB)}\`.`);
});

/** `n` runs of project `p` at `size`, each with `peak` bytes, `cores` hundredths over a ten-minute wall. */
function runs(n, size, { peak = 1048576, cores = 10, oom = 0 } = {}) {
	const wall = 600_000;
	return Array.from({ length: n }, (_, i) => ({
		project: "p",
		size: { ...size, source: "project" },
		resources: { memPeak: peak, cpuUsec: (wall * 1000 * cores) / 100, throttledUsec: 0, memFullUsec: 0 },
		startedAt: new Date(NOW - (i + 1) * 3_600_000 - wall).toISOString(),
		endedAt: new Date(NOW - (i + 1) * 3_600_000).toISOString(),
		reason: i < oom ? "oom-killed" : "completed",
	}));
}
const suggest = (records, current) => suggestSize({ project: "p", records, current, cap: { memMiB: 1 << 20, cpuCenti: 25600 }, now: NOW });

test("docs/sizing.md's run counts and suggestion factors are the ones suggestSize applies", () => {
	says(`A lowering needs at least ${SUGGEST_MIN_SAMPLES} such runs of the project in the last ${SUGGEST_WINDOW_DAYS} days`);
	says(`from its measured runs of the last ${SUGGEST_WINDOW_DAYS} days (the newest ${SUGGEST_WINDOW_RUNS} at most)`);
	const size = { memMiB: 8192, cpuCenti: 200 };
	const MIB = 1048576;
	// Fewer runs than the minimum suggest nothing; the minimum does (the peak is far below the size).
	assert.equal(suggest(runs(SUGGEST_MIN_SAMPLES - 1, size), size).memory.reason, "not-enough-runs");
	assert.equal(suggest(runs(SUGGEST_MIN_SAMPLES, size), size).memory.reason, "oversized");
	// The raise: one oom-killed run at the size. 8g rounds exactly, so the factor is the suggestion over the size.
	const raised = suggest(runs(SUGGEST_MIN_SAMPLES, size, { peak: 5000 * MIB, oom: 1 }), size).memory.suggested;
	says(`A run that ended \`oom-killed\` suggests ${raised / size.memMiB} times the larger of the size and the largest size killed in the window.`);
	// The lowering: the page's two factors, checked at their boundary. Lowered when a x p95 <= b x size.
	const lower = /Memory is lowered\*\* when ([0-9.]+) times the p95 peak is at most ([0-9.]+) times the size, never below ([0-9.]+) times the largest peak/.exec(flat);
	assert.ok(lower, "the page states the lowering rule");
	const [a, b, floorFactor] = lower.slice(1).map(Number);
	assert.equal(floorFactor, a, "the floor is the same factor on the largest peak");
	const big = { memMiB: 10240, cpuCenti: 200 };
	const edge = Math.floor((big.memMiB * MIB * b) / a);
	assert.notEqual(suggest(runs(SUGGEST_MIN_SAMPLES, big, { peak: edge }), big).memory.suggested, null, `lowered at ${b}/${a} of the size`);
	assert.equal(suggest(runs(SUGGEST_MIN_SAMPLES, big, { peak: edge + MIB }), big).memory.suggested, null, "not lowered just above it");
	// CPUs: lowered only when the p95 cores used are below the page's factor of the size.
	const cpu = /when the p95 of the cores used is below ([0-9.]+) times the size/.exec(flat);
	assert.ok(cpu, "the page states the CPU rule");
	const at = Math.round(Number(cpu[1]) * size.cpuCenti);
	assert.equal(suggest(runs(SUGGEST_MIN_SAMPLES, size, { cores: at }), size).cpu.suggested, null, "not lowered at the factor");
	assert.notEqual(suggest(runs(SUGGEST_MIN_SAMPLES, size, { cores: at - 1 }), size).cpu.suggested, null, "lowered just below it");
});
