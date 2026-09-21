import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BACKENDS, PROPERTY_NAMES } from "../src/backends.mjs";
import { BOOT_REFUSING_JOB_USER_CAUSES, JOB_USER_FIX, jobUserRefusal } from "../src/job-user.mjs";

// docs/podman.md's property table restates two derivable sources, so it is BOLTED to them (CLAUDE.md: a hand-written
// table is derived or pinned, never trusted): its rows are the backend table's properties in order, and its Docker
// Engine column is what `local` declares. The Podman columns are measurements, which no source can derive; what is
// pinned for them is their vocabulary, so a cell cannot quietly say a word the table does not have.

const doc = readFileSync(new URL("../../docs/podman.md", import.meta.url), "utf8");

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
	assert.equal(header[1], "Docker Engine, rootful");
	assert.deepEqual(body.map((row) => row[0]), [...PROPERTY_NAMES]);
});

test("its Docker Engine column is what `local` declares, word for word (#345)", () => {
	const { body } = propertyTable();
	for (const [property, dockerEngine] of body) {
		assert.equal(dockerEngine.split(" ")[0], BACKENDS.local.declares[property], property);
	}
});

test("every Podman cell starts with a word of the vocabulary or a refusal cause the worker gives (#345)", () => {
	const { header, body } = propertyTable();
	assert.equal(header.length, 7, "the reference column and five Podman setups");
	for (const row of body) {
		for (const cell of row.slice(2)) {
			const refused = /^refused: ([a-z-]+)$/.exec(cell);
			if (refused) {
				assert.ok(BOOT_REFUSING_JOB_USER_CAUSES.has(refused[1]), `${row[0]}: ${cell}`);
				continue;
			}
			assert.match(cell, /^(enforced|asserted|absent)\b/, `${row[0]}: ${cell}`);
		}
	}
});

// The page quotes the refusal an operator sees. A quote is a copy, and a copy drifts, so the block is pinned to
// `jobUserRefusal` itself: a line the function cannot produce fails here rather than in a support thread.
test("every refusal the page quotes is one the worker prints, and it quotes every cause its table names (#345)", () => {
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
	const { body } = propertyTable();
	for (const row of body) {
		for (const cell of row.slice(2)) {
			const refused = /^refused: ([a-z-]+)$/.exec(cell);
			if (refused) assert.ok(covered.has(refused[1]), `${refused[1]} is a cell but is not quoted`);
		}
	}
});
