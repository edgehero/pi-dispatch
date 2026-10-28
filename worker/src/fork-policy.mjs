import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { parseTriggersDocument } from "./triggers.mjs";

/** Re-read rather than cache: a queued fork cannot retain authority withdrawn after confirmation. */
export function forkPolicyDigest({ triggersPath, job, fs = nodeFs } = {}) {
	try {
		const index = job?.trigger?.matched?.index;
		if (!Number.isInteger(index) || index < 0 || !triggersPath) return { refused: "fork-trigger-unavailable" };
		const { triggers } = parseTriggersDocument(fs.readFileSync(triggersPath, "utf8"), triggersPath);
		const entry = triggers[index];
		if (!entry || entry.run?.kind !== job.kind || entry.on?.type !== job.trigger.matched.type || entry.on?.disarmed || entry.on?.type === "disarmed" || entry.run?.command !== undefined || (entry.on.type !== "comment" && entry.run.flow !== job.flow)) return { refused: "fork-trigger-changed" };
		return { ok: true, digest: createHash("sha256").update(JSON.stringify(entry)).digest("hex") };
	} catch { return { refused: "fork-trigger-unavailable" }; }
}

export function makeCheckForkPolicy({ triggersPath, fs = nodeFs } = {}) {
	return (job) => {
		const read = forkPolicyDigest({ triggersPath, job, fs });
		if (!read.ok) return read;
		return typeof job.forkPolicy === "string" && job.forkPolicy === read.digest ? { ok: true } : { refused: "fork-trigger-changed" };
	};
}
