/**
 * The state of a file a page words, as one of four cases, and the one word each has (issue #988).
 *
 *   read        it gave its content: nothing is said of the file
 *   absent      it "does not exist" (or none is configured): an empty document, which is a read's own answer
 *   unreadable  it "could not be read": nobody could read it, or the page holds no view of it at all
 *   refused     it "does not load": it was read, and its content is refused
 *
 * Every page that words a file's state takes the case from here and the word from `FILE_WORDS`, so no page has a
 * sentence of its own for two cases. The rule was first a list of pages, and each page off the list kept one word for
 * a file that does not exist, one nobody could read and one that does not parse: "could not be read", "could not be
 * loaded" or "does not load", of all three.
 */
export const FILE_WORDS = Object.freeze({ absent: "does not exist", unreadable: "could not be read", refused: "does not load" });

/** The word for a case, or null for a file that was read. */
export const fileWord = (fileCase) => (Object.hasOwn(FILE_WORDS, fileCase) ? FILE_WORDS[fileCase] : null);

/** Whether an error is a read that failed with an errno (`EACCES`, `EISDIR`, `ENOENT` and the like), by its code. */
const errnoOf = (error) => (typeof error?.code === "string" && /^E[A-Z0-9]+$/.test(error.code) ? error.code : null);

/**
 * The case of a read that threw: no such file is absent, another errno is a read that failed, and anything else came
 * from the content, which was read and is refused. Never "read".
 */
export function fileCaseOfError(error) {
  const code = errnoOf(error);
  return code === "ENOENT" ? "absent" : code !== null ? "unreadable" : "refused";
}

/** The errno of a read that failed, for a sentence that names it ("could not be read (EACCES)"); null for none. */
export const fileErrnoOf = errnoOf;

/**
 * Two readers fold a file nobody could read into `invalid`, each with these words first: the settings reader
 * ("settings file unreadable (EACCES)") and the flows page's triggers reader ("triggers file could not be read (...)").
 */
const INVALID_SAYS_UNREADABLE = /^(?:settings|triggers) file (?:unreadable|could not be read)/;

/**
 * The case of a file view, the readers' `{ missing | unset | unreadable | invalid }` or the content: `list` names the
 * key that holds its rows where it has one (`triggers`, `projects`, `limits`), and a view that lacks them without
 * saying why is one nobody read. No view at all is unreadable too: a page that was handed nothing cannot say the file
 * is absent.
 */
export function fileCaseOfView(view, list = null) {
  if (view === null || view === undefined || typeof view !== "object") return "unreadable";
  if (view.missing === true || view.unset === true) return "absent";
  if (view.unreadable) return "unreadable";
  if (view.invalid) return typeof view.invalid === "string" && INVALID_SAYS_UNREADABLE.test(view.invalid) ? "unreadable" : "refused";
  if (list !== null && !Array.isArray(view[list])) return "unreadable";
  return "read";
}
