import { createHash } from "node:crypto";
import { GROUP_ID_RE, QUESTION_RUN_RE, QUESTION_SCOPE_RE } from "./question-groups.mjs";
import { REASONS } from "./reason-catalog.mjs";
export const FIX_KINDS = Object.freeze(["instructions", "config"]);
const DAY = 86400000;
const idOf = value => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
export function validFix(value) {
	return value && Object.keys(value).every(key => ["id", "kind", "at", "runId", "scopeId", "project", "groupId", "reason", "triggerIndex", "undoneAt", "state"].includes(key)) && /^[a-f0-9]{32}$/.test(value.id) && FIX_KINDS.includes(value.kind) && (value.state === undefined || ["pending", "applied", "refused"].includes(value.state)) && Number.isSafeInteger(value.at) && value.at >= 0 && QUESTION_RUN_RE.test(value.runId) && QUESTION_SCOPE_RE.test(value.scopeId) && (value.project === null || typeof value.project === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value.project)) && ((GROUP_ID_RE.test(value.groupId ?? "") && value.reason === null) || (value.groupId === null && Object.hasOwn(REASONS, value.reason))) && (value.triggerIndex === null || Number.isSafeInteger(value.triggerIndex) && value.triggerIndex >= 0) && (value.undoneAt === undefined || Number.isSafeInteger(value.undoneAt) && value.undoneAt >= value.at);
}
/** Safe fix telemetry is public; the exact human instruction used for Undo is private. */
export function makeZeroTouchFixStore({ redis, now = Date.now, retentionDays = 30, prefix = "zero-touch:fixes:" } = {}) {
	const bounded = promise => { let timer; return Promise.race([Promise.resolve(promise), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("fix-store-timeout")), 2000); })]).finally(() => clearTimeout(timer)); };
	const command = (method, ...args) => bounded(redis[method](...args));
	const ttl = Math.min(Number(retentionDays) > 0 ? Number(retentionDays) : 365, 365) * DAY;
	return {
		async add(value, { privateUndo = null, identity = null, pending = false } = {}) {
			const fix = { id: idOf(identity ?? value), kind: value.kind, at: value.at ?? now(), runId: value.runId, scopeId: value.scopeId, project: value.project ?? null, groupId: value.groupId ?? null, reason: value.reason ?? null, triggerIndex: value.triggerIndex ?? null, state: pending ? "pending" : "applied" };
			if (!validFix(fix)) return { invalid: "the fix has no validated source cause" };
			const tx = redis.multi();
			tx.set(`${prefix}meta:${fix.id}`, JSON.stringify(fix), "PX", ttl, "NX");
			if (privateUndo) tx.set(`${prefix}private:${fix.id}`, JSON.stringify(privateUndo), "PX", ttl, "NX");
			tx.zadd(`${prefix}index`, fix.at, fix.id); tx.zremrangebyrank(`${prefix}index`, 0, -5001); tx.pexpire(`${prefix}index`, ttl);
			const result = await bounded(tx.exec());
			if (!Array.isArray(result) || result.some(row => row[0])) throw new Error("fix metadata unavailable");
			return { ok: true, fix };
		},
		async read(id, { includeUndo = false } = {}) {
			if (!/^[a-f0-9]{32}$/.test(id ?? "")) return null;
			const raw = await command("get", `${prefix}meta:${id}`);
			let fix; try { if (typeof raw !== "string" || raw.length > 2048) return null; fix = JSON.parse(raw); } catch { return null; }
			if (!validFix(fix)) return null;
			if (!includeUndo) return fix;
			const body = await command("get", `${prefix}private:${id}`);
			let undo; try { if (typeof body !== "string" || Buffer.byteLength(body) > 8192) return null; undo = JSON.parse(body); } catch { return null; }
			if (!undo) return null;
			const instructionProof = Object.keys(undo).sort().join() === "after,before,index,triggerDigest" && Number.isSafeInteger(undo.index) && (undo.before === null || typeof undo.before === "string") && typeof undo.after === "string" && /^[a-f0-9]{64}$/.test(undo.triggerDigest ?? "");
			const fileProof = Object.keys(undo).sort().join() === "afterDigest,file" && typeof undo.file === "string" && undo.file.length <= 4096 && !/[\u0000-\u001f]/u.test(undo.file) && /^[a-f0-9]{64}$/.test(undo.afterDigest ?? "");
			if (!instructionProof && !fileProof) return null;
			return { ...fix, undo };
		},
		async publicSnapshot({ sinceMs = 0 } = {}) {
			try {
				const ids = await command("zrevrangebyscore", `${prefix}index`, "+inf", sinceMs, "LIMIT", 0, 5000);
				const fixes = (await Promise.all(ids.map(id => this.read(id)))).filter(Boolean);
				const pendingCount = fixes.filter(fix => fix.state === "pending").length;
				return { state: "ok", fixes: fixes.filter(fix => fix.state === undefined || fix.state === "applied"), pendingCount, partial: fixes.length !== ids.length || ids.length === 5000 || pendingCount > 0 };
			} catch { return { state: "unavailable", fixes: [], partial: true }; }
		},
		async stage(value, options = {}) { return this.add(value, { ...options, pending: true }); },
		async commit(id) {
			const fix = await this.read(id); if (!fix || fix.state === "refused") return false;
			await command("set", `${prefix}meta:${id}`, JSON.stringify({ ...fix, state: "applied" }), "PX", ttl); return true;
		},
		async reject(id) {
			const fix = await this.read(id); if (!fix || fix.state !== "pending") return false;
			await command("set", `${prefix}meta:${id}`, JSON.stringify({ ...fix, state: "refused" }), "PX", ttl); return true;
		},
		async repair({ readTrigger, readFile } = {}) {
			if (typeof readTrigger !== "function" && typeof readFile !== "function") return;
			const ids = await command("zrevrangebyscore", `${prefix}index`, "+inf", 0, "LIMIT", 0, 5000);
			for (const id of ids) {
				const fix = await this.read(id, { includeUndo: true });
				if (!fix || fix.state !== "pending") continue;
				try {
					if (fix.undo.file && typeof readFile === "function") {
						// The caller owns the configuration path allowlist. A peer-written path cannot choose a read here.
						const bytes = await readFile(fix.undo.file);
						if ((typeof bytes === "string" || Buffer.isBuffer(bytes)) && createHash("sha256").update(bytes).digest("hex") === fix.undo.afterDigest) await this.commit(id);
					} else if (typeof readTrigger === "function") {
						const current = await readTrigger(fix.undo.index);
						if (current && createHash("sha256").update(JSON.stringify(current)).digest("hex") === fix.undo.triggerDigest) await this.commit(id);
					}
				} catch { /* An unprovable outcome remains pending, never replayed. */ }
			}
		},
		async markUndone(id, at = now()) {
			const fix = await this.read(id); if (!fix || fix.undoneAt) return false;
			await command("set", `${prefix}meta:${id}`, JSON.stringify({ ...fix, undoneAt: at }), "PX", ttl); return true;
		},
	};
}

/** Occurrences, not touch attribution: an unanswered question or untouched refusal still demonstrates recurrence. */
export function compareZeroTouchFixes({ fixes = [], records = [], assignments = [], coverageFromMs, nowMs, windowDays = 30 } = {}) {
	const at = row => Date.parse(row.endedAt ?? "");
	return fixes.filter(validFix).map(fix => {
		const spanMs = Math.max(0, Math.min(windowDays * DAY, nowMs - fix.at, fix.undoneAt === undefined ? Infinity : fix.undoneAt - fix.at));
		const beforeFrom = fix.at - spanMs, afterTo = fix.at + spanMs;
		const sameScope = row => (row.touchScopeId ?? row.scopeId) === fix.scopeId;
		const inSpan = (value, from, to) => value >= from && value < to;
		const matches = fix.groupId ? assignments.filter(row => row.groupId === fix.groupId && (row.scopeId === fix.scopeId)) : records.filter(row => sameScope(row) && row.reason === fix.reason);
		const time = row => Number.isSafeInteger(row.at) ? row.at : at(row);
		const beforeCount = matches.filter(row => inSpan(time(row), beforeFrom, fix.at)).length;
		const afterCount = matches.filter(row => inSpan(time(row), fix.at, afterTo)).length;
		const subsequentRuns = records.filter(row => sameScope(row) && row.purpose !== "zero-touch-grouping" && inSpan(at(row), fix.at, afterTo)).length;
		const partial = !Number.isFinite(coverageFromMs) || beforeFrom < coverageFromMs || spanMs <= 0;
		return { ...fix, spanMs, beforeCount, afterCount, subsequentRuns, partial, status: partial || subsequentRuns === 0 || fix.undoneAt !== undefined ? "observing" : afterCount < beforeCount ? "improved" : afterCount > beforeCount ? "worse" : "unchanged" };
	});
}
