import { createHash } from "node:crypto";
import { PROJECT_ID_RE } from "./project-id.mjs";
import { SKILL_NAME_RE } from "./flow-gate.mjs";
import { parseUsdMicros } from "./money.mjs";

export const ANSWER_CATEGORIES = Object.freeze(["convention", "how-to", "decided"]);
export const ANSWER_CLASSIFICATIONS = Object.freeze([...ANSWER_CATEGORIES, "product", "security", "money", "scope", "approval", "uncovered"]);
export const ANSWER_REASONS = Object.freeze(["approval", "outside-projects", "source-unavailable", "source-oversize", "category-disallowed", "low-confidence", "uncovered", "classify-only", "config-changed", "output-invalid", "failed", "cap-refused"]);
export const ANSWER_STATUSES = Object.freeze(["pending", "queued", "running", "drafted", "passed", "failed", "dropped", "sent"]);
export const ANSWER_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
export const ANSWER_RUN_RE = /^[A-Za-z0-9._:-]{1,200}$/;
export const QUESTION_COMMENT_RE = /^(?:[1-9][0-9]{0,19}|[a-fA-F0-9-]{36})$/;
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const only = (v, keys) => object(v) && Object.keys(v).every(k => keys.includes(k));
const bounded = (v, n) => typeof v === "string" && Buffer.byteLength(v) <= n && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(v);
const projects = v => Array.isArray(v) && v.length > 0 && v.length <= 100 && new Set(v).size === v.length && v.every(p => typeof p === "string" && PROJECT_ID_RE.test(p));
const model = v => typeof v === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./:@~+-]{1,128}$/.test(v);
/** Captured forge identity is an HTTPS instance base; host constructors append their own API prefix.
 * Keep the pathname: stripping /api/v4 or /api/v1 would equate different reviewed instance bases. */
export function answerApiRoot(value) {
	if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash ? url.href.replace(/\/+$/, "") : null;
	} catch { return null; }
}
export const answerConfigDigest = v => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export const answerRuleConfig = (doc, rule) => ({ rule, standing: (doc.standingAnswers ?? []).filter(a => a.projects.some(p => rule.projects.includes(p))) });
export const answerRuleConfigDigest = (doc, rule) => answerConfigDigest(answerRuleConfig(doc, rule));
export function answerStandingSource(answer) {
	const source = { kind: "standing", name: answer.title, revision: answerConfigDigest(answer) };
	return { id: answerConfigDigest(source), ...source };
}
const fail = message => { throw new Error(message); };

/** Only hand-authored rules can buy a draft. Unknown fields refuse instead of quietly dropping a bound. */
export function validateAnswerRules(value) {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 100) fail("answerRules must be an array of at most 100 reviewed rules");
	const ids = new Set(), claimed = new Set();
	for (const r of value) {
		if (!only(r, ["id", "projects", "categories", "confidence", "mode", "flow", "model", "decisionModel", "maxCostUsd"]) || !ANSWER_ID_RE.test(r.id ?? "") || ids.has(r.id)) fail("answerRules requires unique rule ids and only declared fields");
		if (!projects(r.projects) || r.projects.some(p => claimed.has(p))) fail("answerRules projects must be valid, unique and belong to at most one rule");
		if (!Array.isArray(r.categories) || !r.categories.length || new Set(r.categories).size !== r.categories.length || r.categories.some(c => !ANSWER_CATEGORIES.includes(c))) fail("answerRules categories are convention, how-to and decided");
		if (typeof r.confidence !== "number" || !Number.isFinite(r.confidence) || r.confidence <= 0.5 || r.confidence > 1) fail("answerRules confidence must be above 0.5 and at most 1");
		if (!["classify", "draft"].includes(r.mode) || typeof r.flow !== "string" || !SKILL_NAME_RE.test(r.flow) || !model(r.model) || !model(r.decisionModel) || parseUsdMicros(r.maxCostUsd) === null) fail("answerRules requires a mode, flow, explicit model and decisionModel, and dollar cap");
		ids.add(r.id); for (const p of r.projects) claimed.add(p);
	}
	return JSON.parse(JSON.stringify(value));
}

export function validateStandingAnswers(value) {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 1000) fail("standingAnswers must be an array of at most 1000 reviewed answers");
	const ids = new Set();
	for (const a of value) {
		if (!only(a, ["id", "title", "text", "projects", "repo", "adoptedAt"]) || !ANSWER_ID_RE.test(a.id ?? "") || ids.has(a.id) || !bounded(a.title, 160) || !a.title.trim() || !bounded(a.text, 8192) || !a.text.trim() || !projects(a.projects) || typeof a.repo !== "string" || !/^(?:github|gitlab|forgejo|azure):[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+$/.test(a.repo)) fail("standingAnswers requires unique ids, title, bounded text, project scope and a forge-qualified repository");
		if (a.adoptedAt !== undefined && (typeof a.adoptedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(a.adoptedAt) || !Number.isFinite(Date.parse(a.adoptedAt)) || new Date(a.adoptedAt).toISOString() !== a.adoptedAt)) fail("standingAnswers adoptedAt must be a canonical UTC instant");
		if (/[\r\n\t]/.test(a.title)) fail("standingAnswers title must fit on one line");
		ids.add(a.id);
	}
	if (Buffer.byteLength(JSON.stringify(value)) > 262144) fail("standingAnswers exceeds the 256 KiB reviewed corpus limit");
	return JSON.parse(JSON.stringify(value));
}

/** Source kinds are closed. A private decision adapter supplies data through this seam, never execution authority. */
export function validAnswerSource(s) {
	if (!only(s, ["id", "kind", "name", "revision", "url"]) || !/^[a-f0-9]{64}$/.test(s.id ?? "") || !["standing", "repository", "reply"].includes(s.kind) || !bounded(s.name, 200) || !s.name.length || /[\r\n\t]/.test(s.name) || !(s.kind === "repository" ? /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/ : /^[a-f0-9]{64}$/).test(s.revision ?? "")) return false;
	if (s.url !== undefined) { try { const u = new URL(s.url); if (u.protocol !== "https:" || u.username || u.password || typeof s.url !== "string" || s.url.length > 2048) return false; } catch { return false; } }
	return true;
}

const json = text => { try { return JSON.parse(text); } catch { return null; } };
const META_MAX_BYTES = 16384, INPUT_MAX_BYTES = 16384, PRIVATE_MAX_BYTES = 65536;
const probability = n => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
const distribution = m => object(m.probabilities) && ANSWER_CLASSIFICATIONS.includes(m.category) && Object.keys(m.probabilities).sort().join() === [...ANSWER_CLASSIFICATIONS].sort().join() && Object.values(m.probabilities).every(probability) && Math.abs(Object.values(m.probabilities).reduce((a, b) => a + b, 0) - 1) <= 0.000001 && m.confidence === m.probabilities[m.category] && Object.values(m.probabilities).every(p => p <= m.confidence);
const validMeta = m => only(m, ["v", "runId", "ruleId", "draftRunId", "draftDigest", "status", "at", "draftExists", "sources", "passReason", "category", "confidence", "answerableConfidence", "probabilities", "costUsd", "sentAt", "by", "disposition"]) && m.v === 1 && ANSWER_RUN_RE.test(m.runId ?? "") && ANSWER_ID_RE.test(m.ruleId ?? "") && ANSWER_STATUSES.includes(m.status) && (m.draftRunId === null || ANSWER_RUN_RE.test(m.draftRunId ?? "")) && Number.isSafeInteger(m.at) && m.at >= 0 && typeof m.draftExists === "boolean" && Array.isArray(m.sources) && m.sources.length <= 32 && m.sources.every(validAnswerSource) && (m.passReason === undefined || ANSWER_REASONS.includes(m.passReason)) && (m.category === undefined || ANSWER_CLASSIFICATIONS.includes(m.category)) && ["confidence", "answerableConfidence"].every(k => m[k] === undefined || probability(m[k])) && (m.probabilities === undefined || distribution(m)) && (m.draftDigest === undefined || /^[a-f0-9]{64}$/.test(m.draftDigest)) && (m.costUsd === undefined || m.costUsd === null || typeof m.costUsd === "number" && Number.isFinite(m.costUsd) && m.costUsd >= 0) && (m.sentAt === undefined || Number.isSafeInteger(m.sentAt) && m.sentAt >= 0) && (m.by === undefined || /^[a-z0-9][a-z0-9._-]{0,31}$/.test(m.by)) && (m.disposition === undefined || ["as-drafted", "edited"].includes(m.disposition));

/** Private bodies never ride public reads. All keys and indexes expire even on keep-forever deployments. */
export function makeAnswerDraftStore({ redis, now = Date.now, retentionDays = 30, prefix = "answerer:", timeoutMs = 2000 } = {}) {
	const days = Number.isFinite(Number(retentionDays)) && Number(retentionDays) > 0 ? Math.min(Number(retentionDays), 90) : 90;
	const ttl = Math.round(days * 86400000);
	const key = (part, runId) => `${prefix}${part}:${answerConfigDigest(runId)}`;
	async function command(method, ...args) {
		let timer;
		try { return await Promise.race([redis[method](...args), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("answer-store-timeout")), timeoutMs); })]); }
		finally { clearTimeout(timer); }
	}
	async function readMeta(runId) {
		if (!ANSWER_RUN_RE.test(runId ?? "")) return null;
		const raw = await command("get", key("meta", runId));
		if (typeof raw !== "string" || Buffer.byteLength(raw) > META_MAX_BYTES) return null;
		const m = json(raw); return validMeta(m) && m.at >= now() - ttl ? m : null;
	}
	async function update(runId, fields, expected = {}) {
		const allowed = ["status", "draftRunId", "draftDigest", "draftExists", "passReason", "category", "confidence", "answerableConfidence", "probabilities", "sources", "costUsd", "sentAt", "by", "disposition"];
		if (!only(fields, allowed)) return false;
		// Compare serialized bytes. Redis Lua's cjson turns an empty JSON array into {}, which would
		// silently invalidate a queued row's empty sources on its very first status transition.
		const script = `if redis.call("GET",KEYS[1])~=ARGV[1] then return 0 end; redis.call("SET",KEYS[1],ARGV[2],"KEEPTTL"); return 1`;
		for (let attempt = 0; attempt < 3; attempt++) {
			const raw = await command("get", key("meta", runId)), m = typeof raw === "string" ? json(raw) : null;
			if (typeof raw !== "string" || Buffer.byteLength(raw) > META_MAX_BYTES || !validMeta(m) || ["sent", "dropped", "failed", "passed"].includes(m.status)) return false;
			if (Object.entries(expected).some(([k, v]) => !["draftRunId", "draftDigest"].includes(k) || m[k] !== v)) return false;
			if (m.status === "drafted" && !["sent", "dropped"].includes(fields.status) || fields.status === "queued" && m.status !== "pending") return false;
			const next = { ...m, ...fields }; if (!validMeta(next)) return false;
			const text = JSON.stringify(next); if (Buffer.byteLength(text) > META_MAX_BYTES) return false;
			if (await command("eval", script, 1, key("meta", runId), raw, text) === 1) return true;
		}
		return false;
	}
	return {
		readMeta, update,
		async capture(input, meta) {
			if (!validMeta(meta) || input.runId !== meta.runId) return false;
			const inputText = JSON.stringify(input), metaText = JSON.stringify(meta);
			if (Buffer.byteLength(inputText) > INPUT_MAX_BYTES || Buffer.byteLength(metaText) > META_MAX_BYTES) return false;
			const script = `if redis.call("EXISTS",KEYS[1])==1 then return 0 end; redis.call("SET",KEYS[1],ARGV[1],"PX",ARGV[3]); redis.call("SET",KEYS[2],ARGV[2],"PX",ARGV[3]); redis.call("ZADD",KEYS[3],ARGV[4],ARGV[5]); redis.call("PEXPIRE",KEYS[3],ARGV[3]); redis.call("ZREMRANGEBYRANK",KEYS[3],0,-5001); return 1`;
			return await command("eval", script, 3, key("meta", meta.runId), key("input", meta.runId), `${prefix}index`, metaText, inputText, ttl, meta.at, meta.runId) === 1;
		},
		async privateInput(runId) {
			const raw = await command("get", key("input", runId));
			return typeof raw === "string" && Buffer.byteLength(raw) <= INPUT_MAX_BYTES ? json(raw) : null;
		},
		async pending() {
			const rows = await this.publicSnapshot();
			if (rows.state !== "ok") throw new Error("answer-store-unavailable");
			return rows.rows.filter(m => m.status === "pending");
		},
		async publicSnapshot() {
			try {
				const ids = await command("zrevrangebyscore", `${prefix}index`, "+inf", now() - ttl, "LIMIT", 0, 5000);
				if (!Array.isArray(ids)) throw new Error("invalid-index");
				const rows = (await Promise.all(ids.filter(id => ANSWER_RUN_RE.test(id)).map(readMeta))).filter(Boolean);
				return { state: "ok", rows, partial: ids.length >= 5000 || rows.length !== ids.length };
			} catch { return { state: "unavailable", rows: [], partial: true }; }
		},
		async saveDraft(runId, { question, draft, sources, digest }) {
			if (!bounded(question, 16384) || !bounded(draft, 8192) || !draft.trim() || !Array.isArray(sources) || !sources.length || sources.length > 32 || !sources.every(validAnswerSource) || digest !== answerConfigDigest({ question, draft, sources })) return false;
			const privateText = JSON.stringify({ question, draft, sources, digest });
			if (Buffer.byteLength(privateText) > PRIVATE_MAX_BYTES) return false;
			const script = `if redis.call("GET",KEYS[1])~=ARGV[1] then return 0 end; local ttl=redis.call("PTTL",KEYS[1]); if ttl<=0 then return 0 end; redis.call("SET",KEYS[2],ARGV[3],"PX",ttl); redis.call("SET",KEYS[1],ARGV[2],"KEEPTTL"); return 1`;
			for (let attempt = 0; attempt < 3; attempt++) {
				const raw = await command("get", key("meta", runId)), meta = typeof raw === "string" ? json(raw) : null;
				if (typeof raw !== "string" || Buffer.byteLength(raw) > META_MAX_BYTES || !validMeta(meta) || !["pending", "queued", "running"].includes(meta.status)) return false;
				const next = { ...meta, status: "drafted", draftExists: true, draftDigest: digest, sources };
				const metaText = JSON.stringify(next); if (Buffer.byteLength(metaText) > META_MAX_BYTES) return false;
				if (await command("eval", script, 2, key("meta", runId), key("private", runId), raw, metaText, privateText) === 1) return true;
			}
			return false;
		},
		async privateDraft(runId) {
			const meta = await readMeta(runId);
			if (!meta || meta.status !== "drafted" || meta.draftExists !== true) return null;
			const raw = await command("get", key("private", runId));
			const p = typeof raw === "string" && Buffer.byteLength(raw) <= PRIVATE_MAX_BYTES ? json(raw) : null;
			if (!p || !bounded(p.question, 16384) || !bounded(p.draft, 8192) || !Array.isArray(p.sources) || !p.sources.length || !p.sources.every(validAnswerSource) || p.digest !== meta.draftDigest || p.digest !== answerConfigDigest({ question: p.question, draft: p.draft, sources: p.sources })) return null;
			return { meta, ...p };
		},
		async drop(runId, expected = {}) {
			const changed = await update(runId, { status: "dropped", draftExists: false }, expected);
			if (changed) await command("del", key("private", runId));
			return changed;
		},
		async markSent(runId, { by, at = now(), draftRunId, draftDigest, disposition }) {
			if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(by ?? "") || !Number.isSafeInteger(at) || !ANSWER_RUN_RE.test(draftRunId ?? "") || !/^[a-f0-9]{64}$/.test(draftDigest ?? "") || !["as-drafted", "edited"].includes(disposition)) return false;
			const meta = await readMeta(runId);
			if (!meta || meta.status !== "drafted" || !meta.draftExists || meta.draftRunId !== draftRunId) return false;
			const changed = await update(runId, { status: "sent", draftExists: false, by, sentAt: at, disposition }, { draftRunId, draftDigest });
			if (changed) await command("del", key("private", runId));
			return changed;
		},
	};
}
