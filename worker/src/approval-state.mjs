/**
 * Durable approval requests (issue #649). Every transition is a Valkey compare-and-set: a label, queue payload or
 * a second reply cannot replace the first accepted decision. Pending requests never expire as keys: the deadline
 * produces a durable decline instead. Callers authorize the actor before decide and keep this private store's text
 * out of run records and logs. Claiming again with the same job id supports infrastructure retry after queue.add.
 */
import { createHash } from "node:crypto";
import { ANSWER_TEXT_MAX_BYTES, scrubAnswerText } from "./console-answer.mjs";

export const APPROVAL_FINISHED_TTL_MS = 32 * 86400_000;
export const APPROVAL_PREFIX = "run:approval:";
export const APPROVAL_DUE_KEY = `${APPROVAL_PREFIX}due`;
const ID = /^[A-Za-z0-9._:-]{1,200}$/;
const word = (v, max = 256) => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/u.test(v);
const instant = (v) => Number.isSafeInteger(v) && v >= 0;
const key = (id) => `${APPROVAL_PREFIX}request:${id}`;
export const approvalDueKey = (host) => `${APPROVAL_DUE_KEY}:${createHash("sha256").update(host).digest("hex")}`;

/** A derived target key, shared by publish and find; no attacker text is put in a Valkey key. */
export function approvalTargetKey(job) {
	if (!word(job?.kind) || !word(job?.repo) || !["issue", "pull_request"].includes(job?.target?.type) || !Number.isSafeInteger(job.target.number) || job.target.number <= 0) return null;
	return `${APPROVAL_PREFIX}target:${createHash("sha256").update(JSON.stringify([job.kind, job.repo, job.target.type, job.target.number])).digest("hex")}`;
}

function normalized(request) {
	if (request?.version !== undefined && request.version !== 1) return null;
	if (request?.sessionDigest !== undefined && (typeof request.sessionDigest !== "string" || !/^[a-f0-9]{64}$/.test(request.sessionDigest))) return null;
	if (!request || !ID.test(request.requestId ?? "") || !ID.test(request.runId ?? "") || !approvalTargetKey(request) || !word(request.action, 128) || !word(request.toolCallId) || !word(request.configDigest) || !word(request.sessionKey) || !word(request.host) || !instant(request.createdAt)) return null;
	if (request.hostQueue !== undefined && request.hostQueue !== null && (typeof request.hostQueue !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(request.host) || request.hostQueue !== `pi-jobs@${request.host}`)) return null;
	if (request.expiresAt !== undefined && (!instant(request.expiresAt) || request.expiresAt <= request.createdAt)) return null;
	const out = { version: 1, requestId: request.requestId, runId: request.runId, kind: request.kind, repo: request.repo, target: { type: request.target.type, number: request.target.number }, action: request.action, toolCallId: request.toolCallId, configDigest: request.configDigest, sessionKey: request.sessionKey, host: request.host, createdAt: request.createdAt };
	if (request.expiresAt !== undefined) out.expiresAt = request.expiresAt;
	if (request.sessionDigest !== undefined) out.sessionDigest = request.sessionDigest;
	if (request.hostQueue !== undefined && request.hostQueue !== null) out.hostQueue = request.hostQueue;
	// Routing data is worker-authored and private; its JSON must remain bounded before it reaches Valkey.
	if (request.resumeJob !== undefined) {
		if (!request.resumeJob || typeof request.resumeJob !== "object" || Array.isArray(request.resumeJob)) return null;
		out.resumeJob = request.resumeJob;
	}
	if (Buffer.byteLength(JSON.stringify(out)) > 128 * 1024) return null;
	return out;
}

const PUBLISH = `local prior = redis.call('GET', KEYS[1])
if prior then
 local valid, r = pcall(cjson.decode, prior)
 if not valid or type(r) ~= 'table' or r.version ~= 1 then return {'refused', 'state-invalid'} end
 if r.identity ~= ARGV[1] then return {'refused', 'request-conflict'} end
 return {'ok', prior}
end
if redis.call('EXISTS', KEYS[2]) == 1 then return {'refused', 'target-pending'} end
local r = cjson.decode(ARGV[1]); r.state = 'pending'; r.identity = ARGV[1]
local raw = cjson.encode(r)
redis.call('SET', KEYS[1], raw); redis.call('SET', KEYS[2], r.requestId)
if r.expiresAt then redis.call('ZADD', KEYS[3], r.expiresAt, r.requestId); redis.call('ZADD', KEYS[4], r.expiresAt, r.requestId) end
return {'ok', raw}`;

const MOVE = `local raw = redis.call('GET', KEYS[1])
if not raw then return {'refused', 'request-missing'} end
local valid, r = pcall(cjson.decode, raw)
if not valid or type(r) ~= 'table' or r.version ~= 1 then return {'refused', 'state-invalid'} end
if (ARGV[1] == 'finish' or ARGV[1] == 'cancel') and r.state == 'finished' and r.jobId == ARGV[3] then return {'ok', raw} end
if redis.call('GET', KEYS[2]) ~= r.requestId then return {'refused', 'request-stale'} end
local op = ARGV[1]; local at = tonumber(ARGV[2])
if op == 'decide' or op == 'expire' then
 if r.state ~= 'pending' then
  if op == 'decide' and r.decision and r.decision.decisionId == ARGV[3] then return {'ok', raw} end
  if op == 'expire' and r.decision and r.decision.actor.kind == 'system' then return {'ok', raw} end
  return {'refused', 'already-decided'}
 end
 if op == 'expire' and (not r.expiresAt or at < r.expiresAt) then return {'refused', 'not-expired'} end
 if r.expiresAt and at >= r.expiresAt then
  r.decision = {decisionId = 'expiry-' .. r.requestId, decision = 'declined', actor = {kind = 'system', id = 'expiry'}, text = '', at = at}
 else
  r.decision = cjson.decode(ARGV[4]); r.decision.at = at
 end
 r.state = 'decided'
 if r.decision.actor.kind ~= 'system' then redis.call('ZREM', KEYS[3], r.requestId); redis.call('ZREM', KEYS[4], r.requestId) end
elseif op == 'claim' then
 if r.state == 'claimed' and r.jobId == ARGV[3] then return {'ok', raw} end
 if r.state ~= 'decided' then return {'refused', 'not-decided'} end
 r.state = 'claimed'; r.jobId = ARGV[3]; redis.call('ZREM', KEYS[3], r.requestId); redis.call('ZREM', KEYS[4], r.requestId)
elseif op == 'finish' then
 if r.state ~= 'claimed' or r.jobId ~= ARGV[3] then return {'refused', 'not-claimed'} end
 r.state = 'finished'; redis.call('DEL', KEYS[2]); redis.call('ZREM', KEYS[3], r.requestId); redis.call('ZREM', KEYS[4], r.requestId)
elseif op == 'cancel' then
 if r.state == 'claimed' and r.jobId ~= ARGV[3] then return {'refused', 'not-claimed'} end
 if r.state ~= 'pending' and r.state ~= 'decided' and r.state ~= 'claimed' then return {'refused', 'request-stale'} end
 if not r.decision then r.decision = {decisionId = 'revocation-' .. r.requestId, decision = 'declined', actor = {kind = 'system', id = 'revocation'}, text = '', at = at} end
 r.state = 'finished'; r.jobId = ARGV[3]; redis.call('DEL', KEYS[2]); redis.call('ZREM', KEYS[3], r.requestId); redis.call('ZREM', KEYS[4], r.requestId)
else return {'refused', 'operation-invalid'} end
raw = cjson.encode(r); redis.call('SET', KEYS[1], raw)
if op == 'finish' or op == 'cancel' then redis.call('PEXPIRE', KEYS[1], ${APPROVAL_FINISHED_TTL_MS}) end
return {'ok', raw}`;

const exposed = (raw) => {
	try {
		const request = JSON.parse(raw);
		if (request?.version !== 1 || !normalized(request) || !["pending", "decided", "claimed", "finished"].includes(request.state)) return null;
		if (request.state !== "pending" && (!request.decision || !["approved", "declined", "question"].includes(request.decision.decision) || !["forge", "operator", "panel", "system"].includes(request.decision.actor?.kind) || !word(request.decision.actor.id, 200) || !instant(request.decision.at) || typeof request.decision.text !== "string")) return null;
		delete request.identity;
		return request;
	} catch { return null; }
};

/** Methods return {ok, request}, {refused}, or {error}; missing read/find returns request:null. */
export function makeApprovalStore({ redis, now = () => Date.now() } = {}) {
	if (!redis || typeof redis.eval !== "function") throw new TypeError("makeApprovalStore needs redis.eval");
	const safe = async (fn) => {
		try { return await fn(); } catch (error) { return { error: typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : "approval-store-error" }; }
	};
	const read = (id) => safe(async () => {
		if (!ID.test(id ?? "")) return { refused: "request-invalid" };
		const raw = await redis.get(key(id));
		if (raw === null) return { ok: true, request: null };
		const request = exposed(raw);
		return request ? { ok: true, request } : { refused: "state-invalid" };
	});
	const decode = (result) => {
		if (result[0] !== "ok") return { refused: result[1] };
		const request = exposed(result[1]);
		return request ? { ok: true, request } : { refused: "state-invalid" };
	};
	const move = (op, id, marker = "", decision = null) => safe(async () => {
		const got = await read(id);
		if (!got.ok) return got;
		if (!got.request) return { refused: "request-missing" };
		const at = now();
		if (!instant(at)) return { refused: "clock-invalid" };
		return decode(await redis.eval(MOVE, 4, key(id), approvalTargetKey(got.request), APPROVAL_DUE_KEY, approvalDueKey(got.request.host), op, String(at), marker, JSON.stringify(decision)));
	});
	return {
		publish: (request) => safe(async () => {
			const r = normalized(request);
			if (!r) return { refused: "request-invalid" };
			return decode(await redis.eval(PUBLISH, 4, key(r.requestId), approvalTargetKey(r), APPROVAL_DUE_KEY, approvalDueKey(r.host), JSON.stringify(r)));
		}),
		read,
		find: (job) => safe(async () => {
			const target = approvalTargetKey(job);
			if (!target) return { refused: "target-invalid" };
			const id = await redis.get(target);
			return id === null ? { ok: true, request: null } : read(id);
		}),
		decide: ({ requestId, decisionId, decision, actor, text = "" } = {}) => {
			if (!ID.test(decisionId ?? "") || !["approved", "declined", "question"].includes(decision) || !["forge", "operator", "panel"].includes(actor?.kind) || !word(actor?.id, 200) || typeof text !== "string" || Buffer.byteLength(text) > ANSWER_TEXT_MAX_BYTES || (typeof text.isWellFormed === "function" && !text.isWellFormed())) return Promise.resolve({ refused: "decision-invalid" });
			return move("decide", requestId, decisionId, { decisionId, decision, actor: { kind: actor.kind, id: actor.id }, text: scrubAnswerText(text) });
		},
		claim: ({ requestId, jobId } = {}) => ID.test(jobId ?? "") ? move("claim", requestId, jobId) : Promise.resolve({ refused: "job-invalid" }),
		finish: ({ requestId, jobId } = {}) => ID.test(jobId ?? "") ? move("finish", requestId, jobId) : Promise.resolve({ refused: "job-invalid" }),
		cancel: ({ requestId, jobId } = {}) => ID.test(jobId ?? "") ? move("cancel", requestId, jobId) : Promise.resolve({ refused: "job-invalid" }),
		expire: (id) => move("expire", id),
		hasPending: (host) => safe(async () => {
			if (!word(host)) return { refused: "host-invalid" };
			return { ok: true, pending: (await redis.zcard(approvalDueKey(host))) > 0 };
		}),
		due: (limit = 100, host = null) => safe(async () => {
			if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !instant(now()) || host !== null && !word(host)) return { refused: "limit-invalid" };
			return { ok: true, requestIds: await redis.zrangebyscore(host === null ? APPROVAL_DUE_KEY : approvalDueKey(host), "-inf", String(now()), "LIMIT", 0, limit) };
		}),
	};
}
