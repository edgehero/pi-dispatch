import { UNREADABLE_RECORD } from "./run-history.mjs";

/**
 * A fleet-visible copy of the run history (issue #57, Gap 3).
 *
 * Every worker writes its records to its own `PI_LOGS_DIR`, so on more than one machine each host's panel
 * lists only the runs on its own disk. The operator sees a third of their deployment and has no way to
 * know it.
 *
 * SHARED STORAGE IS THE OTHER ANSWER AND IT IS NOT SECOND-BEST. On a shared `PI_LOGS_DIR` the local read
 * IS the merged read, with no machinery at all, and this module is redundant. It ships because that trade
 * runs both ways and an operator must be allowed to decline it: sharing the directory also shares the
 * PII-bearing raw `.log`, and a mount outage becomes a LOST RECORD where a Valkey outage costs only a
 * fleet view. Both shapes work; `docs/multi-host.md` says which is which.
 *
 * THE FILE IS THE RECORD AND THIS IS A VIEW. Three things follow, and each is load-bearing:
 *
 *   - The file is written FIRST, always. A crash between the two leaves a fleet-visible run whose durable
 *     source does not exist, which inverts the one claim this design rests on.
 *   - The mirror's TTL is never longer than the file retention window, so it can never show a run whose
 *     file has already been reaped. A view that outlives its source is a second source of truth, which is
 *     exactly what `DES-RUN-HISTORY-FLAT-FILES-NO-DB` refuses.
 *   - Nothing derived is stored. The bytes are the sidecar's own bytes, so there is nothing to be stale
 *     RELATIVE TO: a retry overwrites the same key exactly as it overwrites the same file, and cost
 *     classification is still computed at fold time from `subscriptions.json` rather than frozen here.
 *
 * WHY THE WHOLE RECORD RATHER THAN A PROJECTION. The record is PII-free BY CONSTRUCTION -- it holds no
 * attacker-chosen string, which `INT-RUN-HISTORY-FILE-CONTRACT` states and `buildRecord` enforces field by
 * field. Copying it whole inherits that property; a projection would re-derive it at a second serialiser,
 * where the next person to add a field has to remember this file exists. It is also what the readers need:
 * the cost fold, the graph and the insights view read eleven fields between them.
 *
 * NOT MIRRORED: the raw `.log`. It is the one artifact here that holds issue text, comment text and tool
 * output, and mirroring it would move that off the machine the operator chose to keep it on. A foreign
 * run's record names its host, so the panel can say where the bytes are rather than pretending there are
 * none.
 */

/** The index: sanitized jobId -> the run's end (or start) in millis. */
export const RUNS_INDEX = "runs:index";

/**
 * The fleet's HISTORY HORIZON (issue #599): a one-member ZSET (`trim`) whose score is the newest instant before which a
 * writer has trimmed runs out of the index. Every writer trims the SHARED index by its OWN retention (and the shared
 * count cap), so a host with a short `PI_LOG_RETENTION_DAYS` removes every host's older runs; a reader cannot know
 * that from its own settings, and without this key it read the gap as idle time. Raised only, never lowered (`ZADD
 * GT`), so concurrent writers agree on the latest cut without a lock.
 */
export const RUNS_HORIZON = "runs:horizon";
/** The horizon's one member. */
export const RUNS_HORIZON_MEMBER = "trim";

/**
 * WHEN THIS MIRROR STARTED (issue #599): a hash, `at` the instant in millis from which the index holds every run that
 * ended, and `member` a run of the index that vouches for it. Nothing above says it: the reader's other bounds (the
 * depth, the horizon, the cap, an expired body) all live in keys that a flushed or replaced Valkey, or an index that
 * expired, loses together with the runs, and the next write then recreates an index that claimed the whole window, so a
 * peer read every lost run as idle.
 *
 * A start is TRUSTED only while its `member` is in the index. The start can outlive its index (a worker of 4.0.1 sets
 * the index's expiry to its own retention while the start keeps the deepest window; a pruning reader can remove every
 * member), and an older worker can then recreate the index without knowing this key: a member that is still there is
 * the one proof that the index the start describes is the index that exists. Rejected: also trusting it while
 * `runs:horizon` is at or past it, since the horizon outlives a lost index just the same.
 *   - The write that finds no index starts it NOW (the write's time), vouched for by the run it adds.
 *   - A write that finds an index whose start it cannot trust (none, or its member is gone) starts it at the index's
 *     oldest run before this write, vouched for by that run: the most the index can say, so time before it reads as
 *     missing. A trusted start is kept.
 *   - Whatever removes the vouching run while the start is trusted (a trim, `PRUNE_SCRIPT`) hands it to the oldest run
 *     that remains, `at` unchanged, and deletes the start with the last run. So no trim moves `at`, earlier or later.
 * It expires with the index (one `PEXPIRE` each, in the same script). A reader that finds no trusted start starts the
 * mirror at the index's oldest run.
 */
export const RUNS_SINCE = "runs:since";

/**
 * Lua shared by the three scripts (KEYS[1] the index, KEYS[3] the start): whether the start is a hash, whether its member
 * is held, and handing a trusted start on once its member is removed. A start that is not a hash (a string from a
 * development build, or a hand SET) is read as absent, and the writing scripts delete it first (`sinceClean`), so a
 * stray value can never make HGET fail with WRONGTYPE and stop the mirror.
 */
const SINCE_LUA = `
local function sinceIsHash()
	local t = redis.call("TYPE", KEYS[3])
	return (t.ok or t) == "hash"
end
local function sinceClean()
	if redis.call("EXISTS", KEYS[3]) == 1 and not sinceIsHash() then redis.call("DEL", KEYS[3]) end
end
local function sinceHeld()
	if not sinceIsHash() then return false end
	local member = redis.call("HGET", KEYS[3], "member")
	return member and redis.call("ZSCORE", KEYS[1], member) and true or false
end
local function sinceHandOn()
	local first = redis.call("ZRANGE", KEYS[1], 0, 0)
	if first[1] then redis.call("HSET", KEYS[3], "member", first[1]) else redis.call("DEL", KEYS[3]) end
end
`;

/**
 * The writer's index write and trim, in one script so the member, the start (`RUNS_SINCE`) and the horizon it raises
 * are atomic (issue #599). KEYS: the index, the horizon and the start; ARGV: the age cutoff in millis, the count cap,
 * the expiry all three keys get, the horizon's member, the run's score, its id, and the write's time in millis.
 *
 * - The start is checked and set as `RUNS_SINCE` says, from the index as it was before this write, and the member is
 *   added (`ZADD`).
 * - By age (scores below the cutoff, exclusive) and by count (all but the newest `cap`). A trim that REMOVED something
 *   raises the horizon with `ZADD GT`: to the cutoff, or after a count trim to the oldest score that remains, which is
 *   conservative (a removed run ended at or before it). Nothing removed, nothing written: a fleet whose writers trim
 *   nothing keeps no horizon. A trim that removed the start's member hands the start on.
 * - The keys expire after the DEEPEST window any reader asks for (`mirrorWindowMs(0)`), never the writer's own. The
 *   index's members are trimmed by score anyway; a short-retention writer that set the shared index's TTL to its own
 *   window made the whole index expire on a quiet day, every peer's history with it and no horizon to say so. The
 *   expiry still rolls with traffic: a fleet that runs nothing for that long has nothing to show.
 */
export const TRIM_SCRIPT = `${SINCE_LUA}
sinceClean()
local oldest = redis.call("ZRANGE", KEYS[1], 0, 0, "WITHSCORES")
if not oldest[2] then
	redis.call("DEL", KEYS[3])
	redis.call("HSET", KEYS[3], "at", ARGV[7], "member", ARGV[6])
elseif not (redis.call("HGET", KEYS[3], "at") and sinceHeld()) then
	redis.call("DEL", KEYS[3])
	redis.call("HSET", KEYS[3], "at", string.format("%d", tonumber(oldest[2])), "member", oldest[1])
end
redis.call("ZADD", KEYS[1], ARGV[5], ARGV[6])
redis.call("PEXPIRE", KEYS[3], ARGV[3])
local removed = redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", "(" .. ARGV[1])
local horizon = nil
if removed > 0 then horizon = tonumber(ARGV[1]) end
if redis.call("ZREMRANGEBYRANK", KEYS[1], 0, -tonumber(ARGV[2]) - 1) > 0 then
	local kept = redis.call("ZRANGE", KEYS[1], 0, 0, "WITHSCORES")
	if kept[2] then
		local score = tonumber(kept[2])
		if horizon == nil or score > horizon then horizon = score end
	end
end
if horizon then
	redis.call("ZADD", KEYS[2], "GT", string.format("%d", horizon), ARGV[4])
	redis.call("PEXPIRE", KEYS[2], ARGV[3])
	if not sinceHeld() then sinceHandOn() end
end
redis.call("PEXPIRE", KEYS[1], ARGV[3])
return horizon and string.format("%d", horizon) or false
`;

/**
 * A pruning reader's removal of members whose bodies are gone (`readMirroredRuns`), in one script so the cut is
 * recorded with it (issue #599). The run a removed member stood for is no longer shown, so the time up to it is no
 * longer whole: the horizon is raised (`ZADD GT`) to the highest score removed, as `TRIM_SCRIPT` raises it for a trim,
 * and a trusted start whose member is removed is handed on. Without it, the reader's "expired body" bound was erased by
 * the very read that saw it, and the time before it read as idle. KEYS: the index, the horizon and the start; ARGV: the
 * horizon's expiry, its member, then the ids. Returns the highest score removed, or false.
 */
export const PRUNE_SCRIPT = `${SINCE_LUA}
sinceClean()
-- Handed on only when the start was trusted BEFORE this removal: a start whose run was already gone (an older worker
-- recreated the index under it) must not be revalidated by handing it to a run of the new index.
local held = sinceHeld()
local top = nil
for i = 3, #ARGV do
	local score = redis.call("ZSCORE", KEYS[1], ARGV[i])
	if score then
		redis.call("ZREM", KEYS[1], ARGV[i])
		score = tonumber(score)
		if top == nil or score > top then top = score end
	end
end
if top then
	redis.call("ZADD", KEYS[2], "GT", string.format("%d", top), ARGV[2])
	redis.call("PEXPIRE", KEYS[2], ARGV[1])
	if held and not sinceHeld() then sinceHandOn() end
end
return top and string.format("%d", top) or false
`;

/**
 * The capacity reader's one snapshot of the index (issue #599): its size, its oldest score, the horizon, the start's
 * `at` and whether its member is held, and the members that ended after ARGV[2] (exclusive) with their scores, newest
 * first. One script, so a flush or a write between these reads cannot mix two states into one report. KEYS: the index,
 * the horizon and the start; ARGV: the horizon's member and the window's start.
 */
export const READ_SCRIPT = `${SINCE_LUA}
local size = redis.call("ZCARD", KEYS[1])
if size == 0 then return {0} end
local oldest = redis.call("ZRANGE", KEYS[1], 0, 0, "WITHSCORES")
local horizon = redis.call("ZSCORE", KEYS[2], ARGV[1])
local at = sinceIsHash() and redis.call("HGET", KEYS[3], "at") or false
local range = redis.call("ZREVRANGEBYSCORE", KEYS[1], "+inf", "(" .. ARGV[2], "WITHSCORES")
return {size, oldest[2] or false, horizon, at, sinceHeld() and 1 or 0, range}
`;

/** One run's own bytes. */
export const runRecordKey = (sanitizedJobId) => `runs:rec:${sanitizedJobId}`;

/**
 * The deepest any reader asks. `SCAN_WINDOW_MAX_DAYS` in the admin is 92, so a longer window would hold
 * bytes nothing can request.
 */
export const MIRROR_MAX_DAYS = 92;

/**
 * A hard ceiling on index members, independent of the time window.
 *
 * The window alone does not bound memory: a deployment running thousands of jobs a day would hold a
 * quarter of a million members for ninety-two days. This caps what the fleet view can cost at roughly the
 * depth a panel can display, and the file on disk remains the complete history either way.
 */
export const RUNS_INDEX_MAX = 5_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const OP_TIMEOUT_MS = 2_000;

/**
 * How long a mirrored record lives.
 *
 * Never longer than the operator's own retention, and never longer than what any reader asks for.
 * `retentionDays: 0` means keep the files forever, which is the one case where the mirror is the shorter
 * of the two, so it clamps to the reader's ceiling rather than to infinity.
 */
export function mirrorWindowMs(retentionDays) {
	const days = Number(retentionDays) > 0 ? Math.min(Number(retentionDays), MIRROR_MAX_DAYS) : MIRROR_MAX_DAYS;
	return days * DAY_MS;
}

/**
 * BullMQ's connections carry `maxRetriesPerRequest: null`, so a command against an unreachable server
 * QUEUES FOREVER rather than rejecting. Every await here is bounded for that reason; an unbounded one
 * would not fail the mirror, it would hang the job that was writing to it.
 */
function bounded(promise, ms) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error("mirror timeout")), ms);
		}),
	]).finally(() => clearTimeout(timer));
}

/**
 * The writer. Returns `{ mirror, close }`; `mirror` never throws and never rejects.
 *
 * A history blip must not fail a job that has already run and already been recorded to disk. Every failure
 * here costs a row in a fleet view and nothing else, which is why the whole body is wrapped and the result
 * is a boolean nobody is obliged to read.
 */
export function makeRunMirror({ redis, retentionDays, now = () => Date.now(), log = () => {}, timeoutMs = OP_TIMEOUT_MS, indexMax = RUNS_INDEX_MAX } = {}) {
	const windowMs = mirrorWindowMs(retentionDays);
	let warned = false;

	return {
		async mirror(record, sanitizedJobId) {
			if (!redis || !record || !sanitizedJobId) return false;
			try {
				const at = Date.parse(record.endedAt ?? record.startedAt ?? "");
				const score = Number.isFinite(at) ? at : now();
				const body = JSON.stringify(record);
				await bounded(redis.set(runRecordKey(sanitizedJobId), body, "PX", windowMs), timeoutMs);
				// Indexed, and trimmed by the WRITER, twice: by age, and by count, with the mirror's start (`RUNS_SINCE`) and
				// the fleet's horizon written by the same script (`TRIM_SCRIPT`), so no crash or timeout can land between a
				// member and the record of where the index starts, or between a cut and the record of it. A script, not a
				// MULTI, because both depend on what the index held: the start on whether it existed, the horizon on what a
				// trim REMOVED and what remains.
				const writtenMs = now();
				await bounded(redis.eval(TRIM_SCRIPT, 3, RUNS_INDEX, RUNS_HORIZON, RUNS_SINCE, writtenMs - windowMs, indexMax, mirrorWindowMs(0), RUNS_HORIZON_MEMBER, score, sanitizedJobId, writtenMs), timeoutMs);
				warned = false;
				return true;
			} catch (err) {
				// Once per transition, not once per job: a Valkey outage during a busy hour must not turn one
				// fault into a thousand log lines (`notePackageKey`'s precedent).
				if (!warned) {
					warned = true;
					log("run_mirror_failed", { jobId: sanitizedJobId, reason: err?.message });
				}
				return false;
			}
		},
	};
}

/**
 * The reader. Returns `{ runs, degraded }` and never throws.
 *
 * `degraded` is a DISCRIMINATED channel rather than a silence, and two of its values must not collapse:
 * `"off"` means the index is absent, which is what a single-host deployment and a fleet of workers still
 * below the version floor both look like, while `"unreachable"` means we could not tell. A new panel
 * meeting old workers has to read "off", not "error".
 *
 * Two round trips regardless of how many runs come back: one `ZREVRANGEBYSCORE` for the ids, one `MGET`
 * for the bodies. Never one read per run.
 */
export async function readMirroredRuns(redis, { limit = 50, sinceMs = 0, now = () => Date.now(), timeoutMs = OP_TIMEOUT_MS } = {}) {
	if (!redis) return { runs: [], degraded: "off" };
	let ids;
	try {
		ids = await bounded(redis.zrevrangebyscore(RUNS_INDEX, "+inf", `(${sinceMs}`, "LIMIT", 0, Math.max(1, limit)), timeoutMs);
	} catch (err) {
		return { runs: [], degraded: `unreachable (${err?.message ?? "?"})` };
	}
	if (!Array.isArray(ids) || ids.length === 0) return { runs: [], degraded: "off" };

	let bodies;
	try {
		bodies = await bounded(redis.mget(...ids.map(runRecordKey)), timeoutMs);
	} catch (err) {
		return { runs: [], degraded: `unreachable (${err?.message ?? "?"})` };
	}

	const runs = [];
	const stale = [];
	for (let i = 0; i < ids.length; i++) {
		const raw = bodies?.[i];
		if (typeof raw !== "string" || raw === "") {
			// An id whose body has expired: the per-key TTL fired and the index member outlived it. The
			// READER prunes it, which is what `wait:held` does for the same shape and for the same reason --
			// a writer that crashed cannot clean up after itself, and a reader is already here.
			stale.push(ids[i]);
			continue;
		}
		try {
			const rec = JSON.parse(raw);
			if (rec && typeof rec === "object") runs.push(rec);
		} catch {
			stale.push(ids[i]); // unparseable is indistinguishable from gone, and equally not showable
		}
	}
	if (stale.length > 0) {
		try {
			// Removed with the cut recorded (`PRUNE_SCRIPT`): the time up to a pruned run is no longer whole.
			await bounded(redis.eval(PRUNE_SCRIPT, 3, RUNS_INDEX, RUNS_HORIZON, RUNS_SINCE, mirrorWindowMs(0), RUNS_HORIZON_MEMBER, ...stale), timeoutMs);
		} catch {
			// best-effort: a straggler in the index costs one skipped row next time, never a wrong one
		}
	}
	return { runs, degraded: runs.length >= limit ? "truncated" : "ok" };
}

/**
 * One run's mirrored record, by its sanitized id: the parsed object, `null`, or `UNREADABLE_RECORD`. Never throws,
 * never rejects.
 *
 * The by-id read the lost-lock check needs (`makeSettledRecord` in `run-history.mjs`): one bounded `GET`, not the
 * index scan `readMirroredRuns` does for the panel. Unreachable and absent are `null` (nothing found); a value that
 * is there but is not a record (unparseable, empty, not an object) is `UNREADABLE_RECORD`, exactly as the local
 * reader says it, so the check can log `unreadable` from `mirror`. Neither is ever accepted: the caller keeps
 * today's path.
 */
export async function readMirroredRecord(redis, sanitizedJobId, { timeoutMs = OP_TIMEOUT_MS } = {}) {
	if (!redis || !sanitizedJobId) return null;
	try {
		const raw = await bounded(redis.get(runRecordKey(sanitizedJobId)), timeoutMs);
		if (raw === null || raw === undefined) return null;
		if (typeof raw !== "string" || raw === "") return UNREADABLE_RECORD;
		let rec;
		try {
			rec = JSON.parse(raw);
		} catch {
			return UNREADABLE_RECORD;
		}
		return rec !== null && typeof rec === "object" && !Array.isArray(rec) ? rec : UNREADABLE_RECORD;
	} catch {
		return null; // unreachable or timed out: nothing was read
	}
}

/**
 * One list from two sources.
 *
 * DEDUP BY LATER `endedAt`, LOCAL BREAKS A TIE. Not decoration: a retry can land on a different host, so
 * host A may hold attempt 0 (failed) while host B mirrored attempt 1 (completed). "Local wins" alone would
 * show the stale one. Local breaking an exact tie keeps a single-host deployment reading its own files.
 *
 * CUT AFTER THE SORT, never before. Slicing first is the defect `held.test.mjs` already exists to prevent:
 * it makes the result depend on which source happened to be longer.
 */
export function mergeRuns(local, mirrored, { limit = 50 } = {}) {
	const by = new Map();
	const at = (r) => {
		const t = Date.parse(r?.endedAt ?? r?.startedAt ?? "");
		return Number.isFinite(t) ? t : -Infinity;
	};
	// Mirrored first, so a local record with an equal timestamp overwrites it on the second pass.
	for (const r of Array.isArray(mirrored) ? mirrored : []) if (r?.jobId) by.set(r.jobId, r);
	for (const r of Array.isArray(local) ? local : []) {
		if (!r?.jobId) continue;
		const seen = by.get(r.jobId);
		if (!seen || at(r) >= at(seen)) by.set(r.jobId, r);
	}
	const out = [...by.values()].sort((a, b) => at(b) - at(a));
	return out.slice(0, Math.max(0, limit));
}

/** The distinct hosts a merged list came from, computed from the RECORDS rather than from the mirror. */
export function hostsIn(runs) {
	const names = new Set();
	for (const r of runs ?? []) if (typeof r?.host === "string" && r.host !== "") names.add(r.host);
	return [...names].sort();
}
