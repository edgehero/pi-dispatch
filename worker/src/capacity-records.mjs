/**
 * The run records a capacity report reads (issue #599, DES-CAPACITY-FROM-RECORDS), and what they cover. Two sources,
 * merged by the one rule the panel already reads the fleet's runs by (run-mirror.mjs `mergeRuns`):
 *
 *   - THE RUN MIRROR, where workers declared names (`runs:index`, `runs:rec:*`, `runs:horizon` and `runs:since`,
 *     run-mirror.mjs): every named host's records. Read in a fixed number of bounded round trips: ONE script
 *     (`READ_SCRIPT`: the size, the oldest score, the horizon, the mirror's start and the members over the window, one
 *     snapshot, so a flush between them cannot mix two states), then MGET in chunks of `CAPACITY_MGET_CHUNK`. A body
 *     over 256 KiB is skipped and counted, as a local file is. READ-ONLY: unlike `readMirroredRuns`, this reader prunes nothing, so a
 *     report can never change what another surface shows.
 *   - THE LOCAL FILES in the logs directory, size-records.mjs' pattern: an mtime prefilter (a file last written before
 *     the window, less a day of skew, is not opened) and the 256 KiB cap per file (`SIZING_RECORD_MAX_BYTES`), a larger
 *     file skipped and counted.
 *
 * WHAT EACH COVERS, never more than it can show, so a report never reads lost history as idle time. The two sources
 * cover different hosts, so each states its own start and `computeCapacity` judges every host by the sources that hold
 * all of its runs:
 *   - the local files hold this host's runs (and every host's, on a shared logs directory) back to
 *     `PI_LOG_RETENTION_DAYS` (0 keeps them). An absent or unreadable directory covers nothing (`local: null`): a host
 *     whose files are gone has no history here, not an idle one;
 *   - the mirror holds the named hosts' runs back to the LATEST of: the mirror's own start (`runs:since`, trusted only
 *     while the run that vouches for it is in the index; without a trusted one, the index's oldest run, since an index
 *     written before that key, recreated by a worker that does not know it, or whose key was lost, vouches for nothing
 *     older), the deepest window any writer keeps
 *     (`mirrorWindowMs(0)`), the fleet horizon (`runs:horizon`, raised by every writer whose trim removed runs, by its
 *     OWN retention or the count cap, so a peer with a short retention cuts everyone's history and says so), the oldest
 *     run at the `RUNS_INDEX_MAX` cap when that run ended after the window began, and the newest run whose body has
 *     expired while its index member stayed (its writer has not trimmed since). Any of these past the window's start
 *     makes it `truncated`. The start is the one bound that survives losing the mirror's keys: a flushed or replaced
 *     Valkey, or an index that expired, loses the horizon with the runs, and the next write recreates an index whose
 *     other bounds all reach back past the loss, so without it a peer read every lost run as idle.
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
import { READ_SCRIPT, RUNS_HORIZON, RUNS_HORIZON_MEMBER, RUNS_INDEX, RUNS_INDEX_MAX, RUNS_SINCE, mergeRuns, mirrorWindowMs, runRecordKey } from "./run-mirror.mjs";
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
 * The mirror's records that ended after `sinceMs`: `{ records, state, fromMs, truncated, skipped }`, `state` "ok", "off"
 * or "unreachable (<reason>)", `fromMs` where its history starts (see the header). Never throws.
 */
export async function readMirrorWindow(redis, { sinceMs, nowMs, timeoutMs = CAPACITY_OP_TIMEOUT_MS, chunk = CAPACITY_MGET_CHUNK } = {}) {
	const none = (state) => ({ records: [], state, fromMs: null, truncated: false, skipped: 0 });
	if (!redis) return none("off");
	try {
		const snap = await bounded(redis.eval(READ_SCRIPT, 3, RUNS_INDEX, RUNS_HORIZON, RUNS_SINCE, RUNS_HORIZON_MEMBER, sinceMs), timeoutMs);
		if (!Array.isArray(snap)) throw new Error("the index did not answer a list");
		const size = Number(snap[0]);
		if (!Number.isSafeInteger(size) || size <= 0) return none("off");
		const num = (v) => (typeof v === "string" && /^\d{1,16}$/.test(v) ? Number(v) : typeof v === "number" && Number.isSafeInteger(v) ? v : NaN);
		const oldestMs = num(snap[1]);
		const horizonMs = num(snap[2]);
		// The start counts only while the run that vouches for it is in the index (`RUNS_SINCE`).
		const startMs = snap[4] === 1 ? num(snap[3]) : NaN;
		const ids = snap[5];
		if (!Array.isArray(ids) || ids.length % 2 !== 0) throw new Error("the index did not answer a list");
		const members = [];
		for (let i = 0; i < ids.length; i += 2) members.push({ id: ids[i], score: Number(ids[i + 1]) });
		const records = [];
		let skipped = 0;
		let expiredMs = NaN;
		for (let i = 0; i < members.length; i += chunk) {
			const part = members.slice(i, i + chunk);
			const bodies = await bounded(redis.mget(...part.map((m) => runRecordKey(m.id))), timeoutMs);
			part.forEach((m, k) => {
				const raw = Array.isArray(bodies) ? bodies[k] : null;
				if (typeof raw !== "string" || raw === "") {
					// Expired while its member stayed: a run this index once held and no longer shows, so the history of the
					// mirror cannot start before it (the members are newest first, so the first one found is the newest).
					if (!Number.isFinite(expiredMs) && Number.isFinite(m.score)) expiredMs = m.score;
					return;
				}
				if (Buffer.byteLength(raw, "utf8") > SIZING_RECORD_MAX_BYTES) {
					skipped++;
					return;
				}
				try {
					const record = JSON.parse(raw);
					if (record !== null && typeof record === "object" && !Array.isArray(record)) records.push(record);
				} catch {
					// unparseable is not showable
				}
			});
		}
		let fromMs = Math.max(sinceMs, nowMs - mirrorWindowMs(0));
		// The mirror's own start; without a trusted one, the oldest run the index holds (`RUNS_SINCE`): never the window's
		// start.
		if (Number.isFinite(startMs)) fromMs = Math.max(fromMs, startMs);
		else if (Number.isFinite(oldestMs)) fromMs = Math.max(fromMs, oldestMs);
		if (Number.isFinite(horizonMs)) fromMs = Math.max(fromMs, horizonMs);
		if (size >= RUNS_INDEX_MAX && Number.isFinite(oldestMs)) fromMs = Math.max(fromMs, oldestMs);
		if (Number.isFinite(expiredMs)) fromMs = Math.max(fromMs, expiredMs);
		fromMs = Math.min(fromMs, nowMs);
		return { records, state: "ok", fromMs, truncated: fromMs > sinceMs, skipped };
	} catch (err) {
		return none(`unreachable (${err?.message ?? "error"})`);
	}
}

/**
 * This host's records that ended after `sinceMs`: `{ records, skipped, unreachable, absent }`. `fs` is `{ readdirSync,
 * statSync, readFileSync }`.
 */
export function readLocalWindow(logsDir, { sinceMs, fs = { readdirSync, readFileSync, statSync } } = {}) {
	let names;
	try {
		names = fs.readdirSync(logsDir);
	} catch (err) {
		const absent = err?.code === "ENOENT";
		return { records: [], skipped: 0, unreachable: absent ? null : `logs dir unreadable (${err?.code ?? "read-error"})`, absent };
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
	return { records, skipped, unreachable: null, absent: false };
}

/**
 * The records of the window `[sinceMs, nowMs]` from both sources, merged, and what each covers: `{ records, mirrorState,
 * coverage }`,
 * `coverage` being `{ source, reason, localHost, localHosts, local: { fromMs } | null, mirror: { fromMs, truncated,
 * hosts } | null, skipped }` as `computeCapacity` reads it. `redis` may be null (no Valkey to ask); `noMirrorReason` then
 * says why, in place of "no run mirror". `localHost` is this host's name. Never throws.
 */
export async function readCapacityRecords({ redis = null, logsDir, sinceMs, nowMs, fs, retentionDays = 0, localHost = null, noMirrorReason = null, timeoutMs = CAPACITY_OP_TIMEOUT_MS, chunk = CAPACITY_MGET_CHUNK } = {}) {
	const mirror = await readMirrorWindow(redis, { sinceMs, nowMs, timeoutMs, chunk });
	const local = readLocalWindow(logsDir, { sinceMs, ...(fs ? { fs } : {}) });
	const mirrored = mirror.state === "ok";
	const days = Number(retentionDays);
	const localFromMs = Math.min(nowMs, Number.isFinite(days) && days > 0 ? Math.max(sinceMs, nowMs - days * DAY_MS) : sinceMs);
	const localRead = local.unreachable === null && !local.absent;
	const reasons = [];
	if (!mirrored) {
		if (!redis && noMirrorReason) reasons.push(noMirrorReason);
		else if (mirror.state === "off") reasons.push("no run mirror: only this host's files were read");
		else reasons.push(`run mirror ${mirror.state}: only this host's files were read`);
	}
	if (local.absent) reasons.push("no logs directory here, so this host's own runs are not read");
	if (local.unreachable) reasons.push(local.unreachable);
	const skipped = local.skipped + mirror.skipped;
	if (skipped > 0) reasons.push(`${skipped} record${skipped === 1 ? "" : "s"} over ${SIZING_RECORD_MAX_BYTES / 1024} KiB skipped`);
	const hostsOf = (records) => [...new Set(records.map((r) => r.host).filter((h) => typeof h === "string" && h !== ""))].sort();
	return {
		// One per job id, the later end winning (a retry can land on another host); `Infinity` keeps every run, since the
		// window, not a page, bounds this read.
		records: mergeRuns(local.records, mirror.records, { limit: Infinity }),
		// "ok", "off" or "unreachable (<reason>)": a caller that named this Valkey fails on the last.
		mirrorState: mirror.state,
		coverage: {
			source: mirrored ? (localRead ? "mirror+local" : "mirror") : "local",
			reason: reasons.length > 0 ? reasons.join("; ") : null,
			localHost,
			localHosts: hostsOf(local.records),
			local: localRead ? { fromMs: localFromMs } : null,
			mirror: mirrored ? { fromMs: mirror.fromMs, truncated: mirror.truncated, hosts: hostsOf(mirror.records) } : null,
			skipped,
		},
	};
}
