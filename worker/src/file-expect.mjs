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
 * `expect` is not an array: no expectation, nothing to refuse). Every confirmed write says a lost race in these words:
 * the triggers and settings writers here, `writePauseWindows` and `replaceFile` through the package's `./file-expect`.
 *
 * A difference one side of which is a failed read is no lost race, and "another session wrote it" would send a person
 * looking for a session that never ran, so it says what happened. Two failed reads with one code still compare equal: a
 * writer that means to replace the file has read it first, and refuses there.
 */
export function expectRefusal(fs, expect) {
	if (!Array.isArray(expect)) return null;
	for (const input of expect) {
		const now = fileSnapshot(fs, input?.path);
		if (now === input?.text) continue;
		const failed = [now, input?.text].find((snapshot) => typeof snapshot === "string" && snapshot.startsWith(UNREADABLE));
		if (failed !== undefined) return `${input?.path} could not be read (${failed.slice(UNREADABLE.length)}) when this change was checked against it; nothing was written. Look again and retry`;
		return `${input?.path} changed after this change was built from it (another session wrote it); nothing was written. Look again and retry`;
	}
	return null;
}
