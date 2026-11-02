/**
 * The one version rule for a store that had no version and may need one (issue #761, `DES-STORE-VERSION-WHEN-NEEDED`).
 * A LEAF: it imports nothing, so the admin console, the receiver and every worker module can share it.
 *
 * A version is an optional integer. A file or job without one is version 1, and a writer writes the LOWEST version its
 * content needs, which is nothing at all while that is 1: so a store whose content every release can read stays
 * byte-identical, and an older reader is turned away only by content it would misread. What needs a version is
 * declared per store in a table, `field -> the version that introduced it`, frozen and empty until a field needs one;
 * the store's own `*_VERSION` constant is the highest version its build reads and equals the table's largest value
 * (or 1), which `versionTableProblems` holds every store to.
 *
 * Why not stamp the current version on every write: every reader older than the writer would then refuse every file,
 * including the ones it could read perfectly well. Why not compare release numbers: a release number says nothing
 * about which fields a file uses, so it refuses too much and protects nothing a field table does not.
 *
 * A field table cannot say "this EXISTING field now takes a wider value" (a new condition kind in a list, a new form of
 * a scope), and an older build meeting such a value refuses it as broken, with no stamp to say an upgrade is the fix. So
 * a store can also declare a value table, `field -> (value) => the version that value needs`, frozen and empty until a
 * value needs one, and its writer stamps the version for exactly the values that need it (`valueNeededVersion`).
 *
 * Two different failures, told apart on purpose: a version newer than this build reads is not an error in the file
 * (`newer: true`, the caller defers or refuses with an upgrade to name), while a version that is not an integer of 1
 * or more is a broken file and keeps that store's ordinary refusal. The broken-file message never repeats the value it
 * judged, and the newer one names only two integers: the version declared and the one this build reads.
 */

/**
 * The problem with a declared version, or null when it is readable here: missing (version 1) or an integer from 1 to
 * `supported`. `what` names the store in the message ("settings file", "pause windows file", ...).
 */
export function versionProblem(declared, { supported, what }) {
	if (declared === undefined) return null;
	if (!Number.isSafeInteger(declared) || declared < 1) return { newer: false, message: `${what} "version" must be an integer of 1 or more` };
	if (declared > supported) return { newer: true, message: `${what} written by a newer pi-dispatch (version ${declared}; this build understands ${supported})` };
	return null;
}

/** The lowest version that expresses content using `fields` (an iterable of names): 1 when no field needs more. */
export function neededVersion(fields, table) {
	let needed = 1;
	for (const field of fields ?? []) {
		if (typeof field === "string" && Object.hasOwn(table, field) && table[field] > needed) needed = table[field];
	}
	return needed;
}

/**
 * The first field whose version is above the one the file declares (`declared` missing reads as 1), as
 * `{ field, needs }`, or null. A file that uses such a field without saying so was written by hand or by a writer that
 * dropped the stamp, and an older reader would read it without the field: refused like a broken file.
 */
export function underDeclared(fields, table, declared) {
	const have = declared === undefined ? 1 : declared;
	for (const field of fields ?? []) {
		if (typeof field === "string" && Object.hasOwn(table, field) && table[field] > have) return { field, needs: table[field] };
	}
	return null;
}

/**
 * The version `value` needs under `field`'s rule in `valueTable`: 1 without an own rule, or when the rule answers no
 * integer above 1. A rule that THROWS answers 1 too: it runs over a file's raw content, and a value it was not written
 * for (a `null` where it expects a list) is the store's own validator's to judge, never a reason to crash the reader.
 */
function ruleVersion(valueTable, field, value) {
	if (!Object.hasOwn(valueTable, field) || typeof valueTable[field] !== "function") return 1;
	let needs;
	try {
		needs = valueTable[field](value);
	} catch {
		return 1;
	}
	return Number.isSafeInteger(needs) && needs > 1 ? needs : 1;
}

/**
 * The lowest version that expresses the VALUES of `record`'s own fields under `valueTable` (`field -> (value) =>
 * version`, for a wider range of an existing field): the highest version any rule answers, 1 when none answers an
 * integer above 1. A field-name table says which fields need a version; this says which values of a field do.
 */
export function valueNeededVersion(record, valueTable) {
	let needed = 1;
	if (record === null || typeof record !== "object") return needed;
	for (const field of Object.keys(record)) {
		const needs = ruleVersion(valueTable, field, record[field]);
		if (needs > needed) needed = needs;
	}
	return needed;
}

/**
 * The first own field of `record` whose value needs a version above the declared one (`declared` missing reads as 1),
 * as `{ field, needs }`, or null: `underDeclared` for a value table, refused by the reader for the same reason.
 */
export function valueUnderDeclared(record, valueTable, declared) {
	const have = declared === undefined ? 1 : declared;
	if (record === null || typeof record !== "object") return null;
	for (const field of Object.keys(record)) {
		const needs = ruleVersion(valueTable, field, record[field]);
		if (needs > have) return { field, needs };
	}
	return null;
}

/**
 * Every way a store's table breaks the rule, as sentences (empty when it holds): a key that is not a field the store
 * knows, a value that is not an integer from 2 to the store's version, and a version that is not the table's largest
 * value (or 1). A store's test calls this with its own table, its known fields and its version.
 */
export function versionTableProblems(table, { known, version }) {
	const problems = [];
	if (!Object.isFrozen(table)) problems.push("the table is not frozen");
	const knownSet = new Set(known);
	let largest = 1;
	for (const [field, needs] of Object.entries(table)) {
		if (!knownSet.has(field)) problems.push(`${field} is not a field this store knows`);
		if (!Number.isSafeInteger(needs) || needs < 2 || needs > version) problems.push(`${field} needs version ${needs}, outside 2 to ${version}`);
		else if (needs > largest) largest = needs;
	}
	if (version !== largest) problems.push(`the store's version is ${version}, but its table's largest value is ${largest}`);
	return problems;
}

/**
 * `versionTableProblems` for a value table, as far as a rule can be judged without running it: frozen, every key a
 * field the store knows and every value a function, and the store's version an integer of 1 or more. Which versions a
 * rule answers depends on the value it is given, so the store's test probes each rule with the values that need it.
 */
export function valueTableProblems(table, { known, version }) {
	const problems = [];
	if (!Object.isFrozen(table)) problems.push("the table is not frozen");
	const knownSet = new Set(known);
	for (const [field, rule] of Object.entries(table)) {
		if (!knownSet.has(field)) problems.push(`${field} is not a field this store knows`);
		if (typeof rule !== "function") problems.push(`${field}'s rule is not a function of the value`);
	}
	if (!Number.isSafeInteger(version) || version < 1) problems.push(`the store's version is ${version}, not an integer of 1 or more`);
	return problems;
}
