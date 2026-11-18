import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { isForgeKind } from "./forges.mjs";
import { DISARMED_TYPE, ON_TYPES, parseTriggersDocument } from "./triggers.mjs";
import { isForgeTriggerOf } from "./trigger-identity.mjs";

const DIGEST = /^[a-f0-9]{64}$/;
const forgeTrigger = (type) => ON_TYPES.has(type) && type !== "cron" && type !== "watch";
const ordered = (value) => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object"
	? Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])])) : value;

/** A witness of reviewed configuration, not a secret or a credential. Callers pass the loader's normalized entry. */
export function mergePolicyDigest(entry) {
	if (entry?.run?.mayMerge !== true || !isForgeKind(entry.run.kind) || !forgeTrigger(entry?.on?.type) || entry.run.command !== undefined) {
		throw new TypeError("merge policy requires an enabled forge flow trigger");
	}
	return createHash("sha256").update(JSON.stringify(ordered(entry))).digest("hex");
}

/** Validate both halves together: a missing or truthy non-boolean flag must never be filled from the live file. */
export function mergePolicyJobProblem(job) {
	if (job?.mayMerge !== undefined && typeof job.mayMerge !== "boolean") return "merge-policy-invalid";
	if (job?.mayMerge !== true) return job?.mayMergePolicy === undefined ? null : "merge-policy-invalid";
	const matched = job?.trigger?.matched;
	return !isForgeKind(job.kind) || job.command !== undefined || typeof job.flow !== "string" || !job.flow
		|| !Number.isSafeInteger(matched?.index) || matched.index < 0 || !forgeTrigger(matched?.type)
		|| typeof job.mayMergePolicy !== "string" || !DIGEST.test(job.mayMergePolicy)
		? "merge-policy-invalid" : null;
}

/**
 * Re-read on every attempt, without a last-good cache: withdrawing permission must take effect at the next start.
 * This is a pickup snapshot, not revocation of a running container or an operation already accepted by a forge.
 * Read failures are infrastructure; an absent, invalid or changed policy is a determinate refusal. No file text,
 * filesystem error message or operator instruction is returned to the caller's logs or forge comment.
 */
export function makeCheckMergePolicy({ triggersPath, fs = nodeFs } = {}) {
	return function checkMergePolicy(job, { queueJobId } = {}) {
		const invalid = mergePolicyJobProblem(job);
		if (invalid) return { refused: invalid };
		if (job?.mayMerge !== true) return { ok: true };
		if (typeof triggersPath !== "string" || !triggersPath) return { refused: "merge-policy-unavailable" };
		let text;
		try { text = fs.readFileSync(triggersPath, "utf8"); }
		catch (error) {
			return error?.code === "ENOENT" ? { refused: "merge-policy-unavailable" } : { unreadable: true };
		}
		let entries;
		try { entries = parseTriggersDocument(text, triggersPath).triggers; }
		catch (error) { return error?.newer === true ? { newer: true } : { refused: "merge-policy-unavailable" }; }
		const index = job.trigger.matched.index;
		// A one-shot's own failed attempt may have disarmed it. Preserve its existing same-job retry exception,
		// but only after validating the original document, and never for a foreign or hand-written disarm.
		if (entries[index]?.on?.type === DISARMED_TYPE && typeof queueJobId === "string" && queueJobId) {
			const raw = JSON.parse(text);
			if (raw.triggers[index]?.on?.disarmed?.jobId === queueJobId) {
				delete raw.triggers[index].on.disarmed;
				try { entries = parseTriggersDocument(JSON.stringify(raw), triggersPath).triggers; }
				catch { return { refused: "merge-policy-unavailable" }; }
			}
		}
		const entry = entries[index];
		// The identity every pre-spend check shares (issue #933), which this check's own reading became: a GitLab merge
		// request a label matched, and a comment routed to another trigger's flow, are both this entry's jobs.
		if (entry?.run?.mayMerge !== true || entry.run.command !== undefined || !isForgeTriggerOf(entries, entry, job)) {
			return { refused: "merge-policy-changed" };
		}
		return mergePolicyDigest(entry) === job.mayMergePolicy ? { ok: true } : { refused: "merge-policy-changed" };
	};
}
