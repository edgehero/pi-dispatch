/**
 * `pi-dispatch status --target <item>` (issue #932): what the queue holds for ONE issue or pull request, for a person or
 * a dispatcher on the worker's host that must know whether asking again would start a job, be joined to one, or be
 * dropped.
 *
 * It reads two things on every queue of the deployment, and never a queued payload (the status command's rule,
 * status-waiting.mjs): the item's semantic windows (`de:<item>:*`, one per flow, each with the job that holds it and
 * when it closes) and the jobs queued, held or running whose stored dedup id names the item (`deid`, two short hash
 * fields per job, never `data`). A window says what a new request for that flow does now: joined to a live job, or
 * dropped against an ended one, which leaves a comment on the item (`duplicate-notice.mjs`). A job whose window has
 * already closed (one held longer than ten minutes, say) is still listed, by its dedup id.
 *
 * What it cannot see, and says: a job queued without a dedup id (a notice, the job a late reply resumes) is not found
 * by its item; a scan cut by its bounds or its time, or a queue that did not answer, makes `complete` false, and then
 * an empty list is not "nothing". Bounded per queue, concurrently, under one time budget. Never throws.
 */
import { JOB_FIELD, jobKeyOf, readSemanticWindowOwner, semanticIdOfKey, semanticWindowItemPatternOf } from "./bullmq-internals.mjs";
import { RECORD_REASON_RE } from "./record-reason.mjs";

/** The states a job that has not ended can be in, running first. */
export const TARGET_STATUS_STATES = Object.freeze(["active", "waiting", "prioritized", "delayed", "paused", "waiting-children"]);
/** Ids read per queue and state, and window keys per queue, before the answer says it is cut. */
export const TARGET_STATUS_IDS_MAX = 1000;
export const TARGET_STATUS_WINDOWS_MAX = 64;
export const TARGET_STATUS_TIMEOUT_MS = 5_000;

const ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const OUTCOMES = new Set(["completed", "policy", "failed"]);
const SCAN_ROUNDS_MAX = 64;

/** What an ended owner's result says, as tokens only: `{ outcome, reason }`, either null when it is not one. */
function outcomeOf(rawResult) {
	let result;
	try { result = JSON.parse(rawResult); } catch { return { outcome: null, reason: null }; }
	return {
		outcome: OUTCOMES.has(result?.outcome) ? result.outcome : null,
		reason: typeof result?.reason === "string" && RECORD_REASON_RE.test(result.reason) ? result.reason : null,
	};
}

async function readQueue(q, item, at) {
	const redis = await q.client;
	const windows = [];
	const jobs = [];
	let complete = true;
	// The windows: SCAN is the one way to list a key family by pattern; bounded in rounds and in keys found.
	const keys = [];
	let cursor = "0";
	let rounds = 0;
	do {
		const [next, batch] = await redis.scan(cursor, "MATCH", semanticWindowItemPatternOf(q, item), "COUNT", 500);
		cursor = String(next);
		for (const key of Array.isArray(batch) ? batch : []) keys.push(key);
		rounds++;
	} while (cursor !== "0" && rounds < SCAN_ROUNDS_MAX && keys.length < TARGET_STATUS_WINDOWS_MAX);
	if (cursor !== "0" || keys.length > TARGET_STATUS_WINDOWS_MAX) complete = false;
	for (const key of [...new Set(keys)].sort().slice(0, TARGET_STATUS_WINDOWS_MAX)) {
		const dedupId = semanticIdOfKey(q, key);
		const owner = await redis.get(key);
		if (dedupId === null || typeof owner !== "string" || !ID_RE.test(owner)) continue; // closed while reading
		const snapshot = await readSemanticWindowOwner(q, dedupId, owner);
		if (snapshot.state === "changed" || snapshot.state === "invalid") continue;
		const ended = snapshot.state === "completed" || snapshot.state === "failed";
		const ownerState = ended ? snapshot.state : await q.getJobState(owner).catch(() => "unknown");
		windows.push({
			queue: q.name,
			slot: dedupId.slice(item.length + 1),
			owner,
			ownerState,
			...(snapshot.state === "completed" ? outcomeOf(snapshot.rawResult) : {}),
			closesAt: Number.isSafeInteger(snapshot.pttlMs) && snapshot.pttlMs >= 0 ? new Date(at + snapshot.pttlMs).toISOString() : null,
			newRequest: ended ? "dropped" : "joined",
		});
	}
	// The jobs: ids state by state, then each one's kind and dedup id in one pipeline, matched on the item's prefix.
	for (const state of TARGET_STATUS_STATES) {
		const ids = (await q.getRanges([state], 0, TARGET_STATUS_IDS_MAX)).filter((id) => typeof id === "string" && ID_RE.test(id));
		if (ids.length > TARGET_STATUS_IDS_MAX) complete = false;
		const page = ids.slice(0, TARGET_STATUS_IDS_MAX);
		if (page.length === 0) continue;
		const pipe = redis.pipeline();
		for (const id of page) pipe.hmget(jobKeyOf(q, id), JOB_FIELD.name, JOB_FIELD.dedupId);
		const got = await pipe.exec();
		page.forEach((id, i) => {
			const [err, fields] = got?.[i] ?? [];
			const dedupId = !err && Array.isArray(fields) && typeof fields[1] === "string" ? fields[1] : null;
			if (dedupId === null || !dedupId.startsWith(`${item}:`)) return;
			jobs.push({ id, queue: q.name, state, kind: typeof fields[0] === "string" && /^[a-z-]{1,32}$/.test(fields[0]) ? fields[0] : null, slot: dedupId.slice(item.length + 1) });
		});
	}
	return { windows, jobs, complete };
}

/**
 * `{ item, jobs, windows, complete, unavailableQueues }` for `item` (`parseSemanticItem`'s spelling) over `queues`.
 * A job is listed once, at the first state it was found in.
 */
export async function readTargetStatus(queues, item, { now = Date.now, timeoutMs = TARGET_STATUS_TIMEOUT_MS } = {}) {
	const at = Number(now());
	const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, TARGET_STATUS_TIMEOUT_MS) : TARGET_STATUS_TIMEOUT_MS;
	const parts = await Promise.all(queues.map(async (q) => {
		let timer;
		try {
			return await Promise.race([
				readQueue(q, item, at),
				new Promise((resolve) => { timer = setTimeout(() => resolve(null), budget); }),
			]);
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
		}
	}));
	const seen = new Set();
	const jobs = [];
	for (const part of parts) for (const job of part?.jobs ?? []) {
		const key = `${job.queue}\u0000${job.id}`;
		if (!seen.has(key)) { seen.add(key); jobs.push(job); }
	}
	const unavailableQueues = queues.filter((_, i) => parts[i] === null).map((q) => q.name);
	return {
		item,
		jobs,
		windows: parts.flatMap((part) => part?.windows ?? []),
		complete: unavailableQueues.length === 0 && parts.every((part) => part === null || part.complete),
		unavailableQueues,
	};
}
