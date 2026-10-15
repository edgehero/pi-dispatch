/**
 * The re-check a confirmed write makes right before its rename (issue #642): the files the change was BUILT from, as
 * `{ path, text }` snapshots taken before an operator's confirm (the admin's `writeInputs`, stored in the console's
 * ticket), compared with the files as they are now. A difference refuses, with nothing written, so a confirm applies
 * exactly what was previewed and a second session's write in between is a refusal, never a silent lost update.
 *
 * One encoding, the admin's `fileSnapshot` (admin/src/read-model.mjs), and a test holds the two to it: the text, `null`
 * for a file that does not exist (ENOENT and only ENOENT), or `UNREADABLE` plus the error code for any other read
 * failure, a string no file's text can equal. A snapshot taken by one and compared by the other must agree, because the
 * console takes it through the admin and the triggers and settings writers compare it here.
 *
 * Pure apart from the reads, and import-free, so `runtime-settings.mjs` (which the admin bundles) can take it.
 */

/** What `fileSnapshot` returns for a file that is there but cannot be read: a string no file's text can equal. */
const UNREADABLE = "\u0000unreadable:";

/** A file's text, `null` when it does not exist, or `UNREADABLE` + the error code for any other read failure. */
export function fileSnapshot(fs, path) {
	try {
		return fs.readFileSync(path, "utf8");
	} catch (e) {
		if (e?.code === "ENOENT") return null;
		return `${UNREADABLE}${typeof e?.code === "string" ? e.code : "error"}`;
	}
}

/**
 * The refusal for the first snapshot in `expect` whose file changed, or null when every one still holds (and when
 * `expect` is not an array: no expectation, nothing to refuse). The words are `writePauseWindows`' and `replaceFile`'s,
 * so every confirmed write says a lost race the same way.
 */
export function expectRefusal(fs, expect) {
	if (!Array.isArray(expect)) return null;
	for (const input of expect) {
		if (fileSnapshot(fs, input?.path) !== input?.text) {
			return `${input?.path} changed after this change was built from it (another session wrote it); nothing was written. Look again and retry`;
		}
	}
	return null;
}
