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
				await bounded(redis.zadd(RUNS_INDEX, score, sanitizedJobId), timeoutMs);
				// Trimmed by the WRITER, twice: by age, and by count. Two `ZREMRANGE`s against a run that
				// took minutes is free, and it means no reader has to pay for a backlog it did not create.
				await bounded(redis.zremrangebyscore(RUNS_INDEX, "-inf", `(${now() - windowMs}`), timeoutMs);
				await bounded(redis.zremrangebyrank(RUNS_INDEX, 0, -indexMax - 1), timeoutMs);
				// ROLLING expiry, deliberately unlike `budget.mjs`'s set-once rule and deliberately like
				// `pi-dispatch:sched-stalls:<schedulerId>`. A budget window must not be pushed forward by traffic or a busy
				// day never resets; an ACTIVITY index should roll with traffic, because that is what it
				// describes. A fleet that stops running jobs loses its index one window later, which is
				// correct: there is nothing left to show.
				await bounded(redis.pexpire(RUNS_INDEX, windowMs), timeoutMs);
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
			await bounded(redis.zrem(RUNS_INDEX, ...stale), timeoutMs);
		} catch {
			// best-effort: a straggler in the index costs one skipped row next time, never a wrong one
		}
	}
	return { runs, degraded: runs.length >= limit ? "truncated" : "ok" };
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
