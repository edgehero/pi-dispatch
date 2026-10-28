import { issueBranch } from "./branch.mjs";

export const FORK_THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const ID = /^[A-Za-z0-9._:-]{1,200}$/;
const ENTRY = /^[A-Za-z0-9_-]{1,128}$/;
const KEY = /^[0-9a-f]{32}$/;

/** A closed queue contract: no paths, credentials, or policy overrides can ride inside lineage. */
export function validateFork(value) {
	const bad = () => { throw new TypeError("fork must name a bounded run, entry, digest and independent lineage"); };
	if (!value || typeof value !== "object" || Array.isArray(value)) return bad();
	const { id, fromJob, fromEntry, position, sourceDigest, rootKey, message } = value;
	if (![id, fromJob, fromEntry, position, sourceDigest, rootKey].every((field) => typeof field === "string")) return bad();
	if (Object.keys(value).some((k) => !["id", "fromJob", "fromEntry", "position", "sourceDigest", "rootKey", "message"].includes(k)) || !KEY.test(id ?? "") || !ID.test(fromJob ?? "") || !ENTRY.test(fromEntry ?? "") || !["before", "at"].includes(position) || !/^[0-9a-f]{64}$/.test(sourceDigest ?? "") || !KEY.test(rootKey ?? "") || (message !== undefined && (typeof message !== "string" || Buffer.byteLength(message) > 16_384 || message.includes("\0")))) return bad();
	return { id, fromJob, fromEntry, position, sourceDigest, rootKey, ...(message !== undefined ? { message } : {}) };
}

export function forkBranch(job) {
	const fork = validateFork(job.fork);
	return `${issueBranch(job.target.number)}-fork-${fork.id}`;
}

/** Fixed harness instructions precede operator text, which remains fenced user data. */
export function managedForkPrompt(job, original) {
	if (!job.fork) return original;
	const fork = validateFork(job.fork);
	const branch = forkBranch(job);
	return [
		"## Managed session fork",
		`Continue the selected historical conversation on your own branch \`${branch}\`.`,
		"Earlier messages describe a different attempt. Its branch and pull request belong to that attempt.",
		"Do not push to, close, or update that attempt's branch or pull request. Open a separate pull request for this fork.",
		"The workspace is restored to the selected point. Check its state before repeating external side effects.",
		"", original,
		...(fork.message ? ["", "## Operator follow-up (data)", JSON.stringify(fork.message)] : []),
	].join("\n");
}

/** Run records retain validated identifiers and the selected model, never the operator's message. */
export function recordedFork(fork, model = null) {
	try {
		const value = validateFork(fork);
		// pi generates eight hex digits; a crafted transcript id is never durable record text.
		if (!/^[0-9a-f]{8}$/.test(value.fromEntry)) return null;
		return { id: value.id, fromJob: value.fromJob, fromEntry: value.fromEntry, position: value.position, model };
	} catch { return null; }
}


const ARCHIVE_REASONS = new Set(["capacity", "busy", "unsafe-extensions", "base-too-large", "store-full", "store-unreadable", "timeout", "invalid", "immutable", "not-completed", "transcript-unavailable", "checkpoint-unavailable", "unavailable"]);
/** Archive telemetry is a closed vocabulary; filesystem messages and transcript text never enter records. */
export function forkArchiveFact({ saved = false, reason = null, pointSkipped = null } = {}) {
	const clean = (value) => {
		const token = typeof value === "string" ? value.replace(/^fork-source-/, "").replace(/^fork-/, "") : "unavailable";
		return ARCHIVE_REASONS.has(token) ? token : "unavailable";
	};
	return { saved: saved === true, reason: saved === true ? null : clean(reason), ...(pointSkipped !== null ? { pointSkipped: clean(pointSkipped) } : {}) };
}
