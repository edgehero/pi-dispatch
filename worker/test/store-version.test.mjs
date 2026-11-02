import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { JOB_DATA_FIELD_VERSIONS, JOB_DATA_VALUE_VERSIONS, JOB_DATA_VERSION, JOB_DATA_VERSION_FIELD, jobDataNewer, jobDataVersionFor, withJobDataVersion } from "../src/job-data-version.mjs";
import { neededVersion, underDeclared, valueNeededVersion, valueTableProblems, valueUnderDeclared, versionProblem, versionTableProblems } from "../src/store-version.mjs";

// The one version rule for stores that had none (issue #761). These cases hold the rule itself; each store's own
// tests hold its table, its reader and its writer to it, with a non-empty table injected so the machinery runs while
// every shipped table is still empty.

test("versionProblem: missing is version 1, an integer up to the build's version reads, above it is newer, anything else is broken", () => {
	const at = (declared, supported = 2) => versionProblem(declared, { supported, what: "x file" });
	assert.equal(at(undefined), null);
	assert.equal(at(1), null);
	assert.equal(at(2), null, "the build's own version reads (a > that became >= would refuse it)");
	assert.deepEqual(at(3), { newer: true, message: "x file written by a newer pi-dispatch (version 3; this build understands 2)" });
	for (const broken of [0, -1, 1.5, "1", "2", null, true, [], {}, Number.NaN, 2 ** 60]) {
		const problem = at(broken);
		assert.equal(problem?.newer, false, `${JSON.stringify(broken)} is a broken version, not a newer one`);
		assert.equal(problem.message, 'x file "version" must be an integer of 1 or more');
	}
});

test("versionProblem never repeats the value it judged, and the newer message names only the two integers", () => {
	const problem = versionProblem("<script>secret</script>", { supported: 1, what: "x file" });
	assert.ok(!problem.message.includes("secret"));
	assert.equal(versionProblem(7, { supported: 2, what: "x file" }).message.replace(/[^0-9]/g, ""), "72");
});

test("neededVersion is the largest version of the fields used, 1 without one, and ignores a field the table does not name", () => {
	const table = Object.freeze({ a: 2, b: 3 });
	assert.equal(neededVersion([], table), 1);
	assert.equal(neededVersion(["z"], table), 1);
	assert.equal(neededVersion(["a"], table), 2);
	assert.equal(neededVersion(["a", "b", "z"], table), 3);
	assert.equal(neededVersion(["toString", "__proto__", "constructor"], table), 1, "an inherited name is not a table entry");
	assert.equal(neededVersion(undefined, table), 1);
});

test("underDeclared names the first field whose version is above the declared one (missing reads as 1)", () => {
	const table = Object.freeze({ a: 2, b: 3 });
	assert.equal(underDeclared(["a"], table, 2), null);
	assert.equal(underDeclared(["a", "b"], table, 3), null);
	assert.deepEqual(underDeclared(["a"], table, undefined), { field: "a", needs: 2 });
	assert.deepEqual(underDeclared(["z", "b"], table, 2), { field: "b", needs: 3 });
});

test("versionTableProblems holds a table to the rule: frozen, known fields, values 2 to the version, version = largest", () => {
	assert.deepEqual(versionTableProblems(Object.freeze({}), { known: ["a"], version: 1 }), []);
	assert.deepEqual(versionTableProblems(Object.freeze({ a: 2 }), { known: ["a"], version: 2 }), []);
	assert.deepEqual(versionTableProblems({}, { known: [], version: 1 }), ["the table is not frozen"]);
	assert.deepEqual(versionTableProblems(Object.freeze({ z: 2 }), { known: ["a"], version: 2 }), ["z is not a field this store knows"]);
	assert.deepEqual(versionTableProblems(Object.freeze({ a: 1 }), { known: ["a"], version: 1 }), ["a needs version 1, outside 2 to 1"]);
	assert.deepEqual(versionTableProblems(Object.freeze({ a: 3 }), { known: ["a"], version: 2 }), ["a needs version 3, outside 2 to 2", "the store's version is 2, but its table's largest value is 1"]);
	assert.deepEqual(versionTableProblems(Object.freeze({}), { known: [], version: 2 }), ["the store's version is 2, but its table's largest value is 1"], "a version raised with no field that needs it");
});

test("valueNeededVersion is the highest version any own field's rule answers, 1 when none answers an integer above 1", () => {
	const rules = Object.freeze({ a: (v) => (v === "wide" ? 2 : 1), b: (v) => (Array.isArray(v) && v.includes("wider") ? 3 : 1) });
	assert.equal(valueNeededVersion({}, rules), 1);
	assert.equal(valueNeededVersion({ a: "narrow", b: [] }, rules), 1);
	assert.equal(valueNeededVersion({ a: "wide" }, rules), 2);
	assert.equal(valueNeededVersion({ a: "wide", b: ["wider"] }, rules), 3);
	assert.equal(valueNeededVersion({ b: ["wider"], a: "wide" }, rules), 3, "the highest, in any order");
	assert.equal(valueNeededVersion({ z: "wide" }, rules), 1, "a field without a rule needs nothing");
	assert.equal(valueNeededVersion(null, rules), 1);
	assert.equal(valueNeededVersion("text", rules), 1);
	// What a rule answers counts only as a whole number above 1, and a rule that throws on a value it was not written for
	// answers nothing: the store's own validator judges that value.
	for (const odd of [1.5, "2", 0, -3, null, Number.NaN, 2 ** 60]) assert.equal(valueNeededVersion({ a: 1 }, { a: () => odd }), 1, String(odd));
	assert.equal(valueNeededVersion({ a: null, b: ["wider"] }, { a: (v) => v.length, b: rules.b }), 3, "a throwing rule answers 1 and the others still count");
	assert.equal(valueNeededVersion({ a: 1 }, { a: "not a function" }), 1);
	// Own names only: an inherited rule or field is not a table entry.
	const parsed = JSON.parse('{"__proto__": "wide", "toString": "wide"}');
	assert.equal(valueNeededVersion(parsed, rules), 1);
	assert.equal(valueNeededVersion(parsed, Object.freeze({ __proto__: null, toString: () => 2 })), 2, "a field named toString with its own rule");
});

test("valueUnderDeclared names the first field whose value needs more than the declared version (missing reads as 1)", () => {
	const rules = Object.freeze({ a: (v) => (v === "wide" ? 2 : 1), b: (v) => (v === "wider" ? 3 : 1) });
	assert.equal(valueUnderDeclared({ a: "wide" }, rules, 2), null);
	assert.deepEqual(valueUnderDeclared({ a: "wide" }, rules, undefined), { field: "a", needs: 2 });
	assert.deepEqual(valueUnderDeclared({ a: "wide", b: "wider" }, rules, 2), { field: "b", needs: 3 });
	assert.equal(valueUnderDeclared({ a: "narrow" }, rules, undefined), null);
	assert.equal(valueUnderDeclared(null, rules, undefined), null);
});

test("valueTableProblems holds a value table to the rule: frozen, known fields, a function each, and a version of 1 or more", () => {
	assert.deepEqual(valueTableProblems(Object.freeze({}), { known: [], version: 1 }), []);
	assert.deepEqual(valueTableProblems(Object.freeze({ a: () => 2 }), { known: ["a"], version: 2 }), []);
	assert.deepEqual(valueTableProblems({}, { known: [], version: 1 }), ["the table is not frozen"]);
	assert.deepEqual(valueTableProblems(Object.freeze({ z: () => 2 }), { known: ["a"], version: 2 }), ["z is not a field this store knows"]);
	assert.deepEqual(valueTableProblems(Object.freeze({ a: 2 }), { known: ["a"], version: 2 }), ["a's rule is not a function of the value"]);
	assert.deepEqual(valueTableProblems(Object.freeze({}), { known: [], version: 0 }), ["the store's version is 0, not an integer of 1 or more"]);
});

// Every `data.<key>` and `job.<key>` any worker module reads: a lenient superset of the job data fields (comments add
// names), which is enough to refuse a table row naming a field nothing reads.
const jobDataFields = () => {
	const fields = new Set();
	for (const name of readdirSync(new URL("../src/", import.meta.url))) {
		if (!name.endsWith(".mjs")) continue;
		for (const m of readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8").matchAll(/\b(?:data|job)\??\.(\w+)/g)) fields.add(m[1]);
	}
	return [...fields];
};

test("the job data tables hold the rule", () => {
	assert.equal(JOB_DATA_VERSION, 1);
	assert.equal(JOB_DATA_VERSION_FIELD, "dataVersion");
	const known = jobDataFields();
	assert.ok(known.includes("waitFor") && known.includes("models"), "the job data fields were found");
	assert.deepEqual(versionTableProblems(JOB_DATA_FIELD_VERSIONS, { known, version: JOB_DATA_VERSION }), []);
	assert.deepEqual(valueTableProblems(JOB_DATA_VALUE_VERSIONS, { known, version: JOB_DATA_VERSION }), []);
	// A value rule can raise the version with no field-table row, which neither check can see. While there is none, the
	// version is the field table's; the first value rule must extend this assertion with the versions it answers.
	assert.deepEqual(Object.keys(JOB_DATA_VALUE_VERSIONS), []);
});

test("jobDataNewer: no field or a readable integer passes; above the build, or anything that is not an integer, cannot be read", () => {
	assert.equal(jobDataNewer({ repo: "a/b" }), null);
	assert.equal(jobDataNewer({ dataVersion: 1 }), null);
	assert.equal(jobDataNewer({ dataVersion: 2 }, { supported: 2 }), null);
	assert.deepEqual(jobDataNewer({ dataVersion: 2 }), { version: 2 });
	for (const odd of ["2", 0, 1.5, null, {}]) assert.deepEqual(jobDataNewer({ dataVersion: odd }), { version: null }, JSON.stringify(odd));
	assert.equal(jobDataNewer(null), null);
	assert.equal(jobDataNewer("x"), null);
});

test("withJobDataVersion writes nothing while the data needs version 1, so today's job data is unchanged", () => {
	const data = { kind: "github", repo: "a/b", models: ["m"] };
	const out = withJobDataVersion(data);
	assert.deepEqual(out, data);
	assert.equal(JSON.stringify(out), JSON.stringify(data), "byte-identical, key order included");
	assert.deepEqual(withJobDataVersion({ ...data, dataVersion: 1 }), data, "a stamp of 1 is dropped");
});

test("withJobDataVersion stamps the lowest version a field needs, keeps a higher declared one, and refuses a newer one", () => {
	const table = Object.freeze({ narrowing: 2 });
	assert.deepEqual(withJobDataVersion({ repo: "a/b", narrowing: true }, { table, supported: 2 }), { repo: "a/b", narrowing: true, dataVersion: 2 });
	assert.deepEqual(withJobDataVersion({ repo: "a/b" }, { table, supported: 2 }), { repo: "a/b" }, "unsetting the field drops the stamp");
	assert.deepEqual(withJobDataVersion({ repo: "a/b", dataVersion: 2 }, { table, supported: 2 }), { repo: "a/b", dataVersion: 2 }, "a re-enqueue keeps the version the job arrived with");
	assert.throws(() => withJobDataVersion({ repo: "a/b", dataVersion: 3 }, { table, supported: 2 }), RangeError, "a builder never re-enqueues a newer job under a lower version");
	assert.throws(() => withJobDataVersion({ repo: "a/b", dataVersion: 2 }), RangeError, "this build's own version is 1");
	assert.equal(jobDataVersionFor({ narrowing: true, dataVersion: 9 }, { table }), 2, "the version field is not a field that needs a version");
});

test("with an injected value table, a wider value is stamped, an ordinary one is not, and the processor's gate sees the stamp", () => {
	// A condition kind this build does not have stands in for one a later release adds to `waitFor`.
	const valueTable = Object.freeze({ waitFor: (conditions) => (Array.isArray(conditions) && conditions.some((c) => c !== null && typeof c === "object" && Object.hasOwn(c, "issueClosed")) ? 2 : 1) });
	const wider = { kind: "github", waitFor: [{ profile: "jira" }, { issueClosed: 12 }] };
	assert.equal(jobDataVersionFor(wider, { valueTable }), 2);
	const stamped = withJobDataVersion(wider, { valueTable, supported: 2 });
	assert.deepEqual(stamped, { ...wider, dataVersion: 2 });
	assert.deepEqual(jobDataNewer(stamped), { version: 2 }, "a build that reads 1 defers it as newer, never refuses it as unreadable");
	assert.equal(jobDataNewer(stamped, { supported: 2 }), null, "and the build that wrote it reads it");
	const ordinary = { kind: "github", waitFor: [{ profile: "jira" }] };
	assert.equal(JSON.stringify(withJobDataVersion(ordinary, { valueTable, supported: 2 })), JSON.stringify(ordinary), "byte-identical");
	assert.equal(jobDataVersionFor({ ...wider, dataVersion: 1 }, { valueTable }), 2, "the version field itself is never a value a rule judges");
	assert.equal(jobDataVersionFor(wider), 1, "the shipped table stamps nothing");
});

test("both modules are leaves the receiver and the console can import: no import but the shared rule", () => {
	const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	const rule = strip(readFileSync(new URL("../src/store-version.mjs", import.meta.url), "utf8"));
	assert.doesNotMatch(rule, /\bimport\b|\brequire\(/);
	const job = strip(readFileSync(new URL("../src/job-data-version.mjs", import.meta.url), "utf8"));
	assert.deepEqual([...job.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]), ["./store-version.mjs"]);
});
