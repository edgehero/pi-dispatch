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
export const GATEWAY_MAX_WATCHERS = 3;
export const GATEWAY_RUN_OUTCOMES = Object.freeze(["completed", "refused", "failed", "awaiting-input", "awaiting-approval", "cancelled"]);
export const GATEWAY_STATES = Object.freeze(["pending", "bound", "authorized", "connected", "ended", "revoked"]);
export const GATEWAY_END_REASONS = Object.freeze(["disconnected", "idle", "session-ended", "authorization-unavailable", "sandbox-ended", "runtime-unavailable", "window-lost", "phone", "protocol-error", "backpressure", "audit-unavailable", "gateway-stopped", "watch-disabled", "watch-removed", "driver-ended"]);
export const gatewayRandom = () => randomBytes(32).toString("base64url");
export const gatewayHash = (value) => createHash("sha256").update(String(value)).digest("hex");
export const gatewaySessionKey = (sessionId) => gatewayHash(`sandbox-workbench-session\0${sessionId}`);
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
export function gatewayTargetKey(target) {
	return cleanGatewayTarget(target) ? gatewayHash(JSON.stringify([target.host, target.venue, target.containerId, target.nonce])) : null;
}
export function validGatewayRunFacts(v) {
	if (v === null) return true;
	return only(v, ["id", "outcome", "project", "target", "flow", "endedAt"]) && Object.keys(v).length === 6 &&
		/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(v.id ?? "") && GATEWAY_RUN_OUTCOMES.includes(v.outcome) &&
		(v.project === null || /^[a-z0-9][a-z0-9-]{0,31}$/.test(v.project ?? "")) &&
		(v.target === null || typeof v.target === "string" && /^[A-Za-z0-9._:/#! -]{1,300}$/.test(v.target)) &&
		(v.flow === null || /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.test(v.flow ?? "")) &&
		(v.endedAt === null || typeof v.endedAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.endedAt) && Number.isFinite(Date.parse(v.endedAt)) && new Date(Date.parse(v.endedAt)).toISOString() === v.endedAt);
}
const driverRef = v => only(v, ["intentId", "connectionId", "epoch"]) && Object.keys(v).length === 3 && [v.intentId, v.connectionId, v.epoch].every(validId);
const integer = v => Number.isSafeInteger(v) && v >= 0;
const storedTarget = v => only(v, ["host", "id", "nonce", "containerId", "venue"]) && Boolean(cleanGatewayTarget(v));
function validRoom(r) {
	if (!only(r, ["v", "target", "driverIntentId", "driverConnectionId", "driverActor", "sessionKey", "gatewayOrigin", "consoleOrigin", "enabled", "epoch", "geometry", "rosterRevision", "seenRosterRevision", "watchers"]) || r.v !== 2 || !storedTarget(r.target) || !validId(r.driverIntentId) || !validId(r.driverConnectionId) || !validActor(r.driverActor) || !GATEWAY_HASH_RE.test(r.sessionKey ?? "") || !distinctGatewayOrigins(r.gatewayOrigin, r.consoleOrigin) || typeof r.enabled !== "boolean" || (r.enabled ? !validId(r.epoch) : r.epoch !== null) || !only(r.geometry, ["cols", "rows", "revision"]) || !Number.isInteger(r.geometry.cols) || r.geometry.cols < 2 || r.geometry.cols > 500 || !Number.isInteger(r.geometry.rows) || r.geometry.rows < 1 || r.geometry.rows > 200 || !integer(r.geometry.revision) || !integer(r.rosterRevision) || !integer(r.seenRosterRevision) || r.seenRosterRevision > r.rosterRevision || !object(r.watchers) || Object.keys(r.watchers).length > GATEWAY_MAX_WATCHERS) return false;
	return Object.entries(r.watchers).every(([id, w]) => validId(id) && only(w, ["watcherKey", "actor", "connectionId", "registeredRevision", "expiresAt", "state"]) && w.watcherKey === gatewayHash(id) && validActor(w.actor) && (w.connectionId === null || validId(w.connectionId)) && integer(w.registeredRevision) && w.registeredRevision <= r.rosterRevision && instant(w.expiresAt) && ["pending", "watching"].includes(w.state));
}
function validIntent(m) {
	return only(m, ["v", "intentId", "owner", "sessionKey", "kind", "runFacts", "driver", "driverReady", "receiptHash", "removed", "target", "gatewayOrigin", "consoleOrigin", "theme", "handoffHash", "browserHash", "createdAt", "handoffUntil", "pendingUntil", "grantUntil", "state", "actor", "connectionId", "connectedAt", "endedAt", "reason"]) && m.v === 2 && validId(m.intentId) && validId(m.owner) && GATEWAY_HASH_RE.test(m.sessionKey ?? "") && ["drive", "watch"].includes(m.kind) && validGatewayRunFacts(m.runFacts) && (m.runFacts === null || m.runFacts.id === m.target?.id) && (m.kind === "watch" ? driverRef(m.driver) : m.driver === undefined) && (m.driverReady === undefined || m.kind === "drive" && m.driverReady === true) && storedTarget(m.target) && distinctGatewayOrigins(m.gatewayOrigin, m.consoleOrigin) && [null, "light", "dark"].includes(m.theme) && GATEWAY_STATES.includes(m.state) && ["createdAt", "handoffUntil", "pendingUntil"].every((k) => instant(m[k])) && ["handoffHash", "browserHash"].every((k) => m[k] === undefined || GATEWAY_HASH_RE.test(m[k])) && (m.actor === undefined || validActor(m.actor)) && (m.connectionId === undefined || validId(m.connectionId)) && ["grantUntil", "connectedAt", "endedAt"].every((k) => m[k] === undefined || instant(m[k])) && (m.reason === undefined || GATEWAY_END_REASONS.includes(m.reason));
}

// Redis owns expiry and comparisons. Renewals only extend an EXISTING key: a command delayed beyond
// its five-second authority can never recreate it after the browser has already detached.
const PRELUDE = `
local function denied(reason) return cjson.encode({refused=reason}) end
local t=redis.call('TIME'); local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
local prefix=ARGV[9]
local function decoded(key)
 local raw=redis.call('GET',key); if not raw then return nil end
 local ok,v=pcall(cjson.decode,raw); if not ok then error('invalid control value') end; return v
end
local function roomKey(target) return prefix..'room:'..target.host..':'..target.containerId end
local function windowKey(target) return prefix..'window:'..target.host..':'..target.containerId end
local function watchWindow(m) return prefix..'watch-window:'..m.target.host..':'..m.target.containerId..':'..m.sessionKey..':'..m.driver.connectionId..':'..m.driver.epoch end
local function roomFor(target) local r=decoded(roomKey(target)); if r and r.v~=2 then error('invalid room version') end; return r end
local function sameTarget(a,b)
 return a.host==b.host and a.id==b.id and a.containerId==b.containerId and a.nonce==b.nonce and a.venue==b.venue
end
local function driverRemaining(r)
 if not r then return 0 end
 local d=decoded(prefix..'intent:'..r.driverIntentId)
 if not d or d.v~=2 or d.kind~='drive' or d.state~='connected' or not d.driverReady or d.connectionId~=r.driverConnectionId or not sameTarget(d.target,r.target) or d.gatewayOrigin~=r.gatewayOrigin or d.consoleOrigin~=r.consoleOrigin or d.sessionKey~=r.sessionKey or redis.call('GET',prefix..'auth:'..r.driverIntentId)~=d.owner or redis.call('GET',windowKey(r.target))~=r.driverConnectionId then return 0 end
 -- The console can keep renewing a driver whose process has died, so its AUTH alone cannot bound a watcher.
 -- The room is what that process renews, and it lapses with it.
 local roomTtl=redis.call('PTTL',roomKey(r.target)); if roomTtl==-1 then roomTtl=${GATEWAY_AUTH_MS} end
 return math.min(${GATEWAY_AUTH_MS},redis.call('PTTL',prefix..'auth:'..r.driverIntentId),roomTtl)
end
local function watchRoom(m)
 local r=roomFor(m.target); local remaining=driverRemaining(r)
 if remaining<=0 or not sameTarget(r.target,m.target) or r.gatewayOrigin~=m.gatewayOrigin or r.consoleOrigin~=m.consoleOrigin or r.driverIntentId~=m.driver.intentId or r.driverConnectionId~=m.driver.connectionId then return nil,'driver-ended' end
 if not r.enabled or r.epoch~=m.driver.epoch then return nil,'watch-disabled' end
 if m.sessionKey==r.sessionKey then return nil,'self-watch' end
 return r,remaining
end
local function prune(r)
 local changed=false
 for id,w in pairs(r.watchers) do if w.expiresAt<=now then r.watchers[id]=nil; changed=true end end
 if changed then r.rosterRevision=r.rosterRevision+1 end
end
local function saveRoom(r) redis.call('SET',roomKey(r.target),cjson.encode(r),'KEEPTTL') end
`;
const READ = `${PRELUDE}
local raw=redis.call('GET',KEYS[1]); if not raw then return denied('intent-missing') end
local ok,m=pcall(cjson.decode,raw); if not ok or m.v~=2 then return denied('intent-invalid') end
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
m.handoffHash=nil; m.browserHash=ARGV[2]; m.receiptHash=ARGV[5]; m.state='bound'; redis.call('SET',KEYS[1],cjson.encode(m),'KEEPTTL')
${answer}`,
	authorize: `${READ}
if m.owner~=ARGV[1] or m.state~='bound' or now>=m.pendingUntil then return denied('intent-unavailable') end
local observed=tonumber(ARGV[6]); local deadline=observed+tonumber(ARGV[4]); if observed>now or now>=deadline then return denied('authorization-expired') end
local r=nil; local remaining=0
if m.kind=='watch' then
 local reason; r,reason=watchRoom(m); if not r then return denied(reason) end
 remaining=driverRemaining(r); prune(r); local count=0; for _,_ in pairs(r.watchers) do count=count+1 end
 if count>=${GATEWAY_MAX_WATCHERS} then saveRoom(r); return denied('watch-limit') end
end
m.actor=cjson.decode(ARGV[2]); m.state='authorized'; m.grantUntil=now+tonumber(ARGV[3]); redis.call('SET',KEYS[1],cjson.encode(m),'PX',ARGV[5]); redis.call('SET',KEYS[2],m.owner,'PXAT',deadline); redis.call('ZADD',KEYS[3],now+tonumber(ARGV[5]),m.intentId); redis.call('PEXPIRE',KEYS[3],ARGV[5])
if r then
 r.rosterRevision=r.rosterRevision+1
 r.watchers[m.intentId]={watcherKey=ARGV[7],actor=m.actor,connectionId=cjson.null,registeredRevision=r.rosterRevision,expiresAt=math.min(deadline,now+remaining),state='pending'}
 saveRoom(r)
end
${answer}`,
	renewAuth: `${READ}
if m.owner~=ARGV[1] or (m.state~='authorized' and m.state~='connected') or (m.state=='authorized' and now>=m.grantUntil) or redis.call('GET',KEYS[2])~=ARGV[1] then return denied('authorization-expired') end
local observed=tonumber(ARGV[4]); local deadline=observed+tonumber(ARGV[2]); if observed>now or now>=deadline then return denied('authorization-expired') end
-- A gateway that died leaves its intents 'connected'. Its lease lapses, and with it the reason to keep renewing: otherwise
-- the console holds a sign-in's slots and a ghost watcher's slot for an attachment nobody has.
if m.state=='connected' then
 local lock=windowKey(m.target); if m.kind=='watch' then lock=watchWindow(m) end
 if redis.call('GET',lock)~=m.connectionId then return denied('window-lost') end
end
if m.kind=='watch' then
 local r,remaining=watchRoom(m); if not r then return denied(remaining) end
 local w=r.watchers[m.intentId]; if not w or w.expiresAt<=now then return denied('watch-removed') end
 w.expiresAt=math.min(deadline,now+remaining); saveRoom(r)
end
redis.call('PEXPIREAT',KEYS[2],deadline); redis.call('PEXPIRE',KEYS[1],ARGV[3]); redis.call('ZADD',KEYS[3],now+tonumber(ARGV[3]),m.intentId); redis.call('PEXPIRE',KEYS[3],ARGV[3])
${answer}`,
	revoke: `${READ}
if m.owner~=ARGV[1] then return denied('intent-unavailable') end
m.state='revoked'; m.reason=ARGV[2]; m.endedAt=now; redis.call('DEL',KEYS[2]); redis.call('SET',KEYS[1],cjson.encode(m),'PX',ARGV[3]); redis.call('ZADD',KEYS[3],now+tonumber(ARGV[3]),m.intentId)
${answer}`,
	redeem: `${READ}
if m.state~='authorized' or now>=m.grantUntil or m.browserHash~=ARGV[1] or redis.call('GET',KEYS[2])~=m.owner then return denied('grant-unavailable') end
local lock=KEYS[3]; local r=nil
if m.kind=='watch' then
 local reason; r,reason=watchRoom(m); if not r then return denied(reason) end
 local w=r.watchers[m.intentId]; if not w or w.expiresAt<=now then return denied('watch-removed') end
 lock=watchWindow(m)
end
-- A losing request cannot restore its ticket when another browser already owns this incarnation.
m.state='ended'; m.reason='window-lost'; m.endedAt=now
if redis.call('SET',lock,ARGV[2],'NX','PX',ARGV[3])==false then
 local winner=redis.call('GET',lock)
 redis.call('SET',KEYS[1],cjson.encode(m),'KEEPTTL'); redis.call('DEL',KEYS[2])
 if r then r.watchers[m.intentId]=nil; r.rosterRevision=r.rosterRevision+1; saveRoom(r) end
 return cjson.encode({refused='window-busy',winnerConnectionId=winner})
end
m.state='connected'; m.reason=nil; m.endedAt=nil; m.connectionId=ARGV[2]; m.connectedAt=now; redis.call('SET',KEYS[1],cjson.encode(m),'KEEPTTL')
if r then r.watchers[m.intentId].connectionId=ARGV[2]; saveRoom(r) end
return cjson.encode({ok=true,intent=m,authRemainingMs=redis.call('PTTL',KEYS[2])})`,
	renewAttachment: `${READ}
if m.state~='connected' or m.connectionId~=ARGV[1] or m.browserHash~=ARGV[2] then return denied('authorization-expired') end
local remaining=math.min(${GATEWAY_AUTH_MS},redis.call('PTTL',KEYS[2])); local r=nil; local lock=KEYS[3]; local seen=true
if m.kind=='watch' then
 local reason; r,reason=watchRoom(m); if not r then return denied(reason) end
 local w=r.watchers[m.intentId]
 -- A lapsed slot and a removed one look alike once pruned, and only one of them was the driver's doing. Telling a watcher
 -- whose authority lapsed that the driver removed them would be false, so a removal is recorded on the intent itself.
 if not w and m.removed then return denied('watch-removed') end
 if not w or w.expiresAt<=now or w.connectionId~=ARGV[1] then return denied('authorization-expired') end
 remaining=math.min(remaining,driverRemaining(r)); lock=watchWindow(m); seen=r.seenRosterRevision>=w.registeredRevision
elseif m.driverReady then
 if redis.call('GET',KEYS[2])~=m.owner then return denied('authorization-expired') end
 r=roomFor(m.target); if driverRemaining(r)<=0 or r.driverConnectionId~=ARGV[1] then return denied('driver-ended') end
 prune(r); saveRoom(r); redis.call('PEXPIRE',roomKey(m.target),remaining)
end
if redis.call('GET',KEYS[2])~=m.owner then return denied('authorization-expired') end
if redis.call('GET',lock)~=ARGV[1] then return denied('window-lost') end
redis.call('PEXPIRE',lock,ARGV[3])
return cjson.encode({ok=true,intent=m,authRemainingMs=remaining,room=r,rosterSeen=seen})`,
	release: `${READ}
if m.connectionId~=ARGV[1] then return denied('window-lost') end
local r=roomFor(m.target); local lock=KEYS[3]
if m.kind=='watch' then
 lock=watchWindow(m)
 if r and r.driverConnectionId==m.driver.connectionId and r.epoch==m.driver.epoch and r.watchers[m.intentId] then r.watchers[m.intentId]=nil; r.rosterRevision=r.rosterRevision+1; saveRoom(r) end
elseif r and r.driverConnectionId==ARGV[1] then
 for id,_ in pairs(r.watchers) do redis.call('DEL',prefix..'auth:'..id) end
 redis.call('DEL',roomKey(m.target))
end
if redis.call('GET',lock)==ARGV[1] then redis.call('DEL',lock) end
redis.call('DEL',KEYS[2]); if m.state~='revoked' then m.state='ended'; m.reason=ARGV[2]; m.endedAt=now end
redis.call('SET',KEYS[1],cjson.encode(m),'PX',ARGV[3]); redis.call('ZADD',KEYS[4],now+tonumber(ARGV[3]),m.intentId)
${answer}`,
	room: `${PRELUDE}
local target=cjson.decode(ARGV[1]); local r=roomFor(target); if not r or not sameTarget(r.target,target) then return denied('room-missing') end
local remaining=driverRemaining(r); if remaining<=0 then return denied('driver-ended') end
return cjson.encode({ok=true,room=r,authRemainingMs=remaining})`,
	startDriver: `${READ}
if m.kind~='drive' or m.state~='connected' or m.connectionId~=ARGV[1] or m.browserHash~=ARGV[2] or redis.call('GET',KEYS[2])~=m.owner or redis.call('GET',KEYS[3])~=ARGV[1] or m.driverReady then return denied('driver-ended') end
local remaining=math.min(${GATEWAY_AUTH_MS},redis.call('PTTL',KEYS[2])); if remaining<=0 then return denied('authorization-expired') end
local r={v=2,target=m.target,driverIntentId=m.intentId,driverConnectionId=m.connectionId,driverActor=m.actor,sessionKey=m.sessionKey,gatewayOrigin=m.gatewayOrigin,consoleOrigin=m.consoleOrigin,enabled=false,epoch=cjson.null,geometry={cols=tonumber(ARGV[3]),rows=tonumber(ARGV[4]),revision=1},rosterRevision=0,seenRosterRevision=0,watchers={}}
m.driverReady=true; redis.call('SET',KEYS[1],cjson.encode(m),'KEEPTTL'); redis.call('SET',roomKey(m.target),cjson.encode(r),'PX',remaining)
return cjson.encode({ok=true,intent=m,room=r,authRemainingMs=remaining})`,
	control: `${READ}
local r=roomFor(m.target)
if m.kind~='drive' then return denied('driver-ended') end
if m.state~='connected' or m.connectionId~=ARGV[1] or m.browserHash~=ARGV[2] or redis.call('GET',KEYS[2])~=m.owner then return denied('authorization-expired') end
if not r or r.driverIntentId~=m.intentId or r.driverConnectionId~=ARGV[1] or driverRemaining(r)<=0 then return denied('driver-ended') end
local action=ARGV[3]
if action=='policy' then
 local enabled=ARGV[4]=='true'
 if r.enabled~=enabled then
  for id,_ in pairs(r.watchers) do redis.call('DEL',prefix..'auth:'..id) end
  r.watchers={}; r.enabled=enabled; if enabled then r.epoch=ARGV[5] else r.epoch=cjson.null end; r.rosterRevision=r.rosterRevision+1
 end
elseif action=='remove' then
 for id,w in pairs(r.watchers) do if w.watcherKey==ARGV[4] then redis.call('DEL',prefix..'auth:'..id); local gone=decoded(prefix..'intent:'..id); if gone then gone.removed=true; redis.call('SET',prefix..'intent:'..id,cjson.encode(gone),'KEEPTTL') end; r.watchers[id]=nil; r.rosterRevision=r.rosterRevision+1; break end end
elseif action=='seen' then
 local revision=tonumber(ARGV[4]); if revision>r.rosterRevision then return denied('roster-invalid') end
 r.seenRosterRevision=math.max(r.seenRosterRevision,revision)
elseif action=='geometry' then
 local cols=tonumber(ARGV[4]); local rows=tonumber(ARGV[5])
 if r.geometry.cols~=cols or r.geometry.rows~=rows then r.geometry={cols=cols,rows=rows,revision=r.geometry.revision+1} end
elseif action=='watch-ready' then
 return denied('control-invalid')
else return denied('control-invalid') end
saveRoom(r)
return cjson.encode({ok=true,intent=m,room=r,authRemainingMs=driverRemaining(r)})`,
	watchReady: `${READ}
if m.kind~='watch' or m.state~='connected' or m.connectionId~=ARGV[1] or m.browserHash~=ARGV[2] then return denied('authorization-expired') end
local r,reason=watchRoom(m); if not r then return denied(reason) end
local w=r.watchers[m.intentId]; if not w or w.expiresAt<=now then return denied('watch-removed') end
if redis.call('GET',KEYS[2])~=m.owner or redis.call('GET',watchWindow(m))~=ARGV[1] then return denied('authorization-expired') end
if r.seenRosterRevision<w.registeredRevision then return denied('roster-unseen') end
if w.state~='watching' then w.state='watching'; r.rosterRevision=r.rosterRevision+1 end; saveRoom(r)
return cjson.encode({ok=true,intent=m,room=r,authRemainingMs=math.min(driverRemaining(r),redis.call('PTTL',KEYS[2]))})`,
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
			const wire = [...args]; while (wire.length < 8) wire.push(""); wire.push(prefix);
			const raw = await bounded(() => redis.eval(script, keys.length, ...keys, ...wire));
			if (typeof raw !== "string" || Buffer.byteLength(raw) > 8192) return { refused: "control-invalid" };
			const result = JSON.parse(raw);
			if (only(result, ["ok", "intent", "room", "authRemainingMs", "rosterSeen"]) && result.ok === true && (result.intent !== undefined || result.room !== undefined) && (result.intent === undefined || validIntent(result.intent)) && (result.room === undefined || validRoom(result.room)) && (result.authRemainingMs === undefined || Number.isInteger(result.authRemainingMs) && result.authRemainingMs > 0 && result.authRemainingMs <= GATEWAY_AUTH_MS) && (result.rosterSeen === undefined || typeof result.rosterSeen === "boolean")) return result;
			if (only(result, ["refused", "winnerConnectionId"]) && result.refused === "window-busy" && validId(result.winnerConnectionId)) return result;
			return object(result) && Object.keys(result).length === 1 && typeof result.refused === "string" && /^[a-z-]{1,40}$/.test(result.refused) ? { refused: result.refused } : { refused: "control-invalid" };
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
	const dimensions = (cols, rows) => Number.isInteger(cols) && cols >= 2 && cols <= 500 && Number.isInteger(rows) && rows >= 1 && rows <= 200;
	async function connectionKeys(intentId, connectionId, browserHash) {
		if (!validId(intentId) || !validId(connectionId) || !GATEWAY_HASH_RE.test(browserHash ?? "")) return null;
		const m = await readIntent(intentId);
		return m ? [key(intentId), auth(intentId), windowKey(m.target)] : null;
	}
	async function control(input, action, args) {
		let keys; try { keys = await connectionKeys(input.intentId, input.connectionId, input.browserHash); } catch { return { refused: "control-unavailable" }; }
		return keys ? evaluate(GATEWAY_SCRIPTS.control, keys, [input.connectionId, input.browserHash, action, ...args]) : invalid();
	}
	return {
		readIntent,
		async readRoom(target) {
			if (!cleanGatewayTarget(target)) throw new Error("gateway-control-invalid");
			const result = await evaluate(GATEWAY_SCRIPTS.room, [], [JSON.stringify(cleanGatewayTarget(target))]);
			if (result.ok) return result.room;
			if (["room-missing", "driver-ended"].includes(result.refused)) return null;
			throw new Error("gateway-control-unavailable");
		},
		async observeTime() {
			try { const nowMs = await bounded(() => redis.eval(GATEWAY_SCRIPTS.time, 0)); return instant(nowMs) ? { ok: true, nowMs } : { refused: "control-invalid" }; }
			catch { return { refused: "control-unavailable" }; }
		},
		async createIntent(input) {
			if (!only(input, ["intentId", "owner", "handoffHash", "target", "gatewayOrigin", "consoleOrigin", "theme", "sessionKey", "kind", "runFacts", "driver"]) || !validId(input.intentId) || !validId(input.owner) || !GATEWAY_HASH_RE.test(input.sessionKey ?? "") || !["drive", "watch"].includes(input.kind) || !validGatewayRunFacts(input.runFacts) || (input.runFacts !== null && input.runFacts.id !== input.target?.id) || (input.kind === "watch" ? !driverRef(input.driver) : input.driver !== undefined) || !GATEWAY_HASH_RE.test(input.handoffHash ?? "") || !cleanGatewayTarget(input.target) || !distinctGatewayOrigins(input.gatewayOrigin, input.consoleOrigin) || ![undefined, null, "light", "dark"].includes(input.theme)) return invalid();
			const m = { v: 2, ...input, target: cleanGatewayTarget(input.target), theme: input.theme ?? null, state: "pending" };
			return evaluate(GATEWAY_SCRIPTS.create, [key(input.intentId), index], [JSON.stringify(m), handoffMs, pendingMs, input.intentId, maxIntents]);
		},
		async bindIntent({ intentId, handoff, browserHash, receiptHash, gatewayOrigin: origin, host } = {}) {
			if (!validId(intentId) || !validId(handoff) || !GATEWAY_HASH_RE.test(browserHash ?? "") || !GATEWAY_HASH_RE.test(receiptHash ?? "") || !gatewayOrigin(origin) || !WORKER_NAME_RE.test(host ?? "")) return invalid();
			return evaluate(GATEWAY_SCRIPTS.bind, [key(intentId)], [gatewayHash(handoff), browserHash, origin, host, receiptHash]);
		},
		async authorizeIntent({ intentId, owner, actor, observedAt } = {}) {
			if (!validId(intentId) || !validId(owner) || !validActor(actor) || !clockOk(observedAt)) return invalid();
			return evaluate(GATEWAY_SCRIPTS.authorize, [key(intentId), auth(intentId), index], [owner, JSON.stringify(actor), grantMs, authMs, pendingMs, observedAt, gatewayHash(intentId)]);
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
		async startDriver(input = {}) {
			if (!dimensions(input.cols, input.rows)) return invalid();
			let keys; try { keys = await connectionKeys(input.intentId, input.connectionId, input.browserHash); } catch { return { refused: "control-unavailable" }; }
			return keys ? evaluate(GATEWAY_SCRIPTS.startDriver, keys, [input.connectionId, input.browserHash, input.cols, input.rows]) : invalid();
		},
		async setWatching(input = {}) {
			return typeof input.enabled === "boolean" ? control(input, "policy", [String(input.enabled), gatewayRandom()]) : invalid();
		},
		async removeWatcher(input = {}) {
			return GATEWAY_HASH_RE.test(input.watcherKey ?? "") ? control(input, "remove", [input.watcherKey]) : invalid();
		},
		async acknowledgeRoster(input = {}) {
			return integer(input.revision) ? control(input, "seen", [input.revision]) : invalid();
		},
		async updateGeometry(input = {}) {
			return dimensions(input.cols, input.rows) ? control(input, "geometry", [input.cols, input.rows]) : invalid();
		},
		async readyWatch(input = {}) {
			let keys; try { keys = await connectionKeys(input.intentId, input.connectionId, input.browserHash); } catch { return { refused: "control-unavailable" }; }
			return keys ? evaluate(GATEWAY_SCRIPTS.watchReady, keys, [input.connectionId, input.browserHash]) : invalid();
		},
	};
}
