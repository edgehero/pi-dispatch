import assert from "node:assert/strict";
import { test } from "node:test";
import * as vendored from "../../image/runner/src/plan-check.mjs";
import { DEFAULT_MAX_PLAN_DAYS, OTHER, PLAN_FIELDS, PLAN_MAX_BYTES, PLAN_RULES, PLAN_VERSION, REASON_MAX, WEIGHT_MAX, parsePlan } from "../src/priorities.mjs";

// The runner's plan pre-check (issue #505) carries a COPY of parsePlan's structural half, because the image cannot import
// worker/. A copy that drifts would log one verdict in the job while the host records another, so the two are bolted
// here: the constants, and the verdict over one corpus. Every case takes an injected `now`.

const NOW = Date.parse("2026-10-07T06:00:00.000Z");
const plan = (over = {}) => JSON.stringify({ version: 1, basis: null, projects: [{ id: "shop", weight: 3 }, { id: "_other", weight: 0 }], ...over });

const CORPUS = [
	plan(),
	plan({ basis: "0123456789abcdef" }),
	plan({ basis: "0123456789ABCDEF" }),
	plan({ basis: "short" }),
	plan({ version: 2 }),
	plan({ version: 0 }),
	plan({ version: "1" }),
	JSON.stringify({ basis: null, projects: [] }),
	JSON.stringify({ version: 1, projects: [] }),
	plan({ extra: 1 }),
	plan({ validUntil: "2026-10-10T00:00:00Z" }),
	plan({ validUntil: "2026-10-10T00:00:00.000Z" }),
	plan({ validUntil: "2026-10-10" }),
	plan({ validUntil: "2026-10-01T00:00:00Z" }),
	plan({ validUntil: "2026-12-30T00:00:00Z" }),
	plan({ validUntil: "2026-02-30T00:00:00Z" }),
	plan({ validUntil: "2026-10-10T00:00:00+02:00" }),
	plan({ projects: "shop" }),
	plan({ projects: [1] }),
	plan({ projects: [{ id: "shop", weight: 3, colour: "red" }] }),
	plan({ projects: [{ weight: 3 }] }),
	plan({ projects: [{ id: "Shop", weight: 3 }] }),
	plan({ projects: [{ id: "shop", weight: 3 }, { id: "shop", weight: 1 }] }),
	plan({ projects: [{ id: "shop" }] }),
	plan({ projects: [{ id: "shop", weight: 1.5 }] }),
	plan({ projects: [{ id: "shop", weight: 1001 }] }),
	plan({ projects: [{ id: "shop", weight: -1 }] }),
	plan({ projects: [{ id: "shop", weight: 3, reason: "launch on Friday" }] }),
	plan({ projects: [{ id: "shop", weight: 3, reason: "   " }] }),
	plan({ projects: [{ id: "shop", weight: 3, reason: "tab\there" }] }),
	plan({ projects: [{ id: "shop", weight: 3, reason: "x".repeat(201) }] }),
	plan({ projects: [{ id: "shop", weight: 3, reason: "a‍b" }] }),
	plan({ projects: [{ id: "shop", weight: 3, repos: [{ ref: "a1b2c3d4", weight: 2 }, { ref: "9e8d7c6b", weight: 1 }] }] }),
	plan({ projects: [{ id: "shop", weight: 3, repos: [] }] }),
	plan({ projects: [{ id: "_other", weight: 3, repos: [{ ref: "a1b2c3d4", weight: 2 }] }] }),
	plan({ projects: [{ id: "shop", weight: 3, repos: [{ ref: "A1B2C3D4", weight: 2 }] }] }),
	plan({ projects: [{ id: "shop", weight: 3, repos: [{ ref: "a1b2c3d4", weight: 2 }, { ref: "a1b2c3d4", weight: 1 }] }] }),
	plan({ projects: [{ id: "shop", weight: 3, repos: [{ ref: "a1b2c3d4" }] }] }),
	plan({ projects: [{ id: "shop", weight: 3, repos: [{ ref: "a1b2c3d4", weight: 2, x: 1 }] }] }),
	plan({ projects: [{ id: "shop", weight: 3, repos: [{ weight: 2 }] }] }),
	plan({ projects: [{ id: "shop", weight: 3, repos: ["a1b2c3d4"] }] }),
	plan({ projects: Array.from({ length: 257 }, (_, i) => ({ id: `p${i}`, weight: 1 })) }),
	"{nope",
	"[]",
	"null",
	'"plan"',
	JSON.stringify({ version: 1, basis: null, projects: [{ id: "shop", weight: 3, reason: "y".repeat(17_000) }] }),
];

const verdict = (r) => (r.ok ? { ok: true } : { ok: false, reason: r.reason, field: r.field, rule: r.rule });

test("the vendored shape check gives parsePlan's verdict (no envelope, no projects file) on every corpus case (#505)", () => {
	for (const text of CORPUS) {
		for (const maxPlanDays of [DEFAULT_MAX_PLAN_DAYS, 60]) {
			assert.deepEqual(verdict(vendored.checkPlanShape(text, { now: NOW, maxPlanDays })), verdict(parsePlan(text, { now: NOW, maxPlanDays })), `${text.slice(0, 80)} (maxPlanDays ${maxPlanDays})`);
		}
	}
});

test("the vendored constants are the worker's (#505)", () => {
	assert.equal(vendored.PLAN_VERSION, PLAN_VERSION);
	assert.equal(vendored.WEIGHT_MAX, WEIGHT_MAX);
	assert.equal(vendored.REASON_MAX, REASON_MAX);
	assert.equal(vendored.PLAN_MAX_BYTES, PLAN_MAX_BYTES);
	assert.equal(vendored.DEFAULT_MAX_PLAN_DAYS, DEFAULT_MAX_PLAN_DAYS);
	assert.equal(vendored.OTHER, OTHER);
	assert.deepEqual(vendored.PLAN_FIELDS, PLAN_FIELDS);
	assert.deepEqual(vendored.PLAN_RULES, PLAN_RULES);
});

test("the runner's file name and refusal tokens are the host collector's (#505)", async () => {
	const host = await import("../src/outbox-plan.mjs");
	assert.equal(vendored.PLAN_FILE, host.PLAN_FILE);
	const src = (await import("node:fs")).readFileSync(new URL("../../image/runner/src/plan-check.mjs", import.meta.url), "utf8");
	const tokens = new Set([...src.matchAll(/"(plan-[a-z-]+)"/g)].map((m) => m[1]));
	for (const t of tokens) {
		if (t === "plan-invalid" || t === "plan-precheck-unjudged") continue;
		assert.ok(host.PLAN_COLLECT_REASONS.includes(t), `${t} is a token the host does not record`);
	}
});
