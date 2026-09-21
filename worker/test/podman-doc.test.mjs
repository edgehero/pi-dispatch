import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BACKENDS, DAEMON_APPLIES_BOUNDS, DOCKER_ENDPOINT_LOCAL, PROPERTY_NAMES, RUNTIME_ADDS_NO_MOUNTS, effectiveWord, meets } from "../src/backends.mjs";
import { BOOT_REFUSING_JOB_USER_CAUSES, JOB_USER_FIX, jobUserRefusal } from "../src/job-user.mjs";

// docs/podman.md's property table restates two derivable sources, so it is BOLTED to them (CLAUDE.md: a hand-written
// table is derived or pinned, never trusted): its rows are the backend table's properties in order, and its Docker
// Engine column is what `local` declares. The Podman columns are measurements, which no source can derive, and the
// first review of this file showed why pinning only their VOCABULARY is not enough: a page that said `isolation:
// enforced` in every Podman column passed. So each Podman column also names the OBSERVATIONS that column describes,
// and its word is capped by `effectiveWord` under them -- a word the worker could never print on that host now fails
// here. What stays unpinned is the rest of a cell's sentence, which is prose about a measurement.
//
// WHAT THIS FILE DELIBERATELY DOES NOT PIN, and the history is worth the lines because it keeps recurring: prose
// about WHEN a job-user refusal fires. The page got that subtly wrong three review rounds running under #345
// (`9cb2bce`'s own message says so), and the eventual answer was NOT a bigger regex here. Nothing in this file was
// ever widened to chase it: `REFUSED_ENTRY_POINT` below was written once and has been byte-identical since, and it
// governs the ENTRY-POINTS table anyway, while the refusal block's own test reads only the `Refused:` lines. The
// timing clauses were never in range of either. `9cb2bce` moved the timing PARAGRAPHS off the page instead, onto
// what owns them (`docs/backends.md`, `DES-JOB-USER-INFERRED-READ-BACK-ON-REQUEST`, and
// `BOOT_REFUSING_JOB_USER_CAUSES` for the list itself), and that is the shape of the answer.
//
// It did not end there, which is the part to remember: the page still carries a timing clause in each of its eight
// refusal headings, and the very next commit (`0335146`) had to correct one of them from "(at boot)" to "(at boot
// when local is the default venue, else per job)" -- a fourth round of the same defect, after the round that was
// supposed to have settled it. Those headings are unpinned on purpose, because a regex over them would pin their
// SHAPE and never their truth, and a green regex over a false sentence is worse than no test. So the answer to the
// next recurrence is to DERIVE the claim from what a function returns, the way every test below is derived, or to
// delete the sentence. Adding a regex over prose here would be repeating what has already failed four times.

const doc = readFileSync(new URL("../../docs/podman.md", import.meta.url), "utf8");

// The six setups, in the order both of the page's tables use them, with what the worker observes on each. A column
// with `refusal` runs no job at all, so its cells are the refusal rather than a word.
const SETUPS = Object.freeze([
	{ header: "Docker Engine, rootful", observations: { [DOCKER_ENDPOINT_LOCAL]: true, [DAEMON_APPLIES_BOUNDS]: true, [RUNTIME_ADDS_NO_MOUNTS]: true } },
	{ header: "Podman rootful", observations: { [DOCKER_ENDPOINT_LOCAL]: true, [DAEMON_APPLIES_BOUNDS]: false, [RUNTIME_ADDS_NO_MOUNTS]: true } },
	{ header: "Podman rootless, keep-id", refusal: "rootless" },
	{ header: "Podman rootless", refusal: "rootless" },
	{ header: "podman-docker, rootful", observations: { [DOCKER_ENDPOINT_LOCAL]: false, [DAEMON_APPLIES_BOUNDS]: false, [RUNTIME_ADDS_NO_MOUNTS]: true } },
	{ header: "podman-docker, rootless", refusal: "rootless" },
]);

function propertyTable() {
	const start = doc.indexOf("<!-- PODMAN-PROPERTY-TABLE -->");
	const end = doc.indexOf("<!-- /PODMAN-PROPERTY-TABLE -->");
	assert.ok(start >= 0 && end > start, "the table is between its markers");
	const rows = doc
		.slice(start, end)
		.split("\n")
		.filter((line) => line.startsWith("|"))
		.map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
	const [header, separator, ...body] = rows;
	assert.match(separator.join(""), /^-+$/);
	return { header, body };
}

test("the Podman property table's rows are the backend table's properties, in order (#345)", () => {
	const { header, body } = propertyTable();
	assert.equal(header[0], "Property");
	assert.deepEqual(header.slice(1), SETUPS.map((setup) => setup.header));
	assert.deepEqual(body.map((row) => row[0]), [...PROPERTY_NAMES]);
});

test("its Docker Engine column is what `local` declares, word for word (#345)", () => {
	const { body } = propertyTable();
	for (const [property, dockerEngine] of body) {
		assert.equal(/^\S+/.exec(dockerEngine)?.[0], BACKENDS.local.declares[property], property);
	}
});

// The teeth. A cell must say exactly what its setup's observations earn, which is at most what `local` declares
// (`effectiveWord` never raises a word). `isolation: enforced` on any Podman column dies here, because
// `observeBounds` returns false for every Podman daemon, and the `meets` check below names that case separately
// so the failure says which of the two rules a cell broke.
test("every Podman cell is a word its own setup could actually earn, or its refusal (#345)", () => {
	const { body } = propertyTable();
	for (const row of body) {
		const property = row[0];
		for (const [index, setup] of SETUPS.entries()) {
			const cell = row[index + 1];
			if (setup.refusal) {
				assert.equal(cell, `refused: ${setup.refusal}`, `${property} on ${setup.header}`);
				assert.ok(BOOT_REFUSING_JOB_USER_CAUSES.has(setup.refusal), setup.refusal);
				continue;
			}
			const [, word] = /^(enforced|asserted|absent)\b/.exec(cell) ?? [];
			assert.ok(word, `${property} on ${setup.header}: ${cell}`);
			assert.ok(meets(BACKENDS.local.declares[property], word), `${property} on ${setup.header} claims more than local declares`);
			assert.equal(word, effectiveWord("local", property, setup.observations), `${property} on ${setup.header}`);
		}
	}
});

// The page quotes the refusal an operator sees. A quote is a copy, and a copy drifts, so the block is pinned to
// `jobUserRefusal` itself: a line the function cannot produce fails here rather than in a support thread, and a
// cause the page quietly stops quoting fails too.
test("the page quotes every refusal the worker can print, verbatim (#345)", () => {
	const start = doc.indexOf("<!-- PODMAN-REFUSAL-TEXTS -->");
	const end = doc.indexOf("<!-- /PODMAN-REFUSAL-TEXTS -->");
	assert.ok(start >= 0 && end > start, "the refusal block is between its markers");
	const quoted = doc
		.slice(start, end)
		.split("\n")
		.filter((line) => line.startsWith("Refused:"));
	const byText = new Map(Object.keys(JOB_USER_FIX).map((cause) => [jobUserRefusal(cause), cause]));
	const covered = new Set();
	for (const line of quoted) {
		const cause = byText.get(line);
		assert.ok(cause, `not a text the worker prints: ${line}`);
		assert.ok(!covered.has(cause), `quoted twice: ${cause}`);
		covered.add(cause);
	}
	assert.deepEqual([...covered].sort(), Object.keys(JOB_USER_FIX).sort());
});

// The entry-points table is the same six setups in the same order, so it is pinned to the same list. Its cells are
// prose rather than declaration words, but a column whose jobs are all refused may only say so: an entry point that
// claims to run something there would be a page that contradicts its own property table.
const REFUSED_ENTRY_POINT = /^(refused `[a-z-]+`|✗ `[a-z-]+`|not run\b.*|as doctor|unmeasured\b.*)$/;

// The rows, by name, so a row cannot be dropped, renamed or invented while the count stays right.
const ENTRY_POINTS = Object.freeze(["worker", "`pi-dispatch doctor`", "`pi-dispatch doctor --live`", "`pi-dispatch sandbox`", "`pi-dispatch up`", "`docker compose --profile egress`"]);

test("the entry-points table covers the same six setups, and a refused column only refuses (#345)", () => {
	const start = doc.indexOf("## Entry points");
	const end = doc.indexOf("##", start + 3);
	const rows = doc
		.slice(start, end)
		.split("\n")
		.filter((line) => line.startsWith("|"))
		.map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
	const [header, separator, ...body] = rows;
	assert.match(separator.join(""), /^-+$/);
	assert.equal(header[0], "Entry point");
	assert.deepEqual(header.slice(1), SETUPS.map((setup) => setup.header));
	assert.deepEqual(body.map((row) => row[0]), [...ENTRY_POINTS]);
	for (const row of body) {
		for (const [index, setup] of SETUPS.entries()) {
			const cell = row[index + 1];
			if (!setup.refusal) {
				// The rule has to run both ways, or a supported column can quietly claim it is refused.
				assert.doesNotMatch(cell, /refus|✗/, `${row[0]} on ${setup.header} claims a refusal it does not get`);
				continue;
			}
			assert.match(cell, REFUSED_ENTRY_POINT, `${row[0]} on ${setup.header}: ${cell}`);
			// "not run" and "unmeasured" carry a tail, and the tail must not put back what the cell just denied.
			assert.doesNotMatch(cell.replace(/^(not run|unmeasured)/, ""), /\bruns?\b|\bopens\b|\breads\b|\bstarts\b/, `${row[0]} on ${setup.header} claims a run anyway`);
			// "as doctor" says "whatever the doctor row says", which is only true of the row that really does that.
			if (cell === "as doctor") assert.equal(row[0], "`pi-dispatch up`", `${row[0]} cannot defer to doctor`);
			if (/`[a-z-]+`/.test(cell)) assert.ok(cell.includes(`\`${setup.refusal}\``), `${row[0]} on ${setup.header} names another cause`);
		}
	}
});
