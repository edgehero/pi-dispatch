/**
 * The harness's comment on a forge job's artifacts (issue #920, part 3, `REQ-JOB-STATUS-COMMENTS`): once a run's outcome is
 * final and it kept or dropped a file, one comment on its issue or pull request says what was kept, by name and size, what
 * was not and why, and where to open them. Written by the worker, never the model, so a reviewer can trust that the list
 * is what the store holds.
 *
 * Names are the one agent-chosen token a harness comment carries. The collection's charset
 * (`ARTIFACT_NAME_RE`: letters, digits, dot, dash, underscore, at most 64) leaves a name no markup, no mention and no link,
 * and each is set in backticks. When the whole text could still spell the phrase that starts a comment trigger, the names
 * are left out and only the counts are said, so the bot's own comment can never look like a request (the status comment's
 * guard, `statusTextMayMatch`, for the same reason).
 *
 * The link is `PI_CONSOLE_PUBLIC_URL` plus the run page and the card's anchor. Without that setting the comment names the
 * job and says to open it on the console, which is true and links nowhere: fail open, and say which.
 */
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { ARTIFACT_DROP_REASONS, ARTIFACT_DROP_TEXT, ARTIFACTS_MANIFEST, ARTIFACTS_MANIFEST_MAX_BYTES, artifactRunDirOf, artifactSizeText, artifactsManifestOf } from "./artifacts-record.mjs";

/** The run page's address on a console a reviewer can reach, or null without one. */
export function artifactsLink(consoleUrl, jobId) {
	if (typeof consoleUrl !== "string" || consoleUrl === "") return null;
	return `${consoleUrl}/run?id=${encodeURIComponent(jobId)}#p-artifacts`;
}

/** The run's manifest from the store, or null (missing, unreadable, another job's, or not a manifest). Never throws. */
export function readArtifactsManifest(storeDir, jobId, { fs = nodeFs } = {}) {
	try {
		const dir = artifactRunDirOf(jobId);
		if (dir === null || typeof storeDir !== "string") return null;
		const path = join(storeDir, dir, ARTIFACTS_MANIFEST);
		const st = fs.lstatSync(path);
		if (!st.isFile() || st.size > ARTIFACTS_MANIFEST_MAX_BYTES) return null;
		const manifest = artifactsManifestOf(fs.readFileSync(path, "utf8"));
		return manifest !== null && manifest.jobId === jobId ? manifest : null;
	} catch {
		return null;
	}
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The comment's text for run `jobId`: from its manifest when this host keeps one (names and sizes), else from the record's
 * counts alone. `withNames` false leaves the names out. Null when there is nothing to say.
 */
export function artifactsCommentText({ jobId, counts, manifest = null, consoleUrl = null, withNames = true }) {
	const files = Array.isArray(manifest?.files) ? manifest.files : [];
	const kept = manifest ? files.length : counts?.kept ?? 0;
	const dropped = manifest ? manifest.dropped : counts?.dropped ?? {};
	const reasons = ARTIFACT_DROP_REASONS.filter((r) => Number.isSafeInteger(dropped?.[r]) && dropped[r] > 0);
	if (kept === 0 && reasons.length === 0) return null;
	const lines = [];
	lines.push(kept > 0 ? `pi-dispatch kept ${plural(kept, "file", "files")} from job \`${jobId}\` for its reviewer:` : `pi-dispatch kept no file from job \`${jobId}\`.`);
	// The names when this host keeps the manifest and they may be said; the count otherwise (the record's, from another host).
	if (withNames && files.length > 0) for (const f of files) lines.push(`- \`${f.name}\` (${artifactSizeText(f.size)})`);
	else if (kept > 0) lines.push(`- ${plural(kept, "file", "files")}, ${artifactSizeText(counts?.bytes ?? files.reduce((n, f) => n + f.size, 0))} in all`);
	for (const r of reasons) lines.push(`${plural(dropped[r], "file was", "files were")} not kept: ${ARTIFACT_DROP_TEXT[r]}.`);
	const link = artifactsLink(consoleUrl, jobId);
	if (kept > 0) lines.push(link !== null ? `Open them on the run page: ${link}` : `Open them on the console's page for job \`${jobId}\`.`);
	return lines.join("\n");
}

/** Whether `text` holds `phrase` (a comment trigger's), as a comment trigger would read it: case aside. */
export function textMayMatchPhrase(phrase, text) {
	return typeof phrase === "string" && phrase !== "" && typeof text === "string" && text.toLowerCase().includes(phrase.toLowerCase());
}

/**
 * The comment for a run whose record says it kept or dropped files, or null: with names, without them when they could
 * spell the trigger's phrase, and none at all when even the counts could (then the record and the run page say it).
 */
export function artifactsComment({ jobId, counts, storeDir, consoleUrl = null, phrase = null, fs = nodeFs }) {
	const manifest = readArtifactsManifest(storeDir, jobId, { fs });
	const named = artifactsCommentText({ jobId, counts, manifest, consoleUrl });
	if (named === null) return null;
	if (!textMayMatchPhrase(phrase, named)) return named;
	const bare = artifactsCommentText({ jobId, counts, manifest, consoleUrl, withNames: false });
	return bare !== null && !textMayMatchPhrase(phrase, bare) ? bare : null;
}
