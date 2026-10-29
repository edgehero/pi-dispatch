import { publicWatchTrace } from "./watch-trace.mjs";
import { recordedWatchDecision } from "./watch-record.mjs";
import { noteWatchIssueActivity } from "./watch-issue.mjs";
import { createHash } from "node:crypto";
import { validateWatchBoard as checkBoard } from "./watch-board.mjs";
import { watchFingerprint, matchesWatchFinding, watchDurationMs } from "./watch-contract.mjs";

const TTL_MS = 7 * 86400000;
// One script owns replay, digest and caps: a receiver crash between separate writes must never
// consume a delivery without leaving the same enqueueable finding for its retry.
export const WATCH_INGEST_SCRIPT = `
local now = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local replay = redis.call('GET', KEYS[1])
if replay then return replay end
local sourceCount = tonumber(redis.call('GET', KEYS[2]) or '0')
if sourceCount >= tonumber(ARGV[3]) then return cjson.encode({status='capped',reason='watch-cap'}) end
redis.call('INCR', KEYS[2]); redis.call('PEXPIRE', KEYS[2], 172800000)
redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now)
local active = redis.call('GET', KEYS[3])
local result
if active then
 local a = cjson.decode(active)
 if now > a.dueAt + tonumber(ARGV[7]) then redis.call('DEL', KEYS[3]); active=nil end
end
if active then
 local a = cjson.decode(active)
 if now <= a.dueAt then
  local existing = redis.call('GET', ARGV[12] .. ':finding:' .. a.id)
  if existing then
   local f = cjson.decode(existing)
   if not f.claimed then
   local incoming = cjson.decode(ARGV[8])
   f.count = math.min(1000000, f.count + incoming.count)
   if incoming.firstSeen < f.firstSeen then f.firstSeen = incoming.firstSeen end
   if incoming.lastSeen > f.lastSeen then f.lastSeen = incoming.lastSeen end
   for _, sample in ipairs(incoming.samples) do if #f.samples < 8 then table.insert(f.samples, sample) end end
   redis.call('SET', ARGV[12] .. ':finding:' .. a.id, cjson.encode(f), 'PX', ttl)
   result = cjson.encode({status='held',id=a.id,fingerprint=ARGV[9],dueAt=a.dueAt})
   end
  end
 end
 if not result then result = cjson.encode({status='suppressed',id=a.id,fingerprint=ARGV[9],dueAt=a.dueAt,reason='watch-cooldown'}) end
elseif redis.call('ZCARD', KEYS[4]) >= tonumber(ARGV[4]) or tonumber(redis.call('GET', KEYS[5]) or '0') >= tonumber(ARGV[5]) then
 result = cjson.encode({status='capped',reason='watch-cap',fingerprint=ARGV[9]})
else
 local due = now + tonumber(ARGV[6])
 local a = {id=ARGV[10],dueAt=due}
 local f = cjson.decode(ARGV[8]); f.id=ARGV[10]; f.fingerprint=ARGV[9]; f.dueAt=due; f.createdAt=now
 f.source=ARGV[11]; f.ruleId=ARGV[13]; f.status='held'; f.minCount=tonumber(ARGV[15])
 redis.call('SET', KEYS[3], cjson.encode(a), 'PX', tonumber(ARGV[6])+tonumber(ARGV[7]))
 redis.call('ZADD', KEYS[4], due+tonumber(ARGV[7]), ARGV[9]); redis.call('PEXPIRE', KEYS[4], ttl+tonumber(ARGV[7]))
 redis.call('INCR', KEYS[5]); redis.call('PEXPIRE', KEYS[5], 172800000)
 redis.call('SET', ARGV[12] .. ':finding:' .. ARGV[10], cjson.encode(f), 'PX', ttl)
 redis.call('ZADD', KEYS[6], now, ARGV[10]); redis.call('ZREMRANGEBYSCORE', KEYS[6], '-inf', now-ttl); redis.call('PEXPIRE', KEYS[6], ttl)
 redis.call('HSET', KEYS[7], ARGV[13], ARGV[14]); redis.call('PEXPIRE', KEYS[7], ttl)
 result = cjson.encode({status='held',id=ARGV[10],fingerprint=ARGV[9],dueAt=due})
end
redis.call('SET', KEYS[1], result, 'PX', ttl)
return result
`;
const BOARD_SCRIPT = `
local raw=redis.call('GET',KEYS[1]); local b
if raw then b=cjson.decode(raw) else b=cjson.decode(ARGV[1]) end
if b.version ~= tonumber(ARGV[2]) then return cjson.encode({ok=false,reason='board-conflict',board=b}) end
local change=cjson.decode(ARGV[3])
if change.action=='freeze' then b.frozen=change.frozen
elseif change.action=='clear' then b.blocks={}; b.proposals={}
elseif change.action=='adopt' then
 if b.frozen then return cjson.encode({ok=false,reason='board-frozen',board=b}) end
 local found=false
 for _,p in ipairs(b.proposals or {}) do if p.id==change.proposalId then b.blocks=p.blocks; found=true end end
 if not found then return cjson.encode({ok=false,reason='board-proposal-missing',board=b}) end
elseif change.action=='revert' then
 local found=false
 for _,v in ipairs(b.versions) do if v.version==change.version then b.blocks=v.blocks; found=true end end
 if not found then return cjson.encode({ok=false,reason='board-version-missing',board=b}) end
else return cjson.encode({ok=false,reason='board-action-invalid',board=b}) end
b.version=b.version+1
table.insert(b.versions,{version=b.version,blocks=b.blocks})
while #b.versions>20 do table.remove(b.versions,1) end
redis.call('SET',KEYS[1],cjson.encode(b),'PX',ARGV[4])
return cjson.encode({ok=true,board=b})
`;
function validId(value) { if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error("invalid watch identifier"); return value; }
const hash = value => createHash("sha256").update(value).digest("hex");
const parse = raw => raw ? JSON.parse(raw) : null;
function boardArrays(board) { if (!Array.isArray(board.blocks)) board.blocks = []; if (!Array.isArray(board.versions)) board.versions = []; if (!Array.isArray(board.proposals)) board.proposals = []; for (const proposal of board.proposals) if (!Array.isArray(proposal.blocks)) proposal.blocks = []; for (const version of board.versions) if (!Array.isArray(version.blocks)) version.blocks = []; return board; }
const publicFinding = f => f && { ...Object.fromEntries(["id", "source", "ruleId", "fingerprint", "severity", "count", "firstSeen", "lastSeen", "dueAt", "createdAt", "status", "reason", "runId"].filter(k => f[k] !== undefined).map(k => [k, f[k]])), ...(recordedWatchDecision(f.decision) ? { decision: recordedWatchDecision(f.decision) } : {}) };
export function makeWatchStore(redis, { now = () => Date.now(), prefix = "watch", sourceCaps = {} } = {}) {
	const key = suffix => `${prefix}:${suffix}`;
	const emptyBoard = ruleId => ({ ruleId, version: 0, frozen: false, blocks: [], versions: [], proposals: [] });
	return {
		async noteIssueActivity(args) { return noteWatchIssueActivity(redis, args, { now }); },
		async recordIssueOutcome(ruleId, outcome) {
			validId(ruleId);
			if (!["closed", "active", "uncertain", "suppressed"].includes(outcome.status) || (outcome.reason !== undefined && !["watch-issue-close-uncertain", "watch-issue-close-raced", "watch-issue-close-policy-changed"].includes(outcome.reason))) throw new Error("invalid watch issue outcome");
			await redis.multi().hset(key(`summary:${ruleId}`), "lastIssueStatus", outcome.status, "lastIssueReason", outcome.reason ?? "").pexpire(key(`summary:${ruleId}`), TTL_MS).exec();
		},
		async scheduleAction(id, ruleId, dueAt = now()) {
			validId(id); validId(ruleId);
			await redis.multi().hset(key("pending-action-rules"), id, ruleId).zadd(key("pending-actions"), dueAt, id).exec();
		},
		async pendingActions() {
			const ids = await redis.zrangebyscore(key("pending-actions"), "-inf", now(), "LIMIT", 0, 100);
			return (await Promise.all(ids.map(async id => ({ id, ruleId: await redis.hget(key("pending-action-rules"), id), dueAt: now() })))).filter(row => row.ruleId);
		},
		async acknowledgeAction(id) { validId(id); await redis.multi().zrem(key("pending-actions"), id).hdel(key("pending-action-rules"), id).exec(); },
		async ingest({ source, rule, finding, delivery, sourceMaxPerDay }) {
			validId(source); validId(rule.id); validId(delivery);
			if (!matchesWatchFinding(rule, finding)) return { status: "unmatched", reason: "watch-unmatched" };
			const fingerprint = watchFingerprint(source, rule, finding);
			const clock = now(); const day = new Date(clock).toISOString().slice(0, 10);
			const id = hash(JSON.stringify([source, rule.id, fingerprint, delivery, clock]));
			const ruleKey = `${source}:${rule.id}`;
			const result = await redis.eval(WATCH_INGEST_SCRIPT, 7,
				key(`delivery:${source}:${rule.id}:${delivery}`), key(`source-day:${source}:${day}`), key(`active:${ruleKey}:${fingerprint}`), key(`fingerprints:${ruleKey}`), key(`rule-day:${ruleKey}:${day}`), key(`findings:${rule.id}`), key("rules"),
				clock, TTL_MS, sourceMaxPerDay ?? sourceCaps[source] ?? 1000, rule.maxFingerprints ?? 256, rule.maxPerDay, rule.windowMs ?? watchDurationMs(rule.window), rule.cooldownMs ?? watchDurationMs(rule.cooldown), JSON.stringify(finding), fingerprint, id, source, prefix, rule.id, JSON.stringify({ id: rule.id, source, maxPerDay: rule.maxPerDay }), rule.minCount ?? 1);
			return parse(result);
		},
		async takeFinding(id) {
			validId(id);
			const script = `local raw=redis.call('GET',KEYS[1]); if not raw then return cjson.encode({status='missing'}) end
local f=cjson.decode(raw)
if tonumber(ARGV[1]) < f.dueAt then return cjson.encode({status='held',dueAt=f.dueAt}) end
if not f.claimed then f.claimed=true; f.status=f.count>=f.minCount and 'ready' or 'below-threshold'; redis.call('SET',KEYS[1],cjson.encode(f),'KEEPTTL') end
return cjson.encode({status=f.count>=f.minCount and 'ready' or 'below-threshold',finding=f,source=f.source,ruleId=f.ruleId,fingerprint=f.fingerprint})`;
			const result = parse(await redis.eval(script, 1, key(`finding:${id}`), now()));
			if (result.finding && !Array.isArray(result.finding.samples)) result.finding.samples = [];
			return result;
		},
		async proposeBoard(ruleId, board, runId) {
			validId(ruleId); validId(runId); validateWatchBoard(board);
			const proposal = { id: hash(JSON.stringify([ruleId, runId, board])), runId, blocks: board.blocks, createdAt: now() };
			const script = `local raw=redis.call('GET',KEYS[1]); local b=raw and cjson.decode(raw) or cjson.decode(ARGV[1]); b.proposals=b.proposals or {}; local p=cjson.decode(ARGV[2]); for _,old in ipairs(b.proposals) do if old.id==p.id then return cjson.encode(old) end end; table.insert(b.proposals,p); while #b.proposals>20 do table.remove(b.proposals,1) end; redis.call('SET',KEYS[1],cjson.encode(b),'PX',ARGV[3]); return cjson.encode(p)`;
			return parse(await redis.eval(script, 1, key(`board:${ruleId}`), JSON.stringify(emptyBoard(ruleId)), JSON.stringify(proposal), TTL_MS));
		},
		async recordVerdict(ruleId, source, status) {
			validId(ruleId); validId(source);
			if (!["held", "suppressed", "capped", "unmatched"].includes(status)) throw new Error("invalid watch verdict");
			await redis.multi().hset(key("rules"), ruleId, JSON.stringify({ id: ruleId, source })).hincrby(key(`summary:${ruleId}`), status, 1).hset(key(`summary:${ruleId}`), "lastDeliveryAt", String(now())).pexpire(key(`summary:${ruleId}`), TTL_MS).pexpire(key("rules"), TTL_MS).exec();
		},
		async listRules() { return Promise.all(Object.values(await redis.hgetall(key("rules"))).map(parse).map(async rule => ({ ...rule, summary: await redis.hgetall(key(`summary:${rule.id}`)) }))); },
		async listFindings(ruleId, { limit = 1000 } = {}) {
			validId(ruleId); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("invalid watch findings limit");
			const ids = await redis.zrevrange(key(`findings:${ruleId}`), 0, limit - 1);
			return (await Promise.all(ids.map(id => this.readFinding(id)))).filter(Boolean);
		},
		async readFinding(id, { private: privateRead = false } = {}) { validId(id); const f = parse(await redis.get(key(`finding:${id}`))); return privateRead ? f : publicFinding(f); },
		async readTrace(id, { private: privateRead = false } = {}) {
			validId(id); const entries = (await redis.lrange(key(`trace:${id}`), 0, 999)).map(parse);
			const dropped = Number(await redis.get(key(`trace-dropped:${id}`)) ?? 0);
			if (dropped > 0) entries.unshift({ id: "trace-trimmed", kind: "rule", status: "trace-trimmed", count: dropped });
			return privateRead ? entries : entries.map(publicWatchTrace);
		},
		async appendTrace(id, entry) {
			validId(id); const text = JSON.stringify({ ...entry, at: now() });
			if (Buffer.byteLength(text) > 32768) throw new Error("watch trace entry exceeds limit");
			const script = `local n=redis.call('RPUSH',KEYS[1],ARGV[1]); if n>1000 then redis.call('INCRBY',KEYS[2],n-1000); redis.call('LTRIM',KEYS[1],-1000,-1); redis.call('PEXPIRE',KEYS[2],ARGV[2]) end; redis.call('PEXPIRE',KEYS[1],ARGV[2]); return n`;
			await redis.eval(script, 2, key(`trace:${id}`), key(`trace-dropped:${id}`), text, TTL_MS);
		},
		async updateFinding(id, patch) {
			validId(id); const allowed = ["status", "decision", "reason", "runId"];
			if (Object.keys(patch).some(k => !allowed.includes(k))) throw new Error("invalid watch finding update");
			const script = `local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end; local f=cjson.decode(raw); local p=cjson.decode(ARGV[1]); for k,v in pairs(p) do f[k]=v end; redis.call('SET',KEYS[1],cjson.encode(f),'KEEPTTL'); return 1`;
			return Boolean(await redis.eval(script, 1, key(`finding:${id}`), JSON.stringify(patch)));
		},
		async readBoard(ruleId) { validId(ruleId); return boardArrays(parse(await redis.get(key(`board:${ruleId}`))) ?? emptyBoard(ruleId)); },
		async mutateBoard(ruleId, change, expectedVersion) {
			validId(ruleId);
			if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error("invalid board version");
			if (!["freeze", "clear", "revert", "adopt"].includes(change.action) || (change.action === "freeze" && typeof change.frozen !== "boolean")) throw new Error("invalid board change");
			if (change.action === "adopt") validId(change.proposalId);
			const result = parse(await redis.eval(BOARD_SCRIPT, 1, key(`board:${ruleId}`), JSON.stringify(emptyBoard(ruleId)), expectedVersion, JSON.stringify(change), TTL_MS));
			result.board = boardArrays(result.board); return result;
		},
	};
}
export function validateWatchBoard(board) {
	const result = checkBoard({ version: 1, ...board });
	if (!result.ok) throw new Error(result.reason);
	return board;
}
