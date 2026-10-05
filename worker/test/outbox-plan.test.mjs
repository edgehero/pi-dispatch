import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ALLOC_LOG_KEY, CAS_SCRIPT, SEED_SCRIPT, makeAllocationState } from "../src/allocation.mjs";
import { envelopeDigest, parseEnvelope } from "../src/envelope.mjs";
import { RELEASE_IF_MINE } from "../src/fleet-lease.mjs";
import { PLAN_COLLECT_REASONS, makeCollectPlan } from "../src/outbox-plan.mjs";
import { PLAN_MAX_BYTES, parsePlan } from "../src/priorities.mjs";
import { PLAN_RECORD_REASONS } from "../src/run-history.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// The plan collector (issue #505, INT-OUTBOX-CONTRACT's second file). Every subject takes an injected `now`.

const NOW = new Date("2026-10-07T06:00:00.000Z");
const JOB_DIR = "/jobs/job-1";
const PLAN_PATH = join(JOB_DIR, "outbox", "priorities.json");
const DATA = { kind: "local", folder: "/srv/pm", flow: "pm", trigger: { id: "pm-weekly", pattern: "0 6 * * 1" }, portfolio: true };
const JOB = { id: "repeat:pm-weekly:100", data: DATA };
// `portfolio: true`: prepare wrote the snapshot, so prepare agreed (the third of the three decisions).
const PREPARED = { jobDir: JOB_DIR, workspace: "/srv/pm", sha: "abc", portfolio: true };
const TEXT = JSON.stringify({ version: 1, basis: null, projects: [{ id: "shop", weight: 3 }] });

/**
 * A fake fs with only what the collector touches. `file` is `{ content, lstat, open, fstat, grow }`: `lstat` and `fstat`
 * override the stat answers (`{ size, isFile }`), `open` is an error code to throw, `grow` extra bytes the read returns
 * past the fstat size. `absent` is no file at all. Every call is recorded, so "never opened" can be asserted.
 */
function fakeFs({ absent = false, content = TEXT, lstat = {}, open = null, fstat = {}, grow = 0, throwAll = false } = {}) {
	const calls = [];
	const bytes = Buffer.concat([Buffer.from(content), Buffer.alloc(grow, 0x20)]);
	const stat = (over) => ({ size: over.size ?? Buffer.byteLength(content), isFile: () => over.isFile ?? true });
	return {
		calls,
		constants,
		lstatSync(p) {
			calls.push(["lstat", p]);
			if (throwAll) throw Object.assign(new Error("io"), { code: "EIO" });
			if (absent) throw Object.assign(new Error("nope"), { code: "ENOENT" });
			return stat(lstat);
		},
		// What following a link gives: the target, a regular file of the content's size. Only a defect calls it.
		statSync(p) {
			calls.push(["stat", p]);
			if (throwAll) throw Object.assign(new Error("io"), { code: "EIO" });
			if (absent) throw Object.assign(new Error("nope"), { code: "ENOENT" });
			return stat({});
		},
		openSync(p, flags) {
			calls.push(["open", p, flags]);
			if (open) throw Object.assign(new Error(open), { code: open });
			return 7;
		},
		fstatSync(fd) {
			calls.push(["fstat", fd]);
			return stat(fstat);
		},
		readSync(fd, buf, off, len) {
			const at = calls.filter((c) => c[0] === "read").reduce((s, c) => s + c[1], 0);
			const n = Math.max(0, Math.min(len, bytes.length - at));
			bytes.copy(buf, off, at, at + n);
			calls.push(["read", n]);
			return n;
		},
		closeSync(fd) {
			calls.push(["close", fd]);
		},
	};
}

/** A fake allocation state: applyPlan answers `answer`, recordRefusal keeps its rows. */
function fakeAllocation(answer = { outcome: "applied", reason: null, planId: "0123456789abcdef", clamped: true }) {
	const applied = [];
	const refusals = [];
	return {
		applied,
		refusals,
		async applyPlan(args) {
			applied.push(args);
			if (answer instanceof Error) throw answer;
			return answer;
		},
		async recordRefusal(args) {
			refusals.push(args);
		},
	};
}

function collector({ fs = fakeFs(), allocation = fakeAllocation(), live = true, governing = { envelope: { e: 1 }, digest: "d".repeat(16) } } = {}) {
	const logs = [];
	const flagCalls = [];
	const collect = makeCollectPlan({
		allocation,
		governing: () => governing,
		projects: () => [{ id: "shop", members: [] }],
		checkPortfolioFlag: (data) => {
			flagCalls.push(data);
			if (live instanceof Error) throw live;
			return live;
		},
		fs,
		log: (event, fields) => logs.push({ event, ...fields }),
		now: () => NOW,
	});
	return { collect, logs, allocation, fs, flagCalls };
}

const refusedAs = (reason) => ({ outcome: "refused", reason, planId: null, clamped: false });

test("no priorities.json (or no outbox, or a forge job) collects nothing for a job that is no confirmed portfolio job: plan null, no row, no apply (#505, #507)", async () => {
	const cases = [
		["a forge job", { id: "g", data: { kind: "github" } }, PREPARED, true],
		["no job dir", JOB, null, true],
		["the pickup said no", JOB, PREPARED, false],
		["a manual run", { id: "m", data: { kind: "local", folder: "/srv/pm" } }, PREPARED, false],
		["a chained child", { id: "c", data: { ...DATA, parentJobId: "p", chainDepth: 1 } }, PREPARED, true],
		["an unflagged cron job", { id: "u", data: { ...DATA, portfolio: undefined } }, PREPARED, true],
		["prepare wrote no snapshot (the flag went away before prepare)", JOB, { ...PREPARED, portfolio: undefined }, true],
	];
	for (const [what, job, prepared, portfolio] of cases) {
		for (const fs of [fakeFs({ absent: true }), Object.assign(fakeFs({ absent: true }), { lstatSync: () => { throw Object.assign(new Error("not a dir"), { code: "ENOTDIR" }); } })]) {
			const { collect, allocation, logs } = collector({ fs });
			assert.equal(await collect({ job, prepared, portfolio }), null, what);
			assert.equal(allocation.applied.length + allocation.refusals.length, 0, what);
			assert.equal(logs.length, 0, what);
		}
	}
	// The flag removed from the live file while the job ran: it is no longer asked for a plan.
	for (const live of [false, new Error("unreadable")]) {
		const { collect, allocation, logs } = collector({ fs: fakeFs({ absent: true }), live });
		assert.equal(await collect({ job: JOB, prepared: PREPARED, portfolio: true }), null);
		assert.equal(allocation.refusals.length + logs.length, 0);
	}
});

test("plan-absent: a confirmed portfolio job that wrote no plan is refused and recorded, a log line and an audit row (#507)", async () => {
	for (const code of ["ENOENT", "ENOTDIR"]) {
		const fs = fakeFs({ absent: true });
		fs.lstatSync = (p) => {
			fs.calls.push(["lstat", p]);
			throw Object.assign(new Error("nope"), { code });
		};
		const { collect, allocation, logs, flagCalls } = collector({ fs });
		assert.deepEqual(await collect({ job: JOB, prepared: PREPARED, portfolio: true }), refusedAs("plan-absent"), code);
		assert.equal(allocation.applied.length, 0);
		assert.equal(allocation.refusals.length, 1, `${code}: one audit and alloc:log row`);
		assert.equal(allocation.refusals[0].reason, "plan-absent");
		assert.deepEqual(allocation.refusals[0].writer, { kind: "portfolio-job", jobId: JOB.id, triggerId: "pm-weekly" });
		assert.deepEqual(logs, [{ event: "plan_collected", jobId: JOB.id, outcome: "refused", reason: "plan-absent" }]);
		assert.deepEqual(flagCalls, [DATA], "only after the live file agreed");
		assert.ok(!fs.calls.some((c) => c[0] === "open"));
	}
});

test("a flagged job's plan is applied with the portfolio-job writer, its id and trigger, and the pickup's envelope (#505)", async () => {
	const { collect, allocation, logs, fs } = collector();
	const plan = await collect({ job: JOB, prepared: PREPARED, portfolio: true });
	assert.deepEqual(plan, { outcome: "applied", reason: null, planId: "0123456789abcdef", clamped: true });
	const [args] = allocation.applied;
	assert.deepEqual(args.writer, { kind: "portfolio-job", jobId: "repeat:pm-weekly:100", triggerId: "pm-weekly" });
	assert.equal(args.text, TEXT);
	assert.equal(args.digest, "d".repeat(16));
	assert.equal(args.now, NOW);
	assert.deepEqual(logs, [{ event: "plan_collected", jobId: "repeat:pm-weekly:100", outcome: "applied", reason: null }]);
	const open = fs.calls.find((c) => c[0] === "open");
	assert.equal(open[2] & constants.O_NOFOLLOW, constants.O_NOFOLLOW, "opened with O_NOFOLLOW");
	assert.equal(open[2] & constants.O_NONBLOCK, constants.O_NONBLOCK, "and O_NONBLOCK");
	assert.ok(fs.calls.some((c) => c[0] === "fstat"), "the open descriptor is fstat'ed");
	assert.ok(fs.calls.some((c) => c[0] === "close"));
});

test("plan-not-portfolio: a manual job, a chained child, an unflagged cron job, and a job the pickup did not confirm (#505)", async () => {
	const cases = [
		["manual run", { kind: "local", folder: "/srv/pm", portfolio: true }, true],
		["chained child", { ...DATA, parentJobId: "p", chainDepth: 1 }, true],
		["chain depth alone", { ...DATA, chainDepth: 1 }, true],
		["unflagged cron job", { ...DATA, portfolio: undefined }, true],
		["a flag that is not exactly true", { ...DATA, portfolio: "true" }, true],
		["the pickup said no (the live file did not flag it then)", DATA, false],
	];
	for (const [what, data, pickup] of cases) {
		const { collect, allocation, fs, logs } = collector();
		assert.deepEqual(await collect({ job: { id: "j", data }, prepared: PREPARED, portfolio: pickup }), refusedAs("plan-not-portfolio"), what);
		assert.equal(allocation.applied.length, 0, what);
		// Never a portfolio job: the run record and the log line only, never an audit or alloc:log row.
		assert.equal(allocation.refusals.length, 0, `${what}: no audit or alloc:log row`);
		assert.deepEqual(logs, [{ event: "plan_collected", jobId: "j", outcome: "refused", reason: "plan-not-portfolio" }], what);
		assert.ok(!fs.calls.some((c) => c[0] === "open"), `${what}: the file is never opened`);
	}
});

test("a confirmed job whose prepare wrote no snapshot is refused, and that refusal IS recorded: it is the trigger's own attempt (#505)", async () => {
	const { collect, allocation, fs, flagCalls } = collector();
	assert.deepEqual(await collect({ job: JOB, prepared: { ...PREPARED, portfolio: undefined }, portfolio: true }), refusedAs("plan-not-portfolio"));
	assert.equal(allocation.applied.length, 0);
	assert.equal(allocation.refusals.length, 1);
	assert.deepEqual(allocation.refusals[0].writer, { kind: "portfolio-job", jobId: JOB.id, triggerId: "pm-weekly" });
	assert.ok(!fs.calls.some((c) => c[0] === "open"));
	assert.deepEqual(flagCalls, [], "decided before the live file is asked");
});

test("an outbox the job made unreadable is judged by authority first: a non-portfolio job has no plan, a confirmed one is plan-unreadable (#505)", async () => {
	const eacces = () => {
		const f = fakeFs();
		f.lstatSync = (p) => {
			f.calls.push(["lstat", p]);
			throw Object.assign(new Error("denied"), { code: "EACCES" });
		};
		return f;
	};
	// No file proven present on the non-portfolio path: no plan at all, so the record stays byte-identical.
	const manual = collector({ fs: eacces() });
	assert.equal(await manual.collect({ job: { id: "m", data: { kind: "local", folder: "/srv/pm" } }, prepared: PREPARED, portfolio: false }), null);
	assert.equal(manual.allocation.refusals.length, 0);
	assert.deepEqual(manual.logs, [], "no log line either");
	const flagged = collector({ fs: eacces() });
	assert.deepEqual(await flagged.collect({ job: JOB, prepared: PREPARED, portfolio: true }), refusedAs("plan-unreadable"));
	assert.equal(flagged.allocation.refusals[0].reason, "plan-unreadable");
});

test("a flag removed from the live file after the job was picked up refuses its plan as plan-not-portfolio (#505)", async () => {
	const { collect, allocation, flagCalls } = collector({ live: false });
	assert.deepEqual(await collect({ job: JOB, prepared: PREPARED, portfolio: true }), refusedAs("plan-not-portfolio"));
	assert.equal(allocation.applied.length, 0);
	assert.deepEqual(flagCalls, [DATA], "asked about the job's data as queued");
	const thrown = collector({ live: new Error("unreadable") });
	assert.deepEqual(await thrown.collect({ job: JOB, prepared: PREPARED, portfolio: true }), refusedAs("plan-not-portfolio"), "a check that throws grants nothing");
});

test("the ladder in order: oversize, then not a regular file, then the descriptor checks, then parse (#505)", async () => {
	const big = PLAN_MAX_BYTES + 1;
	const cases = [
		["oversize by lstat, before anything is opened (even when it is no regular file)", { lstat: { size: big, isFile: false } }, "plan-oversize", false],
		["a symlink (lstat does not follow it)", { lstat: { size: 20, isFile: false } }, "plan-not-regular-file", false],
		["a link swapped in after the lstat: O_NOFOLLOW gives ELOOP", { open: "ELOOP" }, "plan-not-regular-file", true],
		["a socket swapped in: ENXIO", { open: "ENXIO" }, "plan-not-regular-file", true],
		["an open that fails otherwise", { open: "EACCES" }, "plan-unreadable", true],
		["the descriptor is no regular file", { fstat: { isFile: false } }, "plan-not-regular-file", true],
		["the descriptor is over the cap", { fstat: { size: big } }, "plan-oversize", true],
		["a file that grows past the cap while it is read", { grow: PLAN_MAX_BYTES }, "plan-oversize", true],
		["not JSON", { content: "{nope" }, "plan-parse-error", true],
		["an array root", { content: "[]" }, "plan-parse-error", true],
		["a null root", { content: "null" }, "plan-parse-error", true],
	];
	for (const [what, fsOpts, reason, opened] of cases) {
		const { collect, allocation, fs } = collector({ fs: fakeFs(fsOpts) });
		assert.deepEqual(await collect({ job: JOB, prepared: PREPARED, portfolio: true }), refusedAs(reason), what);
		assert.equal(allocation.applied.length, 0, what);
		assert.equal(allocation.refusals[0].reason, reason, what);
		assert.equal(fs.calls.some((c) => c[0] === "open"), opened, `${what}: opened ${opened}`);
		if (opened && !fsOpts.open) assert.ok(fs.calls.some((c) => c[0] === "close"), `${what}: the descriptor is closed`);
	}
});

test("applyPlan's answers map onto the record: duplicate, a refusal with its reason, and a lost CAS as plan-stale (#505)", async () => {
	const cases = [
		[{ outcome: "duplicate", reason: "plan-duplicate", planId: "0123456789abcdef" }, { outcome: "duplicate", reason: "plan-duplicate", planId: "0123456789abcdef", clamped: false }],
		[{ outcome: "refused", reason: "plan-invalid", field: "projects.weight", rule: "range" }, refusedAs("plan-invalid")],
		[{ outcome: "refused", reason: "plan-too-soon", planId: "0123456789abcdef" }, { outcome: "refused", reason: "plan-too-soon", planId: "0123456789abcdef", clamped: false }],
		[{ outcome: "apply-failed", reason: "plan-stale", planId: "0123456789abcdef" }, { outcome: "refused", reason: "plan-stale", planId: "0123456789abcdef", clamped: false }],
		[{ outcome: "refused", reason: "Not A Token" }, refusedAs("plan-collect-error")],
	];
	for (const [answer, want] of cases) {
		const { collect, allocation } = collector({ allocation: fakeAllocation(answer) });
		assert.deepEqual(await collect({ job: JOB, prepared: PREPARED, portfolio: true }), want, JSON.stringify(answer));
		assert.equal(allocation.refusals.length, 0, "applyPlan records its own rows");
	}
});

test("the collector never throws: applyPlan rejecting, the refusal row failing, every fs call failing (#505)", async () => {
	const rejecting = collector({ allocation: fakeAllocation(Object.assign(new Error("valkey down"), { code: "ECONNREFUSED" })) });
	// Outcome unknown (a lost reply may hide a plan that applied): the record carries the plan's id, so it can be found.
	assert.deepEqual(await rejecting.collect({ job: JOB, prepared: PREPARED, portfolio: true }), { ...refusedAs("plan-collect-error"), planId: parsePlan(TEXT, { now: NOW }).id });
	assert.ok(rejecting.logs.some((l) => l.event === "plan_collect_failed" && l.code === "ECONNREFUSED"));

	const rowFails = fakeAllocation();
	rowFails.recordRefusal = async () => {
		throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
	};
	const c = collector({ allocation: rowFails, live: false });
	assert.deepEqual(await c.collect({ job: JOB, prepared: PREPARED, portfolio: true }), refusedAs("plan-not-portfolio"));
	assert.ok(c.logs.some((l) => l.event === "plan_refusal_row_lost" && l.code === "ENOSPC"));

	const broken = collector({ fs: fakeFs({ throwAll: true }) });
	assert.deepEqual(await broken.collect({ job: JOB, prepared: PREPARED, portfolio: true }), refusedAs("plan-unreadable"));
	const nowThrows = makeCollectPlan({ allocation: fakeAllocation(), now: () => {
		throw new Error("clock");
	} });
	assert.deepEqual(await nowThrows({ job: JOB, prepared: PREPARED, portfolio: true }), refusedAs("plan-collect-error"));
});

test("log lines carry jobId, outcome and reason only, never a byte of the plan (#505)", async () => {
	const secret = "Fix the login bug before Friday";
	const text = JSON.stringify({ version: 1, basis: null, projects: [{ id: "shop", weight: 3, reason: secret }] });
	for (const fsOpts of [{ content: text }, { content: `${text}{` }]) {
		const { collect, logs, allocation } = collector({ fs: fakeFs(fsOpts), allocation: fakeAllocation({ outcome: "refused", reason: "plan-too-soon" }) });
		await collect({ job: JOB, prepared: PREPARED, portfolio: true });
		for (const l of logs) assert.deepEqual(Object.keys(l).sort(), ["event", "jobId", "outcome", "reason"]);
		assert.ok(!JSON.stringify(logs).includes("Fix the"));
		assert.ok(!JSON.stringify(allocation.refusals).includes("Fix the"));
	}
});

test("every reason the collector can put in a record is one the record accepts (#505)", () => {
	for (const r of PLAN_COLLECT_REASONS) assert.ok(PLAN_RECORD_REASONS.includes(r), r);
});

// ── real files: the kernel's answers, not the fake's ───────────────────────────────────────────────────────────

function realJob() {
	const jobDir = tempDir("pi-dispatch-plan-");
	mkdirSync(join(jobDir, "outbox"));
	return { jobDir, path: join(jobDir, "outbox", "priorities.json"), prepared: { jobDir, portfolio: true } };
}

function realCollector(answer) {
	const allocation = fakeAllocation(answer);
	return { allocation, collect: makeCollectPlan({ allocation, governing: () => null, checkPortfolioFlag: () => true, now: () => NOW }) };
}

test("a symlinked priorities.json is refused as plan-not-regular-file and its target is never read (#505)", async () => {
	const { path, prepared, jobDir } = realJob();
	const target = join(jobDir, "elsewhere.json");
	writeFileSync(target, TEXT);
	symlinkSync(target, path);
	const { collect, allocation } = realCollector();
	assert.deepEqual(await collect({ job: JOB, prepared, portfolio: true }), refusedAs("plan-not-regular-file"));
	assert.equal(allocation.applied.length, 0);
});

test("a FIFO named priorities.json is refused at once, never blocking the worker (#505)", async () => {
	const { path, prepared } = realJob();
	execFileSync("mkfifo", [path]);
	const { collect } = realCollector();
	assert.deepEqual(await collect({ job: JOB, prepared, portfolio: true }), refusedAs("plan-not-regular-file"));
});

test("a real regular plan file is read whole and handed to applyPlan; a directory of that name is refused (#505)", async () => {
	const { path, prepared } = realJob();
	writeFileSync(path, TEXT);
	const { collect, allocation } = realCollector();
	assert.equal((await collect({ job: JOB, prepared, portfolio: true })).outcome, "applied");
	assert.equal(allocation.applied[0].text, TEXT);
	const dir = realJob();
	mkdirSync(dir.path);
	assert.deepEqual(await realCollector().collect({ job: JOB, prepared: dir.prepared, portfolio: true }), refusedAs("plan-not-regular-file"));
});

// ── with the real allocation state: duplicates, retries, and the refusal rows ─────────────────────────────────

const PROJECTS = [
	{ id: "shop", members: ["github:acme/web"] },
	{ id: "platform", members: ["github:acme/infra"] },
];
const ENVELOPE = parseEnvelope(
	JSON.stringify({ version: 1, window: "week", totalUsd: "100", floorsUsd: { shop: "10", platform: "10" }, defaultWeights: { _other: 0 }, delegation: { enabled: true, writers: ["portfolio-job", "operator-session"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 } }),
	"/e/envelope.json",
	{ projects: PROJECTS, maxCostMicros: 2_000_000 },
);
const DIGEST = envelopeDigest(ENVELOPE);
const planText = (shop, platform, basis) => JSON.stringify({ version: 1, basis, projects: [{ id: "shop", weight: shop }, { id: "platform", weight: platform }, { id: "_other", weight: 0 }] });

/** The allocation tests' fake Valkey: SET NX, the two scripts by their semantics, the release, and the list commands. */
function fakeRedis() {
	const store = new Map();
	const lists = new Map();
	return {
		store,
		lists,
		get: async (k) => (store.has(k) ? store.get(k) : null),
		async set(k, v, ...args) {
			if (args.includes("NX") && store.has(k)) return null;
			store.set(k, v);
			return "OK";
		},
		exists: async (k) => (store.has(k) ? 1 : 0),
		async eval(script, _n, key, ...argv) {
			if (script === CAS_SCRIPT) {
				const s = JSON.parse(store.get(key));
				if ((typeof s.planId === "string" ? s.planId : "") !== argv[0] || s.envelopeDigest !== argv[1]) return 0;
				store.set(key, argv[2]);
				return 1;
			}
			if (script === SEED_SCRIPT) {
				const [expectedKey, body, digest, mode] = argv;
				if (mode === "nx" && store.has(key)) return 0;
				store.set(key, body);
				store.set(expectedKey, digest);
				return 1;
			}
			if (script === RELEASE_IF_MINE) {
				if (store.get(key) !== argv[0]) return 0;
				store.delete(key);
				return 1;
			}
			throw new Error("unknown script");
		},
		async lpush(k, v) {
			const l = lists.get(k) ?? [];
			l.unshift(v);
			lists.set(k, l);
		},
		async ltrim(k, a, b) {
			lists.set(k, (lists.get(k) ?? []).slice(a, b + 1));
		},
		lrange: async (k, a, b) => (lists.get(k) ?? []).slice(a, b + 1),
	};
}

function realState(clock) {
	const redis = fakeRedis();
	const rows = [];
	const allocation = makeAllocationState({ redis, host: "mini1", audit: { append: (r) => rows.push(r) }, token: () => "t" });
	const files = new Map();
	const fs = {
		constants,
		lstatSync: (p) => {
			if (!files.has(p)) throw Object.assign(new Error("nope"), { code: "ENOENT" });
			return { size: Buffer.byteLength(files.get(p)), isFile: () => true };
		},
		openSync: (p) => p,
		fstatSync: (p) => ({ size: Buffer.byteLength(files.get(p)), isFile: () => true }),
		readSync(p, buf, off) {
			const b = Buffer.from(files.get(p));
			if (off >= b.length) return 0;
			b.copy(buf, off, off);
			return b.length - off;
		},
		closeSync() {},
	};
	const collect = makeCollectPlan({ allocation, governing: () => ({ envelope: ENVELOPE, digest: DIGEST }), projects: () => PROJECTS, checkPortfolioFlag: () => true, fs, now: () => clock.now });
	return { redis, rows, allocation, files, collect };
}

test("re-collecting the same plan file is plan-duplicate, a no-op; a retried attempt writing from a fresh snapshot is plan-too-soon (#505)", async () => {
	const clock = { now: NOW };
	const { redis, rows, files, collect } = realState(clock);
	files.set(PLAN_PATH, planText(3, 1, null));
	const first = await collect({ job: JOB, prepared: PREPARED, portfolio: true });
	assert.equal(first.outcome, "applied");
	const applied = redis.store.get("alloc:plan");

	// The same file collected again (a job re-run after its container completed, its outbox the same).
	clock.now = new Date(NOW.getTime() + 60_000);
	const again = await collect({ job: JOB, prepared: PREPARED, portfolio: true });
	assert.deepEqual(again, { outcome: "duplicate", reason: "plan-duplicate", planId: first.planId, clamped: false });
	assert.equal(redis.store.get("alloc:plan"), applied, "a duplicate changes nothing");

	// A retried attempt: a new container read a FRESH snapshot (plan.id is the plan that just applied) and wrote on it.
	files.set(PLAN_PATH, planText(2, 1, first.planId));
	const retried = await collect({ job: { ...JOB, attemptsMade: 1 }, prepared: PREPARED, portfolio: true });
	assert.deepEqual(retried.outcome, "refused");
	assert.equal(retried.reason, "plan-too-soon");
	assert.equal(redis.store.get("alloc:plan"), applied);
	assert.deepEqual(rows.map((r) => r.outcome), ["neutral", "applied", "duplicate", "refused"]);
});

test("a collector refusal is a file row and an alloc:log row with the enum reason, the writer and nothing of the body (#505)", async () => {
	const clock = { now: NOW };
	const { redis, rows, files, collect } = realState(clock);
	files.set(PLAN_PATH, '{"version": 1, "projects": "Fix the login bug"');
	assert.deepEqual(await collect({ job: JOB, prepared: PREPARED, portfolio: true }), refusedAs("plan-parse-error"));
	const [row] = rows;
	assert.equal(row.outcome, "refused");
	assert.equal(row.reason, "plan-parse-error");
	assert.equal(row.writer, "portfolio-job");
	assert.equal(row.jobId, JOB.id);
	assert.equal(row.triggerId, "pm-weekly");
	assert.equal(row.envelopeDigest, DIGEST);
	const logged = (redis.lists.get(ALLOC_LOG_KEY) ?? []).map((t) => JSON.parse(t));
	assert.deepEqual(logged, [row]);
	assert.ok(!JSON.stringify(rows).includes("Fix the"));
});

test("plan-absent reaches alloc:log as the trigger's last attempt; 500 non-portfolio jobs writing nothing leave it alone (#507)", async () => {
	const clock = { now: NOW };
	const { redis, rows, allocation, collect } = realState(clock);
	assert.deepEqual(await collect({ job: JOB, prepared: PREPARED, portfolio: true }), refusedAs("plan-absent"));
	assert.equal(rows.length, 1);
	assert.equal(rows[0].reason, "plan-absent");
	assert.equal(rows[0].writer, "portfolio-job");
	const last = await allocation.lastAttempt({ kind: "portfolio-job", triggerId: "pm-weekly" });
	assert.equal(last.outcome, "refused");
	assert.equal(last.reason, "plan-absent");
	const before = [...redis.lists.get(ALLOC_LOG_KEY)];
	for (let i = 0; i < 500; i++) {
		assert.equal(await collect({ job: { id: `manual:x:${i}`, data: { kind: "local", folder: "/srv/other" } }, prepared: PREPARED, portfolio: false }), null);
	}
	assert.deepEqual(redis.lists.get(ALLOC_LOG_KEY), before);
	assert.equal(rows.length, 1);
});

test("500 non-portfolio jobs leaving priorities.json leave alloc:log and the audit file untouched (#505 review)", async () => {
	const clock = { now: NOW };
	const { redis, rows, files, collect } = realState(clock);
	files.set(PLAN_PATH, planText(3, 1, null));
	assert.equal((await collect({ job: JOB, prepared: PREPARED, portfolio: true })).outcome, "applied");
	const before = [...(redis.lists.get(ALLOC_LOG_KEY) ?? [])];
	const rowsBefore = rows.length;
	for (let i = 0; i < 500; i++) {
		const r = await collect({ job: { id: `manual:x:${i}`, data: { kind: "local", folder: "/srv/other" } }, prepared: PREPARED, portfolio: false });
		assert.equal(r.reason, "plan-not-portfolio");
	}
	assert.deepEqual(redis.lists.get(ALLOC_LOG_KEY), before, "the revert history and lastAttempt survive");
	assert.equal(rows.length, rowsBefore);
	assert.ok(before.some((t) => JSON.parse(t).outcome === "applied"));
});
