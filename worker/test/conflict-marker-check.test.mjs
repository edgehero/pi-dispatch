import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers/temp-dir.mjs";
import { findConflictMarkers, scan } from "../../.github/scripts/conflict-marker-check.mjs";

// PR #457's gate: a rebase committed conflict markers into specs/requirements.md and every guard stayed green. The
// markers are BUILT here, never written literally, so this file cannot trip the check it tests.
const OPEN = "<".repeat(7);
const MID = "=".repeat(7);
const CLOSE = ">".repeat(7);

test("a conflict marker is exactly git's: the three shapes, anywhere in a file", () => {
	const text = ["| a |", `${OPEN} HEAD`, "| ours |", MID, "| theirs |", `${CLOSE} 8f0a211 (wip)`, "| b |"].join("\n");
	assert.deepEqual(findConflictMarkers(text), [2, 4, 6]);
	assert.deepEqual(findConflictMarkers(`x\r\n${MID}\r\ny`), [2], "CRLF files too");
	assert.deepEqual(findConflictMarkers(OPEN), [1], "a bare marker line");
});

test("look-alikes are not markers", () => {
	for (const line of [`${MID}=`, `${"=".repeat(6)}`, ` ${MID}`, `${OPEN}x`, `a ${CLOSE} b`, "<<<< HEAD", "---"]) {
		assert.deepEqual(findConflictMarkers(line), [], JSON.stringify(line));
	}
});

test("no tracked text file in this repository carries one", () => {
	const root = fileURLToPath(new URL("../..", import.meta.url));
	const { files, findings } = scan(root);
	assert.ok(files > 100, `the scan saw the repository (${files} files)`);
	assert.deepEqual(findings, []);
});

test("EVERY tracked text file is scanned, not a list of directories (gate round 3)", () => {
	const repo = tempDir("cmc-");
	execFileSync("git", ["init", "-q"], { cwd: repo });
	mkdirSync(join(repo, "somewhere-new"));
	writeFileSync(join(repo, "README.md"), `ok\n${OPEN} HEAD\n`);
	writeFileSync(join(repo, "somewhere-new", "x.txt"), `${MID}\n`);
	writeFileSync(join(repo, "untracked.md"), `${CLOSE} x\n`);
	execFileSync("git", ["add", "README.md", "somewhere-new/x.txt"], { cwd: repo });
	assert.deepEqual(scan(repo).findings.sort(), ["README.md:2", "somewhere-new/x.txt:1"], "tracked files anywhere; an untracked one is not the repository's");
});
