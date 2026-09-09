import assert from "node:assert/strict";
import { test } from "node:test";
import { EXCLUDABLE_TOOL_NAMES, parseTriggers } from "../src/triggers.mjs";

/**
 * `run.excludeTools` at the loader (issue #291). The field's whole hazard class is the SILENT half:
 * pi ignores unknown names in excludeTools without a diagnostic, so everything here that refuses is
 * refusing a file that would otherwise load clean and run a job WITH a tool it says to remove. The
 * processor/runner halves (the capability gate, the in-container membership assert) have their own
 * suites; this one is the file's own grammar.
 */

const parse = (entries) => parseTriggers(JSON.stringify({ triggers: entries }), "/x/triggers.json");

// One entry per normalizer, the trigger-backend suite's shape, so "all five" is a loop and a missed
// arm fails here by name rather than shipping as a kind that quietly drops the field.
const KINDS = [
	["cron", (run = {}, on = {}) => ({ on: { type: "cron", id: "n", pattern: "0 3 * * *", ...on }, run: { kind: "local", folder: "/p", flow: "f", task: "t", ...run } })],
	["label", (run = {}, on = {}) => ({ on: { type: "label", any: ["pi"], ...on }, run: { kind: "github", flow: "f", ...run } })],
	["comment", (run = {}, on = {}) => ({ on: { type: "comment", phrase: "@pi", ...on }, run: { kind: "github", flow: "f", ...run } })],
	["issue", (run = {}, on = {}) => ({ on: { type: "issue", action: ["closed"], ...on }, run: { kind: "github", flow: "f", ...run } })],
	["pull_request", (run = {}, on = {}) => ({ on: { type: "pull_request", action: ["opened"], ...on }, run: { kind: "github", flow: "f", ...run } })],
];

test("an unflagged trigger normalizes byte-identically -- no excludeTools key at all, on all five kinds", () => {
	// The issue's own acceptance clause: a trigger without the field is byte-identical to today. A key
	// present-but-undefined would still change JSON.stringify of the job data, so absence is the assertion.
	for (const [kind, make] of KINDS) {
		assert.equal("excludeTools" in parse([make()])[0].run, false, kind);
	}
});

test("run.excludeTools survives normalization on all five kinds, as a FRESH validated array", () => {
	for (const [kind, make] of KINDS) {
		const wrote = ["bash", "edit"];
		const [t] = parse([make({ excludeTools: wrote })]);
		assert.deepEqual(t.run.excludeTools, ["bash", "edit"], kind);
		// validateWaitFor's rule, pinned: nothing unvalidated rides through, so the normalized array is a
		// copy -- a caller mutating the raw entry after parse cannot reach into what consumers read.
		assert.notEqual(t.run.excludeTools, wrote, `${kind}: must be a fresh array, not the input by reference`);
	}
});

test("a value that is not a non-empty array of names refuses, naming the trigger and the field, on all five kinds", () => {
	for (const [kind, make] of KINDS) {
		for (const bad of ["bash", {}, [], [1], [""], [null], true]) {
			assert.throws(
				() => parse([make({ excludeTools: bad })]),
				(e) => e.piDispatchConfig === true && /trigger/.test(e.message) && /run\.excludeTools/.test(e.message),
				`${kind} must refuse excludeTools=${JSON.stringify(bad)}`,
			);
		}
	}
});

test("a name outside the pinned set refuses at load, printing the whole known set", () => {
	// The acceptance's second clause. "Bash" is in the loop deliberately: pi's names are lower-case, the
	// capitalized form is the likeliest real-world miss, and pi would ignore it without a sound.
	for (const bad of ["Bash", "shell", "not-a-tool", " bash"]) {
		assert.throws(
			() => parse([KINDS[0][1]({ excludeTools: [bad] })]),
			(e) => /is not a tool the pinned pi knows/.test(e.message) && /read, bash, edit, write, grep, find, ls/.test(e.message) && /ignores unknown names silently/.test(e.message),
			bad,
		);
	}
});

test("a duplicate member refuses -- a removal set's second entry can never change the answer", () => {
	assert.throws(() => parse([KINDS[0][1]({ excludeTools: ["bash", "bash"] })]), /names "bash" twice/);
});

test("every member of the pinned set is excludable, all seven at once included", () => {
	// Excluding everything is a legal narrowing: extension and custom tools still load, which is the
	// field's documented bound. The loader must not invent a floor the runner does not have.
	const all = [...EXCLUDABLE_TOOL_NAMES];
	assert.deepEqual(parse([KINDS[1][1]({ excludeTools: all })])[0].run.excludeTools, all);
});

test("a NEAR-MISS spelling is refused, because a dropped exclusion is a destructive absence", () => {
	// run.backend's class, one field over: a dropped exclusion runs the job WITH the tool while the file
	// reads as though it was off -- byte-identical in the record and the log to a job that never narrowed.
	for (const key of ["ExcludeTools", "exclude_tools", "exclude-tools", "EXCLUDETOOLS", "excludeTool", "excludedTools", "excluded_tools"]) {
		assert.throws(() => parse([KINDS[0][1]({ [key]: ["bash"] })]), /is not a field -- did you mean run\.excludeTools\?/, key);
	}
	// The homoglyph branch (validateBackend's): a Cyrillic "а" in "exclude_tools" survives the ASCII
	// normalization as a subsequence and must still be caught, because such a key arrives by paste.
	assert.throws(() => parse([KINDS[0][1]({ ["exclude_tools".replace("a", "а")]: ["bash"] })]), /did you mean run\.excludeTools\?/);
});

test("on.excludeTools is refused even when run carries no excludeTools at all -- the sweep runs before the early return", () => {
	// The mutation this kills: moving the sweep below the `undefined` early return makes it unreachable
	// for exactly the file most likely to exist -- one whose ONLY mistake is putting the field on `on`.
	for (const [kind, make] of KINDS) {
		assert.throws(() => parse([make({}, { excludeTools: ["bash"] })]), /on\.excludeTools is not a field/, kind);
	}
});

test("run.tools is refused BY NAME: pi-dispatch narrows only", () => {
	// The issue's stated bound. An allowlist inverts the question to "which tools exist", which drifts
	// with the pin -- a bump that adds a tool would silently grant it to every allowlisted trigger.
	assert.throws(
		() => parse([KINDS[0][1]({ tools: ["read"] })]),
		(e) => /run\.tools is not a field/.test(e.message) && /run\.excludeTools/.test(e.message),
	);
	// And before the early return: a file whose only field is the wrong one still hears why.
	assert.throws(() => parse([KINDS[2][1]({ tools: ["read"] })]), /run\.tools is not a field/);
});

test("run.noTools is refused BY NAME: the sweep cannot catch it and a dropped tool switch must not be silent", () => {
	// "notools" shares no subsequence with "excludetools", so without its own check this key would ride
	// the documented unknown-key tolerance -- and a silently dropped tool switch is this validator's
	// whole refusal class.
	assert.throws(
		() => parse([KINDS[0][1]({ noTools: "all" })]),
		(e) => /run\.noTools is not a field/.test(e.message) && /run\.excludeTools/.test(e.message),
	);
});

test("an unrelated unknown run key still drops silently -- the sweep is a near-miss guard, not a schema", () => {
	// The negative that keeps this from becoming the general unknown-key sweep design.md rejects:
	// tolerating unknown run keys is the file's documented forward-compatibility posture.
	const [t] = parse([KINDS[0][1]({ someFutureKey: 1 })]);
	assert.equal("someFutureKey" in t.run, false);
});

test("run.secrets cannot bind PI_EXCLUDE_TOOLS -- the variable is reserved by name", () => {
	// reserved-env.mjs's whole purpose: a trigger binding the worker's own variable would either be
	// silently overwritten or silently WIN, and a secret redirecting the tool denylist is the winning
	// direction at its worst.
	assert.throws(
		() => parse([KINDS[1][1]({ secrets: { PI_EXCLUDE_TOOLS: "op://vault/x" } })]),
		(e) => e.piDispatchConfig === true && /PI_EXCLUDE_TOOLS/.test(e.message),
	);
});
