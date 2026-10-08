/**
 * The run records a capacity report reads (issue #599, DES-CAPACITY-FROM-RECORDS), and what they cover. Two sources,
 * merged by the one rule the panel already reads the fleet's runs by (run-mirror.mjs `mergeRuns`):
 *
 *   - THE RUN MIRROR, where workers declared names (`runs:index` and `runs:rec:*`, run-mirror.mjs): every named host's
 *     records. Read in a fixed number of bounded round trips: ZCARD and the oldest score, one ZREVRANGEBYSCORE over the
 *     window, then MGET in chunks of `CAPACITY_MGET_CHUNK`. READ-ONLY: unlike `readMirroredRuns`, this reader prunes
 *     nothing, so a report can never change what another surface shows.
 *   - THE LOCAL FILES in the logs directory, size-records.mjs' pattern: an mtime prefilter (a file last written before
 *     the window, less a day of skew, is not opened) and the 256 KiB cap per file (`SIZING_RECORD_MAX_BYTES`), a larger
 *     file skipped and counted.
 *
 * WHAT IT COVERS (`coverage.fromMs`), never more than it can show, so a report never reads lost history as idle time:
 *   - the mirror keeps at most `RUNS_INDEX_MAX` runs. At that cap, when its oldest run ended AFTER the window began, the
 *     runs before it were cut, and the history starts there (`truncated`);
 *   - the mirror keeps a run for `mirrorWindowMs(retentionDays)` at most, and the files for `PI_LOG_RETENTION_DAYS`
 *     (0 keeps them), so neither can show anything older.
 *
 * An absent index is `off` (no named worker, or none since the index expired), and an unreachable or slow Valkey is
 * read as no mirror, both with the reason stated: the local files are still read, and the report says it is local
 * only. Every Valkey call is bounded (`bounded`, host-registry.mjs' reason: this client QUEUES a command while offline
 * rather than rejecting it, so an unbounded await is a hang, not an error).
 *
 * Never throws.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { RUNS_INDEX, RUNS_INDEX_MAX, mergeRuns, mirrorWindowMs, runRecordKey } from "./run-mirror.mjs";
import { SIZING_RECORD_MAX_BYTES } from "./size-records.mjs";

/** How many record bodies one MGET asks for: a full mirror is ten round trips, never one 5,000-key command. */
export const CAPACITY_MGET_CHUNK = 500;
/** How long one Valkey call may take before the mirror is read as unreachable. */
export const CAPACITY_OP_TIMEOUT_MS = 2_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Reject rather than wait forever (host-registry.mjs `bounded`). */
function bounded(promise, ms) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("timeout")), ms);
		Promise.resolve(promise).then(
			(v) => (clearTimeout(t), resolve(v)),
			(e) => (clearTimeout(t), reject(e)),
		);
	});
}

/**
 * The mirror's records that ended after `sinceMs`: `{ records, state, truncated, oldestMs }`, `state` "ok", "off" or
 * "unreachable (<reason>)". Never throws.
 */
export async function readMirrorWindow(redis, { sinceMs, timeoutMs = CAPACITY_OP_TIMEOUT_MS, chunk = CAPACITY_MGET_CHUNK } = {}) {
	if (!redis) return { records: [], state: "off", truncated: false, oldestMs: null };
	try {
		const size = Number(await bounded(redis.zcard(RUNS_INDEX), timeoutMs));
		if (!Number.isSafeInteger(size) || size <= 0) return { records: [], state: "off", truncated: false, oldestMs: null };
		const oldest = await bounded(redis.zrange(RUNS_INDEX, 0, 0, "WITHSCORES"), timeoutMs);
		const oldestMs = Array.isArray(oldest) && oldest.length >= 2 ? Number(oldest[1]) : NaN;
		const truncated = size >= RUNS_INDEX_MAX && Number.isFinite(oldestMs) && oldestMs > sinceMs;
		const ids = await bounded(redis.zrevrangebyscore(RUNS_INDEX, "+inf", `(${sinceMs}`), timeoutMs);
		if (!Array.isArray(ids)) throw new Error("the index did not answer a list");
		const records = [];
		for (let i = 0; i < ids.length; i += chunk) {
			const part = ids.slice(i, i + chunk);
			const bodies = await bounded(redis.mget(...part.map(runRecordKey)), timeoutMs);
			for (const raw of Array.isArray(bodies) ? bodies : []) {
				if (typeof raw !== "string" || raw === "") continue; // expired: its index member outlived it
				try {
					const record = JSON.parse(raw);
					if (record !== null && typeof record === "object" && !Array.isArray(record)) records.push(record);
				} catch {
					// unparseable is not showable
				}
			}
		}
		return { records, state: "ok", truncated, oldestMs: Number.isFinite(oldestMs) ? oldestMs : null };
	} catch (err) {
		return { records: [], state: `unreachable (${err?.message ?? "error"})`, truncated: false, oldestMs: null };
	}
}

/**
 * This host's records that ended after `sinceMs`: `{ records, skipped, unreachable }`. `fs` is `{ readdirSync,
 * statSync, readFileSync }`.
 */
export function readLocalWindow(logsDir, { sinceMs, fs = { readdirSync, readFileSync, statSync } } = {}) {
	let names;
	try {
		names = fs.readdirSync(logsDir);
	} catch (err) {
		return { records: [], skipped: 0, unreachable: err?.code === "ENOENT" ? null : `logs dir unreadable (${err?.code ?? "read-error"})` };
	}
	const records = [];
	let skipped = 0;
	for (const name of names) {
		if (typeof name !== "string" || !name.endsWith(".json")) continue;
		try {
			const path = join(logsDir, name);
			const st = fs.statSync(path);
			// A record file is written when its run ends, so one last written before the window (less a day of skew) holds
			// no run that reaches into it.
			if (!st.isFile() || st.mtimeMs < sinceMs - DAY_MS) continue;
			if (st.size > SIZING_RECORD_MAX_BYTES) {
				skipped++;
				continue;
			}
			const buf = fs.readFileSync(path);
			if (buf.length > SIZING_RECORD_MAX_BYTES) {
				skipped++; // it grew between the stat and the read
				continue;
			}
			const record = JSON.parse(buf.toString("utf8"));
			if (record === null || typeof record !== "object" || Array.isArray(record) || typeof record.jobId !== "string") continue;
			const end = Date.parse(record.endedAt ?? "");
			if (Number.isFinite(end) && end > sinceMs) records.push(record);
		} catch {
			// unparseable, or reaped between the listing and the read
		}
	}
	return { records, skipped, unreachable: null };
}

/**
 * The records of the window `[sinceMs, nowMs]` from both sources, merged, and what they cover:
 * `{ records, coverage }`, `coverage` being `{ source, reason, fromMs, truncated, mirrored, localHost, localHosts,
 * skipped }` as `computeCapacity` reads it. `redis` may be null (no Valkey to ask). `localHost` is this host's name,
 * whose history the files always hold. Never throws.
 */
export async function readCapacityRecords({ redis = null, logsDir, sinceMs, nowMs, fs, retentionDays = 0, localHost = null, timeoutMs = CAPACITY_OP_TIMEOUT_MS, chunk = CAPACITY_MGET_CHUNK } = {}) {
	const mirror = await readMirrorWindow(redis, { sinceMs, timeoutMs, chunk });
	const local = readLocalWindow(logsDir, { sinceMs, ...(fs ? { fs } : {}) });
	const mirrored = mirror.state === "ok";
	let fromMs = sinceMs;
	const days = Number(retentionDays);
	if (Number.isFinite(days) && days > 0) fromMs = Math.max(fromMs, nowMs - days * DAY_MS);
	if (mirrored) {
		fromMs = Math.max(fromMs, nowMs - mirrorWindowMs(retentionDays));
		if (mirror.truncated) fromMs = Math.max(fromMs, mirror.oldestMs);
	}
	const reasons = [];
	if (mirror.state === "off") reasons.push("no run mirror: only this host's files were read");
	else if (!mirrored) reasons.push(`run mirror ${mirror.state}: only this host's files were read`);
	if (local.unreachable) reasons.push(local.unreachable);
	if (local.skipped > 0) reasons.push(`${local.skipped} record file${local.skipped === 1 ? "" : "s"} over ${SIZING_RECORD_MAX_BYTES / 1024} KiB skipped`);
	const localHosts = [...new Set(local.records.map((r) => r.host).filter((h) => typeof h === "string" && h !== ""))].sort();
	return {
		// One per job id, the later end winning (a retry can land on another host); `Infinity` keeps every run, since the
		// window, not a page, bounds this read.
		records: mergeRuns(local.records, mirror.records, { limit: Infinity }),
		coverage: {
			source: mirrored ? (local.records.length > 0 ? "mirror+local" : "mirror") : "local",
			reason: reasons.length > 0 ? reasons.join("; ") : null,
			fromMs: Math.min(fromMs, nowMs),
			truncated: mirrored && mirror.truncated,
			mirrored,
			localHost,
			localHosts,
			skipped: local.skipped,
		},
	};
}
