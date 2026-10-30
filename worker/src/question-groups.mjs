import { createHash } from "node:crypto";

/** Private question context and public assignment metadata are separate stores. A public read never fetches text. */
export const QUESTION_GROUP_LIMITS = Object.freeze({ excerptBytes: 16384, inputBytes: 262144, corpusEntries: 1000, metadataEntries: 5000, candidates: 14, retentionDays: 90, timeoutMs: 2000 });
export const QUESTION_GROUP_STATUSES = Object.freeze(["unassigned", "pending", "assigned", "source-expired", "source-unavailable", "source-oversize", "candidates-expired", "group-limit", "stale", "refused", "failed"]);
export const GROUP_ID_RE = /^[a-f0-9]{32}$/;
export const QUESTION_SCOPE_RE = /^[a-f0-9]{64}$/;
export const QUESTION_RUN_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const own = (value, keys) => object(value) && Object.keys(value).every((key) => keys.includes(key));
const safeWord = (value, max = 200) => typeof value === "string" && value.length <= max && /^[A-Za-z0-9._:/ @!#-]+$/.test(value);
export const questionDigest = (value) => sha(JSON.stringify(value));

/** No model-owned names or prompts live here. Names are operator-owned and never sent as classification criteria. */
export function validateZeroTouchConfig(value) {
	if (value === undefined || value === null) return null;
	if (!own(value, ["capture", "model", "maxCostUsd", "confidence", "names"]) || typeof value.capture !== "boolean") throw new Error("zeroTouch requires capture and only declared grouping settings");
	if (typeof value.model !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./:@~+-]{1,128}$/.test(value.model)) throw new Error("zeroTouch.model requires an explicit provider/model");
	if (typeof value.maxCostUsd !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value.maxCostUsd) || !Number.isSafeInteger(Number(value.maxCostUsd) * 1e6)) throw new Error("zeroTouch.maxCostUsd must be a bounded dollar string");
	const confidence = value.confidence ?? 0.9;
	if (typeof confidence !== "number" || confidence <= 0.5 || confidence > 1) throw new Error("zeroTouch.confidence must be above 0.5 and at most 1");
	const names = value.names ?? {};
	if (!object(names) || Object.keys(names).length > 1000) throw new Error("zeroTouch.names must hold at most 1000 human names");
	for (const [id, name] of Object.entries(names)) if (!GROUP_ID_RE.test(id) || typeof name !== "string" || !name.trim() || [...name].length > 120 || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(name)) throw new Error("zeroTouch group names must be human text of 1 to 120 characters without controls");
	return { capture: value.capture, model: value.model, maxCostUsd: value.maxCostUsd, confidence, names: { ...names } };
}

/** Redact before bounding; silently cutting before redaction can expose the head of a secret. */
export function privateQuestionExcerpt(text, redact) {
	if (typeof redact !== "function" || typeof text !== "string" || text === "") return { status: "source-unavailable" };
	let clean;
	try { clean = redact(text); } catch { return { status: "source-unavailable" }; }
	if (typeof clean !== "string" || !clean.trim()) return { status: "source-unavailable" };
	// The caller supplies the run's final bounded context, not a model-generated summary. Overlong context is
	// refused rather than pretending the omitted half of a question was understood.
	if (Buffer.byteLength(clean) > QUESTION_GROUP_LIMITS.excerptBytes) return { status: "source-oversize" };
	return { status: "unassigned", excerpt: clean };
}

export const QUESTION_CAPTURE_SCRIPT = `
if redis.call("EXISTS", KEYS[2]) == 1 then return "existing" end
redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[4])
redis.call("SET", KEYS[2], ARGV[2], "PX", ARGV[5])
redis.call("ZADD", KEYS[3], ARGV[3], ARGV[6])
redis.call("ZADD", KEYS[4], ARGV[3], ARGV[6])
local cut = redis.call("ZRANGE", KEYS[3], 0, -tonumber(ARGV[7])-1)
for _, id in ipairs(cut) do redis.call("DEL", ARGV[9] .. id) end
if #cut > 0 then redis.call("ZREM", KEYS[3], unpack(cut)) end
redis.call("ZREMRANGEBYRANK", KEYS[4], 0, -tonumber(ARGV[8])-1)
redis.call("PEXPIRE", KEYS[3], ARGV[4]); redis.call("PEXPIRE", KEYS[4], ARGV[5])
return "captured"
`;
export const QUESTION_ASSIGN_SCRIPT = `
local old = redis.call("GET", KEYS[2])
if not old then return "source-expired" end
local meta = cjson.decode(old)
if meta.groupId then return "existing" end
if meta.digest ~= ARGV[1] then return "stale" end
local rev = tonumber(redis.call("HGET", KEYS[1], "revision") or "0")
if rev ~= tonumber(ARGV[2]) then return "stale" end
if ARGV[3] == "new" then
 redis.call("HSET", KEYS[1], ARGV[4], ARGV[5], "revision", rev + 1)
elseif redis.call("HEXISTS", KEYS[1], ARGV[4]) == 0 then return "stale" end
meta.groupId = ARGV[4]; meta.status = "assigned"
redis.call("SET", KEYS[2], cjson.encode(meta), "PX", ARGV[6])
redis.call("PEXPIRE", KEYS[1], ARGV[6])
return "assigned"
`;

function bounded(promise, ms) {
	let timer;
	return Promise.race([Promise.resolve(promise), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("question-store-timeout")), ms); })]).finally(() => clearTimeout(timer));
}
const json = (value) => { try { return JSON.parse(value); } catch { return null; } };
const validMeta = (m) => own(m, ["v", "runId", "scopeId", "project", "repo", "at", "digest", "status", "groupId", "triggerIndex", "contextTruncated"]) && m.v === 1 && QUESTION_RUN_RE.test(m.runId) && QUESTION_SCOPE_RE.test(m.scopeId) && integer(m.at) && /^[a-f0-9]{64}$/.test(m.digest) && QUESTION_GROUP_STATUSES.includes(m.status) && (m.groupId === undefined || GROUP_ID_RE.test(m.groupId)) && (m.project === null || safeWord(m.project, 64)) && (m.repo === null || safeWord(m.repo)) && (m.triggerIndex === undefined || integer(m.triggerIndex)) && (m.contextTruncated === undefined || typeof m.contextTruncated === "boolean");

export function makeQuestionGroupStore({ redis, now = Date.now, retentionDays = 30, prefix = "zero-touch:questions:", timeoutMs = QUESTION_GROUP_LIMITS.timeoutMs } = {}) {
	const days = Number(retentionDays);
	// Even keep-forever deployments have a finite private corpus. Its shorter availability is explicit.
	const ttlMs = Math.min(Number.isFinite(days) && days > 0 ? days : QUESTION_GROUP_LIMITS.retentionDays, QUESTION_GROUP_LIMITS.retentionDays) * 86400000;
	const metaTtlMs = Math.max(ttlMs, 86400000);
	const token = (runId) => sha(runId);
	const privateKey = (runId) => `${prefix}private:${token(runId)}`;
	const metaKey = (runId) => `${prefix}meta:${token(runId)}`;
	const command = (method, ...args) => bounded(redis[method](...args), timeoutMs);
	async function readMeta(runId) {
		if (!QUESTION_RUN_RE.test(runId ?? "")) return null;
		const raw = await command("get", metaKey(runId));
		if (typeof raw !== "string" || Buffer.byteLength(raw) > 2048) return null;
		const meta = json(raw);
		return validMeta(meta) ? meta : null;
	}
	return {
		async capture({ runId, scopeId, project = null, repo = null, at = now(), text, redact, triggerIndex, sourceStatus = null, contextTruncated = false } = {}) {
			if (!QUESTION_RUN_RE.test(runId ?? "") || !QUESTION_SCOPE_RE.test(scopeId ?? "") || !integer(at) || project !== null && !safeWord(project, 64) || repo !== null && !safeWord(repo) || triggerIndex !== undefined && !integer(triggerIndex)) return { ok: false, status: "source-unavailable" };
			if (sourceStatus !== null && !["source-unavailable", "source-oversize"].includes(sourceStatus) || typeof contextTruncated !== "boolean") return { ok: false, status: "source-unavailable" };
			const selected = sourceStatus === null ? privateQuestionExcerpt(text, redact) : { status: sourceStatus };
			const digest = sha(selected.excerpt ?? `${runId}:${selected.status}`);
			const meta = { v: 1, runId, scopeId, project, repo, at, digest, status: selected.status, ...(contextTruncated ? { contextTruncated: true } : {}), ...(triggerIndex !== undefined ? { triggerIndex } : {}) };
			try {
				if (selected.excerpt === undefined) {
					await command("set", metaKey(runId), JSON.stringify(meta), "PX", metaTtlMs, "NX");
					await command("zadd", `${prefix}index`, at, token(runId));
					await command("pexpire", `${prefix}index`, metaTtlMs);
					return { ok: true, status: selected.status };
				}
				await command("eval", QUESTION_CAPTURE_SCRIPT, 4, privateKey(runId), metaKey(runId), `${prefix}corpus`, `${prefix}index`, JSON.stringify({ v: 1, runId, scopeId, at, digest, excerpt: selected.excerpt }), JSON.stringify(meta), at, ttlMs, metaTtlMs, token(runId), QUESTION_GROUP_LIMITS.corpusEntries, QUESTION_GROUP_LIMITS.metadataEntries, `${prefix}private:`);
				return { ok: true, status: "unassigned" };
			} catch { return { ok: false, status: "source-unavailable" }; }
		},
		readMeta,
		async publicSnapshot({ sinceMs = 0, names = {} } = {}) {
			try {
				const ids = await command("zrevrangebyscore", `${prefix}index`, "+inf", sinceMs, "LIMIT", 0, QUESTION_GROUP_LIMITS.metadataEntries);
				if (!Array.isArray(ids) || ids.some((id) => !/^[a-f0-9]{64}$/.test(id))) throw new Error("invalid index");
				const raw = ids.length ? await command("mget", ...ids.map((id) => `${prefix}meta:${id}`)) : [];
				const rows = raw.map(json).filter(validMeta);
				// Availability probes read only key existence. A public projection never loads private bytes.
				for (let i = 0; i < rows.length; i += 100) {
					await Promise.all(rows.slice(i, i + 100).map(async row => {
						if (!row.groupId && ["unassigned", "pending", "failed", "stale"].includes(row.status) && !await command("exists", privateKey(row.runId))) row.status = "source-expired";
					}));
				}
				const groups = new Map();
				for (const row of rows) {
					const id = row.groupId ?? `unassigned-${row.scopeId}`;
					if (!groups.has(id)) groups.set(id, { id: row.groupId ?? null, name: row.groupId && typeof names[row.groupId] === "string" ? names[row.groupId] : null, scopeId: row.scopeId, repo: row.repo, project: row.project, count: 0, runIds: [], status: row.groupId ? "open" : "unassigned", sourceStatus: row.status, ...(row.triggerIndex !== undefined ? { triggerIndex: row.triggerIndex } : {}) });
					const group = groups.get(id); group.count++; group.runIds.push(row.runId);
				}
				return { state: "ok", groups: [...groups.values()], rows, partial: rows.length !== raw.length || ids.length === QUESTION_GROUP_LIMITS.metadataEntries || rows.some(row => row.contextTruncated === true) };
			} catch { return { state: "unavailable", groups: [], rows: [], partial: true }; }
		},
		async privateInput(runId) {
			const meta = await readMeta(runId);
			if (!meta || !["unassigned", "pending", "assigned", "failed", "stale", "refused"].includes(meta.status)) return { status: meta?.status ?? "source-expired" };
			const raw = await command("get", privateKey(runId));
			if (typeof raw !== "string" || Buffer.byteLength(raw) > QUESTION_GROUP_LIMITS.excerptBytes + 1024) return { status: "source-expired" };
			const source = json(raw);
			if (!object(source) || source.runId !== runId || source.scopeId !== meta.scopeId || source.digest !== meta.digest || typeof source.excerpt !== "string" || sha(source.excerpt) !== meta.digest) return { status: "source-unavailable" };
			const groupRaw = await command("hgetall", `${prefix}groups:${meta.scopeId}`);
			const revision = Number(groupRaw.revision ?? 0);
			const candidates = [];
			for (const [id, encoded] of Object.entries(groupRaw)) {
				if (id === "revision") continue;
				const candidate = json(encoded);
				if (!GROUP_ID_RE.test(id) || !own(candidate, ["id", "runId", "at"]) || candidate.id !== id || !QUESTION_RUN_RE.test(candidate.runId) || !integer(candidate.at)) return { status: "source-unavailable" };
				const exemplarRaw = await command("get", privateKey(candidate.runId));
				const exemplar = typeof exemplarRaw === "string" && Buffer.byteLength(exemplarRaw) <= QUESTION_GROUP_LIMITS.excerptBytes + 1024 ? json(exemplarRaw) : null;
				if (!exemplar || exemplar.scopeId !== meta.scopeId || typeof exemplar.excerpt !== "string" || sha(exemplar.excerpt) !== exemplar.digest) return { status: "candidates-expired" };
				candidates.push({ id, runId: candidate.runId, excerpt: exemplar.excerpt });
			}
			if (candidates.length > QUESTION_GROUP_LIMITS.candidates) return { status: "group-limit" };
			return { status: "ready", meta, revision, excerpt: source.excerpt, candidates: candidates.sort((a, b) => a.id.localeCompare(b.id)) };
		},
		async assign({ runId, digest, revision, groupId = null } = {}) {
			const meta = await readMeta(runId);
			if (!meta || meta.digest !== digest || !integer(revision) || groupId !== null && !GROUP_ID_RE.test(groupId)) return { status: "stale" };
			const id = groupId ?? sha(`${meta.scopeId}\0${runId}`).slice(0, 32);
			const status = await command("eval", QUESTION_ASSIGN_SCRIPT, 2, `${prefix}groups:${meta.scopeId}`, metaKey(runId), digest, revision, groupId === null ? "new" : "existing", id, JSON.stringify({ id, runId, at: meta.at }), metaTtlMs);
			return { status, ...(status === "assigned" || status === "existing" ? { groupId: id } : {}) };
		},
		async setStatus(runId, status) {
			if (!QUESTION_GROUP_STATUSES.includes(status)) return false;
			if (!QUESTION_RUN_RE.test(runId ?? "")) return false;
			const script = `local raw=redis.call("GET",KEYS[1]); if not raw then return 0 end; local meta=cjson.decode(raw); if meta.groupId then return 0 end; meta.status=ARGV[1]; redis.call("SET",KEYS[1],cjson.encode(meta),"PX",ARGV[2]); return 1`;
			return await command("eval", script, 1, metaKey(runId), status, metaTtlMs) === 1;
		},
	};
}
