import assert from "node:assert/strict";
import { test } from "node:test";
import { reserveDollars } from "../src/dollar-budget.mjs";
import { sanitizeJobId } from "../src/run-history.mjs";
import {
	RUN_BUDGET_KEY_PREFIX,
	RUN_BUDGET_MAX_KEYS,
	RUN_BUDGET_STATES,
	RUN_BUDGET_TTL_MS,
	makeRunBudgetLedger,
	runBudgetKeyFor,
	validHold,
} from "../src/run-budget-ledger.mjs";

// Issue #645: the per-run budget ledger. The shape checks and the error paths need no server (a fake client); every
// transition is tested against a real Valkey, because the atomicity of the scripts is the whole argument. DATABASE 5,
// flushed first: the worker and admin Valkey tests already use 0, 2, 7, 8, 9 and 11 to 15, and 5 was free when this
// file was written (grep `pathname = "/N"` and `/N\`` under worker/test and admin/test before taking another).

const AT_MS = Date.parse("2026-10-17T10:00:00.000Z");
const clock = () => AT_MS;

const SCOPE = "budget:usd:s:0123456789abcdef";
const MODEL = "budget:usd:mdl:fedcba9876543210";
const HOLD = Object.freeze({
	amountMicros: 2_000_000,
	keys: ["budget:usd:2026-10-17", `${SCOPE}:2026-10-17`, `${MODEL}:m:2026-10`],
	ledgers: [
		{ keyPrefix: "budget:usd", keys: ["budget:usd:2026-10-17"] },
		{ keyPrefix: SCOPE, keys: [`${SCOPE}:2026-10-17`] },
		{ keyPrefix: MODEL, keys: [`${MODEL}:m:2026-10`] },
	],
});

// --- shape and constants (no server) ---------------------------------------------------------------------------

test("the key is the run mirror's sanitized id under run:budget:, and the constants readers share", () => {
	assert.equal(RUN_BUDGET_KEY_PREFIX, "run:budget:");
	assert.equal(runBudgetKeyFor("repeat:abc:17"), `run:budget:${sanitizeJobId("repeat:abc:17")}`);
	assert.equal(runBudgetKeyFor("repeat:abc:17"), "run:budget:repeat_abc_17");
	assert.equal(RUN_BUDGET_TTL_MS, 35 * 24 * 3600 * 1000);
	assert.equal(RUN_BUDGET_MAX_KEYS, 16);
	assert.deepEqual([...RUN_BUDGET_STATES], ["held", "settled", "released", "settled-crashed"]);
});

test("validHold keeps reserveDollars' shape and refuses everything else", () => {
	assert.deepEqual(validHold(HOLD), { amountMicros: HOLD.amountMicros, keys: HOLD.keys, ledgers: HOLD.ledgers });
	assert.deepEqual(validHold({ amountMicros: 0, keys: [] }), { amountMicros: 0, keys: [] }, "the zero hold carries no ledgers");
	assert.deepEqual(validHold({ amountMicros: 0, keys: [], extra: "x", note: { a: 1 } }), { amountMicros: 0, keys: [] }, "unknown fields are dropped from a hold without ledgers too");
	assert.deepEqual(Object.keys(validHold({ amountMicros: 3, keys: ["budget:usd:2026-10-17"], extra: "x" })), ["amountMicros", "keys"]);
	assert.deepEqual(validHold({ amountMicros: 5, keys: [], ledgers: [] }), { amountMicros: 5, keys: [], ledgers: [] }, "no active window");
	assert.deepEqual(validHold({ ...HOLD, extra: "x" }), { amountMicros: HOLD.amountMicros, keys: HOLD.keys, ledgers: HOLD.ledgers }, "unknown fields are dropped, not stored");
	const many = Array.from({ length: 17 }, (_, i) => `budget:usd:s:${String(i).padStart(16, "0")}:2026-10-17`);
	for (const [why, bad] of [
		["null", null],
		["an array", []],
		["a float", { ...HOLD, amountMicros: 1.5 }],
		["negative", { ...HOLD, amountMicros: -1 }],
		["unsafe", { ...HOLD, amountMicros: 2 ** 53 }],
		["a string amount", { ...HOLD, amountMicros: "2000000" }],
		["keys not an array", { ...HOLD, keys: "budget:usd:2026-10-17" }],
		["a key outside the dollar prefix", { amountMicros: 1, keys: ["budget:2026-10-17"] }],
		["a look-alike prefix", { amountMicros: 1, keys: ["budget:usdx:2026-10-17"] }],
		["a bare prefix", { amountMicros: 1, keys: ["budget:usd:"] }],
		["a non-string key", { amountMicros: 1, keys: [7] }],
		["a duplicate key", { amountMicros: 1, keys: ["budget:usd:2026-10-17", "budget:usd:2026-10-17"] }],
		["seventeen keys", { amountMicros: 1, keys: many }],
		["ledgers not flattening to keys", { ...HOLD, ledgers: HOLD.ledgers.slice(1) }],
		["ledgers out of order", { ...HOLD, ledgers: [...HOLD.ledgers].reverse() }],
		["a ledger key under another prefix", { amountMicros: 1, keys: [`${SCOPE}:2026-10-17`], ledgers: [{ keyPrefix: MODEL, keys: [`${SCOPE}:2026-10-17`] }] }],
		["a ledger prefix outside the dollar prefix", { amountMicros: 1, keys: ["budget:usd:2026-10-17"], ledgers: [{ keyPrefix: "budget", keys: ["budget:usd:2026-10-17"] }] }],
		["an empty ledger", { amountMicros: 1, keys: [], ledgers: [{ keyPrefix: "budget:usd", keys: [] }] }],
	]) assert.equal(validHold(bad), null, why);
});

test("a ttlMs that is not a positive integer is a wiring defect and throws at construction", () => {
	for (const ttlMs of [0, -1, 1.5, "1000", Number.NaN]) assert.throws(() => makeRunBudgetLedger({ redis: {}, now: clock, ttlMs }), TypeError, String(ttlMs));
});

// --- error paths (fake clients) ---------------------------------------------------------------------------------

test("a Valkey fault returns { error } with the code and never throws, from every method, sync or async", async () => {
	const failing = (mode) => {
		const fail = (...args) => {
			if (mode === "sync") throw Object.assign(new Error("boom"), { code: "ECONNREFUSED" });
			return Promise.reject(Object.assign(new Error("boom"), { code: "ECONNREFUSED" }));
		};
		return { eval: fail, hgetall: fail, del: fail };
	};
	for (const mode of ["sync", "async"]) {
		const logs = [];
		const l = makeRunBudgetLedger({ redis: failing(mode), now: clock, log: (e, f) => logs.push([e, f]) });
		assert.deepEqual(await l.claimSlot("r"), { error: "ECONNREFUSED" }, mode);
		assert.deepEqual(await l.recordHold("r", 1, HOLD), { error: "ECONNREFUSED" }, mode);
		assert.deepEqual(await l.settle("r", 1), { error: "ECONNREFUSED" }, mode);
		assert.deepEqual(await l.release("r", 1), { error: "ECONNREFUSED" }, mode);
		assert.deepEqual(await l.settleCrashed("r", 2), { error: "ECONNREFUSED" }, mode);
		assert.deepEqual(await l.nextSeq("r"), { error: "ECONNREFUSED" }, mode);
		assert.deepEqual(await l.read("r"), { error: "ECONNREFUSED" }, mode);
		assert.deepEqual(await l.remove("r"), { error: "ECONNREFUSED" }, mode);
		assert.deepEqual(logs, ["claimSlot", "recordHold", "settle", "release", "settleCrashed", "nextSeq", "read", "remove"].map((op) => ["run_budget_ledger_error", { op, code: "ECONNREFUSED" }]), "exactly { op, code }, nothing more");
		assert.ok(!JSON.stringify(logs).includes("run:budget") && !JSON.stringify(logs).includes("budget:usd"), "no key and no value in a log line");
	}
	const noCode = makeRunBudgetLedger({ redis: { eval: () => Promise.reject(new Error("x")) }, now: clock });
	assert.deepEqual(await noCode.nextSeq("r"), { error: "valkey" }, "an error with no code still reads as a fault");
});

test("bad arguments are refused before Valkey is asked, as { error }, never thrown", async () => {
	let asked = 0;
	const l = makeRunBudgetLedger({ redis: { eval: async () => (asked++, 1) }, now: clock });
	for (const seq of [0, -1, 1.5, "1", null, Number.NaN]) {
		assert.deepEqual(await l.recordHold("r", seq, HOLD), { error: "bad-seq" }, String(seq));
		assert.deepEqual(await l.settle("r", seq), { error: "bad-seq" }, String(seq));
		assert.deepEqual(await l.release("r", seq), { error: "bad-seq" }, String(seq));
		assert.deepEqual(await l.settleCrashed("r", seq), { error: "bad-seq" }, String(seq));
	}
	assert.deepEqual(await l.recordHold("r", 1, { amountMicros: -1, keys: [] }), { error: "bad-hold" });
	assert.equal(asked, 0);
	const odd = makeRunBudgetLedger({ redis: { eval: async () => "nope" }, now: clock });
	assert.deepEqual(await odd.nextSeq("r"), { error: "bad-reply" }, "a reply that is not a container number is not handed out");
});

// --- against a real Valkey --------------------------------------------------------------------------------------

const valkeyUrl = process.env.VALKEY_TEST_URL;
if (!valkeyUrl && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("run-budget-ledger tests REQUIRE VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
const live = valkeyUrl ? false : "VALKEY_TEST_URL not set; the scripts need a real Valkey";

const clients = [];
let flushed = false;
async function client() {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const url = new URL(valkeyUrl);
	url.pathname = "/5";
	const r = makeRedisClient(url.toString());
	r.on("error", () => {});
	clients.push(r);
	if (!flushed) {
		flushed = true;
		await r.flushdb();
	}
	return r;
}
test.after(async () => {
	await Promise.all(clients.map((r) => r.quit().catch(() => {})));
});

let runs = 0;
const runId = (name) => `${name}:${++runs}`;

test("claimSlot is new once, then carried for every later call of the same run", { skip: live }, async () => {
	const l = makeRunBudgetLedger({ redis: await client(), now: clock });
	const id = runId("claim");
	assert.equal(await l.claimSlot(id), "new");
	assert.equal(await l.claimSlot(id), "carried");
	assert.equal(await l.claimSlot(id), "carried");
	assert.equal(await l.claimSlot(runId("claim-other")), "new", "another run's slot is its own");
	assert.deepEqual(await l.read(id), { slot: "held", seq: 0, at: AT_MS, holds: [] });
});

test("two recoveries claiming at once: exactly one reserves the job-count slots", { skip: live }, async () => {
	const [a, b] = [await client(), await client()];
	const id = runId("claim-race");
	const got = await Promise.all([makeRunBudgetLedger({ redis: a, now: clock }).claimSlot(id), makeRunBudgetLedger({ redis: b, now: clock }).claimSlot(id)]);
	assert.deepEqual(got.sort(), ["carried", "new"]);
});

test("recordHold writes once per seq, refuses a second write and a bad shape, and a real reserveDollars hold round-trips", { skip: live }, async () => {
	const r = await client();
	const l = makeRunBudgetLedger({ redis: r, now: clock });
	const id = runId("record");
	assert.deepEqual(await l.recordHold(id, 1, HOLD), { ok: true });
	assert.deepEqual(await l.recordHold(id, 1, { amountMicros: 1, keys: [] }), { error: "exists" });
	assert.deepEqual(JSON.parse(await r.hget(runBudgetKeyFor(id), "h1")), { amountMicros: HOLD.amountMicros, keys: HOLD.keys, ledgers: HOLD.ledgers }, "the first record stands");
	assert.deepEqual(await l.recordHold(id, 2, { ...HOLD, keys: ["budget:9999"] }), { error: "bad-hold" });
	assert.equal(await r.hexists(runBudgetKeyFor(id), "s2"), 0, "a refused shape writes nothing");
	assert.equal(await l.settle(id, 1), "moved");
	assert.deepEqual(await l.recordHold(id, 1, HOLD), { error: "exists" }, "a terminal hold is never put back to held");
	assert.deepEqual((await l.read(id)).holds, [{ seq: 1, state: "settled", amountMicros: 2_000_000 }]);

	// The hold reserveDollars really returns, in this file's own database, is accepted as it is.
	const now = new Date(AT_MS);
	const res = await reserveDollars(r, { ledgers: [{ keyPrefix: "budget:usd", caps: { day: 10_000_000, week: null, month: 10_000_000 } }, { keyPrefix: SCOPE, caps: { day: null, week: 10_000_000, month: null } }], amountMicros: 1_500_000, now });
	assert.equal(res.allowed, true);
	assert.deepEqual(await l.recordHold(id, 3, res.hold), { ok: true });
	assert.deepEqual(JSON.parse(await r.hget(runBudgetKeyFor(id), "h3")), res.hold);
	const zero = await reserveDollars(r, { ledgers: [], amountMicros: 0, now });
	assert.deepEqual(await l.recordHold(id, 4, zero.hold), { ok: true }, "the zero hold, which carries no ledgers");
});

test("settle and release move a hold only from held; the second call is not-held", { skip: live }, async () => {
	const l = makeRunBudgetLedger({ redis: await client(), now: clock });
	const id = runId("move");
	assert.equal(await l.settle(id, 1), "not-held", "no record");
	assert.equal(await l.release(id, 1), "not-held", "no record");
	assert.deepEqual(await l.read(id), { absent: true }, "a refused move on a missing ledger does not create it");
	for (const seq of [1, 2]) assert.deepEqual(await l.recordHold(id, seq, HOLD), { ok: true });
	assert.equal(await l.settle(id, 1), "moved");
	assert.equal(await l.settle(id, 1), "not-held");
	assert.equal(await l.release(id, 1), "not-held", "a settled hold is never released");
	assert.equal(await l.release(id, 2), "moved");
	assert.equal(await l.release(id, 2), "not-held", "never released twice");
	assert.equal(await l.settle(id, 2), "not-held");
	assert.equal((await l.settleCrashed(id, 99)).settled.length, 0, "terminal holds are not crash-settled either");
	assert.deepEqual((await l.read(id)).holds.map((h) => [h.seq, h.state]), [[1, "settled"], [2, "released"]]);
});

test("settleCrashed settles only the holds still held below the seq, once", { skip: live }, async () => {
	const r = await client();
	const l = makeRunBudgetLedger({ redis: r, now: clock });
	const id = runId("crashed");
	assert.equal(await l.claimSlot(id), "new");
	for (let seq = 1; seq <= 5; seq++) assert.deepEqual(await l.recordHold(id, seq, HOLD), { ok: true });
	assert.equal(await l.release(id, 2), "moved");
	assert.deepEqual(await l.settleCrashed(id, 4), { settled: [1, 3] }, "2 is released, 4 and 5 are not below");
	assert.deepEqual(await l.settleCrashed(id, 4), { settled: [] }, "a second call finds none");
	assert.deepEqual((await l.read(id)).holds.map((h) => [h.seq, h.state]), [[1, "settled-crashed"], [2, "released"], [3, "settled-crashed"], [4, "held"], [5, "held"]]);
	assert.equal(await l.settle(id, 1), "not-held", "a crash-settled hold is never settled again");
	assert.equal(await l.release(id, 3), "not-held", "nor released");
	assert.equal((await l.read(id)).slot, "held", "slot and seq are not holds, though they start with s");
	// An absent (never written, or expired) ledger stays absent: no `at`, no TTL, no key. The same id is used for the
	// call and the checks (runId() hands out a new id on every call).
	const none = runId("crashed-none");
	assert.deepEqual(await l.settleCrashed(none, 10), { settled: [] }, "no ledger at all");
	assert.equal(await r.exists(runBudgetKeyFor(none)), 0, "and none is created");
	assert.equal(await r.pttl(runBudgetKeyFor(none)), -2, "nor a TTL set on it");
	assert.deepEqual(await l.read(none), { absent: true });
	// An expired ledger: written, then gone by its own TTL, then crash-settled.
	const expired = runId("crashed-expired");
	await l.recordHold(expired, 1, HOLD);
	await r.pexpire(runBudgetKeyFor(expired), 1);
	while ((await r.exists(runBudgetKeyFor(expired))) === 1) await new Promise((res) => setTimeout(res, 5));
	assert.deepEqual(await l.settleCrashed(expired, 10), { settled: [] }, "an expired ledger has no holds to settle");
	assert.equal(await r.exists(runBudgetKeyFor(expired)), 0, "and is not revived");
	// A live ledger with nothing held: settleCrashed writes nothing, so neither the TTL nor `at` moves.
	const idle = runId("crashed-idle");
	const later = makeRunBudgetLedger({ redis: r, now: () => AT_MS + 60_000 });
	await l.recordHold(idle, 1, HOLD);
	await l.settle(idle, 1);
	await r.pexpire(runBudgetKeyFor(idle), 10_000);
	assert.deepEqual(await later.settleCrashed(idle, 10), { settled: [] });
	assert.ok((await r.pttl(runBudgetKeyFor(idle))) <= 10_000, "the TTL is not refreshed when nothing moved");
	assert.equal(Number(await r.hget(runBudgetKeyFor(idle), "at")), AT_MS, "nor is `at` stamped");
	// Ten holds: the comparison is numeric, never lexical ("10" < "4" as text).
	const big = runId("crashed-numeric");
	for (let seq = 1; seq <= 11; seq++) await l.recordHold(big, seq, HOLD);
	assert.deepEqual(await l.settleCrashed(big, 10), { settled: [1, 2, 3, 4, 5, 6, 7, 8, 9] });
});

test("two settleCrashed calls racing on two clients settle each hold exactly once between them", { skip: live }, async () => {
	const [a, b] = [makeRunBudgetLedger({ redis: await client(), now: clock }), makeRunBudgetLedger({ redis: await client(), now: clock })];
	for (let round = 0; round < 20; round++) {
		const id = runId("crashed-race");
		for (let seq = 1; seq <= 6; seq++) await a.recordHold(id, seq, HOLD);
		const [x, y] = await Promise.all([a.settleCrashed(id, 6), b.settleCrashed(id, 6)]);
		assert.deepEqual([...x.settled, ...y.settled].sort((p, q) => p - q), [1, 2, 3, 4, 5], `round ${round}: every hold once, none twice`);
		assert.ok(x.settled.length === 0 || y.settled.length === 0, "one script ran first and took them all");
	}
});

test("nextSeq numbers the run's containers 1, 2, 3 and never hands one out twice", { skip: live }, async () => {
	const [a, b] = [makeRunBudgetLedger({ redis: await client(), now: clock }), makeRunBudgetLedger({ redis: await client(), now: clock })];
	const id = runId("seq");
	assert.equal(await a.nextSeq(id), 1);
	assert.equal(await a.nextSeq(id), 2);
	const raced = await Promise.all([a.nextSeq(id), b.nextSeq(id), a.nextSeq(id), b.nextSeq(id)]);
	assert.deepEqual(raced.sort((p, q) => p - q), [3, 4, 5, 6]);
	assert.equal((await a.read(id)).seq, 6);
	assert.equal(await a.nextSeq(runId("seq-other")), 1);
});

test("every write sets the TTL and refreshes it; a refused write does not revive an absent ledger", { skip: live }, async () => {
	const r = await client();
	const ttlMs = 60_000;
	let t = AT_MS;
	const l = makeRunBudgetLedger({ redis: r, now: () => t, ttlMs });
	const id = runId("ttl");
	const key = runBudgetKeyFor(id);
	const fresh = async (why) => {
		const pttl = await r.pttl(key);
		assert.ok(pttl > ttlMs - 5_000 && pttl <= ttlMs, `${why}: pttl ${pttl}`);
	};
	const shorten = () => r.pexpire(key, 1_000);
	assert.equal(await l.claimSlot(id), "new");
	await fresh("claimSlot");
	for (const [why, write] of [
		["claimSlot carried", () => l.claimSlot(id)],
		["nextSeq", () => l.nextSeq(id)],
		["recordHold", () => l.recordHold(id, 1, HOLD)],
		["settle", () => l.settle(id, 1)],
		["recordHold 2", () => l.recordHold(id, 2, HOLD)],
		["release", () => l.release(id, 2)],
		["recordHold 3", () => l.recordHold(id, 3, HOLD)],
		["settleCrashed", () => l.settleCrashed(id, 4)],
	]) {
		await shorten();
		t += 1_000;
		await write();
		await fresh(why);
		assert.equal(Number(await r.hget(key, "at")), t, `${why} stamps the injected clock`);
	}
	const absent = runId("ttl-absent");
	assert.equal(await l.settle(absent, 1), "not-held");
	assert.equal(await r.exists(runBudgetKeyFor(absent)), 0);
	const def = makeRunBudgetLedger({ redis: r, now: clock });
	const other = runId("ttl-default");
	await def.claimSlot(other);
	const pttl = await r.pttl(runBudgetKeyFor(other));
	assert.ok(pttl > RUN_BUDGET_TTL_MS - 5_000 && pttl <= RUN_BUDGET_TTL_MS, `the default is 35 days: ${pttl}`);
});

test("remove deletes the ledger at the run's end", { skip: live }, async () => {
	const l = makeRunBudgetLedger({ redis: await client(), now: clock });
	const id = runId("remove");
	await l.claimSlot(id);
	await l.recordHold(id, 1, HOLD);
	assert.deepEqual(await l.remove(id), { ok: true });
	assert.deepEqual(await l.read(id), { absent: true });
	assert.deepEqual(await l.remove(id), { ok: true }, "removing an absent ledger is fine");
});

test("read reports an unparseable hold record as an unknown amount rather than guessing", { skip: live }, async () => {
	const r = await client();
	const l = makeRunBudgetLedger({ redis: r, now: clock });
	const id = runId("read-bad");
	await r.hset(runBudgetKeyFor(id), "s1", "held", "h1", "{not json");
	assert.deepEqual(await l.read(id), { slot: null, seq: 0, at: null, holds: [{ seq: 1, state: "held", amountMicros: null }] });
});

/** mulberry32: a seeded generator, so a failing interleaving is reproducible from the seed in the message. */
function rng(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let x = s;
		x = Math.imul(x ^ (x >>> 15), x | 1);
		x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
		return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
	};
}

test("property: over random interleavings on two clients, no hold leaves a terminal state and none moves twice", { skip: live, timeout: 60_000 }, async () => {
	const ledgers = [makeRunBudgetLedger({ redis: await client(), now: clock }), makeRunBudgetLedger({ redis: await client(), now: clock })];
	const SEQS = 4;
	for (let trial = 0; trial < 40; trial++) {
		const seed = 0x645 + trial;
		const rand = rng(seed);
		const pick = (n) => Math.floor(rand() * n);
		const id = runId("property");
		const recorded = new Map(); // seq -> number of successful records
		const moves = new Map(); // seq -> the terminal states the transitions that succeeded named
		const seen = new Map(); // seq -> the terminal state last read
		const note = (seq, state) => moves.set(seq, [...(moves.get(seq) ?? []), state]);
		for (let step = 0; step < 12; step++) {
			const batch = Array.from({ length: 1 + pick(3) }, () => {
				const l = ledgers[pick(2)];
				const seq = 1 + pick(SEQS);
				switch (pick(4)) {
					case 0:
						return l.recordHold(id, seq, HOLD).then((r) => r.ok && recorded.set(seq, (recorded.get(seq) ?? 0) + 1));
					case 1:
						return l.settle(id, seq).then((r) => r === "moved" && note(seq, "settled"));
					case 2:
						return l.release(id, seq).then((r) => r === "moved" && note(seq, "released"));
					default:
						return l.settleCrashed(id, 1 + pick(SEQS + 1)).then((r) => r.settled.forEach((s) => note(s, "settled-crashed")));
				}
			});
			await Promise.all(batch);
			const state = await ledgers[0].read(id);
			for (const h of state.holds ?? []) {
				const before = seen.get(h.seq);
				if (before) assert.equal(h.state, before, `seed ${seed}: hold ${h.seq} left its terminal state ${before}`);
				if (h.state !== "held") seen.set(h.seq, h.state);
			}
		}
		const final = await ledgers[0].read(id);
		const states = new Map((final.holds ?? []).map((h) => [h.seq, h.state]));
		for (let seq = 1; seq <= SEQS; seq++) {
			const m = moves.get(seq) ?? [];
			assert.ok((recorded.get(seq) ?? 0) <= 1, `seed ${seed}: hold ${seq} recorded twice`);
			assert.ok(m.length <= 1, `seed ${seed}: hold ${seq} moved ${m.length} times (${m.join(", ")})`);
			if (m.length === 1) {
				assert.equal(recorded.get(seq), 1, `seed ${seed}: hold ${seq} moved without a record`);
				assert.equal(states.get(seq), m[0], `seed ${seed}: hold ${seq} ends where its one move put it`);
			} else if (recorded.get(seq)) assert.equal(states.get(seq), "held", `seed ${seed}: hold ${seq} is still held`);
			else assert.equal(states.has(seq), false, `seed ${seed}: hold ${seq} was never recorded`);
		}
	}
});
