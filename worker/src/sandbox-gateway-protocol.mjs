import { createHash, randomBytes } from "node:crypto";
import { WORKER_NAME_RE } from "./worker-name.mjs";

/** Private control facts only. Neither a console session nor terminal bytes belong in this protocol. */
export const GATEWAY_ID_RE = /^[A-Za-z0-9_-]{43}$/;
export const GATEWAY_HASH_RE = /^[a-f0-9]{64}$/;
export const GATEWAY_PENDING_MS = 300_000;
export const GATEWAY_HANDOFF_MS = 60_000;
export const GATEWAY_GRANT_MS = 60_000;
export const GATEWAY_AUTH_MS = 5_000;
export const GATEWAY_WINDOW_MS = 15_000;
export const GATEWAY_MAX_INTENTS = 256;
export const GATEWAY_STATES = Object.freeze(["pending", "bound", "authorized", "connected", "ended", "revoked"]);
export const GATEWAY_END_REASONS = Object.freeze(["disconnected", "idle", "session-ended", "authorization-unavailable", "sandbox-ended", "runtime-unavailable", "window-lost", "phone", "protocol-error", "backpressure", "audit-unavailable", "gateway-stopped"]);
export const gatewayRandom = () => randomBytes(32).toString("base64url");
export const gatewayHash = (value) => createHash("sha256").update(String(value)).digest("hex");
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const only = (v, fields) => object(v) && Object.keys(v).every((k) => fields.includes(k));
const instant = (v) => Number.isSafeInteger(v) && v >= 0;
const validId = (v) => typeof v === "string" && GATEWAY_ID_RE.test(v) && Buffer.from(v, "base64url").toString("base64url") === v;

export function gatewayOrigin(value) {
	if (typeof value !== "string" || value.length > 2048) return null;
	try {
		const u = new URL(value);
		if (u.hostname.endsWith(".") || u.hostname.endsWith(".docker.internal") || u.hostname.endsWith(".containers.internal")) return null;
		const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || u.hostname.endsWith(".localhost");
		return u.origin === value && !u.username && !u.password && !u.search && !u.hash && (u.protocol === "https:" || u.protocol === "http:" && loopback) ? value : null;
	} catch { return null; }
}
export function distinctGatewayOrigins(gateway, console) {
	return Boolean(gatewayOrigin(gateway) && gatewayOrigin(console) && new URL(gateway).hostname !== new URL(console).hostname);
}
export function cleanGatewayTarget(value) {
	if (!object(value) || !WORKER_NAME_RE.test(value.host ?? "") || /\.(?:json|log)$/i.test(value.host) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value.id ?? "") || !/^[a-f0-9]{32}$/.test(value.nonce ?? "") || !GATEWAY_HASH_RE.test(value.containerId ?? "") || !["local", "podman"].includes(value.venue)) return null;
	return { host: value.host, id: value.id, nonce: value.nonce, containerId: value.containerId, venue: value.venue };
}
function validActor(value) {
	return only(value, ["name", "role", "session"]) && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(value.name ?? "") && value.role === "operator" && /^[a-f0-9]{12}$/.test(value.session ?? "");
}
function validIntent(m) {
	return only(m, ["v", "intentId", "owner", "target", "gatewayOrigin", "consoleOrigin", "theme", "handoffHash", "browserHash", "createdAt", "handoffUntil", "pendingUntil", "grantUntil", "state", "actor", "connectionId", "connectedAt", "endedAt", "reason"]) && m.v === 1 && validId(m.intentId) && validId(m.owner) && cleanGatewayTarget(m.target) && distinctGatewayOrigins(m.gatewayOrigin, m.consoleOrigin) && [null, "light", "dark"].includes(m.theme) && GATEWAY_STATES.includes(m.state) && ["createdAt", "handoffUntil", "pendingUntil"].every((k) => instant(m[k])) && ["handoffHash", "browserHash"].every((k) => m[k] === undefined || GATEWAY_HASH_RE.test(m[k])) && (m.actor === undefined || validActor(m.actor)) && (m.connectionId === undefined || validId(m.connectionId)) && ["grantUntil", "connectedAt", "endedAt"].every((k) => m[k] === undefined || instant(m[k])) && (m.reason === undefined || GATEWAY_END_REASONS.includes(m.reason));
}

// Redis owns expiry and comparisons. Renewals only extend an EXISTING key: a command delayed beyond
// its five-second authority can never recreate it after the browser has already detached.
const PRELUDE = `
local function denied(reason) return cjson.encode({refused=reason}) end
local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
`;
const READ = `${PRELUDE}
local raw=redis.call('GET',KEYS[1]); if not raw then return denied('intent-missing') end
local ok,m=pcall(cjson.decode,raw); if not ok or m.v~=1 then return denied('intent-invalid') end
`;
const answer = `return cjson.encode({ok=true,intent=m})`;
export const GATEWAY_SCRIPTS = Object.freeze({
	time: `${PRELUDE}return now`,
	create: `${PRELUDE}
redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',now)
if redis.call('ZCARD',KEYS[2])>=tonumber(ARGV[5]) then return denied('intent-limit') end
if redis.call('EXISTS',KEYS[1])==1 then return denied('intent-exists') end
local m=cjson.decode(ARGV[1]); m.createdAt=now; m.handoffUntil=now+tonumber(ARGV[2]); m.pendingUntil=now+tonumber(ARGV[3])
redis.call('SET',KEYS[1],cjson.encode(m),'PX',ARGV[3]); redis.call('ZADD',KEYS[2],m.pendingUntil,m.intentId); redis.call('PEXPIRE',KEYS[2],ARGV[3])
${answer}`,
	bind: `${READ}
if m.state~='pending' or now>=m.handoffUntil or now>=m.pendingUntil then return denied('handoff-expired') end
if m.handoffHash~=ARGV[1] or m.gatewayOrigin~=ARGV[3] or m.target.host~=ARGV[4] then return denied('handoff-invalid') end
m.handoffHash=nil; m.browserHash=ARGV[2]; m.state='bound'; redis.call('SET',KEYS[1],cjson.encode(m),'KEEPTTL')
${answer}`,
	authorize: `${READ}
if m.owner~=ARGV[1] or m.state~='bound' or now>=m.pendingUntil then return denied('intent-unavailable') end
local observed=tonumber(ARGV[6]); local deadline=observed+tonumber(ARGV[4]); if observed>now or now>=deadline then return denied('authorization-expired') end
m.actor=cjson.decode(ARGV[2]); m.state='authorized'; m.grantUntil=now+tonumber(ARGV[3]); redis.call('SET',KEYS[1],cjson.encode(m),'PX',ARGV[5]); redis.call('SET',KEYS[2],m.owner,'PXAT',deadline); redis.call('ZADD',KEYS[3],now+tonumber(ARGV[5]),m.intentId); redis.call('PEXPIRE',KEYS[3],ARGV[5])
${answer}`,
	renewAuth: `${READ}
if m.owner~=ARGV[1] or (m.state~='authorized' and m.state~='connected') or (m.state=='authorized' and now>=m.grantUntil) or redis.call('GET',KEYS[2])~=ARGV[1] then return denied('authorization-expired') end
local observed=tonumber(ARGV[4]); local deadline=observed+tonumber(ARGV[2]); if observed>now or now>=deadline then return denied('authorization-expired') end
redis.call('PEXPIREAT',KEYS[2],deadline); redis.call('PEXPIRE',KEYS[1],ARGV[3]); redis.call('ZADD',KEYS[3],now+tonumber(ARGV[3]),m.intentId); redis.call('PEXPIRE',KEYS[3],ARGV[3])
${answer}`,
	revoke: `${READ}
if m.owner~=ARGV[1] then return denied('intent-unavailable') end
m.state='revoked'; m.reason=ARGV[2]; m.endedAt=now; redis.call('DEL',KEYS[2]); redis.call('SET',KEYS[1],cjson.encode(m),'PX',ARGV[3]); redis.call('ZADD',KEYS[3],now+tonumber(ARGV[3]),m.intentId)
${answer}`,
	redeem: `${READ}
if m.state~='authorized' or now>=m.grantUntil or m.browserHash~=ARGV[1] or redis.call('GET',KEYS[2])~=m.owner then return denied('grant-unavailable') end
-- A losing request cannot restore its ticket when another browser already owns this incarnation.
m.state='ended'; m.reason='window-lost'; m.endedAt=now
if redis.call('SET',KEYS[3],ARGV[2],'NX','PX',ARGV[3])==false then redis.call('SET',KEYS[1],cjson.encode(m),'KEEPTTL'); redis.call('DEL',KEYS[2]); return denied('window-busy') end
m.state='connected'; m.reason=nil; m.endedAt=nil; m.connectionId=ARGV[2]; m.connectedAt=now; redis.call('SET',KEYS[1],cjson.encode(m),'KEEPTTL')
return cjson.encode({ok=true,intent=m,authRemainingMs=redis.call('PTTL',KEYS[2])})`,
	renewAttachment: `${READ}
if m.state~='connected' or m.connectionId~=ARGV[1] or m.browserHash~=ARGV[2] or redis.call('GET',KEYS[2])~=m.owner then return denied('authorization-expired') end
if redis.call('GET',KEYS[3])~=ARGV[1] then return denied('window-lost') end
redis.call('PEXPIRE',KEYS[3],ARGV[3])
return cjson.encode({ok=true,intent=m,authRemainingMs=redis.call('PTTL',KEYS[2])})`,
	release: `${READ}
if m.connectionId~=ARGV[1] then return denied('window-lost') end
if redis.call('GET',KEYS[3])==ARGV[1] then redis.call('DEL',KEYS[3]) end
redis.call('DEL',KEYS[2]); if m.state~='revoked' then m.state='ended'; m.reason=ARGV[2]; m.endedAt=now end
redis.call('SET',KEYS[1],cjson.encode(m),'PX',ARGV[3]); redis.call('ZADD',KEYS[4],now+tonumber(ARGV[3]),m.intentId)
${answer}`,
});

export function makeGatewayStore({ redis, timeoutMs = 2_000, prefix = "sandbox-gateway:", pendingMs = GATEWAY_PENDING_MS, handoffMs = GATEWAY_HANDOFF_MS, grantMs = GATEWAY_GRANT_MS, authMs = GATEWAY_AUTH_MS, windowMs = GATEWAY_WINDOW_MS, maxIntents = GATEWAY_MAX_INTENTS } = {}) {
	for (const [n, cap] of [[pendingMs, GATEWAY_PENDING_MS], [handoffMs, GATEWAY_HANDOFF_MS], [grantMs, GATEWAY_GRANT_MS], [authMs, GATEWAY_AUTH_MS], [windowMs, GATEWAY_WINDOW_MS], [maxIntents, GATEWAY_MAX_INTENTS]]) if (!Number.isInteger(n) || n < 1 || n > cap) throw new Error("gateway protocol bounds cannot exceed their contract");
	if (typeof prefix !== "string" || !/^[A-Za-z0-9:_-]{1,100}$/.test(prefix)) throw new Error("invalid gateway key prefix");
	const key = (id) => `${prefix}intent:${id}`;
	const auth = (id) => `${prefix}auth:${id}`;
	const index = `${prefix}intents`;
	const windowKey = (target) => `${prefix}window:${target.host}:${target.containerId}`;
	async function bounded(fn) {
		let timer;
		try { return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("gateway-control-timeout")), timeoutMs); })]); }
		finally { clearTimeout(timer); }
	}
	async function evaluate(script, keys, args) {
		try {
			const raw = await bounded(() => redis.eval(script, keys.length, ...keys, ...args));
			if (typeof raw !== "string" || Buffer.byteLength(raw) > 8192) return { refused: "control-invalid" };
			const result = JSON.parse(raw);
			if (result?.ok === true && validIntent(result.intent)) return result;
			return typeof result?.refused === "string" && /^[a-z-]{1,40}$/.test(result.refused) ? { refused: result.refused } : { refused: "control-invalid" };
		} catch { return { refused: "control-unavailable" }; }
	}
	async function readIntent(intentId) {
		if (!validId(intentId)) return null;
		const raw = await bounded(() => redis.get(key(intentId)));
		if (raw === null) return null;
		if (typeof raw !== "string" || Buffer.byteLength(raw) > 8192) throw new Error("gateway-control-invalid");
		let m; try { m = JSON.parse(raw); } catch { throw new Error("gateway-control-invalid"); }
		if (!validIntent(m) || m.intentId !== intentId) throw new Error("gateway-control-invalid");
		return m;
	}
	const invalid = () => ({ refused: "intent-invalid" });
	const clockOk = (at) => instant(at) && Number.isSafeInteger(at + authMs);
	return {
		readIntent,
		async observeTime() {
			try { const nowMs = await bounded(() => redis.eval(GATEWAY_SCRIPTS.time, 0)); return instant(nowMs) ? { ok: true, nowMs } : { refused: "control-invalid" }; }
			catch { return { refused: "control-unavailable" }; }
		},
		async createIntent(input) {
			if (!only(input, ["intentId", "owner", "handoffHash", "target", "gatewayOrigin", "consoleOrigin", "theme"]) || !validId(input.intentId) || !validId(input.owner) || !GATEWAY_HASH_RE.test(input.handoffHash ?? "") || !cleanGatewayTarget(input.target) || !distinctGatewayOrigins(input.gatewayOrigin, input.consoleOrigin) || ![undefined, null, "light", "dark"].includes(input.theme)) return invalid();
			const m = { v: 1, ...input, target: cleanGatewayTarget(input.target), theme: input.theme ?? null, state: "pending" };
			return evaluate(GATEWAY_SCRIPTS.create, [key(input.intentId), index], [JSON.stringify(m), handoffMs, pendingMs, input.intentId, maxIntents]);
		},
		async bindIntent({ intentId, handoff, browserHash, gatewayOrigin: origin, host } = {}) {
			if (!validId(intentId) || !validId(handoff) || !GATEWAY_HASH_RE.test(browserHash ?? "") || !gatewayOrigin(origin) || !WORKER_NAME_RE.test(host ?? "")) return invalid();
			return evaluate(GATEWAY_SCRIPTS.bind, [key(intentId)], [gatewayHash(handoff), browserHash, origin, host]);
		},
		async authorizeIntent({ intentId, owner, actor, observedAt } = {}) {
			if (!validId(intentId) || !validId(owner) || !validActor(actor) || !clockOk(observedAt)) return invalid();
			return evaluate(GATEWAY_SCRIPTS.authorize, [key(intentId), auth(intentId), index], [owner, JSON.stringify(actor), grantMs, authMs, pendingMs, observedAt]);
		},
		async renewAuthorization({ intentId, owner, observedAt } = {}) {
			if (!validId(intentId) || !validId(owner) || !clockOk(observedAt)) return invalid();
			return evaluate(GATEWAY_SCRIPTS.renewAuth, [key(intentId), auth(intentId), index], [owner, authMs, pendingMs, observedAt]);
		},
		async revoke({ intentId, owner, reason = "session-ended" } = {}) {
			if (!validId(intentId) || !validId(owner) || !GATEWAY_END_REASONS.includes(reason)) return invalid();
			return evaluate(GATEWAY_SCRIPTS.revoke, [key(intentId), auth(intentId), index], [owner, reason, grantMs]);
		},
		async redeem({ intentId, browserHash, connectionId } = {}) {
			if (!validId(intentId) || !validId(connectionId) || !GATEWAY_HASH_RE.test(browserHash ?? "")) return invalid();
			let m; try { m = await readIntent(intentId); } catch { return { refused: "control-unavailable" }; }
			if (!m) return { refused: "intent-missing" };
			return evaluate(GATEWAY_SCRIPTS.redeem, [key(intentId), auth(intentId), windowKey(m.target)], [browserHash, connectionId, windowMs]);
		},
		async renewAttachment({ intentId, connectionId, browserHash } = {}) {
			if (!validId(intentId) || !validId(connectionId) || !GATEWAY_HASH_RE.test(browserHash ?? "")) return invalid();
			let m; try { m = await readIntent(intentId); } catch { return { refused: "control-unavailable" }; }
			if (!m) return { refused: "intent-missing" };
			return evaluate(GATEWAY_SCRIPTS.renewAttachment, [key(intentId), auth(intentId), windowKey(m.target)], [connectionId, browserHash, windowMs]);
		},
		async release({ intentId, connectionId, reason = "disconnected" } = {}) {
			if (!validId(intentId) || !validId(connectionId) || !GATEWAY_END_REASONS.includes(reason)) return invalid();
			let m; try { m = await readIntent(intentId); } catch { return { refused: "control-unavailable" }; }
			if (!m) return { refused: "intent-missing" };
			return evaluate(GATEWAY_SCRIPTS.release, [key(intentId), auth(intentId), windowKey(m.target), index], [connectionId, reason, grantMs]);
		},
	};
}
