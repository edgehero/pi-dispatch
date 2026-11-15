import { QUEUE_KEY, dueOfScore, queueKeyOf } from "./bullmq-internals.mjs";
import { DEFER_FIELDS, DEFER_ID_RE, WAITING_DUE_GRACE_MS, deferKey, parseDefer, recordMatchesDue } from "./defer-reasons.mjs";

export const STATUS_WAITING_QUEUES_MAX = 64;
export const STATUS_WAITING_PER_QUEUE_MAX = 100;
export const STATUS_WAITING_TIMEOUT_MS = 2_000;

/**
 * CLI status reads delayed membership and the worker's own explanation, never a queued payload. Counts still come
 * from the queue; these bounded rows explain only the portion inspected. An unanswered read stays explicitly unknown.
 * Each queue gets the same concurrent time budget, including obtaining its client, so a late first response cannot
 * start an unbounded second read after status has returned.
 */
export async function readStatusWaiting(queues, { now = Date.now, perQueue = STATUS_WAITING_PER_QUEUE_MAX, timeoutMs = STATUS_WAITING_TIMEOUT_MS } = {}) {
	const bound = Number.isInteger(perQueue) && perQueue > 0 ? Math.min(perQueue, STATUS_WAITING_PER_QUEUE_MAX) : STATUS_WAITING_PER_QUEUE_MAX;
	const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, STATUS_WAITING_TIMEOUT_MS) : STATUS_WAITING_TIMEOUT_MS;
	const at = Number(now());
	const selected = queues.slice(0, STATUS_WAITING_QUEUES_MAX);
	const skippedQueues = Math.max(0, queues.length - selected.length);
	const parts = await Promise.all(selected.map(async (q) => {
		let timer;
		let active = true;
		const unavailable = { rows: [], unavailable: true, truncated: false, invalid: 0 };
		try {
			const read = async () => {
				if (!Number.isSafeInteger(at)) return unavailable;
				const redis = await q.client;
				if (!active) return unavailable;
				const members = await redis.zrange(queueKeyOf(q, QUEUE_KEY.delayed), 0, bound, "WITHSCORES");
				if (!active || !Array.isArray(members)) return unavailable;
				const rows = [];
				let invalid = 0;
				for (let i = 0; i < Math.min(members.length, bound * 2); i += 2) {
					const jobId = members[i], dueAt = dueOfScore(members[i + 1]);
					if (typeof jobId !== "string" || !DEFER_ID_RE.test(jobId) || dueAt === null) { invalid++; continue; }
					rows.push({ jobId, queue: q.name, dueAt });
				}
				const result = { rows, unavailable: false, truncated: members.length > bound * 2, invalid };
				if (rows.length === 0) return result;
				let replies;
				try { replies = await redis.pipeline(rows.map((row) => ["hmget", deferKey(row.jobId), ...DEFER_FIELDS])).exec(); }
				catch { replies = null; }
				for (let i = 0; i < rows.length; i++) {
					const row = rows[i], reply = replies?.[i];
					if (!Array.isArray(reply) || reply[0] || !Array.isArray(reply[1])) {
						row.unavailable = true;
						result.unavailable = true;
						continue;
					}
					const parsed = parseDefer(reply[1]);
					const record = recordMatchesDue(parsed, row.dueAt) ? parsed : null;
					row.bucket = row.dueAt < at - WAITING_DUE_GRACE_MS ? "due" : record?.bucket ?? "none";
					row.why = record?.why ?? null;
					row.until = record?.until ?? null;
				}
				return result;
			};
			return await Promise.race([
				read(),
				new Promise((resolve) => { timer = setTimeout(() => resolve(unavailable), timeout); }),
			]);
		} catch { return unavailable; }
		finally { active = false; clearTimeout(timer); }
	}));
	const unavailableQueues = selected.filter((_, i) => parts[i].unavailable).map((q) => q.name);
	const truncated = skippedQueues > 0 || parts.some((part) => part.truncated);
	const invalidEntries = parts.reduce((sum, part) => sum + part.invalid, 0);
	return {
		rows: parts.flatMap((part) => part.rows),
		partial: truncated || unavailableQueues.length > 0 || invalidEntries > 0,
		truncated,
		skippedQueues,
		unavailableQueues,
		invalidEntries,
	};
}
