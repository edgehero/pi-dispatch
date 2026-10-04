import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { parseEnvelope } from "../src/envelope.mjs";
import { SKILL_NAME_RE } from "../src/flow-gate.mjs";
import { MINTED_TOKEN_VARS } from "../src/forges.mjs";
import { allocate, neutralAllocation, parsePlan } from "../src/priorities.mjs";
import { parseTriggers } from "../src/triggers.mjs";

// The portfolio manager example (issue #506) and its page. The example is copied by operators, so what it ships must
// load through the same parsers the worker uses, and the page's worked numbers are computed here from the page's own
// envelope rather than trusted (CLAUDE.md: a hand-written table that restates a derivable source is pinned).

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const EXAMPLE = "examples/portfolio-manager/";
const PAGE = read("docs/portfolio-manager.md");
const NOW = new Date("2026-10-05T06:00:00.000Z");
const USD = 1_000_000;

/** The page's ```json blocks, parsed. */
function pageJson() {
	return [...PAGE.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1]));
}
const PROJECTS = pageJson().find((b) => Array.isArray(b.projects)).projects;
const ENVELOPE = parseEnvelope(JSON.stringify(pageJson().find((b) => b.floorsUsd)), "/e/envelope.json", { projects: PROJECTS, maxCostMicros: 2 * USD });

/** Dollars as the page writes them. */
const usd = (micros) => `$${(micros / USD).toFixed(2)}`;

test("the example's trigger parses through the shared parser, carries portfolio: true and no github (#506)", () => {
	const [entry, ...rest] = parseTriggers(read(`${EXAMPLE}triggers.portfolio.example.json`), "triggers.portfolio.example.json");
	assert.equal(rest.length, 0);
	assert.equal(entry.on.type, "cron");
	assert.equal(entry.run.portfolio, true);
	assert.equal(entry.run.flow, "portfolio-manager");
	// The parser normalizes an absent flag to undefined; the file itself must not carry the key at all.
	assert.equal(entry.run.github, undefined, "the manager must not hold the deployment's GitHub credential");
	assert.equal("github" in JSON.parse(read(`${EXAMPLE}triggers.portfolio.example.json`)).triggers[0].run, false);
	for (const name of Object.keys(entry.run.secrets)) assert.equal(MINTED_TOKEN_VARS.has(name), false, `${name} is a reserved forge token name`);
	// The page shows the same entry, with a real folder.
	const shown = pageJson().find((b) => b.on?.id === "pm-weekly");
	assert.deepEqual({ ...shown.run, folder: entry.run.folder }, JSON.parse(read(`${EXAMPLE}triggers.portfolio.example.json`)).triggers[0].run);
	assert.deepEqual(parseTriggers(JSON.stringify({ triggers: [shown] }), "page").length, 1);
});

test("every example skill's frontmatter name matches its directory and SKILL_NAME_RE (#506)", () => {
	const skills = [];
	for (const base of ["examples/.pi/skills/", `${EXAMPLE}.pi/skills/`]) {
		for (const dir of readdirSync(new URL(base, root))) {
			const text = read(`${base}${dir}/SKILL.md`);
			const name = /^---\nname: (.*)\n/.exec(text)?.[1];
			assert.equal(name, dir, `${base}${dir}`);
			assert.match(name, SKILL_NAME_RE);
			skills.push(name);
		}
	}
	assert.deepEqual(skills.sort(), ["portfolio-fixture", "portfolio-manager", "tidy"]);
});

test("neither the flow nor the fixture sets validUntil, so a plan lives maxPlanDays, past the next weekly run (#506 review)", () => {
	const skill = read(`${EXAMPLE}.pi/skills/portfolio-manager/SKILL.md`);
	assert.ok(skill.includes("Do not add a `validUntil`"));
	const shape = /```json\n([\s\S]*?)\n```/.exec(skill.slice(skill.indexOf("## Step 5")))[1];
	assert.ok(!shape.includes("validUntil"), "the plan shape the flow copies has no validUntil");
	assert.equal("validUntil" in JSON.parse(read(`${EXAMPLE}plan.fixture.json`)), false);
	const parsed = parsePlan(read(`${EXAMPLE}plan.fixture.json`), { envelope: ENVELOPE, projects: PROJECTS, now: NOW });
	assert.equal(Date.parse(parsed.validUntil) - NOW.getTime(), ENVELOPE.delegation.maxPlanDays * 86_400_000);
	assert.ok(ENVELOPE.delegation.maxPlanDays > 7);
});

test("plan.fixture.json passes parsePlan against the page's envelope, with basis null for a first plan (#506)", () => {
	const parsed = parsePlan(read(`${EXAMPLE}plan.fixture.json`), { envelope: ENVELOPE, projects: PROJECTS, now: NOW });
	assert.equal(parsed.ok, true, JSON.stringify(parsed));
	assert.equal(parsed.plan.basis, null);
	assert.deepEqual(parsed.plan.projects.map((p) => p.id), ["_other", "ops", "platform", "shop"]);
});

test("the page's worked numbers are what the allocator gives for its envelope and the fixture (#506)", () => {
	const neutral = neutralAllocation(ENVELOPE);
	const weights = Object.fromEntries(JSON.parse(read(`${EXAMPLE}plan.fixture.json`)).projects.map((p) => [p.id, p.weight]));
	const first = allocate({ envelope: ENVELOPE, weights, current: { allocations: neutral.allocations, unallocated: neutral.unallocated } });
	assert.equal(first.clamped, false, "the page says the fixture applies whole");
	for (const id of ["shop", "platform", "ops", "_other"]) {
		const label = id === "_other" ? "`_other`" : id;
		const line = `| ${label} | ${usd(ENVELOPE.floors[id])} | ${usd(neutral.allocations[id])} | ${usd(first.allocations[id])} |`;
		assert.ok(PAGE.includes(line), `the page must hold: ${line}`);
	}
	const largest = Math.max(...Object.keys(weights).map((id) => Math.abs(first.allocations[id] - neutral.allocations[id])));
	assert.ok(PAGE.includes(`moves no project by more than ${usd(largest)}, under the ${usd((ENVELOPE.totalMicros * ENVELOPE.delegation.maxStepPct) / 100)} step`));
	const second = allocate({ envelope: ENVELOPE, weights: { shop: 1, platform: 6, ops: 1, _other: 0 }, current: { allocations: first.allocations, unallocated: 0 } });
	assert.equal(second.clamped, true);
	assert.ok(PAGE.includes(`aims platform at ${usd(second.target.allocations.platform)}`));
	assert.ok(PAGE.includes(`to shop ${usd(second.allocations.shop)}, platform ${usd(second.allocations.platform)} and ops ${usd(second.allocations.ops)}`));
	// The manager's own share admits its job: ops is floored at or above the per-job cap.
	assert.ok(ENVELOPE.floors.ops >= 2 * USD);
	assert.ok(PROJECTS.find((p) => p.id === "ops").members.includes("/home/me/pm"));
});

test("every spec ID docs/portfolio-manager.md names is a heading in specs/ (#506)", () => {
	const ids = [...new Set(PAGE.match(/\b(?:CONST|REQ|DES|INT|OQ)-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g) ?? [])];
	assert.ok(ids.length >= 5, `the page names ${ids.length} spec IDs`);
	const headings = new Set();
	for (const name of readdirSync(new URL("specs/", root))) {
		if (!name.endsWith(".md")) continue;
		for (const m of read(`specs/${name}`).matchAll(/^## ([A-Z]+-[A-Z0-9-]+)\s*$/gm)) headings.add(m[1]);
	}
	for (const id of ids) assert.ok(headings.has(id), `${id} is not a spec heading`);
});

test("the page is linked from the README, docs/triggers.md and the examples README (#506)", () => {
	assert.ok(read("README.md").includes("(docs/portfolio-manager.md)"));
	assert.ok(read("docs/triggers.md").includes("(portfolio-manager.md)"));
	assert.ok(read("examples/README.md").includes("(../docs/portfolio-manager.md)"));
});
