/**
 * The run record's `artifacts` (issue #920, INT-RUN-HISTORY-FILE-CONTRACT): what a forge job's `/artifacts` folder left,
 * as numbers only, `{ kept, bytes, dropped }`. A LEAF, so the console reads the same shape without the collector.
 *
 * Numbers only, because the record holds no string an agent chose: the files' NAMES live in the run's own manifest in
 * the artifacts store (`INT-ARTIFACTS-STORE-CONTRACT`), which the console reads beside the record. `dropped` counts by
 * reason, each a closed token, only the reasons that happened.
 */

/** Why a file was not kept: its name, its type (a link, a folder, a device), its size, the count or total limit, a job
 * secret in a file that cannot be scrubbed, or a read that failed. */
export const ARTIFACT_DROP_REASONS = Object.freeze(["name", "type", "size", "count", "total", "secret", "unreadable"]);

const MAX_FILES = 10_000;
const MAX_BYTES = 2 ** 40;

/** The record's `artifacts`, REBUILT from what the collector said: null for anything that is not that shape. */
export function recordedArtifacts(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const { kept, bytes, dropped } = value;
	if (!Number.isSafeInteger(kept) || kept < 0 || kept > MAX_FILES) return null;
	if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_BYTES) return null;
	if (dropped === null || typeof dropped !== "object" || Array.isArray(dropped)) return null;
	const counts = {};
	for (const reason of ARTIFACT_DROP_REASONS) {
		const n = dropped[reason];
		if (n === undefined) continue;
		if (!Number.isSafeInteger(n) || n < 1 || n > MAX_FILES) return null;
		counts[reason] = n;
	}
	if (Object.keys(dropped).some((key) => !ARTIFACT_DROP_REASONS.includes(key))) return null;
	if (kept === 0 && Object.keys(counts).length === 0) return null;
	return { kept, bytes, dropped: counts };
}
