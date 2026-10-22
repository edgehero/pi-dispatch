// The run record's reason enum as INT-RUN-HISTORY-FILE-CONTRACT writes it (specs/interfaces.md), parsed ONCE (issue #710).
//
// Three tests used to copy the same parser (run-history.test.mjs twice, host-budget-gate.test.mjs once), and each kept
// what the split left: the first token with its leading space (" worker-abort") and the literal "..." that ends the line.
// Their `includes` checks never asked about either end, so the defect was invisible; a two-way check (every token has a
// catalog entry, and nothing else does) cannot live with either. One parser, used by all of them.
//
// The line is the record shape's `"reason":    "<fixed enum: a|b|...>"`, the only one written with that spacing (the
// nested `plan.reason` enum has one space). The trailing "..." says the enum grows; it is not a token.
//
// The record's NESTED enums (round 1 of PR #733): `session.reason` and `plan.reason` are the `"reason": "<fixed enum:`
// line straight after their object's opening line, and `recoverSkipped` is a union of quoted strings on its own line.
// Each is found by its object's opening line, never by its first token, so a reordered enum still parses.

import { readFileSync } from "node:fs";

const SPEC_URL = new URL("../../../specs/interfaces.md", import.meta.url);
const RECORD_REASON_LINE = '"reason":    "<fixed enum:';

/** The tokens between `<fixed enum:` and `>` on a spec line: split on `|`, each trimmed, the trailing `...` dropped. */
export function fixedEnumTokens(line) {
	const open = line.indexOf("<fixed enum:");
	if (open < 0) throw new Error("not a fixed enum line");
	const from = open + "<fixed enum:".length;
	const to = line.indexOf(">", from);
	if (to < 0) throw new Error("a fixed enum line without its closing >");
	return line
		.slice(from, to)
		.split("|")
		.map((token) => token.trim())
		.filter((token) => token !== "" && token !== "...");
}

/** The tokens of a `"<key>"?: "a" | "b" | ...` union line: every double-quoted string after the key's colon. */
export function quotedUnionTokens(line, key) {
	const at = line.indexOf(`"${key}"`);
	if (at < 0) throw new Error(`not a ${key} line`);
	const colon = line.indexOf(":", at + key.length + 2);
	if (colon < 0) throw new Error(`a ${key} line without its colon`);
	const body = line.slice(colon + 1).split("//")[0];
	return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const NESTED_OPENERS = {
	"session.reason": '"session": { "resumed":',
	"plan.reason": '"plan":    { "outcome":',
};

/**
 * A nested enum of the record shape: `session.reason`, `plan.reason` or `recoverSkipped`. Throws when the line is gone or
 * has moved off its object, so a test cannot pass on nothing.
 */
export function recordNestedEnum(field, spec = readFileSync(SPEC_URL, "utf8")) {
	const lines = spec.split("\n");
	if (field === "recoverSkipped") {
		const line = lines.find((l) => l.includes('"recoverSkipped"?:'));
		if (line === undefined) throw new Error("the record's recoverSkipped line is not in specs/interfaces.md");
		return quotedUnionTokens(line, "recoverSkipped");
	}
	if (!Object.hasOwn(NESTED_OPENERS, field)) throw new Error(`no nested enum ${field}`);
	const open = lines.findIndex((l) => l.includes(NESTED_OPENERS[field]));
	if (open < 0) throw new Error(`the record's ${field} object is not in specs/interfaces.md`);
	const line = lines[open + 1] ?? "";
	if (!line.includes('"reason": "<fixed enum:')) throw new Error(`the record's ${field} enum is not the line after its object's opening`);
	return fixedEnumTokens(line);
}

/** Every top-level reason the record contract names, in its order. Throws when the line is gone, so a test cannot pass on nothing. */
export function recordReasonEnum(spec = readFileSync(SPEC_URL, "utf8")) {
	const line = spec.split("\n").find((l) => l.includes(RECORD_REASON_LINE));
	if (line === undefined) throw new Error("the record's reason enum line is not in specs/interfaces.md");
	return fixedEnumTokens(line);
}
