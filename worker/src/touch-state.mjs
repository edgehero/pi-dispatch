import { createHash } from "node:crypto";
import { normalize } from "node:path";

/** Closed human-intervention facts. Text belongs to the run's private transcript, never this index. */
export const TOUCH_CAUSES = Object.freeze(["question-answer", "approval-decision", "rerun", "config-fix", "steer", "cancel"]);
export const TOUCH_INDEX = "touch:index";
export const TOUCH_META = "touch:meta";
export const TOUCH_PENDING = "touch:pending";
export const TOUCH_MAX_EVENTS = 30_000;
export const TOUCH_MAX_RETENTION_DAYS = 365;
const ID = /^[A-Za-z0-9._:-]{1,200}$/;
const HASH = /^[a-f0-9]{64}$/;
const PROJECT = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const TARGET = /^[A-Za-z0-9._:/#! -]{1,300}$/;
const ms = (v) => Number.isSafeInteger(v) && v >= 0;
const digest = (v) => createHash("sha256").update(v).digest("hex");
export const touchEventKey = (id) => `touch:event:${id}`;
export const touchTtlMs = (retentionDays = 30) => (Number(retentionDays) > 0 ? Math.min(Number(retentionDays), TOUCH_MAX_RETENTION_DAYS) : TOUCH_MAX_RETENTION_DAYS) * 86400_000;

/** An opaque host-authored identity keeps local folders with the same basename apart without recording a path. */
export function touchScopeOf(job, host = null) {
	const data = job?.data ?? job ?? {};
	if (HASH.test(data.touchScopeId ?? "")) return data.touchScopeId;
	if (data.kind === "local" || data.folder) return digest(`local\0${host ?? ""}\0${typeof data.folder === "string" ? normalize(data.folder) : ""}`);
	return digest(`${data.kind ?? "unknown"}\0${data.baseUrl ?? data.host ?? ""}\0${data.repo ?? data.repository ?? ""}`);
}

/** Rebuild, never spread: even an invalid optional field refuses the event rather than carrying arbitrary text. */
export function cleanTouch(value) {
	if (!value || typeof value !== "object" || Array.isArray(value) || !ID.test(value.runId ?? "") || !ms(value.at)) return null;
	if (value.type !== undefined && !["stop", "touch"].includes(value.type)) return null;
	if (value.type !== "stop" && !TOUCH_CAUSES.includes(value.cause)) return null;
	if (value.answerSource !== undefined && !["forge", "console", "panel", "draft"].includes(value.answerSource)) return null;
	if (value.draftRunId !== undefined && !ID.test(value.draftRunId)) return null;
	if (value.scopeId !== undefined && value.scopeId !== null && !HASH.test(value.scopeId)) return null;
	if (value.project !== undefined && value.project !== null && !PROJECT.test(value.project)) return null;
	if (value.target !== undefined && value.target !== null && !TARGET.test(value.target)) return null;
	for (const key of ["endedAt", "parkedAt", "receivedAt"]) if (value[key] !== undefined && value[key] !== null && !ms(value[key])) return null;
	const type = value.type === "stop" ? "stop" : "touch";
	const id = HASH.test(value.id ?? "") ? value.id : digest(`${type}\0${value.runId}\0${value.cause ?? ""}\0${value.nonce ?? value.at}`);
	return { v: 1, id, type, runId: value.runId, ...(type === "touch" ? { cause: value.cause } : {}), at: value.at,
		...(value.scopeId ? { scopeId: value.scopeId } : {}), ...(value.project ? { project: value.project } : {}),
		...(value.target ? { target: value.target } : {}), ...(value.answerSource ? { answerSource: value.answerSource } : {}), ...(value.draftRunId ? { draftRunId: value.draftRunId } : {}), ...Object.fromEntries(["endedAt", "parkedAt", "receivedAt"].filter((k) => ms(value[k])).map((k) => [k, value[k]])) };
}

const INIT = `
if redis.call("EXISTS", KEYS[1]) == 0 then redis.call("HSET", KEYS[1], "since", ARGV[1]) end
redis.call("PEXPIRE", KEYS[1], ARGV[2])
return 1
`;
const WRITE = `
if redis.call("EXISTS", KEYS[2]) == 0 or (redis.call("EXISTS", KEYS[1]) == 0 and redis.call("HGET", KEYS[2], "indexed") == "1") then
 redis.call("DEL", KEYS[2]); redis.call("HSET", KEYS[2], "since", ARGV[1])
end
local added = redis.call("SET", KEYS[3], ARGV[4], "NX", "PX", ARGV[3])
redis.call("ZADD", KEYS[1], ARGV[2], ARGV[5])
redis.call("HSET", KEYS[2], "indexed", "1")
local aged = redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", "(" .. ARGV[6])
if aged > 0 then local prior = tonumber(redis.call("HGET", KEYS[2], "horizon") or "0"); redis.call("HSET", KEYS[2], "horizon", math.max(prior, tonumber(ARGV[6]))) end
local n = redis.call("ZCARD", KEYS[1])
if n > tonumber(ARGV[7]) then
 local removed = redis.call("ZRANGE", KEYS[1], 0, n-tonumber(ARGV[7])-1, "WITHSCORES")
 if #removed > 0 then local prior = tonumber(redis.call("HGET", KEYS[2], "horizon") or "0"); redis.call("HSET", KEYS[2], "horizon", math.max(prior, tonumber(removed[#removed]))) end
 redis.call("ZREMRANGEBYRANK", KEYS[1], 0, n-tonumber(ARGV[7])-1)
end
redis.call("PEXPIRE", KEYS[1], ARGV[3]); redis.call("PEXPIRE", KEYS[2], ARGV[3])
redis.call("HDEL", KEYS[4], ARGV[5])
return added and 1 or 0
`;
const READ = `return {redis.call("HGETALL", KEYS[1]), redis.call("ZRANGE", KEYS[2], 0, -1), redis.call("HLEN", KEYS[3]), redis.call("EXISTS", KEYS[2])}`;
export const TOUCH_SCRIPTS = Object.freeze({ INIT, WRITE, READ });

function bounded(task, timeoutMs) {
	let timer;
	return Promise.race([Promise.resolve().then(task), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("touch-timeout")), timeoutMs); })]).finally(() => clearTimeout(timer));
}

/** Shared by every producer. Unknown or unavailable tracking is a named state; it never becomes zero touches. */
export function makeTouchStore({ redis, now = Date.now, retentionDays = 30, timeoutMs = 2000, prefix = "" } = {}) {
	const ttl = touchTtlMs(retentionDays);
	const key = (name) => `${prefix}${name}`;
	return {
		async initialize() {
			try { await bounded(() => redis.eval(INIT, 1, key(TOUCH_META), now(), ttl), timeoutMs); return { ok: true }; } catch { return { error: "touch-index-unavailable" }; }
		},
		async begin(value) {
			const event = cleanTouch(value);
			if (!event) return { error: "touch-event-invalid" };
			try { await bounded(() => redis.hset(key(TOUCH_PENDING), event.id, event.at), timeoutMs); await bounded(() => redis.pexpire(key(TOUCH_PENDING), ttl), timeoutMs); return { ok: true, event }; } catch { return { error: "touch-index-unavailable", event }; }
		},
		async abort(value) {
			const event = cleanTouch(value);
			if (!event) return { error: "touch-event-invalid" };
			try { await bounded(() => redis.hdel(key(TOUCH_PENDING), event.id), timeoutMs); return { ok: true }; } catch { return { error: "touch-index-unavailable" }; }
		},
		async write(value) {
			const event = cleanTouch(value);
			if (!event) return { error: "touch-event-invalid" };
			try {
				const added = await bounded(() => redis.eval(WRITE, 4, key(TOUCH_INDEX), key(TOUCH_META), key(touchEventKey(event.id)), key(TOUCH_PENDING), now(), event.at, ttl, JSON.stringify(event), event.id, now() - ttl, TOUCH_MAX_EVENTS), timeoutMs);
				return { ok: true, added: added === 1, event };
			} catch { return { error: "touch-index-unavailable" }; }
		},
		async read() {
			try {
				const raw = await bounded(() => redis.eval(READ, 3, key(TOUCH_META), key(TOUCH_INDEX), key(TOUCH_PENDING)), timeoutMs);
				if (!Array.isArray(raw) || !Array.isArray(raw[0]) || !Array.isArray(raw[1])) return { events: [], coverage: { fromMs: now(), partial: true, reasons: ["touch-index-unavailable"] } };
				const meta = Object.fromEntries(raw[0].reduce((xs, x, i, all) => i % 2 === 0 ? [...xs, [x, all[i + 1]]] : xs, []));
				const since = Number(meta.since);
				const reasons = [];
				if (!ms(since)) reasons.push("touch-tracking-not-started");
				// A surviving epoch cannot vouch for an index that was lost. Diagnose it at READ time, before
				// the next touch repairs the epoch; otherwise an idle fleet falsely reads the missing events as zero.
				const indexMissing = meta.indexed === "1" && Number(raw[3]) !== 1;
				if (indexMissing) reasons.push("touch-index-lost");
				const unresolved = Number(raw[2]) > 0;
				if (unresolved) reasons.push("touch-actions-unresolved");
				const events = [];
				let missingAt = 0;
				for (let offset = 0; offset < raw[1].length; offset += 500) {
					const rows = await bounded(() => redis.mget(...raw[1].slice(offset, offset + 500).map((id) => key(touchEventKey(id)))), timeoutMs);
					for (const body of rows) {
						let event; try { event = cleanTouch(JSON.parse(body)); } catch {}
						if (event) events.push(event); else missingAt = now();
					}
				}
				if (missingAt) reasons.push("touch-events-missing");
				return { events, coverage: { fromMs: Math.max(ms(since) ? since : now(), Number(meta.horizon) || 0, now() - ttl, missingAt, indexMissing || unresolved ? now() : 0), partial: reasons.length > 0, reasons } };
			} catch { return { events: [], coverage: { fromMs: now(), partial: true, reasons: ["touch-index-unavailable"] } }; }
		},
	};
}
