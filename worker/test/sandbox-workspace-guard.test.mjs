import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { checkSandboxWorkspace, LOCAL_FOLDER_IS_SANDBOX } from "../src/sandbox-workspace-guard.mjs";
import { prepareLocalWorkspace } from "../src/prepare-local.mjs";

test("kept roots, descendants and outside symlinks into them cannot become local job workspaces", () => {
	const dir = tempDir("sandbox-workspace-guard-");
	const sandboxDir = join(dir, "sandboxes");
	const kept = join(sandboxDir, "sb-prepared", "workspace");
	fs.mkdirSync(kept, { recursive: true });
	const alias = join(dir, "innocent-local-repo");
	fs.symlinkSync(kept, alias, "dir");
	for (const folder of [sandboxDir, kept, alias]) assert.equal(checkSandboxWorkspace({ kind: "local", folder }, { sandboxDir }).reason, LOCAL_FOLDER_IS_SANDBOX);
	const ordinary = join(dir, "ordinary");
	fs.mkdirSync(ordinary);
	assert.equal(checkSandboxWorkspace({ kind: "local", folder: ordinary }, { sandboxDir }), null);
	assert.equal(checkSandboxWorkspace({ kind: "github", folder: kept }, { sandboxDir }), null);
	assert.equal(checkSandboxWorkspace({ kind: "local", folder: ordinary }, { sandboxDir: join(dir, "not-created") }), null);
});

test("inode ancestry catches case/firmlink aliases even when realpath spells neither configured root", () => {
	const realpath = (path) => path === "/configured-sandboxes" ? "/canonical-sandboxes" : "/alias/workspace";
	const fake = { realpathSync: realpath, statSync(path) { return { dev: 1n, ino: path === "/canonical-sandboxes" || path === "/alias" ? 9n : 3n }; } };
	assert.equal(checkSandboxWorkspace({ kind: "local", folder: "/alias/workspace" }, { sandboxDir: "/configured-sandboxes", fs: fake }).reason, LOCAL_FOLDER_IS_SANDBOX);
	const unread = { ...fake, statSync() { throw Object.assign(new Error("unreadable"), { code: "EIO" }); } };
	assert.deepEqual(checkSandboxWorkspace({ kind: "local", folder: "/alias/workspace" }, { sandboxDir: "/configured-sandboxes", fs: unread }), { unavailable: true });
});

test("prepare rechecks a symlink redirected after pickup and refuses before Git or agent materialisation", async () => {
	const dir = tempDir("sandbox-workspace-prepare-");
	const ordinary = join(dir, "ordinary");
	const sandboxDir = join(dir, "sandboxes"), kept = join(sandboxDir, "sb-prepared", "workspace");
	const alias = join(dir, "repo-link");
	fs.mkdirSync(ordinary);
	fs.mkdirSync(kept, { recursive: true });
	fs.symlinkSync(ordinary, alias, "dir");
	assert.equal(checkSandboxWorkspace({ kind: "local", folder: alias }, { sandboxDir }), null);
	fs.unlinkSync(alias);
	fs.symlinkSync(kept, alias, "dir");
	const result = await prepareLocalWorkspace({ folder: alias, jobDir: join(dir, "inputs"), sandboxDir, git: async () => assert.fail("a kept workspace must be refused before any Git read") });
	assert.deepEqual(result, { outcome: "policy", reason: LOCAL_FOLDER_IS_SANDBOX });
	assert.equal(fs.existsSync(join(dir, "inputs")), false);
});
