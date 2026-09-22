import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { SESSION_REASONS } from "../src/run-history.mjs";

// The `session.reason` vocabulary is written out four times: `SESSION_REASONS`, the record-shape enum in
// `INT-RUN-HISTORY-FILE-CONTRACT`, and the read and promote tables in `docs/sessions.md`. Nothing compared
// them until issue #375's gate round, and the drift ran one way: ADDING an invented token to the set passed
// the entire suite, while removing one was caught only because two tests restated the list by hand.
//
// What this file is, and what it is not. It DERIVES the expected text from the code and requires it
// verbatim, which is the shape `docs/backends.md`'s bolt settled on after a parser lost that arms race
// repeatedly. It reads exactly two needles, each with its limits written here rather than discovered later:
// a `<fixed enum: a|b|c>` span, and the first cell of every row of a table under a named heading. It does
// not parse prose, and it cannot see a token described in a paragraph instead of a table row.
const SPEC = fileURLToPath(new URL("../../specs/interfaces.md", import.meta.url));
const DOC = fileURLToPath(new URL("../../docs/sessions.md", import.meta.url));

/** Every `` `token` `` in the first cell of each row of the table that follows `heading`. */
function tableTokens(text, heading) {
	const from = text.indexOf(heading);
	assert.notEqual(from, -1, `the doc must still carry the heading ${JSON.stringify(heading)}`);
	const rest = text.slice(from);
	const rows = [];
	for (const line of rest.split("\n").slice(1)) {
		if (line.startsWith("| `")) rows.push(line.slice(3, line.indexOf("`", 3)));
		else if (rows.length > 0 && !line.startsWith("|")) break; // the table ended
	}
	assert.ok(rows.length > 0, `no table rows under ${JSON.stringify(heading)}`);
	return rows;
}

test("the record-shape enum in INT-RUN-HISTORY-FILE-CONTRACT is exactly SESSION_REASONS", () => {
	const spec = readFileSync(SPEC, "utf8");
	const found = /<fixed enum: ([a-z|-]+)>/.exec(spec);
	assert.ok(found, "the contract must still spell the enum as `<fixed enum: a|b|c>`");
	// GENERATED from the code and required verbatim, rather than compared as a set: the order is part of what
	// a reader compares against the source, and a set comparison would let the two drift into different
	// orders and call it agreement.
	assert.equal(found[1], [...SESSION_REASONS].join("|"), "the contract's enum must be the code's set, in the code's order");
});

test("docs/sessions.md names every reason the code can produce, and invents none", () => {
	const doc = readFileSync(DOC, "utf8");
	const documented = new Set([...tableTokens(doc, "## When it silently doesn't resume"), ...tableTokens(doc, "### When a promotion doesn't happen")]);
	// `disabled` is the runner's token for a job that never armed resume, so it is a record value with nothing
	// for an operator to read on this page. Named here so its absence is a decision rather than a gap.
	const notOnThePage = new Set(["disabled", "resumed"]);
	const missing = [...SESSION_REASONS].filter((r) => !documented.has(r) && !notOnThePage.has(r));
	const invented = [...documented].filter((r) => !SESSION_REASONS.has(r));
	assert.deepEqual(missing, [], "every token the record can carry is on the page an operator reads");
	assert.deepEqual(invented, [], "and the page names no token the code cannot produce");
});
