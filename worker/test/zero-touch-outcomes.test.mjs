import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import * as fs from "node:fs";
import { FIX_OUTCOMES, makeZeroTouchOutcomeReaper, makeZeroTouchOutcomes, parseZeroTouchOutcome, ZERO_TOUCH_OUTCOMES_DIR } from "../src/zero-touch-outcomes.mjs";
import { fixHistoryRetentionMs } from "../src/zero-touch-fixes.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const NOW = Date.UTC(2026, 10, 25, 12);
const DAY = 86400000;
const A = "a".repeat(32), B = "b".repeat(32), C = "c".repeat(32);

test("an outcome is written whole under its fix's id, read back, listed once per folder and removed (#1072)", () => {
	const root = tempDir("pd-zero-touch-outcomes-");
	const dir = join(root, ZERO_TOUCH_OUTCOMES_DIR);
	const logged = [];
	const outcomes = makeZeroTouchOutcomes({ dir, now: () => NOW, log: (event, detail) => logged.push([event, detail]) });
	assert.deepEqual(FIX_OUTCOMES, ["applied", "refused"]);
	assert.equal(outcomes.read(A), null, "no folder yet is no outcome");
	assert.deepEqual([...outcomes.inspect().outcomes], []);
	assert.equal(outcomes.record(A, "applied"), true);
	assert.equal(outcomes.record(B, "refused"), true);
	// Written through a temporary file renamed over the name: nothing of the temporary is left, the folder is private.
	assert.deepEqual(fs.readdirSync(dir).sort(), [`${A}.json`, `${B}.json`]);
	assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
	assert.equal(fs.statSync(join(dir, `${A}.json`)).mode & 0o777, 0o600);
	assert.deepEqual(JSON.parse(fs.readFileSync(join(dir, `${A}.json`), "utf8")), { v: 1, outcome: "applied", at: NOW });
	assert.deepEqual([outcomes.read(A), outcomes.read(B), outcomes.read(C)], ["applied", "refused", null]);
	// A second write replaces the first: the outcome the console knew last.
	assert.equal(outcomes.record(A, "refused"), true);
	assert.equal(outcomes.read(A), "refused");
	assert.deepEqual(new Map(outcomes.inspect().outcomes), new Map([[A, "refused"], [B, "refused"]]));
	outcomes.remove(A);
	outcomes.remove(A);
	assert.deepEqual([outcomes.read(A), fs.readdirSync(dir)], [null, [`${B}.json`]], "a remove of a file already gone is what was asked for");
	// Only an id and one of the two words: nothing else names or fills a file.
	for (const [id, outcome] of [["../escape", "applied"], [A.toUpperCase(), "applied"], [A, "maybe"], [A, null]]) assert.equal(outcomes.record(id, outcome), false);
	assert.deepEqual(fs.readdirSync(dir), [`${B}.json`]);
	assert.deepEqual(logged, []);
});

test("a file that is not an outcome is never read as one, and is counted; a write that fails is logged by its code and answered false (#1072)", () => {
	const dir = join(tempDir("pd-zero-touch-outcomes-"), ZERO_TOUCH_OUTCOMES_DIR);
	const logged = [];
	const outcomes = makeZeroTouchOutcomes({ dir, now: () => NOW, log: (event, detail) => logged.push([event, detail]) });
	outcomes.record(A, "applied");
	fs.writeFileSync(join(dir, `${B}.json`), JSON.stringify({ v: 1, outcome: "applied", at: NOW, note: "an extra key" }));
	fs.writeFileSync(join(dir, `${C}.json`), "not json");
	fs.symlinkSync(join(dir, `${A}.json`), join(dir, `${"d".repeat(32)}.json`));
	fs.writeFileSync(join(dir, `${"e".repeat(32)}.json`), JSON.stringify({ v: 1, outcome: "applied", at: NOW, pad: "x".repeat(300) }));
	fs.writeFileSync(join(dir, "notes.txt"), "an operator's file");
	const found = outcomes.inspect();
	assert.deepEqual([...found.outcomes], [[A, "applied"]]);
	assert.equal(found.invalid, 4, "the extra key, the text, the link and the oversized file");
	assert.deepEqual([outcomes.read(B), outcomes.read(C), outcomes.read("d".repeat(32))], [null, null, null]);
	assert.deepEqual(logged.splice(0), [["zero_touch_outcome_unreadable", { files: 4 }]], "a count, never a name or a content");
	for (const text of ['{"v":2,"outcome":"applied","at":1}', '{"v":1,"outcome":"applied","at":-1}', '{"v":1,"outcome":"applied","at":1.5}', "[]", "null"]) assert.equal(parseZeroTouchOutcome(text), null, text);
	// A folder that cannot be made: logged by its code, answered false, and the caller goes on with the byte rule.
	const blocked = join(tempDir("pd-zero-touch-outcomes-"), "a-file");
	fs.writeFileSync(blocked, "");
	const nowhere = makeZeroTouchOutcomes({ dir: join(blocked, ZERO_TOUCH_OUTCOMES_DIR), log: (event, detail) => logged.push([event, detail]) });
	assert.equal(nowhere.record(A, "refused"), false);
	assert.deepEqual(logged, [["zero_touch_outcome_unwritten", { cause: "ENOTDIR" }]]);
	assert.equal(makeZeroTouchOutcomes({}).record(A, "refused"), false, "no folder configured writes nothing");
});

test("the reaper removes an outcome older than the fix history's retention, by its own time, and nothing else (#1072)", async () => {
	const logsDir = tempDir("pd-zero-touch-outcomes-");
	const dir = join(logsDir, ZERO_TOUCH_OUTCOMES_DIR);
	const logged = [];
	const reap = (retentionDays) => makeZeroTouchOutcomeReaper({ logsDir, retentionDays, now: () => NOW, log: (event, detail) => logged.push([event, detail]) });
	assert.deepEqual(await reap(30)(), { removed: 0 }, "no folder: nothing to do and nothing logged");
	assert.deepEqual(logged, []);
	const at = (id, ms) => makeZeroTouchOutcomes({ dir, now: () => ms }).record(id, "refused");
	at(A, NOW - 30 * DAY - 1);
	at(B, NOW - 30 * DAY + 60_000);
	// The file's own time decides, not its last write: a copy that reset its mtime is still judged by its outcome.
	const old = new Date(NOW - 400 * DAY);
	fs.utimesSync(join(dir, `${B}.json`), old, old);
	// A temporary file a write left behind, judged by its last write; and files of other names are never touched.
	fs.writeFileSync(join(dir, `${C}.json.tmp`), "{");
	fs.utimesSync(join(dir, `${C}.json.tmp`), old, old);
	fs.writeFileSync(join(dir, "notes.txt"), "");
	fs.utimesSync(join(dir, "notes.txt"), old, old);
	fs.writeFileSync(join(dir, `${"d".repeat(32)}.json`), "not an outcome");
	fs.utimesSync(join(dir, `${"d".repeat(32)}.json`), old, old);
	assert.deepEqual(await reap(30)(), { removed: 3 });
	assert.deepEqual(fs.readdirSync(dir).sort(), [`${B}.json`, "notes.txt"]);
	assert.deepEqual(logged.splice(0), [["reaped_zero_touch_outcomes", { removed: 3 }]]);
	// History kept forever keeps a fix 365 days, and so its outcome; the bound is the fix store's own.
	assert.equal(fixHistoryRetentionMs(0), 365 * DAY);
	assert.equal(fixHistoryRetentionMs(900), 365 * DAY);
	at(A, NOW - 300 * DAY);
	assert.deepEqual(await reap(0)(), { removed: 0 });
	// A stopped sweep stops between files.
	at(C, NOW - 400 * DAY);
	assert.deepEqual(await makeZeroTouchOutcomeReaper({ logsDir, retentionDays: 30, now: () => NOW })({ stopped: () => true }), { removed: 0 });
	assert.ok(fs.readdirSync(dir).includes(`${C}.json`));
});
