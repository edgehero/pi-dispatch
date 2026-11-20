import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readPromptAdditions, rememberPromptAdditions, promptAdditionsOf } from "../src/prompt-additions.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

test("append snapshots retain their exact bytes and hashes after the operator changes a file", () => {
	const root = tempDir("prompt-additions-");
	const globalPiDir = join(root, "global");
	const jobPiDir = join(root, "project");
	mkdirSync(globalPiDir); mkdirSync(jobPiDir);
	const text = "<operator_persona version=\"1\">\nBe precise.\n</operator_persona>\n";
	writeFileSync(join(globalPiDir, "APPEND_SYSTEM.md"), text);
	const snapshot = readPromptAdditions({ globalPiDir, jobPiDir });
	const loader = rememberPromptAdditions({}, snapshot);
	writeFileSync(join(globalPiDir, "APPEND_SYSTEM.md"), "updated");
	assert.equal(snapshot.overlay, text);
	assert.deepEqual(promptAdditionsOf(loader), { overlay: createHash("sha256").update(text).digest("hex"), repository: null });
	assert.notEqual(readPromptAdditions({ globalPiDir, jobPiDir }).overlay, text);
	assert.equal(JSON.stringify(promptAdditionsOf(loader)).includes("Be precise"), false);
});

test("absent append files are optional, but unreadable append files are not silently omitted", () => {
	const root = tempDir("prompt-additions-");
	assert.deepEqual(readPromptAdditions({ globalPiDir: root, jobPiDir: root }).hashes, { overlay: null, repository: null });
	assert.throws(() => readPromptAdditions({ globalPiDir: root, jobPiDir: root, readFile() { throw Object.assign(new Error("unreadable"), { code: "EACCES" }); } }), { code: "EACCES" });
});
