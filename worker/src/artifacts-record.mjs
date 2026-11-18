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

/**
 * What each drop reason means, in the words the run page and the closing comment both use (issue #920), so the two say
 * the same of the same file. Fixed, and naming the setting a person can change where there is one.
 */
export const ARTIFACT_DROP_TEXT = Object.freeze({
	name: "its name was not letters, digits, dot, dash and underscore, at most 64",
	type: "it was not a plain file (a link, a folder or a device)",
	size: "it was larger than one file may be (PI_ARTIFACTS_MAX_FILE_MB)",
	count: "the run already kept as many files as it may (PI_ARTIFACTS_MAX_FILES)",
	total: "the run already kept as much as it may in all (PI_ARTIFACTS_MAX_RUN_MB)",
	secret: "it held one of the job's secrets and could not be cleaned",
	unreadable: "it could not be read",
});

/** A size as a person reads it: bytes, KB or MB, one decimal at most. */
export function artifactSizeText(bytes) {
	if (!Number.isSafeInteger(bytes) || bytes < 0) return "unknown size";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round((bytes / 1024) * 10) / 10} KB`;
	return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/** A kept file's name: a letter or digit first, then letters, digits, dot, dash and underscore, at most 64 in all. */
export const ARTIFACT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The served types, by what the bytes are. Only the first five are ever shown inline. */
export const ARTIFACT_TYPES = Object.freeze(["image/png", "image/jpeg", "image/gif", "image/webp", "text/plain", "application/octet-stream"]);
/** The manifest's name in a run's folder, beside `files/`. */
export const ARTIFACTS_MANIFEST = "manifest.json";
export const ARTIFACTS_FILES_DIR = "files";
export const ARTIFACTS_MANIFEST_VERSION = 1;
/** The folder a run's files are kept in, under the store: the run's id, which the record's own file name uses too. */
export const ARTIFACT_RUN_DIR_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/;
/** The largest manifest a reader takes: 200 files at most, each a short line. */
export const ARTIFACTS_MANIFEST_MAX_BYTES = 256 * 1024;

/** The run's folder name, or null for an id that cannot name one (`.` and `..` included). */
export function artifactRunDirOf(jobId) {
	if (typeof jobId !== "string") return null;
	const name = jobId.replace(/[^A-Za-z0-9._-]/g, "_");
	return ARTIFACT_RUN_DIR_RE.test(name) && name !== "." && name !== ".." ? name : null;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * A run's `manifest.json` (INT-ARTIFACTS-STORE-CONTRACT) as its readers take it: the parsed text REBUILT to the version 1
 * shape, or null for anything else (a newer version, a field out of shape, a name outside the charset, a duplicate). The
 * one validator the console's run page and its file route read through, so a manifest the console lists is one whose
 * every name the route can serve.
 */
export function artifactsManifestOf(text) {
	let raw;
	try { raw = JSON.parse(text); } catch { return null; }
	if (raw === null || typeof raw !== "object" || raw.v !== ARTIFACTS_MANIFEST_VERSION || typeof raw.jobId !== "string") return null;
	if (typeof raw.createdAt !== "string" || !ISO_RE.test(raw.createdAt)) return null;
	if (raw.keepUntil !== null && (typeof raw.keepUntil !== "string" || !ISO_RE.test(raw.keepUntil))) return null;
	if (!Array.isArray(raw.files) || raw.files.length > 1000) return null;
	const seen = new Set();
	const files = [];
	for (const f of raw.files) {
		if (f === null || typeof f !== "object" || typeof f.name !== "string" || !ARTIFACT_NAME_RE.test(f.name) || seen.has(f.name)) return null;
		if (!Number.isSafeInteger(f.size) || f.size < 0 || typeof f.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(f.sha256)) return null;
		if (!ARTIFACT_TYPES.includes(f.type) || typeof f.scrubbed !== "boolean") return null;
		seen.add(f.name);
		files.push({ name: f.name, size: f.size, sha256: f.sha256, type: f.type, scrubbed: f.scrubbed });
	}
	const dropped = recordedArtifacts({ kept: files.length, bytes: 0, dropped: raw.dropped ?? {} });
	if (dropped === null && (files.length > 0 || Object.keys(raw.dropped ?? {}).length > 0)) return null;
	return { v: 1, jobId: raw.jobId, createdAt: raw.createdAt, keepUntil: raw.keepUntil, files, dropped: dropped?.dropped ?? {} };
}

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
