/**
 * Free, fail-closed approval transcript preflight (issue #649). An approval cannot cold-start: before credentials,
 * clone or reservation, its canonical session must still end on the exact unanswered request. This intentionally
 * validates only a narrow raw shape, not pi's projection algorithm. The runner checks the pinned SDK's projection
 * again on the staged file. Descriptor reads and path identity rechecks prevent a swapped name deciding this gate.
 */
import * as nodeFs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { SESSION_KEY_PATTERN } from "./session-key.mjs";
import { hasEmptyCompaction } from "./session-store.mjs";
import { MODEL_REF_PATTERN } from "./model-ref.mjs";

const REFUSED = Object.freeze({ refused: "approval-session-unavailable" });
const dirIdentity = (stat) => `${stat.dev}:${stat.ino}`;
const fileIdentity = (stat) => `${dirIdentity(stat)}:${stat.size}:${stat.mtimeMs}`;

/** Pure raw-branch check. Fail closed on ambiguity; the SDK's projected context remains a separate later check. */
export function approvalTranscriptMatches(text, request, { maxAgeDays = 0, now = () => Date.now() } = {}) {
	try {
		const entries = text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
		const header = entries.shift();
		if (header?.type !== "session" || typeof header.id !== "string" || entries.length === 0 || hasEmptyCompaction(text)) return false;
		if (maxAgeDays > 0) {
			const created = typeof header.timestamp === "string" ? Date.parse(header.timestamp) : NaN;
			if (!Number.isFinite(created) || now() - created > maxAgeDays * 86400_000) return false;
		}
		const byId = new Map();
		for (const entry of entries) {
			if (!entry || typeof entry.id !== "string" || !entry.id || byId.has(entry.id) || !(entry.parentId === null || typeof entry.parentId === "string")) return false;
			byId.set(entry.id, entry);
		}
		const branch = [];
		let leaf = entries.at(-1);
		const seen = new Set();
		while (leaf) {
			if (seen.has(leaf.id)) return false;
			seen.add(leaf.id);
			branch.unshift(leaf);
			if (leaf.parentId === null) break;
			leaf = byId.get(leaf.parentId);
			if (!leaf) return false;
		}
		const messages = branch.filter((entry) => entry.type === "message");
		const target = messages.at(-1);
		const result = target?.message;
		const caller = messages.at(-2)?.message;
		if (result?.role !== "toolResult" || result.toolName !== "request_approval" || result.toolCallId !== request.toolCallId || result.isError === true || result.details?.approval?.action !== request.action || result.details?.approval?.toolCallId !== request.toolCallId) return false;
		if (caller?.role !== "assistant" || !Array.isArray(caller.content) || !caller.content.some((part) => part?.type === "toolCall" && part.name === "request_approval" && part.id === request.toolCallId && part.arguments?.action === request.action)) return false;
		const at = branch.indexOf(target);
		if (branch.some((entry, index) => entry.type === "context_edit" && entry.targetId === target.id || index > at && ["compaction", "branch_summary", "custom_message"].includes(entry.type))) return false;
		return true;
	} catch { return false; }
}

export function makeApprovalSessionCheck({ sessionsDir, maxBytes = 8 * 1024 * 1024, ttlDays = 0, maxAgeDays = 0, maxResumeChain = 0, maxContextPct = null, now = () => Date.now(), fs = nodeFs } = {}) {
	const boundedRead = (path, bound) => {
		const before = fs.lstatSync(path);
		if (!before.isFile() || before.size <= 0 || !Number.isSafeInteger(before.size) || bound > 0 && before.size > bound) throw new Error("unavailable");
		let fd;
		try {
			fd = fs.openSync(path, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW);
			const opened = fs.fstatSync(fd);
			if (!opened.isFile() || fileIdentity(before) !== fileIdentity(opened)) throw new Error("unavailable");
			const bytes = Buffer.alloc(before.size + 1);
			let count = 0;
			while (count < bytes.length) {
				const read = fs.readSync(fd, bytes, count, bytes.length - count, count);
				if (read === 0) break;
				count += read;
			}
			if (count !== before.size || fileIdentity(fs.fstatSync(fd)) !== fileIdentity(before) || fileIdentity(fs.lstatSync(path)) !== fileIdentity(before)) throw new Error("unavailable");
			const snapshot = bytes.subarray(0, count);
			return { text: snapshot.toString("utf8"), digest: createHash("sha256").update(snapshot).digest("hex"), stat: before };
		} finally { if (fd !== undefined) fs.closeSync(fd); }
	};
	const validate = (request, expected = {}) => {
		try {
			if (typeof sessionsDir !== "string" || !sessionsDir || !SESSION_KEY_PATTERN.test(request?.sessionKey ?? "") || typeof request.action !== "string" || typeof request.toolCallId !== "string") return REFUSED;
			// The configured root may be a link, as in the existing session store. Only a derived key directory
			// must itself be real; the operator's chosen store location is not an attacker-derived pathname.
			const root = fs.statSync(sessionsDir);
			const directory = join(sessionsDir, request.sessionKey);
			const dir = fs.lstatSync(directory);
			if (!root.isDirectory() || !dir.isDirectory()) return REFUSED;
			const read = boundedRead(join(directory, "current.jsonl"), maxBytes);
			if (request.sessionDigest !== undefined && request.sessionDigest !== read.digest) return REFUSED;
			if (ttlDays > 0 && now() - read.stat.mtimeMs > ttlDays * 86400_000) return REFUSED;
			const sidecar = (name) => {
				try { return boundedRead(join(directory, name), 4096).text.trim(); } catch { return null; }
			};
			if (Object.hasOwn(expected, "piVersion") && (typeof expected.piVersion !== "string" || !expected.piVersion || sidecar("pi-version") !== expected.piVersion)) return REFUSED;
			if (Object.hasOwn(expected, "venue")) {
				let stored;
				try { fs.lstatSync(join(directory, "venue")); stored = sidecar("venue"); } catch (error) { stored = error?.code === "ENOENT" ? "local" : null; }
				if (typeof expected.venue !== "string" || !expected.venue || stored !== expected.venue) return REFUSED;
			}
			// Early preflight has no image/model selection yet. Defer this model-sensitive gate until the caller
			// supplies the current pickup's model, preserving the store's deliberate foreign-model exemption.
			if (maxContextPct !== null && (Object.hasOwn(expected, "modelId") || Object.hasOwn(expected, "provider"))) {
				const raw = sidecar("context");
				if (raw !== null) {
					const [rawTokens, rawWindow, stampedModel] = raw.split(/\s+/);
					const tokens = Number.parseInt(rawTokens, 10);
					const window = Number.parseInt(rawWindow, 10);
					let currentModel = typeof expected.modelId === "string" ? expected.modelId.toLowerCase() : null;
					if (Object.hasOwn(expected, "provider")) {
						const provider = typeof expected.provider === "string" ? expected.provider.toLowerCase() : "";
						currentModel = provider && currentModel && MODEL_REF_PATTERN.test(provider) && MODEL_REF_PATTERN.test(currentModel) ? `${provider}/${currentModel}` : null;
					}
					const foreign = stampedModel !== undefined && currentModel !== null && stampedModel !== currentModel;
					if (Number.isInteger(tokens) && tokens >= 0 && String(tokens) === rawTokens && Number.isInteger(window) && window > 0 && String(window) === rawWindow && !foreign && tokens * 100 / window >= maxContextPct) return REFUSED;
				}
			}
			if (maxResumeChain > 0) {
				let chain = 0;
				try {
					const raw = boundedRead(join(directory, "resume-chain"), 4096).text.trim();
					const value = Number.parseInt(raw, 10);
					if (Number.isInteger(value) && value > 0 && String(value) === raw) chain = value;
				} catch { /* The session store treats an absent or unreadable counter as zero, too. */ }
				if (chain >= maxResumeChain) return REFUSED;
			}
			if (!approvalTranscriptMatches(read.text, request, { maxAgeDays, now })) return REFUSED;
			const rootAfter = fs.statSync(sessionsDir);
			const dirAfter = fs.lstatSync(directory);
			if (!rootAfter.isDirectory() || !dirAfter.isDirectory() || dirIdentity(rootAfter) !== dirIdentity(root) || dirIdentity(dirAfter) !== dirIdentity(dir)) return REFUSED;
			return { ok: true, digest: read.digest };
		} catch { return REFUSED; }
	};
	const check = (request, expected = {}) => {
		const out = validate(request, expected);
		return out.ok ? { ok: true } : out;
	};
	check.fingerprint = validate;
	return check;
}
