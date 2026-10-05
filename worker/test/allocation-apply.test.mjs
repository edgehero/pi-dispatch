import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	ALLOC_EXPECTED_KEY,
	ALLOC_LOCK_KEY,
	ALLOC_LOG_KEY,
	ALLOC_LOG_MAX,
	ALLOC_PLAN_KEY,
	CAS_SCRIPT,
	SEED_SCRIPT,
	governedDollars,
	makeAllocationAudit,
	makeAllocationLogReaper,
	makeAllocationState,
	neutralState,
} from "../src/allocation.mjs";
import { envelopeDigest, parseEnvelope } from "../src/envelope.mjs";
import { RELEASE_IF_MINE } from "../src/fleet-lease.mjs";
import { scopeRef } from "../src/priorities.mjs";
import { scopeDollarKeyPrefix } from "../src/scoped-limits.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// The applied split (issue #504 part B, DES-DELEGATED-ALLOCATION-INSIDE-ENVELOPE). The fake Valkey is the fleet-lease
// test's (real SET NX PX semantics, compare-and-delete), extended with the two compare-and-set scripts by their
// semantics and with the list commands `alloc:log` uses. Every subject takes an injected `now`, always.

const USD = 1_000_000;
const NOW = Date.parse("2026-10-05T12:00:00Z");
const HOUR = 3_600_000;

function fakeRedis({ onEval = null } = {}) {
	const store = new Map();
	const lists = new Map();
	return {
		store,
		lists,
		async get(key) {
			return store.has(key) ? store.get(key) : null;
		},
		async set(key, value, ...args) {
			if (args.includes("NX") && store.has(key)) return null;
			store.set(key, value);
			return "OK";
		},
		async del(key) {
			store.delete(key);
		},
		async exists(key) {
			return store.has(key) ? 1 : 0;
		},
		async eval(script, _n, key, ...argv) {
			if (onEval) {
				const forced = await onEval(script, key, argv, store);
				if (forced !== undefined) return forced;
			}
			if (script === CAS_SCRIPT) {
				const cur = store.get(key);
				if (cur === undefined) return 0;
				let s;
				try {
					s = JSON.parse(cur);
				} catch {
					return 0;
				}
				if ((typeof s.planId === "string" ? s.planId : "") !== argv[0]) return 0;
				if (s.envelopeDigest !== argv[1]) return 0;
				store.set(key, argv[2]);
				return 1;
			}
			if (script === SEED_SCRIPT) {
				// KEYS[1] plan, KEYS[2] expected (the fake's `key` is KEYS[1]; KEYS[2] rides first in argv).
				const [expectedKey, body, digest, mode, was] = argv;
				if (mode === "nx" ? store.has(key) : store.get(key) !== was) return 0;
				store.set(key, body);
				if (mode === "nx" || !store.has(expectedKey)) store.set(expectedKey, digest);
				return 1;
			}
			if (script === RELEASE_IF_MINE) {
				if (store.get(key) !== argv[0]) return 0;
				store.delete(key);
				return 1;
			}
			throw new Error("unknown script");
		},
		async lpush(key, value) {
			const l = lists.get(key) ?? [];
			l.unshift(value);
			lists.set(key, l);
			return l.length;
		},
		async ltrim(key, start, stop) {
			const l = lists.get(key) ?? [];
			lists.set(key, l.slice(start, stop + 1));
		},
	};
}

/** An audit that keeps rows in memory and can look at Valkey when each row is written. */
function memAudit(redis = null) {
	const rows = [];
	return {
		rows,
		append(row) {
			rows.push({ row, planAtWrite: redis ? redis.store.get(ALLOC_PLAN_KEY) ?? null : null });
		},
	};
}

const PROJECTS = [
	{ id: "shop", name: null, members: ["github:acme/web", "github:acme/api"] },
	{ id: "platform", name: null, members: ["github:acme/infra"] },
];

function envelopeOf(over = {}) {
	const body = {
		version: 1,
		window: "week",
		totalUsd: "100",
		floorsUsd: { shop: "10", platform: "10", _other: "0" },
		defaultWeights: { shop: 1, platform: 1, _other: 0 },
		delegation: { enabled: true, writers: ["operator-session", "portfolio-job"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 },
		...over,
	};
	return parseEnvelope(JSON.stringify(body), "/e/envelope.json", { projects: PROJECTS, limits: [], maxCostMicros: 2 * USD });
}

const plan = (weights, basis = null, extra = {}) => JSON.stringify({ version: 1, basis, projects: Object.entries(weights).map(([id, weight]) => ({ id, weight, ...(extra[id] ?? {}) })), ...(extra.top ?? {}) });
const SESSION = { kind: "operator-session" };

function setup({ envelope = envelopeOf(), redis = fakeRedis(), host = "mini1" } = {}) {
	const audit = memAudit(redis);
	const alloc = makeAllocationState({ redis, host, audit, token: () => "t" });
	return { redis, audit, alloc, envelope, digest: envelopeDigest(envelope) };
}

const stored = (redis) => JSON.parse(redis.store.get(ALLOC_PLAN_KEY));
const logRows = (redis) => (redis.lists.get(ALLOC_LOG_KEY) ?? []).map((t) => JSON.parse(t));

test("the neutral split is persisted with SET NX, writer default, and a first plan with basis null applies (#504)", async () => {
	const { redis, audit, alloc, envelope, digest } = setup();
	const r = await alloc.reconcile({ envelope, digest, now: NOW });
	assert.equal(r.mismatch, false);
	const s = stored(redis);
	assert.equal(s.writer, "default");
	assert.equal(s.planId, null);
	assert.equal(s.envelopeDigest, digest);
	assert.deepEqual(s.allocations, { _other: 0, platform: 50 * USD, shop: 50 * USD });
	assert.equal(audit.rows.length, 1, "the seed's winner writes one neutral row");
	assert.equal(audit.rows[0].row.outcome, "neutral");

	const applied = await alloc.applyPlan({ envelope, digest, projects: PROJECTS, text: plan({ shop: 3, platform: 1, _other: 0 }), writer: SESSION, now: NOW });
	assert.equal(applied.outcome, "applied");
	const after = stored(redis);
	// From 50/50/0 to the target 70/30/0: a move of 20, inside the 25 step, so it applies whole.
	assert.deepEqual(after.allocations, { _other: 0, platform: 30 * USD, shop: 70 * USD });
	assert.equal(after.allocations.shop + after.allocations.platform + after.allocations._other + after.unallocated, 100 * USD);
	assert.equal(after.planId, applied.planId);
	assert.equal(after.lastPlanAt, new Date(NOW).toISOString());
});

test("the ladder refuses in its order, each rung recorded in the file and in alloc:log, nothing changed (#504)", async () => {
	// Each case is built so that EVERY later rung would also refuse it: the reason must be the earliest.
	const base = setup();
	await base.alloc.reconcile({ envelope: base.envelope, digest: base.digest, now: NOW });
	const first = await base.alloc.applyPlan({ envelope: base.envelope, digest: base.digest, projects: PROJECTS, text: plan({ shop: 3, platform: 1, _other: 0 }), writer: SESSION, now: NOW });
	assert.equal(first.outcome, "applied");
	const before = base.redis.store.get(ALLOC_PLAN_KEY);
	const incompleteStale = plan({ shop: 1 }, "0000000000000000");
	const cases = [
		["plan-invalid", { text: "{ not json", envelope: base.envelope }],
		["delegation-off", { text: incompleteStale, envelope: envelopeOf({ delegation: { enabled: false } }) }],
		["writer-not-allowed", { text: incompleteStale, writer: { kind: "portfolio-job" }, envelope: envelopeOf({ delegation: { enabled: true, writers: ["operator-session"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 } }) }],
		["envelope-mismatch", { text: incompleteStale, envelope: envelopeOf({ totalUsd: "90" }), expected: "someone-else" }],
		["plan-duplicate", { text: plan({ shop: 3, platform: 1, _other: 0 }), envelope: base.envelope }],
		["plan-stale", { text: incompleteStale, envelope: base.envelope }],
		["plan-too-soon", { text: plan({ shop: 1 }, first.planId), envelope: base.envelope, now: NOW + HOUR }],
		["plan-incomplete", { text: plan({ shop: 1 }, first.planId), envelope: base.envelope, now: NOW + 25 * HOUR }],
		["plan-busy", { text: plan({ shop: 1, platform: 1, _other: 1 }, first.planId), envelope: base.envelope, now: NOW + 25 * HOUR, locked: true }],
	];
	for (const [reason, c] of cases) {
		if (c.expected) base.redis.store.set(ALLOC_EXPECTED_KEY, c.expected);
		if (c.locked) base.redis.store.set(ALLOC_LOCK_KEY, "mini2#other");
		const rowsBefore = base.audit.rows.length;
		const logBefore = logRows(base.redis).length;
		const r = await base.alloc.applyPlan({ envelope: c.envelope, digest: envelopeDigest(c.envelope), projects: PROJECTS, text: c.text, writer: c.writer ?? SESSION, now: c.now ?? NOW });
		assert.equal(r.reason, reason, reason);
		assert.equal(r.outcome, reason === "plan-duplicate" ? "duplicate" : "refused", reason);
		assert.equal(base.redis.store.get(ALLOC_PLAN_KEY), before, `${reason} changed nothing`);
		// The mismatch also writes its one envelope-changed-externally row; the refusal is the other.
		const mine = base.audit.rows.slice(rowsBefore).map((x) => x.row).filter((x) => x.reason === reason && x.outcome !== "envelope-changed-externally");
		assert.equal(mine.length, 1, `${reason}: one file row`);
		assert.equal(logRows(base.redis).length, logBefore + base.audit.rows.slice(rowsBefore).length, `${reason}: alloc:log has the rows`);
		if (c.expected) base.redis.store.delete(ALLOC_EXPECTED_KEY);
		if (c.locked) {
			assert.equal(base.redis.store.get(ALLOC_LOCK_KEY), "mini2#other", "a busy refusal never touches the other holder's lock");
			base.redis.store.delete(ALLOC_LOCK_KEY);
		}
	}
});

test("audit order: the applied row is written while alloc:plan still holds the old state, and a lost CAS adds apply-failed (#504)", async () => {
	const { redis, audit, alloc, envelope, digest } = setup();
	await alloc.reconcile({ envelope, digest, now: NOW });
	const neutral = redis.store.get(ALLOC_PLAN_KEY);
	const r = await alloc.applyPlan({ envelope, digest, projects: PROJECTS, text: plan({ shop: 3, platform: 1, _other: 0 }), writer: SESSION, now: NOW });
	assert.equal(r.outcome, "applied");
	const appliedRow = audit.rows.find((x) => x.row.outcome === "applied");
	assert.equal(appliedRow.planAtWrite, neutral, "the file row came FIRST, before the CAS changed alloc:plan");

	// A CAS that loses (another host's write landed after this one read): the applied row, then apply-failed.
	const lost = setup({ redis: fakeRedis({ onEval: (script) => (script === CAS_SCRIPT ? 0 : undefined) }) });
	await lost.alloc.reconcile({ envelope: lost.envelope, digest: lost.digest, now: NOW });
	const before = lost.redis.store.get(ALLOC_PLAN_KEY);
	const f = await lost.alloc.applyPlan({ envelope: lost.envelope, digest: lost.digest, projects: PROJECTS, text: plan({ shop: 3, platform: 1, _other: 0 }), writer: SESSION, now: NOW });
	assert.deepEqual([f.outcome, f.reason], ["apply-failed", "plan-stale"]);
	assert.deepEqual(lost.audit.rows.map((x) => x.row.outcome).slice(-2), ["applied", "apply-failed"]);
	assert.equal(lost.redis.store.get(ALLOC_PLAN_KEY), before);
	assert.equal(logRows(lost.redis)[0].outcome, "apply-failed", "alloc:log gets the failure, never the row whose change did not happen");
	assert.ok(!logRows(lost.redis).some((x) => x.outcome === "applied"));
});

test("the CAS compares the envelope digest: a state another host re-based refuses a write made against the old digest (#504)", async () => {
	const { redis, alloc, envelope, digest } = setup();
	await alloc.reconcile({ envelope, digest, now: NOW });
	// Between this host's read and its CAS, another host re-bases to a new digest, keeping the plan id (null).
	const raced = setup({
		redis: fakeRedis({
			onEval: (script, _key, _argv, store) => {
				if (script !== CAS_SCRIPT) return undefined;
				const s = JSON.parse(store.get(ALLOC_PLAN_KEY));
				if (s.envelopeDigest === "rebased-elsewhere") return undefined;
				store.set(ALLOC_PLAN_KEY, JSON.stringify({ ...s, envelopeDigest: "rebased-elsewhere" }));
				return undefined;
			},
		}),
	});
	raced.redis.store.set(ALLOC_PLAN_KEY, redis.store.get(ALLOC_PLAN_KEY));
	const r = await raced.alloc.applyPlan({ envelope, digest, projects: PROJECTS, text: plan({ shop: 3, platform: 1, _other: 0 }), writer: SESSION, now: NOW });
	assert.equal(r.outcome, "apply-failed");
	assert.equal(stored(raced.redis).envelopeDigest, "rebased-elsewhere", "the other host's state stands");
});

test("the lock is released only while it is ours: a lock that expired and was retaken mid-apply stays with its new holder (#504)", async () => {
	const redis = fakeRedis();
	const audit = {
		rows: [],
		append(row) {
			this.rows.push(row);
			// Mid-apply, after the lock was taken: it expires and another host takes it.
			if (row.outcome === "applied") redis.store.set(ALLOC_LOCK_KEY, "mini2#theirs");
		},
	};
	const alloc = makeAllocationState({ redis, host: "mini1", audit, token: () => "mine" });
	const envelope = envelopeOf();
	const digest = envelopeDigest(envelope);
	await alloc.reconcile({ envelope, digest, now: NOW });
	await alloc.applyPlan({ envelope, digest, projects: PROJECTS, text: plan({ shop: 3, platform: 1, _other: 0 }), writer: SESSION, now: NOW });
	assert.equal(redis.store.get(ALLOC_LOCK_KEY), "mini2#theirs");
	// And a lock that is ours is gone after the apply.
	const own = setup();
	await own.alloc.reconcile({ envelope, digest, now: NOW });
	await own.alloc.applyPlan({ envelope, digest, projects: PROJECTS, text: plan({ shop: 3, platform: 1, _other: 0 }), writer: SESSION, now: NOW });
	assert.equal(own.redis.store.has(ALLOC_LOCK_KEY), false);
});

test("alloc:log keeps the newest 500 rows, with weights and micro-dollars and never a reason; the file keeps the reasons (#504)", async () => {
	const { redis, audit, alloc, envelope, digest } = setup();
	await alloc.reconcile({ envelope, digest, now: NOW });
	const r = await alloc.applyPlan({ envelope, digest, projects: PROJECTS, text: plan({ shop: 3, platform: 1, _other: 0 }, null, { shop: { reason: "launch on Friday" } }), writer: SESSION, now: NOW });
	assert.equal(r.outcome, "applied");
	const fileRow = audit.rows.find((x) => x.row.outcome === "applied").row;
	assert.deepEqual(fileRow.reasons, { shop: "launch on Friday" });
	assert.equal(stored(redis).reasons.shop, "launch on Friday", "alloc:plan carries the reasons");
	const logged = logRows(redis).find((x) => x.outcome === "applied");
	assert.equal("reasons" in logged, false);
	assert.deepEqual(logged.weights, { _other: 0, platform: 1, shop: 3 });
	assert.equal(typeof logged.after.allocations.shop, "number");
	assert.equal(JSON.stringify(logRows(redis)).includes("launch"), false, "no reason text anywhere in alloc:log");
	for (let i = 0; i < ALLOC_LOG_MAX + 40; i++) await alloc.applyPlan({ envelope, digest, projects: PROJECTS, text: "nope", writer: SESSION, now: NOW });
	assert.equal(redis.lists.get(ALLOC_LOG_KEY).length, ALLOC_LOG_MAX);
	assert.equal(logRows(redis)[0].reason, "plan-invalid", "newest first");
});

test("expiry: two hosts that both see an expired plan write exactly one expired row, and neutral applies (#504)", async () => {
	const redis = fakeRedis();
	const rows = [];
	const shared = { append: (row) => rows.push(row) };
	const mini1 = makeAllocationState({ redis, host: "mini1", audit: shared, token: () => "a" });
	const mini2 = makeAllocationState({ redis, host: "mini2", audit: shared, token: () => "b" });
	const envelope = envelopeOf();
	const digest = envelopeDigest(envelope);
	await mini1.reconcile({ envelope, digest, now: NOW });
	const until = new Date(NOW + 2 * 24 * HOUR).toISOString();
	const r = await mini1.applyPlan({ envelope, digest, projects: PROJECTS, text: plan({ shop: 3, platform: 1, _other: 0 }, null, { top: { validUntil: until } }), writer: SESSION, now: NOW });
	assert.equal(r.outcome, "applied");
	const later = NOW + 3 * 24 * HOUR;
	const [a, b] = await Promise.all([mini1.reconcile({ envelope, digest, now: later }), mini2.reconcile({ envelope, digest, now: later })]);
	assert.equal(rows.filter((x) => x.outcome === "expired").length, 1, "only the CAS winner writes the row");
	const s = stored(redis);
	assert.deepEqual([s.writer, s.planId], ["expiry", null]);
	assert.deepEqual(s.allocations, { _other: 0, platform: 50 * USD, shop: 50 * USD }, "the neutral split");
	assert.deepEqual(a.state.allocations, s.allocations);
	assert.deepEqual(b.state.allocations, s.allocations);
	// The next plan names the neutral state: basis null.
	const next = await mini2.applyPlan({ envelope, digest, projects: PROJECTS, text: plan({ shop: 1, platform: 3, _other: 0 }), writer: SESSION, now: later });
	assert.equal(next.outcome, "applied");
});

test("a flush puts the persisted neutral split back, and the interval starts over (#504)", async () => {
	const { redis, alloc, envelope, digest } = setup();
	await alloc.reconcile({ envelope, digest, now: NOW });
	const first = await alloc.applyPlan({ envelope, digest, projects: PROJECTS, text: plan({ shop: 3, platform: 1, _other: 0 }), writer: SESSION, now: NOW });
	assert.equal(first.outcome, "applied");
	redis.store.clear(); // FLUSHALL
	const r = await alloc.reconcile({ envelope, digest, now: NOW + HOUR });
	assert.deepEqual([r.state.writer, r.state.planId, r.state.lastPlanAt], ["default", null, null]);
	assert.equal(stored(redis).writer, "default", "persisted, so every host enforces one neutral split");
	const again = await alloc.applyPlan({ envelope, digest, projects: PROJECTS, text: plan({ shop: 3, platform: 1, _other: 0 }), writer: SESSION, now: NOW + HOUR });
	assert.equal(again.outcome, "applied", "basis null is accepted and the interval reset: one extra step per flush, named in DES");
	// A state that does not decode is replaced by neutral too, never trusted.
	redis.store.set(ALLOC_PLAN_KEY, "{ garbage");
	const fixed = await alloc.reconcile({ envelope, digest, now: NOW + 2 * HOUR });
	assert.equal(fixed.state.writer, "default");
});

test("a changed envelope re-bases only when its digest is alloc:envelope:expected; otherwise envelope-mismatch and one changed-externally row (#504)", async () => {
	const { redis, audit, alloc, envelope, digest } = setup();
	await alloc.reconcile({ envelope, digest, now: NOW });
	await alloc.applyPlan({ envelope, digest, projects: PROJECTS, text: plan({ shop: 3, platform: 1, _other: 0 }), writer: SESSION, now: NOW });
	const applied = stored(redis);
	redis.store.set(ALLOC_EXPECTED_KEY, digest);

	// A hand edit on one host: its digest is not the expected one.
	const edited = envelopeOf({ totalUsd: "120" });
	const editedDigest = envelopeDigest(edited);
	const m1 = await alloc.reconcile({ envelope: edited, digest: editedDigest, now: NOW + HOUR });
	const m2 = await alloc.reconcile({ envelope: edited, digest: editedDigest, now: NOW + 2 * HOUR });
	assert.equal(m1.mismatch, true);
	assert.equal(m2.mismatch, true);
	assert.equal(audit.rows.filter((x) => x.row.outcome === "envelope-changed-externally").length, 1, "one row per digest, not one per pickup");
	assert.equal(redis.store.get(ALLOC_PLAN_KEY), JSON.stringify(applied), "the fleet's split is untouched");

	// The admin writer stores the digest first: now the same host re-bases, by the applied vector's shares.
	redis.store.set(ALLOC_EXPECTED_KEY, editedDigest);
	const ok = await alloc.reconcile({ envelope: edited, digest: editedDigest, now: NOW + 3 * HOUR });
	assert.equal(ok.mismatch, false);
	const s = stored(redis);
	assert.deepEqual([s.writer, s.envelopeDigest, s.planId], ["envelope-change", editedDigest, applied.planId], "the plan id stands, so a writer's basis still names it");
	assert.equal(s.allocations.shop + s.allocations.platform + s.allocations._other + s.unallocated, 120 * USD);
	assert.equal(s.lastPlanAt, applied.lastPlanAt, "a re-base starts no interval");
	assert.equal(audit.rows.filter((x) => x.row.outcome === "rebased").length, 1);
});

test("alloc:envelope:expected is seeded with the APPLIED digest: a second host with another envelope mismatches, never re-bases the fleet (#504)", async () => {
	// Two hosts on one Valkey: A carries the fleet's envelope, B a hand edit. Whoever looks first, the split stays A's.
	const good = envelopeOf();
	const edited = envelopeOf({ totalUsd: "1000" });
	const goodDigest = envelopeDigest(good);
	const editedDigest = envelopeDigest(edited);
	const twoHosts = () => {
		const redis = fakeRedis();
		const rows = [];
		const audit = { append: (row) => rows.push(row) };
		return { redis, rows, A: makeAllocationState({ redis, host: "A", audit, token: () => "a" }), B: makeAllocationState({ redis, host: "B", audit, token: () => "b" }) };
	};
	// First boot, A first: the seed writes the expected digest with the split.
	{
		const { redis, rows, A, B } = twoHosts();
		await A.reconcile({ envelope: good, digest: goodDigest, now: NOW });
		assert.equal(redis.store.get(ALLOC_EXPECTED_KEY), goodDigest, "the seed names the envelope it was made for");
		assert.equal((await B.reconcile({ envelope: edited, digest: editedDigest, now: NOW })).mismatch, true, "the hand edit mismatches");
		assert.equal((await A.reconcile({ envelope: good, digest: goodDigest, now: NOW })).mismatch, false, "and the fleet's hosts keep running");
		assert.equal(stored(redis).envelopeDigest, goodDigest);
		assert.deepEqual(rows.map((r) => `${r.host}:${r.outcome}`), ["A:neutral", "B:envelope-changed-externally"]);
	}
	// After a flush, both at once: one seed wins the SET NX, and its digest is the expected one; the other mismatches.
	{
		const { redis, A, B } = twoHosts();
		const [a, b] = await Promise.all([A.reconcile({ envelope: good, digest: goodDigest, now: NOW }), B.reconcile({ envelope: edited, digest: editedDigest, now: NOW })]);
		const winner = stored(redis).envelopeDigest;
		assert.equal(redis.store.get(ALLOC_EXPECTED_KEY), winner, "the expected digest is the seed's, whichever host seeded");
		assert.equal([a, b].filter((r) => r.mismatch).length, 1, "exactly one host mismatches");
	}
	// The key alone deleted (or a state from before it existed): seeded with the applied digest, not the differing host's.
	{
		const { redis, A, B } = twoHosts();
		await A.reconcile({ envelope: good, digest: goodDigest, now: NOW });
		redis.store.delete(ALLOC_EXPECTED_KEY);
		assert.equal((await B.reconcile({ envelope: edited, digest: editedDigest, now: NOW })).mismatch, true);
		assert.equal(redis.store.get(ALLOC_EXPECTED_KEY), goodDigest);
		redis.store.delete(ALLOC_EXPECTED_KEY);
		await A.reconcile({ envelope: good, digest: goodDigest, now: NOW });
		assert.equal(redis.store.get(ALLOC_EXPECTED_KEY), goodDigest, "a host that agrees with the split seeds it too");
	}
});

test("a stored state with an amount that is not micro-dollars is corrupt and replaced by neutral; a newer one is neither trusted nor overwritten (#504)", async () => {
	for (const allocations of [{ shop: "lots", platform: 1, _other: 0 }, { shop: -5, platform: 1, _other: 0 }, { shop: 1.5, platform: 1, _other: 0 }, {}]) {
		const { redis, alloc, envelope, digest } = setup();
		redis.store.set(ALLOC_PLAN_KEY, JSON.stringify({ version: 1, planId: null, envelopeDigest: digest, allocations, unallocated: 0, repos: {} }));
		const r = await alloc.reconcile({ envelope, digest, now: NOW });
		assert.equal(r.state.writer, "default", JSON.stringify(allocations));
		assert.deepEqual(r.state.allocations, { _other: 0, platform: 50 * USD, shop: 50 * USD });
	}
	const { redis, alloc, envelope, digest } = setup();
	const repoBad = JSON.stringify({ version: 1, planId: null, envelopeDigest: digest, allocations: { shop: 1, platform: 1, _other: 0 }, unallocated: 0, repos: { shop: { a1b2c3d4: "x" } } });
	redis.store.set(ALLOC_PLAN_KEY, repoBad);
	assert.equal((await alloc.reconcile({ envelope, digest, now: NOW })).state.writer, "default", "a repo share counts too");
	const newer = JSON.stringify({ version: 2, planId: null, envelopeDigest: digest, allocations: { shop: 1 } });
	redis.store.set(ALLOC_PLAN_KEY, newer);
	const r = await alloc.reconcile({ envelope, digest, now: NOW });
	assert.deepEqual([r.mismatch, r.state], [true, null], "governed jobs refuse: money-safe");
	assert.equal(redis.store.get(ALLOC_PLAN_KEY), newer, "and the newer build's state is left as it is");
});

test("a shrink re-bases at once without the step rule, and turning delegation off applies neutral (#504)", async () => {
	const { redis, alloc, envelope, digest } = setup();
	await alloc.reconcile({ envelope, digest, now: NOW });
	await alloc.applyPlan({ envelope, digest, projects: PROJECTS, text: plan({ shop: 3, platform: 1, _other: 0 }), writer: SESSION, now: NOW });
	const big = stored(redis);
	const small = envelopeOf({ totalUsd: "30" });
	redis.store.set(ALLOC_EXPECTED_KEY, envelopeDigest(small));
	await alloc.reconcile({ envelope: small, digest: envelopeDigest(small), now: NOW + HOUR });
	const s = stored(redis);
	assert.equal(s.allocations.shop + s.allocations.platform + s.allocations._other + s.unallocated, 30 * USD);
	assert.ok(big.allocations.shop - s.allocations.shop > 25 * USD, "moved by more than the step: the operator's act takes no step");
	assert.ok(s.allocations.shop >= 10 * USD && s.allocations.platform >= 10 * USD, "the floors hold");

	const off = envelopeOf({ totalUsd: "30", delegation: { enabled: false } });
	redis.store.set(ALLOC_EXPECTED_KEY, envelopeDigest(off));
	const r = await alloc.reconcile({ envelope: off, digest: envelopeDigest(off), now: NOW + 2 * HOUR });
	assert.deepEqual([r.state.planId, r.state.writer], [null, "envelope-change"]);
});

test("operator-revert skips the interval and the step, and is still a CAS on the state it read (#504)", async () => {
	const { redis, audit, alloc, envelope, digest } = setup();
	await alloc.reconcile({ envelope, digest, now: NOW });
	const p1 = await alloc.applyPlan({ envelope, digest, projects: PROJECTS, text: plan({ shop: 3, platform: 1, _other: 0 }), writer: SESSION, now: NOW });
	const target = logRows(redis).find((x) => x.outcome === "applied" && x.planId === p1.planId);
	// Walk the agent's plans far away from it, a step a day.
	let basis = p1.planId;
	for (let d = 1; d <= 3; d++) {
		const r = await alloc.applyPlan({ envelope, digest, projects: PROJECTS, text: plan({ shop: 0, platform: 1, _other: 0 }, basis, { top: { validUntil: new Date(NOW + (d + 10) * 24 * HOUR).toISOString() } }), writer: SESSION, now: NOW + d * 24 * HOUR });
		assert.equal(r.outcome, "applied");
		basis = r.planId;
	}
	const far = stored(redis);
	// One minute after the last plan, the revert lands in full: no interval, no step.
	const at = NOW + 3 * 24 * HOUR + 60_000;
	const r = await alloc.revert({ envelope, digest, target, now: at });
	assert.equal(r.outcome, "reverted");
	const s = stored(redis);
	assert.equal(s.writer, "operator-revert");
	assert.ok(s.allocations.shop - far.allocations.shop > 25 * USD, "beyond one step");
	assert.equal(audit.rows.at(-1).row.outcome, "reverted");
	// Revert is refused while another apply holds the lock, and while delegation is off.
	redis.store.set(ALLOC_LOCK_KEY, "mini2#x");
	assert.equal((await alloc.revert({ envelope, digest, target, now: at })).reason, "plan-busy");
	redis.store.delete(ALLOC_LOCK_KEY);
	const off = envelopeOf({ delegation: { enabled: false } });
	assert.equal((await alloc.revert({ envelope: off, digest: envelopeDigest(off), target, now: at })).reason, "delegation-off");
});

test("a revert to a row with no plan restores the CURRENT neutral split, never an older envelope's; a plan's row is unchanged (#507)", async () => {
	const { redis, audit, alloc, envelope, digest } = setup();
	await alloc.reconcile({ envelope, digest, now: NOW });
	const until = new Date(NOW + 2 * 24 * HOUR).toISOString();
	const p = await alloc.applyPlan({ envelope, digest, projects: PROJECTS, text: plan({ shop: 3, platform: 1, _other: 0 }, null, { top: { validUntil: until } }), writer: SESSION, now: NOW });
	assert.equal(p.outcome, "applied");
	const later = NOW + 3 * 24 * HOUR;
	await alloc.reconcile({ envelope, digest, now: later });
	const expired = logRows(redis).find((x) => x.outcome === "expired");
	const seeded = logRows(redis).find((x) => x.outcome === "neutral");
	assert.equal(expired.planId, p.planId, "the row still names the plan that ran out: the audit's answer, kept");
	assert.deepEqual(expired.weights, { _other: 0, platform: 1, shop: 1 }, "the neutral of the envelope it was written under");
	// The operator changes the default weights through the expected-digest path, and the fleet re-bases onto it.
	const env2 = envelopeOf({ defaultWeights: { shop: 1, platform: 3, _other: 0 } });
	const d2 = envelopeDigest(env2);
	redis.store.set(ALLOC_EXPECTED_KEY, d2);
	await alloc.reconcile({ envelope: env2, digest: d2, now: later + HOUR });
	const q = await alloc.applyPlan({ envelope: env2, digest: d2, projects: PROJECTS, text: plan({ shop: 3, platform: 1, _other: 0 }), writer: SESSION, now: later + 2 * HOUR });
	assert.equal(q.outcome, "applied");
	const neutral2 = neutralState(env2, d2, new Date(later + 3 * HOUR));
	for (const [name, target] of [["expired", expired], ["neutral", seeded]]) {
		const r = await alloc.revert({ envelope: env2, digest: d2, target, now: later + 3 * HOUR });
		assert.deepEqual(r, { outcome: "reverted", reason: null, planId: null }, name);
		const s = stored(redis);
		assert.deepEqual([s.writer, s.planId, s.validUntil, s.lastPlanAt], ["operator-revert", null, null, new Date(later + 3 * HOUR).toISOString()], `${name}: no plan nobody wrote, nothing to expire`);
		assert.deepEqual(s.weights, env2.defaultWeights, `${name}: today's default weights, not the row's`);
		assert.deepEqual(s.allocations, neutral2.allocations, `${name}: the current neutral split`);
		assert.equal(audit.rows.at(-1).row.planId, null);
	}
	// A revert to an applied row is unchanged: its weights, its plan id, and a fresh expiry.
	const applied = logRows(redis).find((x) => x.outcome === "applied" && x.planId === q.planId);
	const back = await alloc.revert({ envelope: env2, digest: d2, target: applied, now: later + 4 * HOUR });
	assert.equal(back.planId, q.planId);
	assert.deepEqual(stored(redis).weights, { _other: 0, platform: 1, shop: 3 });
	assert.ok(stored(redis).validUntil, "a plan's revert carries an expiry");
	// An old plan row that does not cover this envelope's entries still refuses as before.
	assert.equal((await alloc.revert({ envelope: env2, digest: d2, target: { ...applied, weights: { shop: 1 } }, now: later + 5 * HOUR })).reason, "plan-incomplete");
});

test("governedDollars: min(row, allocation) with its source, synthetic ledgers for a project with no row and for _other, the total on the deployment (#504)", () => {
	const envelope = envelopeOf();
	const state = { allocations: { shop: 70 * USD, platform: 20 * USD, _other: 10 * USD }, unallocated: 0, repos: { shop: { [scopeRef("github:acme/web")]: 50 * USD, [scopeRef("github:acme/api")]: 20 * USD } } };
	// A project row above the allocation: the allocation binds; below it: the operator's row binds; a tie is the operator's.
	const row = (weekUsd) => ({ scope: "project:shop", keyPrefix: scopeDollarKeyPrefix("project:shop"), caps: { day: 5 * USD, week: weekUsd, month: null } });
	const a = governedDollars({ envelope, state, member: { id: "shop", member: "github:acme/web" }, operator: { dollarCaps: { day: null, week: 200 * USD, month: null }, scopedDollars: null, projectDollars: row(90 * USD) } });
	assert.deepEqual(a.projectDollars.caps, { day: 5 * USD, week: 70 * USD, month: null });
	assert.deepEqual(a.projectDollars.capSource, { day: "operator", week: "allocation", month: null });
	assert.deepEqual(a.dollarCaps, { day: null, week: 100 * USD, month: null });
	assert.equal(a.dollarCapSource.week, "allocation", "the envelope total binds the deployment ledger");
	assert.deepEqual(a.scopedDollars.caps.week, 50 * USD, "the repo share, through the scope slot");
	assert.equal(a.scopedDollars.keyPrefix, scopeDollarKeyPrefix("github:acme/web"));
	assert.equal(a.otherDollars, null);
	const tie = governedDollars({ envelope, state, member: { id: "shop", member: "github:acme/web" }, operator: { projectDollars: row(70 * USD) } });
	assert.equal(tie.projectDollars.capSource.week, "operator");
	// No row at all: a synthetic ledger keyed as a row would be, so it settles with the job's cost.
	const none = governedDollars({ envelope, state, member: { id: "platform", member: "github:acme/infra" }, operator: {} });
	assert.equal(none.projectDollars.keyPrefix, scopeDollarKeyPrefix("project:platform"));
	assert.deepEqual(none.projectDollars.caps, { day: null, week: 20 * USD, month: null });
	// No project: _other's own ledger.
	const other = governedDollars({ envelope, state, member: null, operator: {} });
	assert.equal(other.otherDollars.keyPrefix, scopeDollarKeyPrefix("project:_other"));
	assert.equal(other.otherDollars.caps.week, 10 * USD);
	assert.equal(other.projectDollars, null);
});

test("the audit file is YYYY-MM.jsonl under allocations/, appended; the reaper removes only aged files of that shape (#504)", () => {
	const logsDir = tempDir("pi-alloc-logs-");
	const audit = makeAllocationAudit({ logsDir });
	audit.append({ at: "2026-09-30T23:00:00.000Z", outcome: "refused" });
	audit.append({ at: "2026-10-01T01:00:00.000Z", outcome: "applied" });
	audit.append({ at: "2026-10-02T01:00:00.000Z", outcome: "applied" });
	const dir = join(logsDir, "allocations");
	assert.deepEqual(readdirSync(dir).sort(), ["2026-09.jsonl", "2026-10.jsonl"]);
	assert.equal(readFileSync(join(dir, "2026-10.jsonl"), "utf8").trim().split("\n").length, 2);
	writeFileSync(join(dir, "notes.txt"), "the operator's own file");
	mkdirSync(join(dir, "2020-01.jsonl.d"));
	const old = (NOW - 40 * 24 * HOUR) / 1000;
	utimesSync(join(dir, "2026-09.jsonl"), old, old);
	utimesSync(join(dir, "notes.txt"), old, old);
	const reaped = [];
	makeAllocationLogReaper({ logsDir, retentionDays: 30, now: () => NOW, log: (e, f) => reaped.push([e, f]) })();
	assert.deepEqual(readdirSync(dir).sort(), ["2020-01.jsonl.d", "2026-10.jsonl", "notes.txt"]);
	assert.deepEqual(reaped, [["reaped_allocation_log", { file: "2026-09.jsonl" }]]);
	makeAllocationLogReaper({ logsDir, retentionDays: 0, now: () => NOW + 1000 * 24 * HOUR })();
	assert.ok(readdirSync(dir).includes("2026-10.jsonl"), "0 keeps everything");
	makeAllocationLogReaper({ logsDir: join(logsDir, "absent"), retentionDays: 30, now: () => NOW })();
});

test("one apply and its expiry give the same answers 399 days from now: every clock is injected (#504)", () => {
	// The shift-clock guard's own shim (.github/scripts/shift-clock.mjs), run in a child: the subject must read no clock
	// of its own, so the shifted run and this one agree to the micro-dollar.
	const shim = fileURLToPath(new URL("../../.github/scripts/shift-clock.mjs", import.meta.url));
	const src = new URL("../src/", import.meta.url).href;
	const script = `
		const { makeAllocationState } = await import(${JSON.stringify(`${src}allocation.mjs`)});
		const { parseEnvelope, envelopeDigest } = await import(${JSON.stringify(`${src}envelope.mjs`)});
		const { CAS_SCRIPT, SEED_SCRIPT } = await import(${JSON.stringify(`${src}allocation.mjs`)});
		const store = new Map();
		const redis = {
			async get(k) { return store.has(k) ? store.get(k) : null; },
			async set(k, v, ...a) { if (a.includes("NX") && store.has(k)) return null; store.set(k, v); return "OK"; },
			async eval(s, _n, k, ...argv) {
				if (s === CAS_SCRIPT) { const c = JSON.parse(store.get(k)); if ((c.planId ?? "") !== argv[0] || c.envelopeDigest !== argv[1]) return 0; store.set(k, argv[2]); return 1; }
				if (s === SEED_SCRIPT) { if (store.has(k)) return 0; store.set(k, argv[1]); store.set(argv[0], argv[2]); return 1; }
				if (store.get(k) === argv[0]) { store.delete(k); return 1; } return 0;
			},
			async lpush() {}, async ltrim() {},
		};
		const projects = [{ id: "shop", members: ["github:acme/web"] }, { id: "platform", members: ["github:acme/infra"] }];
		const envelope = parseEnvelope(JSON.stringify({ version: 1, window: "week", totalUsd: "100", floorsUsd: { shop: "10", platform: "10" }, defaultWeights: { _other: 0 }, delegation: { enabled: true, writers: ["operator-session"], maxStepPct: 25, minIntervalHours: 24, maxPlanDays: 14 } }), "/e", { projects, maxCostMicros: 1000000 });
		const alloc = makeAllocationState({ redis, host: "h", audit: { append() {} }, token: () => "t" });
		const now = ${NOW};
		const digest = envelopeDigest(envelope);
		await alloc.reconcile({ envelope, digest, now });
		const r = await alloc.applyPlan({ envelope, digest, text: JSON.stringify({ version: 1, basis: null, projects: [{ id: "shop", weight: 3 }, { id: "platform", weight: 1 }, { id: "_other", weight: 0 }] }), writer: { kind: "operator-session" }, now });
		const applied = JSON.parse(store.get("alloc:plan"));
		const e = await alloc.reconcile({ envelope, digest, now: now + 15 * 86400000 });
		console.log(JSON.stringify({ outcome: r.outcome, allocations: applied.allocations, validUntil: applied.validUntil, expired: e.state.writer }));
	`;
	const run = (shift) => JSON.parse(execFileSync(process.execPath, [...(shift ? ["--import", pathToFileURL(shim).href] : []), "--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } }).trim());
	const plain = run(false);
	const shifted = run(true);
	assert.equal(plain.outcome, "applied");
	assert.equal(plain.expired, "expiry");
	assert.deepEqual(shifted, plain);
});

test("a stale alloc:envelope:expected never survives a new seed: after DEL alloc:plan alone, a host with the old envelope mismatches (#504)", async () => {
	// The turn-off deletes the split; if the old expected digest stayed, a re-seed under a new envelope would leave a host
	// still carrying the OLD envelope able to re-base the fleet onto it.
	const old = envelopeOf({ totalUsd: "60" });
	const fresh = envelopeOf({ totalUsd: "100" });
	const redis = fakeRedis();
	const rows = [];
	const audit = { append: (row) => rows.push(row) };
	const A = makeAllocationState({ redis, host: "A", audit, token: () => "a" });
	const B = makeAllocationState({ redis, host: "B", audit, token: () => "b" });
	redis.store.set(ALLOC_EXPECTED_KEY, envelopeDigest(old)); // left behind by the earlier split
	await A.reconcile({ envelope: fresh, digest: envelopeDigest(fresh), now: NOW });
	assert.equal(redis.store.get(ALLOC_EXPECTED_KEY), envelopeDigest(fresh), "the seed overwrites the stale expected, in the same step");
	const b = await B.reconcile({ envelope: old, digest: envelopeDigest(old), now: NOW });
	assert.equal(b.mismatch, true, "the stale host refuses");
	assert.equal(stored(redis).envelopeDigest, envelopeDigest(fresh), "and the fleet's split was not re-based");
	assert.ok(!rows.some((r) => r.outcome === "rebased"));
});

test("a system change whose row the audit file refuses stands: expiry logs allocation_audit_row_lost and still reaches alloc:log (#504)", async () => {
	const redis = fakeRedis();
	let refuse = false;
	const audit = {
		rows: [],
		append(row) {
			if (refuse) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
			this.rows.push(row);
		},
	};
	const logs = [];
	const alloc = makeAllocationState({ redis, host: "h", audit, token: () => "t", log: (e, f) => logs.push({ e, f }) });
	const envelope = envelopeOf();
	const digest = envelopeDigest(envelope);
	await alloc.reconcile({ envelope, digest, now: NOW });
	const until = new Date(NOW + 24 * HOUR).toISOString();
	const p = await alloc.applyPlan({ envelope, digest, projects: PROJECTS, text: plan({ shop: 3, platform: 1, _other: 0 }, null, { top: { validUntil: until } }), writer: SESSION, now: NOW });
	refuse = true;
	const r = await alloc.reconcile({ envelope, digest, now: NOW + 2 * 24 * HOUR });
	assert.equal(r.state.writer, "expiry", "the change happened and is never rolled back");
	assert.deepEqual(logs.find((l) => l.e === "allocation_audit_row_lost")?.f, { outcome: "expired", planId: p.planId, from: digest, to: digest, code: "ENOSPC" });
	assert.equal(logRows(redis)[0].outcome, "expired", "the view still has it");
	assert.equal(JSON.stringify(logs).includes("reason"), false, "the lost row's log line carries no reason text");
});

test("replacing an UNREADABLE plan keeps alloc:envelope:expected: a stale host reconciling first does not take the fleet (#504)", async () => {
	const good = envelopeOf();
	const stale = envelopeOf({ totalUsd: "60" });
	const redis = fakeRedis();
	redis.store.set(ALLOC_PLAN_KEY, "{ garbled");
	redis.store.set(ALLOC_EXPECTED_KEY, envelopeDigest(good));
	const S = makeAllocationState({ redis, host: "stale", audit: memAudit(), token: () => "s" });
	const G = makeAllocationState({ redis, host: "good", audit: memAudit(), token: () => "g" });
	await S.reconcile({ envelope: stale, digest: envelopeDigest(stale), now: NOW });
	assert.equal(redis.store.get(ALLOC_EXPECTED_KEY), envelopeDigest(good), "the fleet's digest stands");
	const g = await G.reconcile({ envelope: good, digest: envelopeDigest(good), now: NOW });
	assert.equal(g.mismatch, false, "the fleet's host re-bases the replaced split onto the fleet's envelope");
	assert.equal(stored(redis).envelopeDigest, envelopeDigest(good));
	assert.equal((await S.reconcile({ envelope: stale, digest: envelopeDigest(stale), now: NOW })).mismatch, true, "and the stale host refuses");
});
