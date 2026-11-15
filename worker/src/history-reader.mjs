import { constants, promises as fsPromises } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { recordReadable, recordVersionOf, sanitizeJobId } from "./run-history.mjs";

// Directory handles are cursors, not offsets into a fresh readdir: a new run must not shift every later page.
// No archive is copied or indexed persistently. Idle cursors expire, and every request does bounded file work.
export const HISTORY_PAGE_SIZE = 100;
export const HISTORY_SCAN_SIZE = 400;
export const HISTORY_CURSOR_TTL_MS = 5 * 60_000;
export const HISTORY_CURSORS_MAX = 32;
export const HISTORY_FILE_MAX = 256 * 1024;
export const HISTORY_REQUEST_PREFIX = "history:request:";
export const HISTORY_REPLY_PREFIX = "history:reply:";
export const HISTORY_TOKEN_RE = /^[a-f0-9]{32}$/;
const ID = /^[A-Za-z0-9._:-]{1,200}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PROJECT = /^[a-z][a-z0-9-]{0,31}$/;
const token = () => randomBytes(16).toString("hex");
const instant = (v) => typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;

export function historyQuery(q) {
	if (q && typeof q.id === "string" && ID.test(q.id)) return { id: q.id };
	if (!q || !Number.isSafeInteger(q.start) || !Number.isSafeInteger(q.end) || q.start < 0 || q.end <= q.start || q.end - q.start > 7 * 86_400_000) return null;
	if (q.project != null && (typeof q.project !== "string" || !PROJECT.test(q.project))) return null;
	return { start: q.start, end: q.end, project: q.project ?? null };
}

// Deliberately metadata only. No loaded tool names, transcript, failure text, path or extension data crosses this wire.
export function historyRow(r) {
	if (!r || typeof r.jobId !== "string" || !ID.test(r.jobId) || recordVersionOf(r) === null) return null;
	const readable = recordReadable(r);
	const startedAt = instant(r.startedAt), endedAt = instant(r.endedAt);
	if (startedAt === null && endedAt === null) return null;
	return {
		jobId: r.jobId, startedAt, endedAt,
		project: typeof r.project === "string" && PROJECT.test(r.project) ? r.project : null,
		host: typeof r.host === "string" && NAME.test(r.host) ? r.host : null,
		target: readable && typeof r.target === "string" && r.target.length <= 512 && !/[\x00-\x1f\x7f]/.test(r.target) ? r.target : null,
		outcome: ["completed", "policy", "failed"].includes(r.outcome) ? r.outcome : null,
		reason: readable && typeof r.reason === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(r.reason) ? r.reason : null,
		attempt: Number.isSafeInteger(r.attempt) ? r.attempt : 0,
	};
}

export function makeHistoryReader({ logsDir, fs = fsPromises, now = () => Date.now(), random = token } = {}) {
	const cursors = new Map();
	let opening = 0;
	async function drop(id) { const c = cursors.get(id); cursors.delete(id); try { await c?.dir.close(); } catch {} }
	async function page(query, cursor = null) {
		const q = historyQuery(query);
		if (!q || cursor !== null && !HISTORY_TOKEN_RE.test(cursor)) return { error: "invalid-query" };
		if (q.id) {
			let file;
			try {
				file = await fs.open(join(logsDir, sanitizeJobId(q.id) + ".json"), constants.O_RDONLY | constants.O_NOFOLLOW);
				const st = await file.stat();
				if (!st.isFile() || st.size > HISTORY_FILE_MAX) return { error: "history-unreadable" };
				const buffer = Buffer.alloc(HISTORY_FILE_MAX + 1);
				const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
				if (bytesRead > HISTORY_FILE_MAX) return { error: "history-unreadable" };
				const record = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
				return record.jobId === q.id && historyRow(record) ? { record } : { error: "history-unreadable" };
			} catch (e) { return e?.code === "ENOENT" ? { missing: true } : { error: "history-unreadable" }; }
			finally { await file?.close().catch(() => {}); }
		}
		for (const [id, c] of cursors) if (!c.busy && now() - c.at >= HISTORY_CURSOR_TTL_MS) await drop(id);
		let c = cursor === null ? null : cursors.get(cursor);
		if (cursor !== null && (!c || JSON.stringify(c.query) !== JSON.stringify(q))) return { error: "cursor-expired" };
		if (c?.busy) return { error: "cursor-busy" };
		if (!c) {
			if (cursors.size + opening >= HISTORY_CURSORS_MAX) return { error: "too-many-readers" };
			let dir;
			opening++;
			try { dir = await fs.opendir(logsDir); } catch (e) { return e?.code === "ENOENT" ? { runs: [], next: null, partial: false, olderAt: null } : { error: "history-unreadable" }; } finally { opening--; }
			cursor = random(); c = { dir, query: q, at: now(), busy: false, partial: false, olderAt: null };
			cursors.set(cursor, c);
		}
		c.busy = true;
		const runs = [];
		let done = false;
		try {
			for (let n = 0; n < HISTORY_SCAN_SIZE && runs.length < HISTORY_PAGE_SIZE; n++) {
				const entry = await c.dir.read();
				if (!entry) { done = true; break; }
				if (!entry.isFile() || !/^[A-Za-z0-9._-]+\.json$/.test(entry.name)) continue;
				let file;
				try {
					file = await fs.open(join(logsDir, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW);
					const st = await file.stat();
					if (!st.isFile() || st.size > HISTORY_FILE_MAX) { c.partial = true; continue; }
					// Read at most the cap even if a writer grows a file after fstat.
					const bytes = Buffer.alloc(Math.min(st.size + 1, HISTORY_FILE_MAX + 1));
					const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
					if (bytesRead > HISTORY_FILE_MAX) { c.partial = true; continue; }
					const r = historyRow(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
					if (!r) { c.partial = true; continue; }
					if (q.project !== null && r.project !== q.project) continue;
					const end = r.endedAt ?? r.startedAt, start = r.startedAt ?? end;
					if (end < q.start) c.olderAt = Math.max(c.olderAt ?? 0, end);
					if (start < q.end && end >= q.start) runs.push(r);
				} catch (e) { if (e?.code !== "ENOENT") c.partial = true; }
				finally { await file?.close().catch(() => {}); }
			}
			return { runs, next: done ? null : cursor, partial: c.partial, olderAt: c.olderAt };
		} catch { await drop(cursor); return { error: "history-unreadable" }; }
		finally { c.busy = false; c.at = now(); if (done) await drop(cursor); }
	}
	return { page, async close() { for (const id of cursors.keys()) await drop(id); } };
}

// Pub/sub is a transient read transport over the deployment's existing authenticated Valkey connection.
// It creates no job, key, retained copy or listener on the host's network. Older/offline workers simply do not answer.
export async function serveHistory({ redis, host, reader, timeoutMs = 5000 }) {
	if (!NAME.test(host)) throw new TypeError("invalid history host");
	const sub = redis.duplicate();
	sub.on("error", () => {});
	const channel = HISTORY_REQUEST_PREFIX + host;
	let busy = false;
	const receive = async (from, body) => {
		if (from !== channel || typeof body !== "string" || body.length > 1024) return;
		let m; try { m = JSON.parse(body); } catch { return; }
		if (!m || typeof m !== "object" || !HISTORY_TOKEN_RE.test(m.id ?? "") || !historyQuery(m.query)) return;
		let result;
		if (busy) result = { error: "host-busy" };
		else { busy = true; try { result = await reader.page(m.query, m.cursor ?? null); } catch { result = { error: "history-unreadable" }; } finally { busy = false; } }
		await redis.publish(HISTORY_REPLY_PREFIX + m.id, JSON.stringify(result)).catch(() => {});
	};
	sub.on("message", receive);
	let timer;
	try {
		await Promise.race([sub.subscribe(channel), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("history subscription timed out")), timeoutMs); })]);
	} catch (e) { sub.disconnect(); await reader.close(); throw e; }
	finally { clearTimeout(timer); }
	return { async close() { sub.off("message", receive); sub.disconnect(); await reader.close(); } };
}

export async function readHostHistory({ redis, host, query, cursor = null, timeoutMs = 5000, random = token }) {
	if (!redis || !NAME.test(host) || !historyQuery(query)) return { error: "host-unavailable" };
	const sub = redis.duplicate();
	sub.on("error", () => {});
	const id = random(), channel = HISTORY_REPLY_PREFIX + id;
	let timer;
	try {
		return await new Promise((resolve) => {
			timer = setTimeout(() => resolve({ error: "host-unavailable" }), timeoutMs);
			sub.on("message", (from, body) => {
				if (from !== channel || body.length > HISTORY_FILE_MAX + 1024) return;
				try { const r = JSON.parse(body); resolve(r); } catch { resolve({ error: "history-unreadable" }); }
			});
			sub.subscribe(channel).then(() => redis.publish(HISTORY_REQUEST_PREFIX + host, JSON.stringify({ id, query, cursor }))).catch(() => resolve({ error: "host-unavailable" }));
		});
	} finally { clearTimeout(timer); sub.disconnect(); }
}
