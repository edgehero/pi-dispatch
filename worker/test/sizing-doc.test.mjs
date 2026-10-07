import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { reservePlan } from "../src/cpu-reserve.mjs";
import { cpuReserveChecks, doctorHostBudget, hostBudgetChecks, jobSizeChecks, sizeSuggestionChecks } from "../src/doctor.mjs";
import { hostBudgetSettings, makeHostBudget } from "../src/host-budget.mjs";
import { parseMemory, parseCpus } from "../src/job-size.mjs";
import { parseProjects } from "../src/projects.mjs";
import { parseScopedLimits } from "../src/scoped-limits.mjs";

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
// WHAT STAYS UNPINNED: the prose around the numbers. The flood scenarios are driven through `makeHostBudget` and their
// counts asserted here, and the page must name those counts, but a sentence can still mis-explain WHY a job waited.
// The fewer such sentences the better; the scenario list below is the whole of what the page may claim.

const doc = readFileSync(new URL("../../docs/sizing.md", import.meta.url), "utf8").replace(/<!--[\s\S]*?-->/g, "");

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
const show = (checks) => checks.map((c) => `${c.ok ? "✓" : c.warn ? "⚠" : "✗"} ${c.label}${!c.ok && c.fix ? `\n    → ${c.fix}` : ""}`);
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
	const lines = [
		...show(jobSizeChecks(env, { daemon, cpuBudgetCenti: view.cpuCenti })),
		...show(hostBudgetChecks(view, { concurrency: Number(env.PI_CONCURRENCY), limits, env })),
		...show(sizeSuggestionChecks({ projects, limits, env, records: [], budget: { memMiB: view.memMiB, cpuCenti: view.cpuCenti }, total: { memMiB: MEM_TOTAL_MIB, cpuCenti: HOST_CPUS * 100 }, nowMs: NOW })),
		...show(cpuReserveChecks([{ plan: SYSTEMD, read: { ok: true, cpuCenti: null }, cgroupManager: "systemd" }], view.cpuCenti)),
	];
	assert.equal(lines.length, 9, "no doctor warning about the example's sizes, minimums or shares");
	assert.ok(doc.includes(`\`\`\`text\n${lines.join("\n")}\n\`\`\``), `docs/sizing.md must show, as one block:\n${lines.join("\n")}`);
	const held = show(cpuReserveChecks([{ plan: SYSTEMD, read: { ok: true, cpuCenti: view.cpuCenti }, cgroupManager: "systemd" }], view.cpuCenti));
	assert.ok(doc.includes(`\`\`\`text\n${held.join("\n")}\n\`\`\``), `docs/sizing.md must show, once the quota is set:\n${held.join("\n")}`);
	assert.ok(doc.includes(`sudo systemctl set-property pidispatch.slice CPUQuota=${view.cpuCenti}%`), "the root command names the example's budget");
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

test("docs/sizing.md's CPU reserve table names who sets the quota as reservePlan decides it", () => {
	const row = (facts, extra = {}) => reservePlan({ venue: "local", facts, endpointLocal: true, platform: "linux", ...extra });
	assert.equal(reservePlan({ venue: "podman", facts: { cgroupManager: "systemd", cgroupVersion: "v2", rootless: true } }).method, "user-systemd");
	assert.equal(row({ cgroupDriver: "cgroupfs", cgroupVersion: "v2" }).method, "helper");
	assert.equal(row({ cgroupDriver: "systemd", cgroupVersion: "v2" }).method, "system-systemd");
	assert.equal(reservePlan({ venue: "podman", facts: { cgroupManager: "systemd", cgroupVersion: "v2", rootless: false } }).why, "podman-rootful-remote");
	assert.equal(row({ cgroupDriver: "systemd", cgroupVersion: "v2", rootless: true }).why, "rootless-docker");
	const table = doc.slice(doc.indexOf("| Runtime | Who sets the quota |"));
	const rows = table.slice(0, table.indexOf("\n\n")).split("\n").slice(2).map((l) => l.split("|")[1].trim());
	assert.deepEqual(rows, ["Rootless Podman", "Docker Desktop, and Docker with the `cgroupfs` driver", "Docker on Linux with systemd, and rootful Podman", "Rootless Docker"]);
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
	return { budget, ask, end };
}

test("docs/sizing.md's light flood: seven light jobs start, then a heavy and a medium start at once", async () => {
	const { ask } = await exampleBudget();
	const started = Array.from({ length: 30 }, (_, i) => ask(`l${i}`, "light")).filter(Boolean).length;
	assert.equal(started, 7);
	assert.equal(ask("h", "heavy"), true);
	assert.equal(ask("m", "medium"), true);
	assert.ok(doc.includes("**Thirty `light` jobs arrive at once.** Seven start") && doc.includes("The other 23 wait"));
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
	const { ask, end } = await exampleBudget();
	const running = [];
	for (let i = 0; i < 20; i++) if (ask(`m${i}`, "medium")) running.push(`m${i}`);
	assert.equal(running.length, 7);
	assert.equal(ask("h", "heavy"), false);
	for (let ended = 1; ended <= 3; ended++) {
		end(running.shift());
		assert.equal(ask(`m${7 + ended}`, "medium"), false, "no medium job takes the room kept for the heavy one");
		assert.equal(ask("m7", "medium"), false, "not even the oldest waiting medium job");
		assert.equal(ask("h", "heavy"), ended === 3, `the heavy job starts after ${ended === 3 ? "" : "not "}${ended} ended`);
	}
	end(running.shift());
	assert.equal(ask("m7", "medium"), true, "then the medium jobs start again as others end");
	assert.ok(doc.includes("When three have\nended") || doc.includes("When three have ended"), "the page says three");
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
