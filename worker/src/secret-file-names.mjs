/**
 * File-secret names are environment names AND basenames on the worker's filesystem (#919). The ASCII bound
 * fits the retained names contract and avoids Windows device entries, which are not ordinary files even when
 * the container itself runs Linux. Keep this leaf import-free: validation and staging must agree.
 */
export function secretFileNameAllowed(name) {
	return typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)
		&& name !== "__proto__" && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name);
}

/** Case-distinct Linux names can alias on a macOS or Windows staging volume. */
export function secretFileNamesDistinct(names) {
	return new Set(names.map((name) => name.toLowerCase())).size === names.length;
}
