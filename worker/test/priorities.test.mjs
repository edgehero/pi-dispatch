import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	DEFAULT_MAX_PLAN_DAYS,
	OTHER,
	PLAN_FIELDS,
	PLAN_LADDER,
	PLAN_MAX_BYTES,
	PLAN_RULES,
	PLAN_VERSION,
	PLAN_WRITERS,
	REASON_MAX,
	WEIGHT_MAX,
	allocate,
	canonicalJson,
	envelopeEntries,
	neutralAllocation,
	parsePlan,
	planId,
	planRefusal,
	rebase,
	scopeRef,
} from "../src/priorities.mjs";

const M = 1_000_000; // micro-dollars per dollar
const NOW = Date.parse("2026-10-04T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

/** A normalized envelope as envelope.mjs returns it, built by hand so these tests judge priorities.mjs alone. */
function envelope({ total = 100 * M, floors = { shop: 10 * M, platform: 10 * M }, defaults = null, pct = 25, interval = 24, days = 14, writers = PLAN_WRITERS, enabled = true } = {}) {
	const f = { [OTHER]: 0, ...floors };
	const d = {};
	for (const id of Object.keys(f)) d[id] = defaults?.[id] ?? 1;
	return { version: 1, window: "week", totalMicros: total, floors: f, defaultWeights: d, delegation: { enabled, writers: [...writers], maxStepPct: pct, minIntervalHours: interval, maxPlanDays: days } };
}

const ENV = envelope();
const plan = (body) => JSON.stringify({ version: 1, basis: null, projects: [{ id: "shop", weight: 3 }, { id: "platform", weight: 1 }, { id: OTHER, weight: 0 }], ...body });
const parse = (body, opts = {}) => parsePlan(typeof body === "string" ? body : plan(body), { envelope: ENV, now: NOW, ...opts });

function refused(result, reason, field, rule) {
	assert.equal(result.ok, false, `expected a refusal on ${field}`);
	assert.deepEqual({ reason: result.reason, field: result.field, rule: result.rule }, { reason, field, rule });
	assert.ok(PLAN_FIELDS.includes(result.field), `${result.field} is in the fixed field list`);
	assert.ok(PLAN_RULES.includes(result.rule), `${result.rule} is in the fixed rule list`);
}

/** A small deterministic PRNG, so a failure names a seed that reproduces it. */
function mulberry(seed) {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ── parsePlan ───────────────────────────────────────────────────────────────────────────────────────────

test("parsePlan accepts the issue's plan and returns the canonical plan, its id and the resolved validUntil", () => {
	const text = JSON.stringify({
		version: 1,
		basis: "3f9a0c1d2e4b5a67",
		validUntil: "2026-10-12T00:00:00Z",
		projects: [
			{ id: "shop", weight: 3, reason: "launch on Friday", repos: [{ ref: "a1b2c3d4", weight: 2 }, { ref: "9e8d7c6b", weight: 1 }] },
			{ id: "platform", weight: 1, reason: "maintenance only" },
			{ id: OTHER, weight: 0 },
		],
	});
	const r = parsePlan(text, { envelope: ENV, now: NOW });
	assert.equal(r.ok, true);
	assert.deepEqual(r.plan, {
		version: 1,
		basis: "3f9a0c1d2e4b5a67",
		validUntil: "2026-10-12T00:00:00.000Z",
		projects: [
			{ id: OTHER, weight: 0 },
			{ id: "platform", weight: 1, reason: "maintenance only" },
			{ id: "shop", weight: 3, reason: "launch on Friday", repos: [{ ref: "9e8d7c6b", weight: 1 }, { ref: "a1b2c3d4", weight: 2 }] },
		],
	});
	assert.equal(r.validUntil, "2026-10-12T00:00:00.000Z");
	assert.equal(r.id, planId(r.plan));
	assert.equal(PLAN_VERSION, 1);
});

test("a written validUntil enters the id in one spelling: Z and .000Z, one instant, give one id", () => {
	const a = parse({ validUntil: "2026-10-12T00:00:00Z" });
	const b = parse({ validUntil: "2026-10-12T00:00:00.000Z" });
	const c = parse({ validUntil: "2026-10-12T00:00:00.0Z" });
	assert.equal(a.ok && b.ok && c.ok, true);
	assert.equal(a.id, b.id);
	assert.equal(a.id, c.id);
	assert.equal(a.plan.validUntil, "2026-10-12T00:00:00.000Z");
	assert.notEqual(parse({ validUntil: "2026-10-12T00:00:00.001Z" }).id, a.id, "another instant is another plan");
});

test("planId is the first 16 hex of sha256 over sorted-key canonical JSON, and key or list order does not move it", () => {
	const a = parse({});
	const b = parse(JSON.stringify({ projects: [{ weight: 0, id: OTHER }, { weight: 1, id: "platform" }, { weight: 3, id: "shop" }], basis: null, version: 1 }));
	assert.equal(a.id, b.id);
	assert.equal(a.id, createHash("sha256").update(canonicalJson(a.plan)).digest("hex").slice(0, 16));
	assert.match(a.id, /^[0-9a-f]{16}$/);
	assert.equal(canonicalJson({ b: 1, a: [{ d: null, c: "x" }] }), '{"a":[{"c":"x","d":null}],"b":1}');
	assert.notEqual(parse({ projects: [{ id: "shop", weight: 2 }, { id: "platform", weight: 1 }, { id: OTHER, weight: 0 }] }).id, a.id, "a weight is part of the id");
});

test("an absent validUntil defaults to now plus maxPlanDays and stays out of the id, so a re-read plan keeps its id", () => {
	const first = parse({});
	const later = parse({}, { now: NOW + 3 * DAY });
	assert.equal(first.id, later.id, "the id is a property of what was written");
	assert.equal(first.validUntil, new Date(NOW + 14 * DAY).toISOString());
	assert.equal(later.validUntil, new Date(NOW + 17 * DAY).toISOString());
	assert.equal(parse({}, { maxPlanDays: 2 }).validUntil, new Date(NOW + 2 * DAY).toISOString(), "the caller's maxPlanDays wins");
	assert.equal(parsePlan(plan({}), { now: NOW }).validUntil, new Date(NOW + DEFAULT_MAX_PLAN_DAYS * DAY).toISOString(), "no envelope: the default");
	assert.throws(() => parsePlan(plan({}), { envelope: ENV }), /`now`/, "the clock is required, never read");
});

test("parsePlan never throws a RangeError: maxPlanDays is capped at 366 and both instants must fit a Date", () => {
	for (const maxPlanDays of [0, 367, 1e9, 1.5]) assert.throws(() => parse({}, { maxPlanDays }), (e) => e instanceof TypeError && /maxPlanDays must be an integer from 1 to 366/.test(e.message));
	assert.equal(parse({}, { maxPlanDays: 366 }).ok, true);
	for (const now of [8.64e15, 8.64e15 - DAY, -8.64e15 - 1]) {
		assert.throws(() => parse({}, { now }), (e) => e instanceof TypeError && /outside the range a Date can hold/.test(e.message), String(now));
	}
	assert.throws(() => parse({ validUntil: "2026-10-05T00:00:00Z" }, { now: 1e300 }), TypeError);
});

test("parsePlan: the body and the plan object", () => {
	refused(parsePlan(42, { now: NOW }), "plan-invalid", "body", "type");
	refused(parse("{nope"), "plan-invalid", "body", "json");
	refused(parse(" ".repeat(PLAN_MAX_BYTES + 1)), "plan-invalid", "body", "too-large");
	refused(parse("[]"), "plan-invalid", "plan", "shape");
	refused(parse("null"), "plan-invalid", "plan", "shape");
	refused(parse({ note: "hi" }), "plan-invalid", "plan", "unknown-key");
});

test("a refusal never quotes what the agent wrote, not even an unknown key's name", () => {
	const marker = "zzSECRETzz";
	for (const r of [parse({ [marker]: 1 }), parse(`{"version":1,"${marker}`), parse({ projects: [{ id: "shop", weight: 1, [marker]: 1 }] })]) {
		assert.equal(r.ok, false);
		assert.ok(!JSON.stringify(r).includes(marker), JSON.stringify(r));
	}
});

test("parsePlan: version is required, an integer >= 1, and a newer one is refused", () => {
	refused(parse(JSON.stringify({ basis: null, projects: [] })), "plan-invalid", "version", "missing");
	refused(parse({ version: "1" }), "plan-invalid", "version", "type");
	refused(parse({ version: 0 }), "plan-invalid", "version", "type");
	refused(parse({ version: 1.5 }), "plan-invalid", "version", "type");
	refused(parse({ version: 2 }), "plan-invalid", "version", "newer");
});

test("parsePlan: basis is required, 16 lowercase hex or null", () => {
	refused(parse(JSON.stringify({ version: 1, projects: [] })), "plan-invalid", "basis", "missing");
	for (const basis of ["3F9A0C1D2E4B5A67", "3f9a0c1d2e4b5a6", "3f9a0c1d2e4b5a678", "", 7, false, {}]) {
		refused(parse({ basis }), "plan-invalid", "basis", "format");
	}
	assert.equal(parse({ basis: "0123456789abcdef" }).ok, true);
});

test("parsePlan: validUntil is a UTC instant, after now, and no later than now plus maxPlanDays", () => {
	for (const validUntil of ["2026-10-12", "2026-10-12T00:00Z", "2026-10-12T00:00:00+00:00", "2026-02-30T00:00:00Z", 1760000000000, null]) {
		refused(parse({ validUntil }), "plan-invalid", "validUntil", "format");
	}
	refused(parse({ validUntil: new Date(NOW).toISOString() }), "plan-invalid", "validUntil", "past");
	refused(parse({ validUntil: "2026-10-01T00:00:00Z" }), "plan-invalid", "validUntil", "past");
	refused(parse({ validUntil: new Date(NOW + 14 * DAY + 1).toISOString() }), "plan-invalid", "validUntil", "too-far");
	assert.equal(parse({ validUntil: new Date(NOW + 14 * DAY).toISOString() }).ok, true, "exactly the limit is allowed");
	assert.equal(parse({ validUntil: "2026-10-05T00:00:00.5Z" }).ok, true, "milliseconds are allowed");
});

test("parsePlan: projects is a list of objects with known keys", () => {
	refused(parse(JSON.stringify({ version: 1, basis: null })), "plan-invalid", "projects", "missing");
	refused(parse({ projects: {} }), "plan-invalid", "projects", "type");
	refused(parse({ projects: ["shop"] }), "plan-invalid", "projects", "shape");
	refused(parse({ projects: [{ id: "shop", weight: 1, why: "x" }] }), "plan-invalid", "projects", "unknown-key");
	refused(parsePlan(plan({ projects: Array.from({ length: 257 }, (_, i) => ({ id: `p${i}`, weight: 1 })) }), { now: NOW }), "plan-invalid", "projects", "too-long");
});

test("parsePlan: a project id is required, well formed, unique and in the envelope", () => {
	refused(parse({ projects: [{ weight: 1 }] }), "plan-invalid", "projects.id", "missing");
	for (const id of ["Shop", "a:b", "-x", "", 7, "_others"]) refused(parse({ projects: [{ id, weight: 1 }] }), "plan-invalid", "projects.id", "format");
	refused(parse({ projects: [{ id: "shop", weight: 1 }, { id: "shop", weight: 2 }] }), "plan-invalid", "projects.id", "duplicate");
	refused(parse({ projects: [{ id: "web", weight: 1 }] }), "plan-invalid", "projects.id", "unknown-id");
	assert.equal(parsePlan(plan({ projects: [{ id: "web", weight: 1 }] }), { now: NOW }).ok, true, "with no envelope the id is checked for form only");
});

test("parsePlan: a weight is required and an integer from 0 to 1000", () => {
	refused(parse({ projects: [{ id: "shop" }] }), "plan-invalid", "projects.weight", "missing");
	for (const weight of ["1", 1.5, null, true]) refused(parse({ projects: [{ id: "shop", weight }] }), "plan-invalid", "projects.weight", "type");
	for (const weight of [-1, WEIGHT_MAX + 1]) refused(parse({ projects: [{ id: "shop", weight }] }), "plan-invalid", "projects.weight", "range");
	assert.equal(WEIGHT_MAX, 1000);
});

test("parsePlan: a reason is optional, at most 200 characters, and a control or bidi character is refused, not stripped", () => {
	const at = (reason) => parse({ projects: [{ id: "shop", weight: 3, reason }, { id: "platform", weight: 1 }, { id: OTHER, weight: 0 }] });
	for (const reason of [7, "", "   ", null]) refused(at(reason), "plan-invalid", "projects.reason", "type");
	for (const cp of [0x00, 0x07, 0x0a, 0x1b, 0x7f, 0x85, 0x9b, 0x2028, 0x2029, 0x061c, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069]) {
		refused(at(`launch ${String.fromCodePoint(cp)} soon`), "plan-invalid", "projects.reason", "control-char");
	}
	// Every format character, a lone surrogate, private use and unassigned code points: each draws as nothing or as
	// something the writer cannot see, and the panel would show it.
	for (const cp of [0x00ad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0xe0041, 0xe007f, 0xd800, 0xdfff, 0xe000, 0xf0000, 0x0378, 0x10ffff]) {
		refused(at(`launch ${String.fromCharCode(...(cp > 0xffff ? [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)] : [cp]))} soon`), "plan-invalid", "projects.reason", "control-char");
	}
	refused(at("x".repeat(REASON_MAX + 1)), "plan-invalid", "projects.reason", "too-long");
	assert.equal(at("x".repeat(REASON_MAX)).ok, true);
	assert.equal(at(String.fromCodePoint(0x1f680).repeat(REASON_MAX)).ok, true, "counted in code points: 200 astral characters fit");
	assert.equal(at("Lancering op vrijdag, café").ok, true);
	assert.equal(REASON_MAX, 200);
});

test("parsePlan: repos is optional, a non-empty list of { ref, weight }, refs 8 hex and unique", () => {
	const at = (repos, id = "shop") => parse({ projects: [{ id, weight: 1, repos }, ...["shop", "platform", OTHER].filter((x) => x !== id).map((x) => ({ id: x, weight: 1 }))] });
	for (const repos of [[], {}, "a1b2c3d4"]) refused(at(repos), "plan-invalid", "projects.repos", "type");
	refused(at([{ ref: "a1b2c3d4", weight: 1 }], OTHER), "plan-invalid", "projects.repos", "unknown-ref");
	refused(at(["a1b2c3d4"]), "plan-invalid", "projects.repos", "shape");
	refused(at([{ ref: "a1b2c3d4", weight: 1, path: "/srv" }]), "plan-invalid", "projects.repos", "unknown-key");
	refused(at(Array.from({ length: 257 }, (_, i) => ({ ref: i.toString(16).padStart(8, "0"), weight: 1 }))), "plan-invalid", "projects.repos", "too-long");
	refused(at([{ weight: 1 }]), "plan-invalid", "projects.repos.ref", "missing");
	for (const ref of ["A1B2C3D4", "a1b2c3d", "github:acme/web", 7]) refused(at([{ ref, weight: 1 }]), "plan-invalid", "projects.repos.ref", "format");
	refused(at([{ ref: "a1b2c3d4", weight: 1 }, { ref: "a1b2c3d4", weight: 2 }]), "plan-invalid", "projects.repos.ref", "duplicate");
	refused(at([{ ref: "a1b2c3d4" }]), "plan-invalid", "projects.repos.weight", "missing");
	refused(at([{ ref: "a1b2c3d4", weight: 0.5 }]), "plan-invalid", "projects.repos.weight", "type");
	refused(at([{ ref: "a1b2c3d4", weight: 1001 }]), "plan-invalid", "projects.repos.weight", "range");
});

test("scopeRef is the first 8 hex of sha256 over the canonical scope, and repos are complete by ref when projects are given", () => {
	assert.equal(scopeRef("github:acme/web"), createHash("sha256").update("github:acme/web").digest("hex").slice(0, 8));
	const projects = [{ id: "shop", members: ["github:acme/web", "/srv/shop-tools"] }, { id: "platform", members: ["github:acme/platform"] }];
	const web = scopeRef("github:acme/web");
	const tools = scopeRef("/srv/shop-tools");
	const body = (repos) => ({ projects: [{ id: "shop", weight: 1, repos }, { id: "platform", weight: 1 }, { id: OTHER, weight: 1 }] });
	assert.equal(parse(body([{ ref: web, weight: 2 }, { ref: tools, weight: 1 }]), { projects }).ok, true);
	const partial = parse(body([{ ref: web, weight: 2 }]), { projects });
	refused(partial, "plan-incomplete", "projects.repos", "missing-repo");
	assert.equal(partial.id, planId(partial.plan), "an incomplete plan still carries its id, for the ladder");
	refused(parse(body([{ ref: web, weight: 2 }, { ref: "00000000", weight: 1 }]), { projects }), "plan-invalid", "projects.repos.ref", "unknown-ref");
	assert.equal(parse(body([{ ref: "00000000", weight: 1 }])).ok, true, "without projects a ref is checked for form only");
});

test("parsePlan: a plan that leaves out an envelope project is plan-incomplete, carrying its id", () => {
	const r = parse({ projects: [{ id: "shop", weight: 3 }, { id: "platform", weight: 1 }] });
	refused(r, "plan-incomplete", "projects", "missing-project");
	assert.equal(r.id, planId(r.plan));
	assert.match(r.validUntil, /Z$/);
	refused(parse({ projects: [] }), "plan-incomplete", "projects", "missing-project");
});

// ── the ladder ──────────────────────────────────────────────────────────────────────────────────────────

test("planRefusal walks the ladder in its order: delegation, writer, duplicate, stale, too soon, incomplete", () => {
	assert.deepEqual(PLAN_LADDER, ["delegation-off", "writer-not-allowed", "plan-duplicate", "plan-stale", "plan-too-soon", "plan-incomplete", "plan-busy"]);
	const ok = parse({});
	const incomplete = parse({ projects: [{ id: "shop", weight: 1 }] });
	const base = { envelope: ENV, writer: "portfolio-job", parsed: ok, current: null, now: NOW };
	assert.equal(planRefusal(base), null, "a first plan with basis null applies");
	assert.equal(planRefusal({ ...base, envelope: null }), "delegation-off");
	assert.equal(planRefusal({ ...base, envelope: envelope({ enabled: false }) }), "delegation-off");
	assert.equal(planRefusal({ ...base, envelope: envelope({ writers: ["operator-session"] }) }), "writer-not-allowed");
	assert.equal(planRefusal({ ...base, writer: "default" }), "writer-not-allowed", "a writer outside the fixed list never applies");
	assert.equal(planRefusal({ ...base, current: { planId: ok.id, lastPlanAt: null } }), "plan-duplicate");
	assert.equal(planRefusal({ ...base, current: { planId: "0123456789abcdef", lastPlanAt: null } }), "plan-stale");
	const next = parse({ basis: "0123456789abcdef" });
	assert.equal(planRefusal({ ...base, parsed: next, current: { planId: "0123456789abcdef", lastPlanAt: null } }), null, "a basis naming the current plan applies");
	const recent = { planId: "0123456789abcdef", lastPlanAt: new Date(NOW - 23 * 3600 * 1000).toISOString() };
	assert.equal(planRefusal({ ...base, parsed: next, current: recent }), "plan-too-soon");
	assert.equal(planRefusal({ ...base, parsed: next, current: { ...recent, lastPlanAt: new Date(NOW - 24 * 3600 * 1000).toISOString() } }), null, "the interval is inclusive of its end");
	assert.equal(planRefusal({ ...base, parsed: incomplete }), "plan-incomplete");
	assert.equal(planRefusal({ ...base, parsed: incomplete, current: { planId: incomplete.id, lastPlanAt: null } }), "plan-duplicate", "duplicate goes before incomplete");
	assert.equal(planRefusal({ ...base, parsed: incomplete, current: recent }), "plan-stale", "stale goes before incomplete");
	assert.equal(planRefusal({ ...base, envelope: envelope({ interval: 0 }), parsed: next, current: recent }), null, "an interval of 0 never refuses");
});

test("planRefusal compares the plan's BASIS with the current id, not the plan's own id or the last plan time", () => {
	const current = { planId: "0123456789abcdef", lastPlanAt: "2026-10-01T00:00:00Z" };
	const good = parse({ basis: "0123456789abcdef" });
	assert.equal(planRefusal({ envelope: ENV, writer: "operator-session", parsed: good, current, now: NOW }), null);
	const wrong = parse({ basis: "fedcba9876543210" });
	assert.equal(planRefusal({ envelope: ENV, writer: "operator-session", parsed: wrong, current, now: NOW }), "plan-stale");
	assert.equal(planRefusal({ envelope: ENV, writer: "operator-session", parsed: parse({}), current, now: NOW }), "plan-stale", "basis null is stale once a plan exists");
});

// ── allocate: the worked cases ──────────────────────────────────────────────────────────────────────────

test("worked case: $100, floors 10/10, weights 3:1 gives $70 and $30, not clamped", () => {
	const r = allocate({ envelope: ENV, weights: { shop: 3, platform: 1, [OTHER]: 0 } });
	assert.deepEqual(r.allocations, { [OTHER]: 0, platform: 30 * M, shop: 70 * M });
	assert.equal(r.unallocated, 0);
	assert.equal(r.clamped, false);
});

test("worked case: three equal weights over a $70 remainder give 23,333,334 / 23,333,333 / 23,333,333 by id", () => {
	const env = envelope({ total: 70 * M, floors: { alpha: 0, beta: 0, gamma: 0 } });
	const r = allocate({ envelope: env, weights: { alpha: 1, beta: 1, gamma: 1, [OTHER]: 0 } });
	assert.deepEqual(r.allocations, { [OTHER]: 0, alpha: 23_333_334, beta: 23_333_333, gamma: 23_333_333 });
	// The same split, ids reversed: the extra micro-dollar follows the id, not the order the entries came in.
	const swapped = allocate({ envelope: envelope({ total: 70 * M, floors: { gamma: 0, beta: 0, alpha: 0 } }), weights: { gamma: 1, beta: 1, alpha: 1, [OTHER]: 0 } });
	assert.deepEqual(swapped.allocations, r.allocations);
});

test("worked case: from 50/50, weights 1:0 with a 25% step gives 75/25, clamped", () => {
	const current = { allocations: { shop: 50 * M, platform: 50 * M, [OTHER]: 0 }, unallocated: 0 };
	const r = allocate({ envelope: ENV, weights: { shop: 1, platform: 0, [OTHER]: 0 }, current });
	assert.deepEqual(r.allocations, { [OTHER]: 0, platform: 25 * M, shop: 75 * M });
	assert.equal(r.clamped, true);
	assert.deepEqual(r.target.allocations, { [OTHER]: 0, platform: 10 * M, shop: 90 * M }, "the target is recorded beside the clamped result");
	// Two steps reach the target (75/25, then 90/10), and further plans hold it: never past a floor. The threat
	// model's worked example (90 and 10 within four days) is this walk.
	let state = current;
	for (let day = 0; day < 4; day++) state = allocate({ envelope: ENV, weights: { shop: 1, platform: 0, [OTHER]: 0 }, current: state });
	assert.deepEqual(state.allocations, { [OTHER]: 0, platform: 10 * M, shop: 90 * M });
});

test("worked case with _other at default weight 1: the neutral split, and 3:1:0 from it clamps", () => {
	const neutral = neutralAllocation(ENV);
	assert.deepEqual(neutral.allocations, { [OTHER]: 26_666_667, platform: 36_666_667, shop: 36_666_666 });
	const r = allocate({ envelope: ENV, weights: { shop: 3, platform: 1, [OTHER]: 0 }, current: neutral });
	// The binding move is shop going up 33.33 of the total, past the 25 step, so every entry moves 25/33.33, three
	// quarters of its way: shop +25, platform -5, _other -20.
	assert.equal(r.clamped, true, "shop would move 33.33 of the total, past the 25 step");
	assert.deepEqual(r.allocations, { [OTHER]: 6_666_667, platform: 31_666_667, shop: 61_666_666 });
	assert.equal(r.unallocated, 0);
});

test("all weights 0: every entry gets its floor and the rest stays unallocated", () => {
	const r = allocate({ envelope: ENV, weights: { shop: 0, platform: 0, [OTHER]: 0 } });
	assert.deepEqual(r.allocations, { [OTHER]: 0, platform: 10 * M, shop: 10 * M });
	assert.equal(r.unallocated, 80 * M);
	// From a full split, all-zero weights move only the step, the unallocated money counted as one more entry.
	const from = allocate({ envelope: ENV, weights: { shop: 3, platform: 1, [OTHER]: 0 } });
	const stepped = allocate({ envelope: ENV, weights: { shop: 0, platform: 0, [OTHER]: 0 }, current: from });
	assert.equal(stepped.clamped, true);
	assert.equal(stepped.unallocated, 25 * M, "the unallocated entry moved by exactly the step");
	assert.ok(stepped.allocations.shop >= 10 * M && stepped.allocations.platform >= 10 * M);
});

test("the neutral allocation uses defaultWeights with no step", () => {
	const r = neutralAllocation(envelope({ defaults: { shop: 1, platform: 1, [OTHER]: 0 } }));
	assert.deepEqual(r.allocations, { [OTHER]: 0, platform: 50 * M, shop: 50 * M });
	assert.equal(r.clamped, false);
});

test("the step uses floor(total * maxStepPct / 100), exact on a total that does not divide", () => {
	const env = envelope({ total: 99_999_999, floors: { shop: 0, platform: 0 }, pct: 25 });
	const current = { allocations: { shop: 99_999_999, platform: 0, [OTHER]: 0 }, unallocated: 0 };
	const r = allocate({ envelope: env, weights: { shop: 0, platform: 1, [OTHER]: 0 }, current });
	assert.equal(r.clamped, true);
	assert.deepEqual(r.allocations, { [OTHER]: 0, platform: 24_999_999, shop: 75_000_000 }, "S is 24,999,999, never 25,000,000");
});

test("a target within the step applies as it is, and D = 0 is no step at all", () => {
	const from = allocate({ envelope: ENV, weights: { shop: 3, platform: 1, [OTHER]: 0 } });
	const same = allocate({ envelope: ENV, weights: { shop: 3, platform: 1, [OTHER]: 0 }, current: from });
	assert.deepEqual(same.allocations, from.allocations);
	assert.equal(same.clamped, false);
	const near = allocate({ envelope: ENV, weights: { shop: 1, platform: 1, [OTHER]: 0 }, current: from });
	assert.deepEqual(near.allocations, { [OTHER]: 0, platform: 50 * M, shop: 50 * M }, "a 20% move under a 25% step is not clamped");
	assert.equal(near.clamped, false);
});

test("per-repo shares split the project's stepped allocation by weight, ties by ref, with no floors and no step", () => {
	const current = { allocations: { shop: 50 * M, platform: 50 * M, [OTHER]: 0 }, unallocated: 0 };
	const r = allocate({ envelope: ENV, weights: { shop: 1, platform: 0, [OTHER]: 0 }, current, repos: { shop: { a1b2c3d4: 2, "9e8d7c6b": 1 }, platform: { "00000001": 1, "00000002": 1, "00000003": 1 } } });
	assert.deepEqual(r.repos.shop, { "9e8d7c6b": 25 * M, a1b2c3d4: 50 * M }, "75 split 2:1 inside the clamped 75");
	assert.deepEqual(r.repos.platform, { "00000001": 8_333_334, "00000002": 8_333_333, "00000003": 8_333_333 });
	assert.deepEqual(allocate({ envelope: ENV, weights: { shop: 1, platform: 1, [OTHER]: 0 }, repos: { shop: { a1b2c3d4: 0 } } }).repos.shop, { a1b2c3d4: 0 }, "all repo weights 0 give each repo 0");
	assert.throws(() => allocate({ envelope: ENV, weights: { shop: 1, platform: 1, [OTHER]: 0 }, repos: { [OTHER]: { a1b2c3d4: 1 } } }), /not an envelope project/);
});

test("allocate refuses inputs it cannot answer for, rather than guess a money answer", () => {
	const w = { shop: 1, platform: 1, [OTHER]: 1 };
	assert.throws(() => allocate({ envelope: ENV, weights: { shop: 1, platform: 1 } }), /weights\._other/);
	assert.throws(() => allocate({ envelope: ENV, weights: { ...w, web: 1 } }), /not an envelope entry/);
	assert.throws(() => allocate({ envelope: ENV, weights: { ...w, shop: 1.5 } }), /integer from 0 to 1000/);
	assert.throws(() => allocate({ envelope: { ...ENV, totalMicros: 2 ** 53 }, weights: w }), /safe integer/);
	assert.throws(() => allocate({ envelope: { ...ENV, totalMicros: 10 * M }, weights: w }), /floors exceed/);
	assert.throws(() => allocate({ envelope: ENV, weights: w, current: { allocations: { shop: 50 * M, platform: 50 * M }, unallocated: 0 } }), /rebase it first/);
	assert.throws(() => allocate({ envelope: ENV, weights: w, current: { allocations: { shop: 50 * M, platform: 40 * M, [OTHER]: 0 }, unallocated: 0 } }), /does not sum/);
	assert.throws(() => allocate({ envelope: { ...ENV, delegation: { ...ENV.delegation, maxStepPct: 0 } }, weights: w, current: neutralAllocation(ENV) }), /maxStepPct/);
});

// ── allocate: properties over a seeded generator ────────────────────────────────────────────────────────

const POOL = ["api", "billing", "docs", "platform", "shop", "web", "x1", "zeta"];

/** A random envelope, weights and current vector, drawn from `rnd`. Totals include ones that do not divide. */
function draw(rnd) {
	const n = 1 + Math.floor(rnd() * 6);
	const ids = [...POOL].sort(() => rnd() - 0.5).slice(0, n);
	const totals = [1, 7, 99, 100 * M, 99_999_999, 123_456_789_011, 1_000_000 * M];
	const total = rnd() < 0.5 ? totals[Math.floor(rnd() * totals.length)] : 1 + Math.floor(rnd() * 1e9);
	const floors = {};
	let left = rnd() < 0.2 ? 0 : Math.floor(total * rnd() * 0.9);
	for (const id of [...ids, OTHER]) {
		const f = Math.floor(left * rnd() * 0.6);
		floors[id] = f;
		left -= f;
	}
	const { [OTHER]: otherFloor, ...rest } = floors;
	const env = envelope({ total, floors: rest, pct: 1 + Math.floor(rnd() * 100) });
	env.floors[OTHER] = otherFloor;
	const weight = () => (rnd() < 0.25 ? 0 : rnd() < 0.1 ? WEIGHT_MAX : Math.floor(rnd() * (WEIGHT_MAX + 1)));
	const weights = {};
	const prior = {};
	for (const id of envelopeEntries(env)) {
		weights[id] = weight();
		prior[id] = weight();
	}
	const current = rnd() < 0.2 ? null : allocate({ envelope: env, weights: prior });
	return { env, weights, current };
}

function sum(vector) {
	return Object.values(vector.allocations).reduce((s, v) => s + BigInt(v), 0n) + BigInt(vector.unallocated);
}

function shuffled(object, rnd) {
	const out = {};
	for (const k of Object.keys(object).sort(() => rnd() - 0.5)) out[k] = object[k];
	return out;
}

test("property: the result sums to the total, every floor holds, and nothing exceeds the total (2000 seeds)", () => {
	for (let seed = 1; seed <= 2000; seed++) {
		const { env, weights, current } = draw(mulberry(seed));
		const r = allocate({ envelope: env, weights, current });
		const total = BigInt(env.totalMicros);
		assert.equal(sum(r), total, `seed ${seed}: allocations plus unallocated equal the total`);
		const anyWeight = Object.values(weights).some((w) => w > 0);
		if (current === null && anyWeight) assert.equal(r.unallocated, 0, `seed ${seed}: any weight above 0 allocates everything`);
		for (const id of envelopeEntries(env)) {
			assert.ok(r.allocations[id] >= env.floors[id], `seed ${seed}: ${id} keeps its floor`);
			assert.ok(r.allocations[id] <= env.totalMicros, `seed ${seed}: ${id} is never above the total`);
			assert.ok(Number.isSafeInteger(r.allocations[id]), `seed ${seed}: ${id} is a safe integer`);
		}
		assert.ok(r.unallocated >= 0 && r.unallocated <= env.totalMicros, `seed ${seed}: unallocated is in range`);
		assert.equal(sum(r.target), total, `seed ${seed}: the target sums to the total`);
	}
});

test("property: no entry, the unallocated money included, moves by more than floor(total * pct / 100) (2000 seeds)", () => {
	let clampedSeen = 0;
	for (let seed = 1; seed <= 2000; seed++) {
		const { env, weights, current } = draw(mulberry(seed));
		if (current === null) continue;
		const r = allocate({ envelope: env, weights, current });
		const step = (BigInt(env.totalMicros) * BigInt(env.delegation.maxStepPct)) / 100n;
		const moves = [BigInt(r.unallocated) - BigInt(current.unallocated), ...envelopeEntries(env).map((id) => BigInt(r.allocations[id]) - BigInt(current.allocations[id]))].map((d) => (d < 0n ? -d : d));
		const largest = moves.reduce((a, b) => (b > a ? b : a), 0n);
		assert.ok(largest <= step, `seed ${seed}: a move of ${largest} exceeds the step ${step}`);
		if (r.clamped) {
			clampedSeen++;
			assert.equal(largest, step, `seed ${seed}: a clamped plan moves its furthest entry by exactly the step`);
		} else {
			assert.deepEqual({ a: r.allocations, u: r.unallocated }, { a: r.target.allocations, u: r.target.unallocated }, `seed ${seed}: unclamped is the target`);
		}
	}
	assert.ok(clampedSeen > 100, `the generator must exercise the step (${clampedSeen} clamped cases)`);
});

test("property: the result is the same whatever order the envelope, weights and current list their entries (500 seeds)", () => {
	for (let seed = 1; seed <= 500; seed++) {
		const rnd = mulberry(seed);
		const { env, weights, current } = draw(rnd);
		const r = allocate({ envelope: env, weights, current });
		const env2 = { ...env, floors: shuffled(env.floors, rnd), defaultWeights: shuffled(env.defaultWeights, rnd) };
		const current2 = current && { ...current, allocations: shuffled(current.allocations, rnd) };
		const r2 = allocate({ envelope: env2, weights: shuffled(weights, rnd), current: current2 });
		assert.deepEqual(r2, r, `seed ${seed}`);
	}
});

test("property: equal weights over equal floors differ by at most one micro-dollar, the extra going to the lower ids (500 seeds)", () => {
	for (let seed = 1; seed <= 500; seed++) {
		const rnd = mulberry(seed);
		const ids = POOL.slice(0, 2 + Math.floor(rnd() * 6));
		const total = 1 + Math.floor(rnd() * 1e9);
		const floors = Object.fromEntries(ids.map((id) => [id, 0]));
		const weights = { [OTHER]: 0, ...Object.fromEntries(ids.map((id) => [id, 7])) };
		const r = allocate({ envelope: envelope({ total, floors }), weights });
		const values = [...ids].sort().map((id) => r.allocations[id]);
		for (let i = 1; i < values.length; i++) assert.ok(values[i - 1] - values[i] === 0 || values[i - 1] - values[i] === 1, `seed ${seed}: ${values}`);
	}
});

// ── rebase ──────────────────────────────────────────────────────────────────────────────────────────────

test("rebase projects a clamped vector onto a new total by its current shares: it never jumps to the plan's target", () => {
	const clamped = { allocations: { shop: 75 * M, platform: 25 * M, [OTHER]: 0 }, unallocated: 0 };
	const r = rebase(clamped, { ...ENV, totalMicros: 200 * M });
	// Above the floors the vector holds 65 and 15; the new remainder of 180 splits 65:15, plus the floors.
	assert.deepEqual(r, { allocations: { [OTHER]: 0, platform: 43_750_000, shop: 156_250_000 }, unallocated: 0 });
	assert.notDeepEqual(r.allocations, { [OTHER]: 0, platform: 10 * M, shop: 190 * M }, "the target (weights 1:0) is not reached through an envelope edit");
	const shrunk = rebase(clamped, { ...ENV, totalMicros: 50 * M });
	assert.deepEqual(shrunk, { allocations: { [OTHER]: 0, platform: 15_625_000, shop: 34_375_000 }, unallocated: 0 });
});

test("rebase onto the same envelope is the identity, and onto a new envelope sums to its total with every floor held (1000 seeds)", () => {
	for (let seed = 1; seed <= 1000; seed++) {
		const rnd = mulberry(seed);
		const { env, current } = draw(rnd);
		if (current === null) continue;
		const vector = { allocations: current.allocations, unallocated: current.unallocated };
		assert.deepEqual(rebase(vector, env), vector, `seed ${seed}: identity`);
		const { env: other } = draw(rnd);
		const r = rebase(vector, other);
		assert.equal(sum(r), BigInt(other.totalMicros), `seed ${seed}: sums to the new total`);
		for (const id of envelopeEntries(other)) assert.ok(r.allocations[id] >= other.floors[id], `seed ${seed}: ${id} keeps its floor`);
		assert.deepEqual(Object.keys(r.allocations).sort(), envelopeEntries(other), `seed ${seed}: covers exactly the new entries`);
	}
});

test("rebase: the unallocated money weighs what it holds, so it stays unallocated in proportion", () => {
	const v = { allocations: { shop: 40 * M, platform: 10 * M, [OTHER]: 0 }, unallocated: 50 * M };
	// Above the floors: shop 30, platform 0, _other 0, unallocated 50. The new remainder of 180 splits 30:50.
	assert.deepEqual(rebase(v, { ...ENV, totalMicros: 200 * M }), { allocations: { [OTHER]: 0, platform: 10 * M, shop: 77_500_000 }, unallocated: 112_500_000 });
});

test("rebase: a new floor, an added project, a dropped project and unallocated money", () => {
	const v = { allocations: { shop: 70 * M, platform: 30 * M, [OTHER]: 0 }, unallocated: 0 };
	// A raised floor: platform's 30 sits 10 above a floor of 20, shop's 70 sits 60 above 10; the 70 left splits 60:10.
	assert.deepEqual(rebase(v, envelope({ floors: { shop: 10 * M, platform: 20 * M } })).allocations, { [OTHER]: 0, platform: 30 * M, shop: 70 * M });
	// An added project gets its floor and no more.
	const added = rebase(v, envelope({ floors: { shop: 10 * M, platform: 10 * M, web: 5 * M } }));
	assert.equal(added.allocations.web, 5 * M);
	assert.equal(sum(added), 100n * BigInt(M));
	// A dropped project's money moves to _other, where its jobs now count.
	const dropped = rebase(v, envelope({ floors: { shop: 10 * M } }));
	assert.deepEqual(dropped.allocations, { [OTHER]: 30 * M, shop: 70 * M });
	// Unallocated money stays unallocated in proportion, and all-floor vectors leave new headroom unallocated.
	const idle = { allocations: { shop: 10 * M, platform: 10 * M, [OTHER]: 0 }, unallocated: 80 * M };
	assert.deepEqual(rebase(idle, { ...ENV, totalMicros: 200 * M }), { allocations: { [OTHER]: 0, platform: 10 * M, shop: 10 * M }, unallocated: 180 * M });
	const full = { allocations: { shop: 50 * M, platform: 50 * M, [OTHER]: 0 }, unallocated: 0 };
	assert.deepEqual(rebase(full, envelope({ total: 120 * M, floors: { shop: 50 * M, platform: 50 * M } })), { allocations: { [OTHER]: 0, platform: 50 * M, shop: 50 * M }, unallocated: 20 * M });
});
