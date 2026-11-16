import assert from "node:assert/strict";
import { mkdirSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readLocalWorkspaceIdentity } from "../src/local-workspace.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

test("a local workspace mutex follows symlink aliases and path spelling, but detects a replaced directory", () => {
	const root = tempDir("local-workspace-");
	const folder = join(root, "repo");
	const alias = join(root, "alias");
	mkdirSync(folder);
	symlinkSync(folder, alias, "dir");
	const original = readLocalWorkspaceIdentity(folder);
	assert.deepEqual(readLocalWorkspaceIdentity(alias), original);
	assert.deepEqual(readLocalWorkspaceIdentity(` ${folder}/../repo/ `), original);
	renameSync(folder, join(root, "old-repo"));
	mkdirSync(folder);
	assert.notEqual(readLocalWorkspaceIdentity(folder).key, original.key);
});

test("workspace identity preserves native filesystem failures for retry classification", () => {
	for (const code of ["ENOENT", "EACCES", "EIO"]) {
		const failure = Object.assign(new Error("unavailable"), { code });
		assert.throws(() => readLocalWorkspaceIdentity("/repo", { fs: { realpathSync: () => { throw failure; } } }), (error) => error === failure);
	}
	assert.throws(() => readLocalWorkspaceIdentity("/file", { fs: { realpathSync: (p) => p, statSync: () => ({ isDirectory: () => false }) } }), { code: "ENOTDIR" });
});
