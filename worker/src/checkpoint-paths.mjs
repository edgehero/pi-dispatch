/**
 * Path rules for a workspace checkpoint (issue #645), shared by the SNAPSHOT walk and the RESTORE write.
 *
 * ONE MODULE FOR BOTH SIDES because the two must agree to the byte. A rule the snapshot applies and the
 * restore does not is the tamper path: the store sits on the worker host, and a restore that trusts what a
 * snapshot "would never have written" trusts a directory, not a rule. So the restore re-validates every
 * path with these same functions, and a single disagreement refuses the whole restore.
 *
 * A LEAF that imports only node builtins, on `git-hardening.mjs`'s precedent: both the checkpointer and
 * any future reader (doctor, an admin view) need it, and a leaf cannot grow an import cycle.
 *
 * Every function takes a `Buffer` or a `string`. The walk reads names as BUFFERS (`readdir` with
 * `encoding: "buffer"`), because the default UTF-8 decode replaces an invalid byte with U+FFFD, and a name
 * that decodes to something it is not is exactly the disagreement described above.
 */

const MAX_SEGMENT_BYTES = 255;
export const MAX_PATH_BYTES = 4096;
export const MAX_DEPTH = 64;

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The codepoints HFS+ ignores when it compares names (git's `is_hfs_dotgit` list): ZWNJ/ZWJ and the
 * directional marks, the bidi embeddings, the deprecated format characters and the BOM. `.g‌it` IS
 * `.git` to a Mac's filesystem, so it must be `.git` to us too.
 */
const HFS_IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/g;

function asBuffer(seg) {
	return Buffer.isBuffer(seg) ? seg : Buffer.from(String(seg), "utf8");
}

/** Decode strictly, or `null` for bytes that are not UTF-8. */
function decode(buf) {
	try {
		return utf8.decode(buf);
	} catch {
		return null;
	}
}

/**
 * True when `seg` names git's own directory on ANY filesystem a restore could land on, after the folding
 * git itself applies under `core.protectHFS` and `core.protectNTFS`: case-insensitive, HFS ignorables
 * removed, trailing dots and spaces stripped (NTFS drops them), and the 8.3 short name `git~1`.
 *
 * Over-inclusive on purpose in one place: everything from the first `:` is cut, so `.git::$INDEX_ALLOCATION`
 * (an NTFS stream spelling of the directory) matches. A real file called `.git:notes` is then excluded too,
 * which costs a checkpoint one oddly named file; the opposite mistake writes into a repository's config.
 *
 * Bytes that are not UTF-8 return false: no filesystem folds them to `.git`, and `validSegment` refuses
 * them separately, so they are counted as a bad name rather than as a dotgit.
 */
export function isDotGitSegment(seg) {
	const s = decode(asBuffer(seg));
	if (s === null) return false;
	let folded = s.replace(HFS_IGNORABLE, "").toLowerCase();
	const colon = folded.indexOf(":");
	if (colon !== -1) folded = folded.slice(0, colon);
	folded = folded.replace(/[. ]+$/, "");
	return folded === ".git" || folded === "git~1";
}

/**
 * One path component: non-empty, not `.`/`..`, no `/`, no NUL or other control byte (C0 and DEL), valid
 * UTF-8, at most 255 bytes (the common NAME_MAX). Control bytes are refused rather than escaped because a
 * name carrying a newline or an escape sequence would reach an operator's terminal through any listing,
 * and nothing legitimate in a repository needs one.
 */
export function validSegment(seg) {
	const buf = asBuffer(seg);
	if (buf.length === 0 || buf.length > MAX_SEGMENT_BYTES) return false;
	if (buf.length === 1 && buf[0] === 0x2e) return false;
	if (buf.length === 2 && buf[0] === 0x2e && buf[1] === 0x2e) return false;
	for (const b of buf) {
		if (b === 0x2f || b < 0x20 || b === 0x7f) return false;
	}
	return decode(buf) !== null;
}

/**
 * A whole relative path: no leading `/`, every segment valid and none a dotgit, at most 4096 bytes and 64
 * segments deep. The depth cap is the walk's own recursion bound, so a restore can never be handed a path
 * the snapshot could not have produced.
 */
export function validPath(p) {
	const buf = asBuffer(p);
	if (buf.length === 0 || buf.length > MAX_PATH_BYTES) return false;
	if (buf[0] === 0x2f) return false;
	const segments = [];
	let start = 0;
	for (let i = 0; i <= buf.length; i++) {
		if (i === buf.length || buf[i] === 0x2f) {
			segments.push(buf.subarray(start, i));
			start = i + 1;
		}
	}
	if (segments.length > MAX_DEPTH) return false;
	return segments.every((seg) => validSegment(seg) && !isDotGitSegment(seg));
}

/**
 * The key two paths collide under on a case-insensitive, normalising filesystem (APFS, HFS+, NTFS): NFC,
 * lower case, HFS ignorables removed. Used only to DETECT a collision and refuse; it never names a file.
 * Not the full Unicode case-folding table, which no filesystem uses either: each implements its own, and
 * this one errs towards calling more pairs a collision, which refuses a restore rather than letting one
 * file silently overwrite another.
 */
export function foldCase(p) {
	const s = Buffer.isBuffer(p) ? p.toString("utf8") : String(p);
	return s.replace(HFS_IGNORABLE, "").normalize("NFC").toLowerCase();
}
