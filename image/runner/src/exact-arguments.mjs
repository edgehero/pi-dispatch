/**
 * Refuses a wrong JSON type before pi can convert it (#796).
 *
 * pi 1.5.0 validates plain JSON Schema tools with TypeBox's full conversion, so a value of the wrong type is quietly
 * changed into one of the right type: `done: 2.7` becomes 2, `draft: null` becomes the string "null", and one object
 * becomes a one-item array. A tool's own `execute` cannot catch this, because it receives the converted copy. A model
 * that sent `draft: null` would spend a coverage classifier call on the text "null" and end the run `uncovered`, where a
 * refusal would have let it try again. `prepareArguments` runs on the raw arguments before validation, on 1.4.0 too, and
 * a throw there comes back to the model as an error result.
 *
 * The rule is read from the tool's own schema, so there is no second table to drift. It judges types only: required keys,
 * unknown keys, lengths and patterns stay with the validator and with each tool's `execute`.
 *
 * MCP tools are deliberately not wrapped. Their schemas belong to their servers, and converting is what pi does for
 * them: a caller's `"1"` for a boolean is that server's contract to judge. docs/job-image.md and the release notes say so.
 */
const TYPE_OF = Object.freeze({
	string: (value) => typeof value === "string",
	boolean: (value) => typeof value === "boolean",
	number: (value) => typeof value === "number" && Number.isFinite(value),
	integer: (value) => Number.isSafeInteger(value),
	array: Array.isArray,
	object: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
	null: (value) => value === null,
});

/** The first wrong type in `value`, as a sentence that names the place and never repeats the value, or null. */
export function rawTypeProblem(schema, value, path = "arguments") {
	if (schema === null || typeof schema !== "object") return null;
	for (const branches of [schema.anyOf, schema.oneOf]) {
		if (Array.isArray(branches)) return branches.some((branch) => rawTypeProblem(branch, value, path) === null) ? null : `${path} has the wrong type`;
	}
	if (schema.type !== undefined) {
		const types = Array.isArray(schema.type) ? schema.type : [schema.type];
		const known = types.filter((type) => Object.hasOwn(TYPE_OF, type));
		if (known.length > 0 && !known.some((type) => TYPE_OF[type](value))) return `${path} must be ${known.join(" or ")}`;
	}
	if (TYPE_OF.array(value) && schema.items) {
		for (let index = 0; index < value.length; index++) {
			const problem = rawTypeProblem(schema.items, value[index], `${path}[${index}]`);
			if (problem) return problem;
		}
	}
	if (TYPE_OF.object(value) && schema.properties) {
		for (const key of Object.keys(value)) {
			if (!Object.hasOwn(schema.properties, key)) continue;
			const problem = rawTypeProblem(schema.properties[key], value[key], `${path}.${key}`);
			if (problem) return problem;
		}
	}
	return null;
}

/**
 * The tool with its raw arguments held to its schema's types. `refusal` replaces the message for a tool whose callers
 * read a closed refusal word.
 */
export function exactArguments(tool, { refusal = null } = {}) {
	return {
		...tool,
		prepareArguments(args) {
			const problem = rawTypeProblem(tool.parameters, args ?? {});
			if (problem) throw new Error(refusal ?? problem);
			return args;
		},
	};
}

/** Every tool the runner defines registers through here, so a new one cannot skip the rule. A test holds that. */
export function registerExact(api, tool) {
	return api.registerTool(exactArguments(tool));
}
