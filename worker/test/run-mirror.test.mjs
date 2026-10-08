import assert from "node:assert/strict";
import { test } from "node:test";
import { UNREADABLE_RECORD } from "../src/run-history.mjs";
import { MIRROR_MAX_DAYS, RUNS_HORIZON, RUNS_INDEX, TRIM_SCRIPT, hostsIn, makeRunMirror, mergeRuns, mirrorWindowMs, readMirroredRecord, readMirroredRuns, runRecordKey } from "../src/run-mirror.mjs";

const DAY = 24 * 60 * 60 * 1000;

// Every fixture in this file is dated 2026-08-30, and the writer trims its own index by AGE against
// its own clock immediately after adding to it. A mirror built on the default `Date.now` therefore
// deletes the member it just wrote, the moment the wall clock passes the retention window past the
// fixture date -- which is exactly what happened seven days after this file was written, in CI, on a
// tree nobody had touched (issue #284). So the clock is pinned to the fixtures rather than the
// fixtures being chased to the clock: these tests describe an instant, not a distance from today.
const AT = Date.parse("2026-08-30T12:00:00.000Z");
const anchored = (opts) => makeRunMirror({ now: () => AT, ...opts });

// A Valkey with real ZSET-and-string semantics for the handful of commands this uses. The ordering IS the
// mechanism under test, so a fake that only records calls would prove nothing.
function fakeRedis({ fail = false, hang = false } = {}) {
	const strings = new Map();
	const zset = new Map(); // member -> score
	const horizon = new Map(); // RUNS_HORIZON's member -> score
	const calls = [];
	const guard = () => {
		if (fail) throw new Error("ECONNREFUSED");
		if (hang) return new Promise(() => {});
		return null;
	};
	return {
		strings,
		zset,
		calls,
		async set(k, v, _px, ms) {
			await guard();
			calls.push(["set", k]);
			strings.set(k, { v, expiresIn: ms });
		},
		horizon,
		async zadd(k, ...args) {
			await guard();
			// The horizon is its own key, written `ZADD runs:horizon GT <score> trim`: raised only, never lowered.
			if (k === RUNS_HORIZON) {
				// Redis semantics: `GT` only ever raises an existing score; without it, ZADD sets whatever it is given.
				const gt = args[0] === "GT";
				const [score, member] = gt ? args.slice(1) : args;
				calls.push(["zadd-horizon", ...args]);
				if (!gt || !horizon.has(member) || score > horizon.get(member)) horizon.set(member, score);
				return;
			}
			const [score, member] = args;
			calls.push(["zadd", member]);
			zset.set(member, score);
		},
		async zremrangebyscore(_k, _min, max) {
			await guard();
			const cut = Number(String(max).replace("(", ""));
			let n = 0;
			for (const [m, s] of zset) if (s < cut) (zset.delete(m), n++);
			return n;
		},
		async zremrangebyrank(_k, _start, stop) {
			await guard();
			// Redis semantics: rank 0 is the LOWEST score. `stop` negative counts from the end.
			const sorted = [...zset.entries()].sort((a, b) => a[1] - b[1]);
			const end = stop < 0 ? sorted.length + stop : stop;
			let n = 0;
			for (let i = 0; i <= end && i < sorted.length; i++) (zset.delete(sorted[i][0]), n++);
			return n;
		},
		// `TRIM_SCRIPT`, done step for step on this fake's maps (the real script is run against Valkey in
		// run-mirror.integration.test.mjs): the two trims, the horizon raised by GT only when one removed something.
		async eval(script, nkeys, index, horizonKey, cutoff, cap, ttl, member) {
			await guard();
			assert.equal(script, TRIM_SCRIPT);
			assert.deepEqual([nkeys, index, horizonKey], [2, RUNS_INDEX, RUNS_HORIZON]);
			calls.push(["eval", Number(cutoff), Number(cap), Number(ttl)]);
			const byAge = await this.zremrangebyscore(index, "-inf", `(${cutoff}`);
			const byCount = await this.zremrangebyrank(index, 0, -Number(cap) - 1);
			let h = byAge > 0 ? Number(cutoff) : null;
			if (byCount > 0) {
				const oldest = [...zset.values()].sort((a, b) => a - b)[0];
				if (oldest !== undefined) h = Math.max(h ?? oldest, oldest);
			}
			if (h !== null) {
				await this.zadd(horizonKey, "GT", h, member);
				calls.push(["pexpire", horizonKey, Number(ttl)]);
			}
			calls.push(["pexpire", index, Number(ttl)]);
			return h === null ? null : String(h);
		},
		async zrange(_k, start, stop, withScores) {
			await guard();
			const sorted = [...zset.entries()].sort((a, b) => a[1] - b[1]).slice(start, stop + 1);
			return withScores === "WITHSCORES" ? sorted.flatMap(([m, sc]) => [m, String(sc)]) : sorted.map(([m]) => m);
		},
		async pexpire(k, ms) {
			await guard();
			calls.push(["pexpire", k, ms]);
		},
		async zrevrangebyscore(_k, _max, min, _lim, _off, count) {
			await guard();
			const cut = Number(String(min).replace("(", ""));
			return [...zset.entries()]
				.filter(([, s]) => s > cut)
				.sort((a, b) => b[1] - a[1])
				.slice(0, count)
				.map(([m]) => m);
		},
		async mget(...keys) {
			await guard();
			return keys.map((k) => strings.get(k)?.v ?? null);
		},
		async zrem(_k, ...members) {
			await guard();
			for (const m of members) zset.delete(m);
		},
	};
}

const record = (jobId, endedAt, extra = {}) => ({ jobId, endedAt, host: "mini1", outcome: "completed", ...extra });

// --- the window ------------------------------------------------------------------------------------------

test("the mirror never outlives the files it is a view of", () => {
	// A view that can outlive its source is a second source of truth, which is what
	// DES-RUN-HISTORY-FLAT-FILES-NO-DB refuses. The mirror can never show a run whose file has been reaped.
	assert.equal(mirrorWindowMs(7), 7 * DAY, "shorter retention wins");
	assert.equal(mirrorWindowMs(365), MIRROR_MAX_DAYS * DAY, "and never deeper than any reader asks");
	assert.equal(mirrorWindowMs(0), MIRROR_MAX_DAYS * DAY, "keep-forever files clamp to the reader's ceiling, not to infinity");
});

// --- the writer ------------------------------------------------------------------------------------------

test("a record is stored whole, under its own TTL, and indexed by when it ended", async () => {
	// WHOLE, not a projection: the record is PII-free by construction, so copying it inherits that property
	// rather than re-deriving it at a second serialiser where the next added field must remember this file.
	const redis = fakeRedis();
	const m = anchored({ redis, retentionDays: 7 });
	const rec = record("job-1", "2026-08-30T12:00:00.000Z", { tokens: { total: 10 } });
	assert.equal(await m.mirror(rec, "job-1"), true);
	assert.deepEqual(JSON.parse(redis.strings.get(runRecordKey("job-1")).v), rec, "byte-for-byte the sidecar's own content");
	assert.equal(redis.strings.get(runRecordKey("job-1")).expiresIn, 7 * DAY);
	assert.equal(redis.zset.get("job-1"), Date.parse(rec.endedAt));
});

test("the index rolls with traffic and is trimmed by the writer", async () => {
	// Rolling expiry, deliberately unlike `budget.mjs`'s set-once rule: a budget window pushed forward by
	// traffic never resets, but an ACTIVITY index should roll, because that is what it describes.
	const redis = fakeRedis();
	await anchored({ redis, retentionDays: 7 }).mirror(record("j", "2026-08-30T12:00:00.000Z"), "j");
	// The DEEPEST reader window, never this writer's 7 days: the index is shared, and a short-retention writer that set
	// its TTL made every peer's history expire on a quiet day. Members are trimmed by score; the body keeps its own PX.
	assert.deepEqual(
		redis.calls.filter((c) => c[0] === "pexpire"),
		[["pexpire", RUNS_INDEX, mirrorWindowMs(0)]],
	);
	assert.equal(redis.strings.get(runRecordKey("j")).expiresIn, 7 * DAY);
	// The expiry is only half the claim. Without this the test passed for a week against an index the
	// writer's own age trim had already emptied: a `pexpire` on nothing is still a `pexpire`.
	assert.deepEqual([...redis.zset.keys()], ["j"], "and the member the expiry is being set over survives");
});

test("the index is capped by COUNT as well as by age", async () => {
	// The window alone does not bound memory: thousands of jobs a day would hold a quarter of a million
	// members for ninety-two days. The files on disk stay the complete history either way.
	const redis = fakeRedis();
	const m = anchored({ redis, retentionDays: 90, indexMax: 3 });
	for (let i = 0; i < 6; i++) await m.mirror(record(`j${i}`, new Date(Date.UTC(2026, 7, 30, 12, i)).toISOString()), `j${i}`);
	assert.equal(redis.zset.size, 3);
	assert.deepEqual([...redis.zset.keys()].sort(), ["j3", "j4", "j5"], "the newest survive");
});

test("a record older than the window is dropped from the index on the next write", async () => {
	const redis = fakeRedis();
	const now = Date.parse("2026-08-30T12:00:00.000Z");
	redis.zset.set("ancient", now - 40 * DAY);
	await makeRunMirror({ redis, retentionDays: 7, now: () => now }).mirror(record("fresh", "2026-08-30T12:00:00.000Z"), "fresh");
	assert.deepEqual([...redis.zset.keys()], ["fresh"]);
});

test("a mirror failure NEVER throws and is logged once, not once per job", async () => {
	// This runs on the job's own completion path, after the record is already on disk. A history blip must
	// cost a row in a fleet view and nothing else -- and a Valkey outage during a busy hour must not turn
	// one fault into a thousand log lines.
	const logs = [];
	for (const redis of [fakeRedis({ fail: true }), fakeRedis({ hang: true })]) {
		const m = anchored({ redis, retentionDays: 7, log: (e) => logs.push(e), timeoutMs: 40 });
		assert.equal(await m.mirror(record("j", "2026-08-30T12:00:00.000Z"), "j"), false);
		assert.equal(await m.mirror(record("k", "2026-08-30T12:00:00.000Z"), "k"), false);
	}
	assert.deepEqual(logs, ["run_mirror_failed", "run_mirror_failed"], "once per transition, not once per job");
});

test("a HANGING Valkey is bounded, because maxRetriesPerRequest null never rejects", async () => {
	const started = Date.now();
	assert.equal(await anchored({ redis: fakeRedis({ hang: true }), retentionDays: 7, timeoutMs: 100 }).mirror(record("j", "2026-08-30T12:00:00.000Z"), "j"), false);
	assert.ok(Date.now() - started < 2_000, "bounded, not hung");
});

// --- the reader ------------------------------------------------------------------------------------------

test("two round trips regardless of how many runs come back", async () => {
	const redis = fakeRedis();
	const m = anchored({ redis, retentionDays: 7 });
	for (let i = 0; i < 20; i++) await m.mirror(record(`j${i}`, new Date(Date.UTC(2026, 7, 30, 12, i)).toISOString()), `j${i}`);
	let ranges = 0;
	let gets = 0;
	const counting = { ...redis, async zrevrangebyscore(...a) { ranges++; return redis.zrevrangebyscore(...a); }, async mget(...a) { gets++; return redis.mget(...a); } };
	const { runs } = await readMirroredRuns(counting, { limit: 20 });
	assert.equal(runs.length, 20);
	assert.deepEqual([ranges, gets], [1, 1], "never one read per run");
});

test("an id whose body expired is pruned by the READER", async () => {
	// The per-key TTL fires independently of the index, so a member can outlive its body. A writer that
	// crashed cannot clean up after itself and a reader is already here -- `wait:held`'s posture.
	const redis = fakeRedis();
	await anchored({ redis, retentionDays: 7 }).mirror(record("alive", "2026-08-30T12:00:00.000Z"), "alive");
	redis.zset.set("gone", Date.parse("2026-08-30T11:00:00.000Z"));
	const { runs } = await readMirroredRuns(redis, { limit: 10 });
	assert.deepEqual(runs.map((r) => r.jobId), ["alive"]);
	assert.deepEqual([...redis.zset.keys()], ["alive"], "and the straggler is gone from the index");
});

test("OFF and UNREACHABLE are different facts and must not collapse", async () => {
	// A new panel meeting workers still below the version floor has to read "off", not "error": one says
	// nothing is mirroring, the other says we could not tell.
	assert.deepEqual(await readMirroredRuns(fakeRedis()), { runs: [], degraded: "off" });
	assert.deepEqual(await readMirroredRuns(null), { runs: [], degraded: "off" });
	const dead = await readMirroredRuns(fakeRedis({ fail: true }));
	assert.deepEqual(dead.runs, []);
	assert.match(dead.degraded, /^unreachable/);
});

test("hitting the cap reports TRUNCATED, so a fold can be labelled a floor", async () => {
	const redis = fakeRedis();
	const m = anchored({ redis, retentionDays: 7 });
	for (let i = 0; i < 5; i++) await m.mirror(record(`j${i}`, new Date(Date.UTC(2026, 7, 30, 12, i)).toISOString()), `j${i}`);
	assert.equal((await readMirroredRuns(redis, { limit: 3 })).degraded, "truncated");
	assert.equal((await readMirroredRuns(redis, { limit: 50 })).degraded, "ok");
});

// --- the merge -------------------------------------------------------------------------------------------

test("a retry that landed on ANOTHER host shows the later attempt", async () => {
	// The reason "local wins" alone is wrong: host A holds attempt 0 (failed) and host B mirrored attempt 1
	// (completed) under the same jobId. Local-wins would show the stale one.
	const local = [record("j1", "2026-08-30T10:00:00.000Z", { outcome: "failed" })];
	const mirrored = [record("j1", "2026-08-30T11:00:00.000Z", { outcome: "completed", host: "mini2" })];
	const merged = mergeRuns(local, mirrored);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].outcome, "completed");
	assert.equal(merged[0].host, "mini2");
});

test("local breaks an exact tie, so a single host reads its own files", () => {
	const local = [record("j1", "2026-08-30T10:00:00.000Z", { outcome: "completed", host: "mine" })];
	const mirrored = [record("j1", "2026-08-30T10:00:00.000Z", { outcome: "completed", host: "theirs" })];
	assert.equal(mergeRuns(local, mirrored)[0].host, "mine");
});

test("the list is CUT AFTER the sort, never before", () => {
	// Slicing each source first makes the answer depend on which source happened to be longer -- the exact
	// defect `held.test.mjs` already exists to prevent.
	// The LOCAL pair is newest here while the mirrored pair is inserted first, so insertion order and time
	// order disagree. A cut-then-sort keeps the two oldest and reverses them, which a fixture whose two
	// orders happen to agree would report as correct.
	const local = [record("new1", "2026-08-30T09:00:00.000Z"), record("new2", "2026-08-30T08:00:00.000Z")];
	const mirrored = [record("old1", "2026-08-30T01:00:00.000Z"), record("old2", "2026-08-30T02:00:00.000Z")];
	assert.deepEqual(mergeRuns(local, mirrored, { limit: 2 }).map((r) => r.jobId), ["new1", "new2"]);
});

test("merging against an empty mirror is the identity, which is the shared-storage shape", () => {
	// On a shared PI_LOGS_DIR the local read IS the merged read, so no second code path is needed for it.
	const local = [record("a", "2026-08-30T02:00:00.000Z"), record("b", "2026-08-30T01:00:00.000Z")];
	assert.deepEqual(mergeRuns(local, [], { limit: 10 }), local);
	assert.deepEqual(mergeRuns(local, undefined, { limit: 10 }), local);
});

test("hosts come from the RECORDS, not from where a row was read", () => {
	// Which is what makes the host count correct on shared storage too, with no extra code.
	assert.deepEqual(hostsIn([record("a", "x", { host: "m2" }), record("b", "y", { host: "m1" }), record("c", "z", { host: "m1" })]), ["m1", "m2"]);
	assert.deepEqual(hostsIn([{ jobId: "a" }]), [], "a pre-#57 record names no host and invents none");
});

// ---- readMirroredRecord: the by-id read the lost-lock check falls back to on a fleet ----------------------

test("readMirroredRecord reads one record by its sanitized id; absent or unreachable is null, a value that is not a record is UNREADABLE_RECORD, never a throw", async () => {
	const rec = { jobId: "repeat:n:1", outcome: "completed", attempt: 1 };
	const asked = [];
	const redis = (value) => ({ get: async (k) => (asked.push(k), typeof value === "function" ? value() : value) });
	assert.deepEqual(await readMirroredRecord(redis(JSON.stringify(rec)), "repeat_n_1"), rec);
	assert.deepEqual(asked, [runRecordKey("repeat_n_1")], "one GET of the writer's own key, no index scan");
	assert.equal(await readMirroredRecord(redis(null), "x"), null, "absent (expired, or never mirrored)");
	assert.equal(await readMirroredRecord(redis("{nope"), "x"), UNREADABLE_RECORD, "unparseable: there, but not a record");
	assert.equal(await readMirroredRecord(redis("[1]"), "x"), UNREADABLE_RECORD, "not a record");
	assert.equal(await readMirroredRecord(redis("null"), "x"), UNREADABLE_RECORD);
	assert.equal(await readMirroredRecord(redis(""), "x"), UNREADABLE_RECORD, "an empty value");
	assert.equal(await readMirroredRecord(redis(() => Promise.reject(new Error("ECONNREFUSED"))), "x"), null, "unreachable");
	assert.equal(await readMirroredRecord({ get: () => new Promise(() => {}) }, "x", { timeoutMs: 5 }), null, "a server that never answers is bounded, not awaited forever");
	assert.equal(await readMirroredRecord(null, "x"), null, "no mirror armed");
	assert.equal(await readMirroredRecord(redis(JSON.stringify(rec)), ""), null, "no id");
});

// --- the fleet's history horizon (issue #599) --------------------------------------------------------------

test("a trim that removes runs raises the fleet's horizon: by age to the cutoff, by count to the oldest kept", async () => {
	const redis = fakeRedis();
	// Two hosts on one index: host B keeps 30 days, host A only 1. A's write trims B's older runs too.
	const b = anchored({ redis, retentionDays: 30 });
	for (const d of [3, 10]) await b.mirror(record(`b${d}`, new Date(AT - d * DAY).toISOString(), { host: "b" }), `b${d}`);
	assert.equal(redis.horizon.size, 0, "nothing trimmed, so no horizon at all");
	assert.ok(!redis.calls.some((c) => c[0] === "zadd-horizon"));
	await anchored({ redis, retentionDays: 1 }).mirror(record("a1", new Date(AT).toISOString(), { host: "a" }), "a1");
	assert.deepEqual([...redis.zset.keys()].sort(), ["a1"], "A's retention trimmed every older run of the fleet");
	assert.equal(redis.horizon.get("trim"), AT - DAY, "and said so: nothing before this instant is in the index");
	assert.deepEqual(redis.calls.filter((c) => c[0] === "pexpire" && c[1] === RUNS_HORIZON), [["pexpire", RUNS_HORIZON, mirrorWindowMs(0)]], "kept as long as any reader's deepest window");

	// A later trim by a longer retention never lowers it.
	await anchored({ redis, retentionDays: 30 }).mirror(record("b-old", new Date(AT - 40 * DAY).toISOString(), { host: "b" }), "b-old");
	assert.equal(redis.horizon.get("trim"), AT - DAY, "GT: raised only");

	// The count cap: the oldest REMAINING score, which a removed run ended at or before.
	const capped = fakeRedis();
	const m = anchored({ redis: capped, retentionDays: 30, indexMax: 2 });
	for (const h of [5, 4, 3]) await m.mirror(record(`c${h}`, new Date(AT - h * 3600_000).toISOString()), `c${h}`);
	assert.deepEqual([...capped.zset.keys()].sort(), ["c3", "c4"]);
	assert.equal(capped.horizon.get("trim"), AT - 4 * 3600_000);
});

test("a horizon write that fails is the mirror's failure: logged once, never thrown", async () => {
	const redis = fakeRedis();
	const logs = [];
	await anchored({ redis, retentionDays: 30 }).mirror(record("old", new Date(AT - 20 * DAY).toISOString()), "old");
	redis.zadd = async (k, ...args) => {
		if (k === RUNS_HORIZON) throw new Error("READONLY");
		return undefined;
	};
	assert.equal(await anchored({ redis, retentionDays: 1, log: (e, f) => logs.push([e, f.reason]) }).mirror(record("new", new Date(AT).toISOString()), "new"), false);
	assert.deepEqual(logs, [["run_mirror_failed", "READONLY"]]);
});
