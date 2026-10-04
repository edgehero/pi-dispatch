import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { governedDollars, memberDollarKeyPrefix } from "../src/allocation.mjs";
import { envelopeDigest, parseEnvelope } from "../src/envelope.mjs";
import {
	PORTFOLIO_SNAPSHOT_MAX_BYTES,
	PORTFOLIO_SNAPSHOT_OVERSIZE,
	buildPortfolioSnapshot,
	makePortfolioSnapshot,
	memberLabel,
	readLocalRuns,
	windowBounds,
} from "../src/portfolio-snapshot.mjs";
import { InfraRetry } from "../src/processor.mjs";
import { scopeRef } from "../src/priorities.mjs";
import { dollarCapsFor, parseScopedLimits, scopeDollarKeyPrefix } from "../src/scoped-limits.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// The portfolio snapshot (issue #505, INT-CONTAINER-JOB-INPUTS). Every subject takes an injected `now`, always.

const USD = 1_000_000;
const NOW = new Date("2026-10-07T06:00:03.000Z");
const TITLE = "Fix the login bug before Friday";
const PROJECTS = [
	{ id: "shop", name: "Web Shop", members: ["github:acme/web", "/srv/acct/shop-tools"] },
	{ id: "platform", name: null, members: ["github:acme/infra"] },
];
const ENVELOPE = parseEnvelope(
	JSON.stringify({ version: 1, window: "week", totalUsd: "100", floorsUsd: { shop: "10", platform: "10" }, defaultWeights: { _other: 0 }, delegation: { enabled: true, writers: ["portfolio-job"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 } }),
	"/e/envelope.json",
	{ projects: PROJECTS, maxCostMicros: 2 * USD },
);
const DIGEST = envelopeDigest(ENVELOPE);
const WEB = scopeRef("github:acme/web");
const TOOLS = scopeRef("/srv/acct/shop-tools");
const INFRA = scopeRef("github:acme/infra");

/** An applied state: a plan of 3:1 with repo weights, and a reason that is agent text and must not reach the snapshot. */
const STATE = {
	version: 1,
	planId: "3f9a0c1d2e4b5a67",
	basis: null,
	writer: "portfolio-job",
	jobId: "repeat:pm-weekly:1",
	triggerId: "pm-weekly",
	appliedAt: "2026-10-05T06:00:00.000Z",
	lastPlanAt: "2026-10-05T06:00:00.000Z",
	validUntil: "2026-10-19T06:00:00.000Z",
	envelopeDigest: DIGEST,
	weights: { _other: 0, platform: 1, shop: 3 },
	repoWeights: { shop: { [WEB]: 2, [TOOLS]: 1 } },
	reasons: { shop: TITLE },
	allocations: { _other: 0, platform: 30 * USD, shop: 70 * USD },
	unallocated: 0,
	repos: { shop: { [WEB]: 46_666_667, [TOOLS]: 23_333_333 } },
	clamped: false,
};
const LAST = { v: 1, at: "2026-10-06T06:00:01.000Z", host: "mini1", writer: "portfolio-job", jobId: "repeat:pm-weekly:2", triggerId: "pm-weekly", outcome: "refused", reason: "plan-too-soon", field: null, planId: "0123456789abcdef", weights: { shop: 1 } };

/** Counters by key, read through MGET only. */
function fakeRedis(values = {}, { fail = false } = {}) {
	const calls = [];
	return {
		calls,
		async mget(...keys) {
			calls.push(keys);
			if (fail) throw Object.assign(new Error("down"), { code: "ECONNREFUSED" });
			return keys.map((k) => values[k] ?? null);
		},
	};
}
const week = (prefix) => `${prefix}:w:2026-10-05`;
const COUNTERS = { [week(scopeDollarKeyPrefix("project:shop"))]: "31000000", [week(scopeDollarKeyPrefix("project:platform"))]: "5000000", [week(scopeDollarKeyPrefix("github:acme/web"))]: "20000000" };

/** Runs: one of each outcome, one too old, one in no envelope project, and one carrying a planted title everywhere it can. */
const LOCAL = [
	{ jobId: "repeat:pm-weekly:1", outcome: "completed", project: "shop", endedAt: "2026-10-06T00:00:00.000Z" },
	{ jobId: "j2", outcome: "policy", reason: "allocation-cap", project: "shop", endedAt: "2026-10-06T01:00:00.000Z" },
	{ jobId: "j3", outcome: "policy", reason: TITLE, title: TITLE, task: TITLE, target: `local:${TITLE}`, flow: TITLE, project: "shop", endedAt: "2026-10-06T02:00:00.000Z" },
	{ jobId: "j4", outcome: "failed", project: "platform", endedAt: "2026-09-29T00:00:00.000Z" },
	{ jobId: "j5", outcome: "failed", reason: null, project: null, endedAt: "2026-10-06T03:00:00.000Z" },
];
const MIRRORED = [
	{ jobId: "j2", outcome: "policy", reason: "allocation-cap", project: "shop", endedAt: "2026-10-06T01:00:00.000Z", host: "mini1" },
	{ jobId: "j6", outcome: "completed", project: "platform", endedAt: "2026-10-06T04:00:00.000Z", host: "mini2" },
	{ jobId: "j7", outcome: "policy", reason: "scope-cap", project: "gone", endedAt: "2026-10-06T05:00:00.000Z", host: "mini2" },
];

/** The fixture, key order and all: the body is compared to its JSON byte for byte. */
const EXPECTED = {
	version: 1,
	generatedAt: "2026-10-07T06:00:03.000Z",
	window: { kind: "week", start: "2026-10-05", end: "2026-10-12" },
	envelope: { digest: DIGEST, totalMicros: 100_000_000, maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14, planAllowedAfter: "2026-10-06T06:00:00.000Z" },
	plan: { id: "3f9a0c1d2e4b5a67", writer: "portfolio-job", appliedAt: "2026-10-05T06:00:00.000Z", validUntil: "2026-10-19T06:00:00.000Z", clamped: false },
	lastAttempt: { at: "2026-10-06T06:00:01.000Z", outcome: "refused", reason: "plan-too-soon", planId: "0123456789abcdef" },
	projects: [
		{ id: "_other", floorMicros: 0, weight: 0, allocationMicros: 0, spentMicros: 0, members: [], runs7d: { completed: 0, policy: 1, failed: 1, byReason: { "scope-cap": 1 } } },
		{ id: "platform", floorMicros: 10_000_000, weight: 1, allocationMicros: 30_000_000, spentMicros: 5_000_000, members: [{ ref: INFRA, label: "github:acme/infra" }], runs7d: { completed: 1, policy: 0, failed: 0, byReason: {} } },
		{
			id: "shop",
			floorMicros: 10_000_000,
			weight: 3,
			allocationMicros: 70_000_000,
			spentMicros: 31_000_000,
			members: [
				{ ref: TOOLS, label: "local:shop-tools", weight: 1, allocationMicros: 23_333_333, spentMicros: 0 },
				{ ref: WEB, label: "github:acme/web", weight: 2, allocationMicros: 46_666_667, spentMicros: 20_000_000 },
			],
			runs7d: { completed: 1, policy: 2, failed: 0, byReason: { "allocation-cap": 1, other: 1 } },
		},
	],
	fleet: { runsComplete: true },
};

function factory({ flag = true, governing = { envelope: ENVELOPE, digest: DIGEST }, redis = fakeRedis(COUNTERS), mirror = true, readMirror = async () => ({ runs: MIRRORED, degraded: "ok" }), logsDir, state = STATE, reconcileThrows = false } = {}) {
	const logs = [];
	const build = makePortfolioSnapshot({
		checkPortfolioFlag: async () => flag,
		governing: () => governing,
		projects: () => PROJECTS,
		allocation: {
			reconcile: async () => {
				if (reconcileThrows) throw Object.assign(new Error("down"), { code: "ECONNREFUSED" });
				return { state, mismatch: false };
			},
			lastAttempt: async ({ kind, triggerId }) => (kind === "portfolio-job" && triggerId === "pm-weekly" ? LAST : null),
		},
		redis,
		logsDir,
		mirror,
		readMirror,
		now: () => NOW,
		log: (event, fields) => logs.push({ event, ...fields }),
	});
	return { build, logs, redis };
}

/** A logs dir holding LOCAL as run-record files, each with an mtime at its end. */
function logsDirWith(records) {
	const dir = tempDir("pi-dispatch-snapshot-logs-");
	for (const r of records) {
		const file = join(dir, `${r.jobId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
		writeFileSync(file, JSON.stringify(r));
		const at = new Date(r.endedAt);
		utimesSync(file, at, at);
	}
	writeFileSync(join(dir, "j3.log"), `raw log holding ${TITLE}\n`);
	return dir;
}

const JOB = { kind: "local", folder: "/srv/acct/pm", flow: "pm", trigger: { id: "pm-weekly", pattern: "0 6 * * 1" }, portfolio: true };

test("the snapshot of two projects with fake counters is the fixture byte for byte (#505)", async () => {
	const { build } = factory({ logsDir: logsDirWith(LOCAL) });
	const out = await build(JOB);
	assert.equal(out.body, JSON.stringify(EXPECTED, null, 2));
});

test("a planted issue title in a run record, a plan reason in the state and a path in projects.json never reach the snapshot (#505)", async () => {
	const { build } = factory({ logsDir: logsDirWith(LOCAL) });
	const { body } = await build(JOB);
	for (const needle of [TITLE, "Fix the login", "Web Shop", "/srv", "acct", "mini1", "mini2", "repeat:pm-weekly"]) assert.ok(!body.includes(needle), needle);
	// Every string value is an id, a digest, an instant, an enum token or an operator label.
	const strings = [];
	JSON.parse(body, (_k, v) => (typeof v === "string" ? strings.push(v) : v));
	for (const s of strings) assert.match(s, /^([a-z0-9_][a-z0-9-]*|[0-9a-f]{8,16}|\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}\.\d{3}Z)?|github:acme\/(web|infra)|local:shop-tools)$/, s);
});

test("without a run mirror (no PI_WORKER_NAME) runsComplete is false and only local runs are counted (#505)", async () => {
	let asked = false;
	const { build } = factory({ logsDir: logsDirWith(LOCAL), mirror: false, readMirror: async () => ((asked = true), { runs: MIRRORED, degraded: "ok" }) });
	const snap = JSON.parse((await build(JOB)).body);
	assert.equal(snap.fleet.runsComplete, false);
	assert.equal(asked, false, "no mirror is read without one");
	assert.equal(snap.projects.find((p) => p.id === "platform").runs7d.completed, 0, "the other host's run is not here");
});

test("a mirror that could not be read, or was cut short, makes runsComplete false; a mirror with nothing in it does not (#505)", async () => {
	for (const [degraded, complete] of [["unreachable (down)", false], ["truncated", false], ["off", true], ["ok", true]]) {
		const { build } = factory({ logsDir: logsDirWith(LOCAL), readMirror: async () => ({ runs: [], degraded }) });
		assert.equal(JSON.parse((await build(JOB)).body).fleet.runsComplete, complete, degraded);
	}
});

test("a snapshot over 64 KiB refuses the job before it spends, naming the project count (#505)", async () => {
	const floors = { _other: 0 };
	const weights = { _other: 1 };
	const allocations = { _other: 0 };
	const projects = [];
	for (let i = 0; i < 400; i++) {
		const id = `p${String(i).padStart(3, "0")}`;
		floors[id] = 0;
		weights[id] = 1;
		allocations[id] = 0;
		projects.push({ id, members: [`github:acme/r${i}`] });
	}
	const envelope = { version: 1, window: "week", totalMicros: 100 * USD, floors, defaultWeights: weights, delegation: { enabled: true, writers: ["portfolio-job"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 } };
	const logs = [];
	const build = makePortfolioSnapshot({
		checkPortfolioFlag: () => true,
		governing: () => ({ envelope, digest: "0123456789abcdef" }),
		projects: () => projects,
		allocation: { reconcile: async () => ({ state: { ...STATE, weights, allocations, repoWeights: {}, repos: {} } }), lastAttempt: async () => null },
		redis: fakeRedis(),
		logsDir: tempDir("pi-dispatch-snapshot-empty-"),
		now: () => NOW,
		log: (event, fields) => logs.push({ event, ...fields }),
	});
	const out = await build(JOB);
	assert.deepEqual(out, { outcome: "policy", reason: PORTFOLIO_SNAPSHOT_OVERSIZE });
	const line = logs.find((l) => l.event === "refused_portfolio_snapshot_oversize");
	assert.equal(line.projects, 401);
	assert.ok(line.bytes > PORTFOLIO_SNAPSHOT_MAX_BYTES);
});

test("a Valkey fault anywhere in the snapshot is an InfraRetry, never a policy refusal or a partial file (#505)", async () => {
	for (const over of [{ reconcileThrows: true }, { redis: fakeRedis({}, { fail: true }) }]) {
		const { build } = factory({ logsDir: tempDir("pi-dispatch-snapshot-empty-"), ...over });
		await assert.rejects(() => build(JOB), (e) => e instanceof InfraRetry);
	}
});

test("the live re-check: a flag no longer in the file, or a host with no envelope now, writes no snapshot and reads no Valkey (#505)", async () => {
	for (const over of [{ flag: false }, { governing: null }]) {
		const { build, redis, logs } = factory({ logsDir: tempDir("pi-dispatch-snapshot-empty-"), ...over });
		assert.equal(await build(JOB), null);
		assert.equal(redis.calls.length, 0);
		assert.equal(logs[0].event, "portfolio_snapshot_skipped");
	}
});

test("the neutral split shows plan null (so a plan's basis is null), and no lastAttempt reads null (#505)", async () => {
	const neutral = { ...STATE, planId: null, writer: "default", lastPlanAt: null, validUntil: null, repoWeights: {}, repos: {} };
	const snap = await buildPortfolioSnapshot({ envelope: ENVELOPE, digest: DIGEST, projects: PROJECTS, allocation: { state: neutral, lastAttempt: null }, redis: fakeRedis(), runs: { records: [], complete: true }, now: NOW });
	assert.equal(snap.plan, null);
	assert.equal(snap.lastAttempt, null);
	assert.equal(snap.envelope.planAllowedAfter, null);
	assert.deepEqual(snap.projects.find((p) => p.id === "shop").members, [{ ref: TOOLS, label: "local:shop-tools" }, { ref: WEB, label: "github:acme/web" }], "no repo weights: refs and labels only");
});

test("lastAttempt keeps enum tokens and an id only, and names the field a plan-invalid refusal named (#505)", async () => {
	const snap = await buildPortfolioSnapshot({ envelope: ENVELOPE, digest: DIGEST, projects: PROJECTS, allocation: { state: STATE, lastAttempt: { at: "2026-10-06T06:00:01.000Z", outcome: "refused", reason: "plan-invalid", field: "projects.weight", rule: "range", planId: null, reasons: { shop: TITLE } } }, redis: fakeRedis(), runs: { records: [] }, now: NOW });
	assert.deepEqual(snap.lastAttempt, { at: "2026-10-06T06:00:01.000Z", outcome: "refused", reason: "plan-invalid", planId: null, field: "projects.weight", rule: "range" });
	const odd = await buildPortfolioSnapshot({ envelope: ENVELOPE, digest: DIGEST, projects: PROJECTS, allocation: { state: STATE, lastAttempt: { at: TITLE, outcome: TITLE, reason: TITLE, field: TITLE, planId: TITLE } }, redis: fakeRedis(), runs: { records: [] }, now: NOW });
	assert.deepEqual(odd.lastAttempt, { at: null, outcome: null, reason: null, planId: null });
});

test("windowBounds: the UTC day, the Monday week and the month holding now (#505)", () => {
	assert.deepEqual(windowBounds("day", NOW), { kind: "day", start: "2026-10-07", end: "2026-10-08" });
	assert.deepEqual(windowBounds("week", new Date("2026-10-11T23:59:59.000Z")), { kind: "week", start: "2026-10-05", end: "2026-10-12" });
	assert.deepEqual(windowBounds("week", new Date("2026-10-05T00:00:00.000Z")), { kind: "week", start: "2026-10-05", end: "2026-10-12" });
	assert.deepEqual(windowBounds("month", new Date("2026-12-31T12:00:00.000Z")), { kind: "month", start: "2026-12-01", end: "2027-01-01" });
});

test("memberLabel: a forge member as stored, a folder by its basename only (#505)", () => {
	assert.equal(memberLabel("github:acme/web"), "github:acme/web");
	assert.equal(memberLabel("/Users/rob/src/shop-tools"), "local:shop-tools");
});

test("readLocalRuns reads run records only, skips a file older than the window by mtime, and a missing dir is complete (#505)", () => {
	const dir = logsDirWith(LOCAL);
	mkdirSync(join(dir, "allocations"));
	const { records, complete } = readLocalRuns({ logsDir: dir, sinceMs: NOW.getTime() - 7 * 86_400_000 });
	assert.equal(complete, true);
	assert.deepEqual(records.map((r) => r.jobId).sort(), ["j2", "j3", "j5", "repeat:pm-weekly:1"]);
	assert.deepEqual(readLocalRuns({ logsDir: join(dir, "nope"), sinceMs: 0 }), { records: [], complete: true });
	const failing = { readdirSync: () => ["a.json"], statSync: () => ({ isFile: () => true, mtimeMs: NOW.getTime() }), readFileSync: () => { throw Object.assign(new Error("io"), { code: "EIO" }); } };
	assert.equal(readLocalRuns({ logsDir: "/x", sinceMs: 0, fs: failing }).complete, false);
});

test("a member matched by a bare scoped-limits row is read from that row's key, the one enforcement settles into (#505 review)", async () => {
	const limits = parseScopedLimits(JSON.stringify({ version: 2, limits: [{ scope: "acme/web", weekUsd: "50" }] }), "/l.json");
	const rowKey = scopeDollarKeyPrefix("acme/web");
	assert.notEqual(rowKey, scopeDollarKeyPrefix("github:acme/web"), "the bare row and the member spell different keys");
	// Enforcement: a github job on acme/web with a repo share reserves in the matched row's key.
	const job = { kind: "github", repo: "acme/web" };
	const enforced = governedDollars({ envelope: ENVELOPE, state: STATE, member: { id: "shop", member: "github:acme/web" }, operator: { scopedDollars: dollarCapsFor(job, limits) } });
	assert.equal(enforced.scopedDollars.keyPrefix, rowKey);
	// The snapshot reads the same key, through the same helper.
	assert.equal(memberDollarKeyPrefix("github:acme/web", { limits }), rowKey);
	const redis = fakeRedis({ [week(rowKey)]: "7000000" });
	const snap = await buildPortfolioSnapshot({ envelope: ENVELOPE, digest: DIGEST, projects: PROJECTS, limits, allocation: { state: STATE }, redis, runs: { records: [] }, now: NOW });
	assert.equal(snap.projects.find((p) => p.id === "shop").members.find((m) => m.ref === WEB).spentMicros, 7_000_000);
	assert.ok(redis.calls[0].includes(week(rowKey)));
	// With no row the member's own synthetic key, both sides.
	assert.equal(memberDollarKeyPrefix("github:acme/web", { limits: [] }), scopeDollarKeyPrefix("github:acme/web"));
	assert.equal(governedDollars({ envelope: ENVELOPE, state: STATE, member: { id: "shop", member: "github:acme/web" }, operator: {} }).scopedDollars.keyPrefix, scopeDollarKeyPrefix("github:acme/web"));
	// A folder member matches a folder row the same way.
	const folderLimits = parseScopedLimits(JSON.stringify({ version: 2, limits: [{ scope: "/srv/acct/shop-tools", weekUsd: "5" }] }), "/l.json");
	assert.equal(memberDollarKeyPrefix("/srv/acct/shop-tools", { limits: folderLimits }), scopeDollarKeyPrefix("/srv/acct/shop-tools"));
});

test("a member label holding a control, bidi or format character is replaced by the member's ref (#505 review)", () => {
	for (const bad of ["github:acme/w\u202eeb", "github:acme/w\u0007eb", "/srv/shop\u200b-tools", "github:acme/web\u2028x"]) {
		assert.equal(memberLabel(bad), scopeRef(bad), JSON.stringify(bad));
	}
	assert.equal(memberLabel("github:Fabrikam Fiber/Web App"), "github:Fabrikam Fiber/Web App", "a space is ordinary");
});
