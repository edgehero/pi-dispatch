import { createHash, randomBytes } from "node:crypto";
import { WORKER_NAME_RE } from "./worker-name.mjs";

/** Operator-private observations, never authority over a job or a reusable container name (#771). */
export const SANDBOX_SESSION_TTL_MS = 45_000;
export const SANDBOX_SESSION_POLL_MS = 1_000;
export const SANDBOX_SESSION_MAX = 256;
export const SANDBOX_SESSION_INDEX = "sandbox:shells";
export const SANDBOX_NOTICE_INDEX = "sandbox:notices";
export const SANDBOX_NOTICE_TTL_MS = 86_400_000;
export const SANDBOX_SESSION_LABEL = "org.pi-dispatch.sandbox-session";
export const SANDBOX_SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const nonceRe = /^[a-f0-9]{32}$/;
const containerRe = /^[a-f0-9]{64}$/;
const memberRe = /^[A-Za-z0-9._-]{1,64}:[a-f0-9]{64}$/;
const instant = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 8_640_000_000_000_000;
const digest = (id) => createHash("sha256").update(id).digest("hex");
export const sandboxSessionMember = (host, id) => `${host}:${digest(id)}`;
export const sandboxSessionKey = (host, id) => `sandbox:shell:${sandboxSessionMember(host, id)}`;
export const sandboxNoticeKey = (host, id) => `sandbox:notice:${sandboxSessionMember(host, id)}`;
export const sandboxEndKey = (nonce) => `sandbox:end:${nonce}`;
export const sandboxEndAckKey = (nonce, requestId) => `sandbox:ended:${nonce}:${requestId}`;

export function parseSandboxSession(raw) {
	let s;
	try { s = typeof raw === "string" && raw.length <= 4096 ? JSON.parse(raw) : raw; } catch { return null; }
	if (!s || ["host", "id", "nonce", "containerId", "venue", "by"].some((k) => typeof s[k] !== "string") || s.v !== 1 || !WORKER_NAME_RE.test(s.host) || !SANDBOX_SESSION_ID_RE.test(s.id) || !nonceRe.test(s.nonce) || !containerRe.test(s.containerId) || !["local", "podman"].includes(s.venue) || !/^[A-Za-z0-9._@-]{1,64}$/.test(s.by) || !instant(s.since) || !instant(s.at) || s.at < s.since) return null;
	return { v: 1, host: s.host, id: s.id, nonce: s.nonce, containerId: s.containerId, venue: s.venue, by: s.by, since: s.since, at: s.at };
}

export function sandboxSessionAccount(name) {
	return typeof name === "string" && /^[A-Za-z0-9._@-]{1,64}$/.test(name) ? name : "operator";
}

export function sandboxBounded(promise, ms = 2_000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("sandbox control timed out")), ms);
		Promise.resolve(promise).then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
	});
}

// A delayed renew/delete must never replace or erase the next shell's lease.
const RENEW = `local raw=redis.call('GET',KEYS[1]); if raw then local ok,s=pcall(cjson.decode,raw); if not ok or s.nonce~=ARGV[1] or s.containerId~=ARGV[2] then return 0 end end; redis.call('SET',KEYS[1],ARGV[3],'PX',ARGV[4]); local t=redis.call('TIME'); local at=t[1]*1000+math.floor(t[2]/1000); redis.call('ZADD',KEYS[2],at+tonumber(ARGV[4]),ARGV[5]); redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',at-tonumber(ARGV[4])); return 1`;
const RELEASE = `local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end; local ok,s=pcall(cjson.decode,raw); if not ok or s.nonce~=ARGV[1] or s.containerId~=ARGV[2] then return 0 end; return redis.call('DEL',KEYS[1])`;
const REMOVE_REQUEST = `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0`;

export async function renewSandboxSession(redis, session, { now = Date.now, ttlMs = SANDBOX_SESSION_TTL_MS, timeoutMs = 2_000 } = {}) {
	const value = parseSandboxSession({ ...session, v: 1, at: now() });
	if (!value) throw new Error("invalid sandbox session");
	const owned = await sandboxBounded(redis.eval(RENEW, 2, sandboxSessionKey(value.host, value.id), SANDBOX_SESSION_INDEX, value.nonce, value.containerId, JSON.stringify(value), String(ttlMs), sandboxSessionMember(value.host, value.id)), timeoutMs);
	if (owned !== 1) return false;
	return true;
}

async function redisNow(redis, timeoutMs = 2_000) {
	const value = await sandboxBounded(redis.time(), timeoutMs);
	if (!Array.isArray(value) || value.length !== 2 || !/^\d+$/.test(value[0]) || !/^\d+$/.test(value[1])) throw new Error("the sandbox lease clock is unreadable");
	const at = Number(value[0]) * 1000 + Math.floor(Number(value[1]) / 1000);
	if (!instant(at)) throw new Error("the sandbox lease clock is invalid");
	return at;
}

export async function releaseSandboxSession(redis, session, { timeoutMs = 2_000 } = {}) {
	return sandboxBounded(redis.eval(RELEASE, 1, sandboxSessionKey(session.host, session.id), session.nonce, session.containerId), timeoutMs);
}

export async function publishSandboxNotice(redis, { host, id, reason }, { now = Date.now } = {}) {
	if (!WORKER_NAME_RE.test(host ?? "") || !SANDBOX_SESSION_ID_RE.test(id ?? "") || !["network-kept", "network-cleanup-failed", "runtime-unreadable"].includes(reason)) throw new Error("invalid sandbox notice");
	const at = now();
	const serverAt = await redisNow(redis);
	await sandboxBounded(redis.set(sandboxNoticeKey(host, id), JSON.stringify({ host, id, at, reason }), "PX", SANDBOX_NOTICE_TTL_MS));
	await sandboxBounded(redis.zadd(SANDBOX_NOTICE_INDEX, serverAt + SANDBOX_NOTICE_TTL_MS, sandboxSessionMember(host, id)));
	await sandboxBounded(redis.zremrangebyscore(SANDBOX_NOTICE_INDEX, "-inf", serverAt));
}

async function readNotices(redis, { now, timeoutMs, hosts }) {
	const members = await sandboxBounded(redis.zrangebyscore(SANDBOX_NOTICE_INDEX, now(), "+inf", "LIMIT", 0, SANDBOX_SESSION_MAX + 1), timeoutMs);
	if (!Array.isArray(members)) throw new Error("unreadable notices");
	const wanted = members.slice(0, SANDBOX_SESSION_MAX).filter((m) => memberRe.test(m) && (!hosts.length || hosts.some((h) => m.startsWith(`${h}:`))));
	const values = wanted.length ? await sandboxBounded(redis.mget(...wanted.map((m) => `sandbox:notice:${m}`)), timeoutMs) : [];
	if (!Array.isArray(values)) throw new Error("unreadable sandbox notice values");
	let unreadable = values.length !== wanted.length;
	const notices = values.flatMap((raw, i) => {
		try {
			if (raw === null) return [];
			if (typeof raw !== "string" || raw.length > 1024) { unreadable = true; return []; }
			const n = JSON.parse(raw);
			if (typeof n?.host !== "string" || !WORKER_NAME_RE.test(n.host) || typeof n.id !== "string" || !SANDBOX_SESSION_ID_RE.test(n.id) || !instant(n.at) || !["network-kept", "network-cleanup-failed", "runtime-unreadable"].includes(n.reason) || sandboxSessionMember(n.host, n.id) !== wanted[i]) { unreadable = true; return []; }
			return [{ host: n.host, id: n.id, at: n.at, reason: n.reason }];
		} catch { unreadable = true; return []; }
	});
	return { notices, partial: members.length > SANDBOX_SESSION_MAX || unreadable };
}

/** The console reads only these bounded keys; an unreachable read is never an invented empty list. */
export async function readSandboxSessions(redis, { hosts = [], now = Date.now, timeoutMs = 2_000 } = {}) {
	try {
		const serverAt = await redisNow(redis, timeoutMs);
		const raw = await sandboxBounded(redis.zrangebyscore(SANDBOX_SESSION_INDEX, serverAt, "+inf", "LIMIT", 0, SANDBOX_SESSION_MAX + 1), timeoutMs);
		if (!Array.isArray(raw)) throw new Error("unreadable index");
		const members = [...new Set(raw.filter((m) => typeof m === "string" && memberRe.test(m) && (!hosts.length || hosts.some((h) => m.startsWith(`${h}:`)))))].sort();
		const wanted = members.slice(0, SANDBOX_SESSION_MAX);
		const values = wanted.length ? await sandboxBounded(redis.mget(...wanted.map((m) => `sandbox:shell:${m}`)), timeoutMs) : [];
		if (!Array.isArray(values) || values.length !== wanted.length) throw new Error("unreadable leases");
		const sessions = [];
		let unreadable = 0;
		for (const [i, value] of values.entries()) {
			if (value === null) continue;
			const s = parseSandboxSession(value);
			if (!s || sandboxSessionMember(s.host, s.id) !== wanted[i]) { unreadable++; continue; }
			// Key existence/TTL is the lease. Host and console clocks can disagree by more than its lifetime.
			sessions.push(s);
		}
		let notices = [], noticesUnavailable = false;
		try { const read = await readNotices(redis, { now: () => serverAt, timeoutMs, hosts }); notices = read.notices; noticesUnavailable = read.partial; } catch { noticesUnavailable = true; }
		return { sessions: sessions.sort((a, b) => a.since - b.since), more: Math.max(0, raw.length - SANDBOX_SESSION_MAX, members.length - wanted.length), unreadable, notices, ...(noticesUnavailable ? { noticesUnavailable: true } : {}) };
	} catch { return { sessions: [], unreachable: true }; }
}

/** End is an attended request for ONE immutable container, never a name that can be reused. */
export async function requestSandboxEnd({ redis, host, id, nonce, containerId, now = Date.now, ackTimeoutMs = 10_000, pollMs = 250, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 2_000, random = () => randomBytes(16).toString("hex") }) {
	if ([host, id, nonce, containerId].some((v) => typeof v !== "string") || !WORKER_NAME_RE.test(host) || !SANDBOX_SESSION_ID_RE.test(id) || !nonceRe.test(nonce) || !containerRe.test(containerId)) return { refused: "invalid-session", message: "The sandbox session is invalid; reload its current state." };
	const current = parseSandboxSession(await sandboxBounded(redis.get(sandboxSessionKey(host, id)), timeoutMs));
	if (!current || current.nonce !== nonce || current.containerId !== containerId) return { refused: "session-changed", message: "The sandbox session ended or changed; reload before asking to end it." };
	const requestId = random();
	if (!nonceRe.test(requestId)) throw new Error("invalid sandbox End request identity");
	const value = JSON.stringify({ host, id, nonce, containerId, requestId });
	await sandboxBounded(redis.set(sandboxEndKey(nonce), value, "PX", Math.max(ackTimeoutMs + 5_000, 15_000)), timeoutMs);
	for (let elapsed = 0; ; elapsed += pollMs) {
		const ack = await sandboxBounded(redis.get(sandboxEndAckKey(nonce, requestId)), timeoutMs);
		if (ack === "ended") return { ended: true };
		if (ack === "stop-failed") return { refused: "stop-failed", message: "The runtime did not confirm this sandbox stopped. Check its terminal and reload." };
		if (elapsed + pollMs > ackTimeoutMs) break;
		await sleep(pollMs);
	}
	await sandboxBounded(redis.eval(REMOVE_REQUEST, 1, sandboxEndKey(nonce), value), timeoutMs).catch(() => {});
	return { timeout: true };
}

/** One monitor tick, injected so identity races, outages and stop failures are exercised without a daemon. */
export async function sandboxSessionTick({ redis, session, inspect, stop, now = Date.now }) {
	const state = await inspect(session.containerId);
	if (state.unknown) return { unknown: true };
	if (!state.present) {
		await releaseSandboxSession(redis, session);
		return { gone: true };
	}
	if (state.containerId !== session.containerId || state.nonce !== session.nonce) return { refused: "container-changed" };
	if (!await renewSandboxSession(redis, session, { now })) return { refused: "lease-changed" };
	const raw = await sandboxBounded(redis.get(sandboxEndKey(session.nonce)));
	let request;
	try { request = JSON.parse(raw); } catch { return { live: true }; }
	if (!request || !nonceRe.test(request.requestId ?? "") || ["host", "id", "nonce", "containerId"].some((k) => request[k] !== session[k])) return { live: true };
	const stopped = await stop(session.containerId);
	const after = await inspect(session.containerId);
	const ended = stopped && !after.unknown && !after.present;
	await sandboxBounded(redis.set(sandboxEndAckKey(session.nonce, request.requestId), ended ? "ended" : "stop-failed", "PX", 60_000));
	await sandboxBounded(redis.eval(REMOVE_REQUEST, 1, sandboxEndKey(session.nonce), raw));
	if (ended) { await releaseSandboxSession(redis, session); return { gone: true, ended: true }; }
	return { live: true, stopFailed: true };
}
