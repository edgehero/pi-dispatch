/**
 * The document a file's text holds, as `{ value }`, or `{ problem }` saying why a writer that keeps a list under `listKey`
 * could not keep what it holds. One rule for the triggers file and the pause windows file, each of which lost every row to a
 * stray comma (`INT-TRIGGERS-FILE-CONTRACT`, `INT-PAUSE-WINDOWS-FILE-CONTRACT`).
 *
 * The words are its own, never the parser's message, which quotes the file. A top-level value that is not an object, or a
 * list key that is not a list, parses and still gives a write nothing to start from, so it would drop what the file holds
 * exactly as it would for a stray comma. A file with no such key is fine: it holds no row, and the writer keeps its other keys.
 * A list key that is not a list comes with its `value` too, since a newer release may mean something by that shape, and a
 * writer says that first: "upgrade" is the answer then, not "fix the file".
 */
export function heldDocument(raw, listKey) {
	let value;
	try {
		value = JSON.parse(raw);
	} catch {
		// An editor shows nothing at the start of such a file, so the plain words would not lead to the fix.
		return { problem: raw.charCodeAt(0) === 0xfeff ? "is not valid JSON (it starts with a byte-order mark)" : "is not valid JSON" };
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) return { problem: "is not a JSON object" };
	if (Object.hasOwn(value, listKey) && !Array.isArray(value[listKey])) return { value, problem: `has a "${listKey}" that is not a list` };
	return { value };
}
