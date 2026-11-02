import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readOverlay, readOverlayDocument, resolveSettings, validateOverlay, writeOverlay } from "../src/runtime-settings.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #761, item 1: a settings write keeps every key this build does not know, in its place, and the file's
// optional `version` is judged before anything else. Real files in a temp directory, because the claim is about the
// bytes on disk: what an older console leaves behind after it edits a file a newer release wrote.

const settingsFile = () => join(tempDir("settings-carry-"), "settings.json");

/** The admin's read-modify-write, as `writeSettings` does it: read the document, mutate the known keys, write with the carry. */
function edit(path, mutate, options = {}) {
	const read = readOverlayDocument(path, options);
	if (read.invalid) return read;
	return writeOverlay(path, mutate({ ...read.overlay }), { carry: read.carry, ...options });
}

const lines = (...rows) => `${rows.join("\n")}\n`;

test("a write keeps every overlay key it does not know (a key from a later release) and a secretBundles block", () => {
	const path = settingsFile();
	writeFileSync(path, lines(
		"{",
		'  "model": "claude-x",',
		'  "laterRelease": {',
		'    "mode": "strict",',
		'    "limits": [',
		"      1,",
		"      2",
		"    ]",
		"  },",
		'  "secretBundles": {',
		'    "acme": {',
		'      "path": "/srv/resolvers/acme.sh",',
		'      "format": "dotenv"',
		"    }",
		"  },",
		'  "dailyCap": 5',
		"}",
	));
	assert.deepEqual(edit(path, (overlay) => ({ ...overlay, dailyCap: 9 })), { ok: true });
	assert.equal(readFileSync(path, "utf8"), lines(
		"{",
		'  "model": "claude-x",',
		'  "laterRelease": {',
		'    "mode": "strict",',
		'    "limits": [',
		"      1,",
		"      2",
		"    ]",
		"  },",
		'  "secretBundles": {',
		'    "acme": {',
		'      "path": "/srv/resolvers/acme.sh",',
		'      "format": "dotenv"',
		"    }",
		"  },",
		'  "dailyCap": 9',
		"}",
	));
});

test("a changed known key keeps its line, an unset one stays gone, and a new one is appended", () => {
	const path = settingsFile();
	writeFileSync(path, `${JSON.stringify({ softHoldPct: 80, future: true, dailyCap: 5, model: "claude-x" }, null, 2)}\n`);
	assert.deepEqual(edit(path, ({ dailyCap: _gone, ...overlay }) => ({ ...overlay, softHoldPct: 60, concurrency: 2 })), { ok: true });
	assert.equal(readFileSync(path, "utf8"), lines("{", '  "softHoldPct": 60,', '  "future": true,', '  "model": "claude-x",', '  "concurrency": 2', "}"));
	// And the unset key does not come back on a later write: the carry holds only what this build does not know.
	assert.deepEqual(edit(path, (overlay) => overlay), { ok: true });
	assert.equal(readFileSync(path, "utf8").includes("dailyCap"), false);
});

test("a candidate's own unknown key is dropped and logged, never carried: only what came from the file rides along", () => {
	const path = settingsFile();
	writeFileSync(path, `${JSON.stringify({ dailyCap: 1, fromFile: "kept" }, null, 2)}\n`);
	const logged = [];
	const res = edit(path, (overlay) => ({ ...overlay, injected: "x", fromFile: "replaced" }), { log: (event, fields) => logged.push([event, fields]) });
	assert.deepEqual(res, { ok: true });
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { dailyCap: 1, fromFile: "kept" });
	assert.deepEqual(logged.filter(([, f]) => f.key !== "fromFile"), [["settings_overlay_unknown_key", { key: "injected" }]], "the candidate's key, by name only");
});

test("a carried key never appears in readOverlay's overlay, so a block list over the overlay cannot leak it", () => {
	const path = settingsFile();
	writeFileSync(path, JSON.stringify({ dailyCap: 2, futureOperatorOnly: { path: "/srv/x" } }));
	assert.deepEqual(readOverlay(path), { overlay: { dailyCap: 2 } });
	const read = readOverlayDocument(path);
	assert.deepEqual(read.overlay, { dailyCap: 2 });
	assert.deepEqual(read.carry.unknownKeys, ["futureOperatorOnly"]);
	assert.equal(read.text, JSON.stringify({ dailyCap: 2, futureOperatorOnly: { path: "/srv/x" } }));
});

test("a carried __proto__ key stays data: no prototype is set, on the read or on the write", () => {
	const path = settingsFile();
	writeFileSync(path, '{\n  "__proto__": {\n    "polluted": true\n  },\n  "dailyCap": 1\n}\n');
	const read = readOverlay(path);
	assert.deepEqual(read, { overlay: { dailyCap: 1 } });
	assert.equal(Object.getPrototypeOf(read.overlay), Object.prototype);
	assert.equal(read.overlay.polluted, undefined);
	assert.deepEqual(edit(path, (overlay) => ({ ...overlay, dailyCap: 3 })), { ok: true });
	const text = readFileSync(path, "utf8");
	assert.equal(text, '{\n  "__proto__": {\n    "polluted": true\n  },\n  "dailyCap": 3\n}\n', "written back as the data it was");
	const parsed = JSON.parse(text);
	assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
	assert.ok(Object.hasOwn(parsed, "__proto__"));
	assert.equal({}.polluted, undefined, "nothing reached Object.prototype");
});

test("a file of known keys only is rewritten byte for byte, and a write without a carry is today's exact text", () => {
	const path = settingsFile();
	const text = lines("{", '  "maxCostUsd": "2.50",', '  "model": "claude-x",', '  "secretProfiles": {', '    "jira": "/srv/jira.sh"', "  },", '  "dailyCap": 4', "}");
	writeFileSync(path, text);
	assert.deepEqual(edit(path, (overlay) => overlay), { ok: true });
	assert.equal(readFileSync(path, "utf8"), text);
	// No carry: the candidate's own order, exactly as the writer always wrote it.
	assert.deepEqual(writeOverlay(path, { dailyCap: 4, model: "claude-x" }), { ok: true });
	assert.equal(readFileSync(path, "utf8"), lines("{", '  "dailyCap": 4,', '  "model": "claude-x"', "}"));
});

test("a hand-written version 1 reads, and the next write drops it: the writer owns the version and 1 is written as nothing", () => {
	const path = settingsFile();
	writeFileSync(path, lines("{", '  "dailyCap": 2,', '  "version": 1', "}"));
	assert.deepEqual(readOverlay(path), { overlay: { dailyCap: 2 } }, "the version is not a setting");
	assert.deepEqual(edit(path, (overlay) => overlay), { ok: true });
	assert.equal(readFileSync(path, "utf8"), lines("{", '  "dailyCap": 2', "}"));
});

test("a newer settings file is invalid with newer:true, judged before any key, and its write is refused with the file untouched", () => {
	const dir = tempDir("settings-carry-");
	const path = join(dir, "settings.json");
	// concurrency 50 is outside this build's range: a later release may have widened it, and the true answer is
	// "upgrade", never "concurrency must be an integer 1-10".
	const text = lines("{", '  "version": 2,', '  "concurrency": 50,', '  "laterKey": true', "}");
	writeFileSync(path, text);
	const newer = { invalid: "settings file written by a newer pi-dispatch (version 2; this build understands 1)", newer: true };
	assert.deepEqual(readOverlay(path), newer);
	assert.deepEqual(readOverlayDocument(path), newer);
	assert.deepEqual(edit(path, (overlay) => ({ ...overlay, dailyCap: 1 })), newer);
	// A carry handed over by any other route is refused the same way: the writer never re-stamps a newer file.
	const parsed = JSON.parse(text);
	assert.deepEqual(writeOverlay(path, { dailyCap: 1 }, { carry: { doc: parsed, unknownKeys: ["concurrency", "laterKey"] } }), newer);
	assert.equal(readFileSync(path, "utf8"), text, "untouched");
	assert.deepEqual(readdirSync(dir), ["settings.json"], "no temp file left behind");
});

test("a broken version is an ordinary invalid file, never newer", () => {
	for (const version of ["1", 0, -2, 1.5, null, true]) {
		const res = validateOverlay({ version, dailyCap: 1 });
		assert.deepEqual(res, { invalid: 'settings file "version" must be an integer of 1 or more' }, JSON.stringify(version));
	}
	assert.deepEqual(validateOverlay({ version: 1, dailyCap: 1, later: 2 }), { overlay: { dailyCap: 1 }, unknownKeys: ["later"] });
});

test("a dollar near miss is refused on read and is never carried, even by a carry built by hand", () => {
	const path = settingsFile();
	const text = lines("{", '  "max_cost_usd": "2",', '  "dailyCap": 1', "}");
	writeFileSync(path, text);
	assert.match(readOverlayDocument(path).invalid, /^max_cost_usd is not a settings key -- did you mean maxCostUsd\?/);
	assert.equal(readOverlayDocument(path).newer, undefined);
	// The writer judges its own output as the reader would, so a forged carry cannot write a file the worker refuses.
	const res = writeOverlay(path, { dailyCap: 1 }, { carry: { doc: { max_cost_usd: "2", dailyCap: 1 }, unknownKeys: ["max_cost_usd"] } });
	assert.match(res.invalid, /^max_cost_usd is not a settings key/);
	assert.equal(readFileSync(path, "utf8"), text);
});

test("a missing file reads as the empty overlay with no carry and a null snapshot, and writes as before", () => {
	const path = settingsFile();
	assert.deepEqual(readOverlayDocument(path), { overlay: {}, carry: null, text: null });
	assert.deepEqual(edit(path, () => ({ dailyCap: 7 })), { ok: true });
	assert.equal(readFileSync(path, "utf8"), lines("{", '  "dailyCap": 7', "}"));
});

test("resolveSettings keeps newer:true on a newer file's refusal, and every other invalid read is exactly { invalid }", () => {
	assert.deepEqual(resolveSettings({}, { invalid: "settings file written by a newer pi-dispatch (version 2; this build understands 1)", newer: true }), { invalid: "settings file written by a newer pi-dispatch (version 2; this build understands 1)", newer: true });
	assert.deepEqual(resolveSettings({}, { invalid: "dailyCap must be an integer >= 1" }), { invalid: "dailyCap must be an integer >= 1" });
	assert.deepEqual(resolveSettings({}, { invalid: "x", newer: false }), { invalid: "x" });
});
