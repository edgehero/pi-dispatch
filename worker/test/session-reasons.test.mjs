import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { SESSION_REASONS } from "../src/run-history.mjs";
import { SESSION_NOT_SAVED, SESSION_SAVE_AMBIGUOUS } from "../src/record-reason.mjs";

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

/**
 * One function's body out of a source file, from its declaration to the closing brace at the declaration's own
 * indentation. Throws when the declaration is gone, so a test cannot pass on nothing.
 */
function bodyOf(src, declaration) {
	const at = src.indexOf(declaration);
	assert.notEqual(at, -1, `the source must still declare ${JSON.stringify(declaration)}`);
	const lineStart = src.lastIndexOf("\n", at) + 1;
	const indent = src.slice(lineStart, at);
	const end = src.indexOf(`\n${indent}}\n`, at);
	assert.notEqual(end, -1, `no closing brace for ${JSON.stringify(declaration)}`);
	return src.slice(at, end);
}

/** The `reason` literals a body returns with a verdict of `false` under `key`. */
const refusals = (body, key) => [...body.matchAll(new RegExp(`return \\{ ${key}: false, reason: "([a-z0-9-]+)"`, "g"))].map((m) => m[1]);

// Which session reasons say this run's conversation was NOT saved (issue #737). A session is written only by
// `promoteSession`, and only on the completed branch, so a reason that only a refused promotion (or a job that keeps no
// session) records says "not saved". Three reasons are written by `inspectFile`, which the resolve step and the promote
// step both call, so from the record alone they cannot say whether the conversation was saved. DERIVED here from the
// two sources, both ways: a refusal added to the store without a place in exactly one list fails, and so does a list
// member no source can produce.
test("SESSION_NOT_SAVED and SESSION_SAVE_AMBIGUOUS split every promote refusal and the live file's disabled, each in exactly one list", () => {
	const store = readFileSync(new URL("../src/session-store.mjs", import.meta.url), "utf8");
	const processor = readFileSync(new URL("../src/processor.mjs", import.meta.url), "utf8");
	const promote = bodyOf(store, "function promoteSession(");
	const inspect = bodyOf(store, "function inspectFile(");
	const merge = bodyOf(processor, "function mergeSession(");

	// The promote step's own refusals, and the inspection it passes through whole.
	const own = new Set(refusals(promote, "promoted"));
	assert.ok(promote.includes("const check = inspectFile(staged);") && promote.includes("return { promoted: false, reason: check.reason };"), "promoteSession still returns inspectFile's refusal as its own");
	const inspected = new Set(refusals(inspect, "ok"));
	// And the resolve step answers with the same inspection, which is what makes those three ambiguous.
	assert.match(bodyOf(store, "function readCanonical("), /const check = inspectFile\(file\);\n\t\tif \(!check\.ok\) return COLD\(check\.reason\);/, "the resolve step records inspectFile's refusal as its own");
	// `no-key` is the store's DI-seam backstop: sessionKeyFor is total, so no wired worker reaches it, and it is not a
	// record value (SESSION_REASONS leaves it out on purpose). It is in neither list.
	assert.ok(own.delete("no-key"), "promoteSession still has its no-key backstop");
	assert.ok(!SESSION_REASONS.has("no-key"));
	// mergeSession records `disabled` for a job that keeps no session, whose runner opened only the live file.
	assert.match(merge, /fromRunner\.reason === "absent"\) return \{ resumed: false, reason: "disabled", bytes: null \}/);

	const produced = new Set([...own, ...inspected, "disabled"]);
	const listed = [...SESSION_NOT_SAVED, ...SESSION_SAVE_AMBIGUOUS];
	assert.equal(new Set(listed).size, listed.length, "no reason is in both lists, nor twice in one");
	assert.deepEqual([...listed].sort(), [...produced].sort(), "every refusal is in a list, and every member is a refusal");
	assert.deepEqual([...SESSION_SAVE_AMBIGUOUS].sort(), [...inspected].sort(), "the ambiguous ones are exactly the shared inspection's");
	for (const reason of own) assert.ok(SESSION_NOT_SAVED.includes(reason) || inspected.has(reason), `${reason}, the promote step's own, says not saved`);
	for (const reason of listed) assert.ok(SESSION_REASONS.has(reason), `${reason} is a record value (SESSION_REASONS)`);
	assert.ok(!SESSION_NOT_SAVED.includes("resumed") && !SESSION_SAVE_AMBIGUOUS.includes("resumed"));
	assert.ok(Object.isFrozen(SESSION_NOT_SAVED) && Object.isFrozen(SESSION_SAVE_AMBIGUOUS));
});
