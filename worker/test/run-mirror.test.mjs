import assert from "node:assert/strict";
import { test } from "node:test";
import { MIRROR_MAX_DAYS, RUNS_INDEX, hostsIn, makeRunMirror, mergeRuns, mirrorWindowMs, readMirroredRuns, runRecordKey } from "../src/run-mirror.mjs";

const DAY = 24 * 60 * 60 * 1000;

// A Valkey with real ZSET-and-string semantics for the handful of commands this uses. The ordering IS the
// mechanism under test, so a fake that only records calls would prove nothing.
function fakeRedis({ fail = false, hang = false } = {}) {
	const strings = new Map();
	const zset = new Map(); // member -> score
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
		async zadd(k, score, member) {
			await guard();
			calls.push(["zadd", member]);
			zset.set(member, score);
		},
		async zremrangebyscore(_k, _min, max) {
			await guard();
			const cut = Number(String(max).replace("(", ""));
			for (const [m, s] of zset) if (s <= cut) zset.delete(m);
		},
		async zremrangebyrank(_k, _start, stop) {
			await guard();
			// Redis semantics: rank 0 is the LOWEST score. `stop` negative counts from the end.
			const sorted = [...zset.entries()].sort((a, b) => a[1] - b[1]);
			const end = stop < 0 ? sorted.length + stop : stop;
			for (let i = 0; i <= end && i < sorted.length; i++) zset.delete(sorted[i][0]);
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
	const m = makeRunMirror({ redis, retentionDays: 7 });
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
	await makeRunMirror({ redis, retentionDays: 7 }).mirror(record("j", "2026-08-30T12:00:00.000Z"), "j");
	assert.deepEqual(
		redis.calls.filter((c) => c[0] === "pexpire"),
		[["pexpire", RUNS_INDEX, 7 * DAY]],
	);
});

test("the index is capped by COUNT as well as by age", async () => {
	// The window alone does not bound memory: thousands of jobs a day would hold a quarter of a million
	// members for ninety-two days. The files on disk stay the complete history either way.
	const redis = fakeRedis();
	const m = makeRunMirror({ redis, retentionDays: 90, indexMax: 3 });
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
		const m = makeRunMirror({ redis, retentionDays: 7, log: (e) => logs.push(e), timeoutMs: 40 });
		assert.equal(await m.mirror(record("j", "2026-08-30T12:00:00.000Z"), "j"), false);
		assert.equal(await m.mirror(record("k", "2026-08-30T12:00:00.000Z"), "k"), false);
	}
	assert.deepEqual(logs, ["run_mirror_failed", "run_mirror_failed"], "once per transition, not once per job");
});

test("a HANGING Valkey is bounded, because maxRetriesPerRequest null never rejects", async () => {
	const started = Date.now();
	assert.equal(await makeRunMirror({ redis: fakeRedis({ hang: true }), retentionDays: 7, timeoutMs: 100 }).mirror(record("j", "2026-08-30T12:00:00.000Z"), "j"), false);
	assert.ok(Date.now() - started < 2_000, "bounded, not hung");
});

// --- the reader ------------------------------------------------------------------------------------------

test("two round trips regardless of how many runs come back", async () => {
	const redis = fakeRedis();
	const m = makeRunMirror({ redis, retentionDays: 7 });
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
	await makeRunMirror({ redis, retentionDays: 7 }).mirror(record("alive", "2026-08-30T12:00:00.000Z"), "alive");
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
	const m = makeRunMirror({ redis, retentionDays: 7 });
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
